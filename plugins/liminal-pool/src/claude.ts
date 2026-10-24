// Reading one Claude login through Claude Code itself, pointed at that account's home, as Liminal's connector does: who
// is signed in (`claude auth status`), and over one control session its model catalog (`initialize`) and plan usage
// (`get_usage`, what the Agent SDK's usage_EXPERIMENTAL call sends). Claude Code stays the only owner of each login's
// Keychain item and refresh token; this never reads a credential.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeWindows, type ProviderModel, type UsageWindow } from "./policy.ts";

// app/broker/runner/environment.mts: the child gets an allowlist of this process's variables, and the account's home
// replaces every inherited login variable (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, …).
const BASE = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_CONFIG_PARAMETERS"];
export function accountEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASE) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.CLAUDE_CONFIG_DIR = home;
  return env;
}

// claude-executable.mts: the official install in ~/.local/bin, else the first `claude` on PATH.
export function claudeExecutable() {
  const configured = process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) return configured;
  const found = [path.join(os.homedir(), ".local/bin"), ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean)
    .map(dir => path.join(dir, "claude"))
    .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  return found ? fs.realpathSync(found) : "claude";
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${path.basename(command)} timed out.`)); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}

export type Availability = "signed-in" | "signed-out" | "unknown";
// claude.mts `claudeIdentity`: `claude auth status --json` under the account's home, with the plan it reports.
export async function claudeAvailability(home: string): Promise<{ availability: Availability; plan: string | null }> {
  try {
    const { stdout } = await run(claudeExecutable(), ["auth", "status", "--json"], accountEnvironment(home), 20_000);
    const status = JSON.parse(stdout) as { loggedIn?: unknown; subscriptionType?: unknown };
    const plan = typeof status.subscriptionType === "string" ? status.subscriptionType : null;
    return { availability: status.loggedIn === true ? "signed-in" : status.loggedIn === false ? "signed-out" : "unknown", plan };
  } catch {
    return { availability: "unknown", plan: null };
  }
}

export interface ClaudeReading { windows: UsageWindow[]; models: ProviderModel[] }
type ControlMessage = { type?: string; response?: { subtype?: string; request_id?: string; response?: unknown; error?: string } };
type InitModel = { value?: string; resolvedModel?: string; supportedEffortLevels?: string[] | null };

// provider.mts `readUsage` + claude.mts `listClaudeModels`: one control session with no settings, no saved session and
// no prompt — initialize for the catalog, then get_usage({ skip_behaviors }) for the plan windows.
export function readClaude(home: string, timeoutMs = 20_000): Promise<ClaudeReading> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeExecutable(), ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
      "--setting-sources", "", "--permission-mode", "default", "--no-session-persistence"],
    { env: accountEnvironment(home), stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", models: ProviderModel[] = [], settled = false;
    const finish = (error: Error | null, value?: ClaudeReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("Usage read timed out.")), timeoutMs);
    const send = (id: string, request: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
    child.on("error", error => finish(error));
    child.on("close", () => finish(new Error("Claude Code exited before reporting usage.")));
    child.stdin.on("error", () => { /* The child closing first is reported by `close`. */ });
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: ControlMessage;
        try { message = JSON.parse(line) as ControlMessage; } catch { continue; }
        const response = message.type === "control_response" ? message.response : undefined;
        if (!response) continue;
        if (response.subtype !== "success") { finish(new Error(response.error || "Claude Code refused the control request.")); return; }
        if (response.request_id === "init") {
          const listed = ((response.response as { models?: InitModel[] } | undefined)?.models || []);
          models = listed.filter(item => item.value && item.value !== "default").map(item => ({
            id: item.value!, ...(item.resolvedModel ? { resolvedModel: item.resolvedModel } : {}), efforts: item.supportedEffortLevels || [],
          }));
          send("usage", { subtype: "get_usage", skip_behaviors: true });
        } else if (response.request_id === "usage") {
          finish(null, { windows: claudeWindows(response.response), models });
        }
      }
    });
    send("init", { subtype: "initialize", hooks: null });
  });
}
