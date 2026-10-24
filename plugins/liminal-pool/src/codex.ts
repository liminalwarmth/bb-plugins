// Reading one Codex login through Codex's own app-server, pointed at that account's CODEX_HOME (or this Mac's ~/.codex
// for Liminal's main Codex login), as Liminal's connector does: who is signed in (`account/read`) and the plan windows
// (`account/rateLimits/read`). The app-server stays the only owner of the login; this never reads a credential.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageWindow, type UsageWindow } from "./policy.ts";

const BASE = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"];
// codex-features.mts: an account's CODEX_HOME replaces CODEX_HOME and OPENAI_API_KEY.
function environment(home: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASE) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (home) env.CODEX_HOME = home;
  return env;
}

function codexExecutable() {
  const found = [path.join(os.homedir(), ".local/bin"), ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean)
    .map(dir => path.join(dir, "codex"))
    .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  return found ?? "codex";
}

// codex/provider.mts `windows`: Codex's plan buckets — its own limit (shared) and per-model limits, each with a primary
// and secondary window.
type Window = { windowDurationMins?: number; usedPercent?: number; resetsAt?: number } | null;
type Bucket = { limitId?: string; limitName?: string; primary?: Window; secondary?: Window };
type CodexUsage = { rateLimits?: Bucket; rateLimitsByLimitId?: Record<string, Bucket> };
export function codexWindows(raw: unknown): UsageWindow[] {
  const data = (raw ?? {}) as CodexUsage, primary = data.rateLimits?.limitId || "codex";
  const buckets = { ...(data.rateLimits ? { [primary]: data.rateLimits } : {}), ...data.rateLimitsByLimitId };
  return Object.entries(buckets).flatMap(([id, limits]) => [limits?.primary, limits?.secondary]
    .filter((item): item is NonNullable<Window> => Boolean(item))
    .flatMap(item => usageWindow(id, limits.limitName || (id === "codex" ? "" : id), item.windowDurationMins, item.usedPercent,
      Number.isFinite(item.resetsAt) ? new Date(item.resetsAt! * 1000).toISOString() : null, id === primary)));
}

export interface CodexReading { signedIn: boolean; email: string | null; plan: string | null; windows: UsageWindow[] }
type Reply = { id?: number; result?: unknown; error?: { message?: string } };

export function readCodex(home: string | null, timeoutMs = 20_000): Promise<CodexReading> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexExecutable(), ["app-server", "--listen", "stdio://"], { env: environment(home), stdio: ["pipe", "pipe", "ignore"], detached: true });
    let buffer = "", account: CodexReading | undefined, settled = false;
    const finish = (error: Error | null, value?: CodexReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); }
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("Codex read timed out.")), timeoutMs);
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", error => finish(error));
    child.on("close", () => finish(new Error("Codex exited before reporting usage.")));
    child.stdin.on("error", () => { /* Reported by `close`. */ });
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let reply: Reply;
        try { reply = JSON.parse(line) as Reply; } catch { continue; }
        if (reply.id === 1) {
          if (reply.error) { finish(new Error(reply.error.message || "Codex refused to start.")); return; }
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/read", params: {} });
        } else if (reply.id === 2) {
          const found = (reply.result as { account?: { email?: string; planType?: string } | null } | undefined)?.account;
          account = { signedIn: Boolean(found), email: found?.email ?? null, plan: found?.planType ?? null, windows: [] };
          if (!found) { finish(null, account); return; }
          send({ id: 3, method: "account/rateLimits/read", params: {} });
        } else if (reply.id === 3) {
          if (reply.error) { finish(new Error(reply.error.message || "Codex could not read its rate limits.")); return; }
          finish(null, { ...account!, windows: codexWindows(reply.result) });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "bb_liminal_pool", title: "Liminal Pool", version: "1.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } } });
  });
}
