import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { usageWindow, type UsageWindow } from "./policy.ts";

export interface SubscriptionReading { plan: string | null; windows: UsageWindow[] }

export function executable(name: string) {
  const dirs = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(path.delimiter)];
  return dirs.filter(Boolean).map(dir => path.join(dir, name))
    .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }) ?? name;
}

const iso = (ms: number | undefined) => typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

const antigravityUsage = z.object({
  command: z.object({
    data: z.object({
      groups: z.array(z.object({
        name: z.string(),
        buckets: z.array(z.object({
          window: z.string(),
          remaining_fraction: z.number().min(0).max(1),
          reset_time: z.string().nullish(),
        })),
      })),
    }),
  }),
});

const antigravityWindows = new Map([["5h", 300], ["weekly", 10080]]);
const execFileAsync = promisify(execFile);

export async function readAntigravity(): Promise<SubscriptionReading> {
  const { stdout } = await execFileAsync(executable("agy"), ["-p", "/usage", "--output-format", "json", "--print-timeout", "12s"], {
    cwd: os.homedir(),
    timeout: 15_000,
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  }).catch(() => { throw new Error("Could not read Antigravity usage."); });
  let payload: unknown;
  try { payload = JSON.parse(stdout); } catch { throw new Error("Antigravity returned unreadable usage."); }
  const quota = antigravityUsage.safeParse(payload);
  if (!quota.success) throw new Error("Antigravity returned unreadable usage.");
  const windows = quota.data.command.data.groups.flatMap(group => {
    const name = group.name.trim().toLowerCase();
    if (name === "claude and gpt models") return [];
    return group.buckets.flatMap(bucket => {
      const minutes = antigravityWindows.get(bucket.window);
      return minutes === undefined ? [] : usageWindow(`${group.name}:${bucket.window}`, group.name, minutes, (1 - bucket.remaining_fraction) * 100, bucket.reset_time, name === "gemini models");
    });
  });
  if (!windows.length) throw new Error("Antigravity returned no quota readings.");
  return { plan: null, windows };
}

type Billing = { config?: { creditUsagePercent?: number; currentPeriod?: { type?: string; start?: string; end?: string } }; subscription_tier?: string };

export function readGrok(timeoutMs = 20_000): Promise<SubscriptionReading> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable("grok"), ["agent", "--always-approve", "--no-leader", "stdio"], {
      detached: true, stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: "1", GROK_TELEMETRY_ENABLED: "false", GROK_TELEMETRY_TRACE_UPLOAD: "false" },
    });
    let buffer = "", settled = false;
    const finish = (error: Error | null, value?: SubscriptionReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); }
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("Grok did not answer in time.")), timeoutMs);
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    child.on("error", () => finish(new Error("Could not launch the Grok CLI.")));
    child.on("close", () => finish(new Error("The Grok CLI stopped.")));
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let reply: { id?: number; result?: Billing; error?: { message?: string } };
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.error) return finish(new Error(reply.error.message || "Grok request failed."));
        if (reply.id === 1) send(2, "_x.ai/billing", {});
        else if (reply.id === 2) {
          const config = reply.result?.config, period = config?.currentPeriod;
          const minutes = /WEEKLY/.test(period?.type ?? "") ? 10080 : Math.round((Date.parse(period?.end ?? "") - Date.parse(period?.start ?? "")) / 60_000) || undefined;
          finish(null, { plan: reply.result?.subscription_tier ?? null, windows: period?.end ? usageWindow("grok", "", minutes, config?.creditUsagePercent ?? 0, period.end, true) : [] });
        }
      }
    });
    send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "bb_liminal_pool", version: "1" } });
  });
}

type GoMeter = { percent?: number; resetsAt?: number } | null | undefined;
type Limits = { data?: { workspace?: { name?: string }; go?: { rolling?: GoMeter; weekly?: GoMeter; monthly?: GoMeter } | null } };

export function readOpenCodeGo(timeoutMs = 30_000): Promise<SubscriptionReading | null> {
  return new Promise((resolve, reject) => {
    execFile(executable("opencode"), ["api", "experimental.usage.limits"], { timeout: timeoutMs, cwd: os.homedir(), env: process.env }, (error, stdout) => {
      if (error) return reject(new Error("Could not read OpenCode Go usage."));
      let parsed: Limits;
      try { parsed = JSON.parse(stdout); } catch { return reject(new Error("OpenCode returned unreadable usage.")); }
      const go = parsed.data?.go;
      if (!go) return resolve(null);
      const meter = (bucket: string, minutes: number, item: GoMeter) => usageWindow(bucket, "", minutes, item?.percent, iso(item?.resetsAt), true);
      resolve({
        plan: parsed.data?.workspace?.name ? `Go · ${parsed.data.workspace.name}` : "Go",
        windows: [...meter("rolling", 300, go.rolling), ...meter("weekly", 10080, go.weekly), ...meter("monthly", 43200, go.monthly)],
      });
    });
  });
}
