// Liminal Tools' own account records, read live and never written: the Claude accounts its AI package signed in (their
// labels, homes and order), which Connections has switched off, which logins failed a Keychain move, and the worker pin
// `./jim account prefer workers claude <label>` sets. bb threads therefore see the same accounts, under the same names,
// with the same switches as Liminal's conversations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LiminalAccount {
  id: string;
  label: string;
  home: string;
}
/** A Codex login Liminal lists: an added account's CODEX_HOME, or (main) this Mac's own ~/.codex. */
export interface LiminalCodexAccount {
  id: string;
  label: string;
  home: string | null;
  main: boolean;
}
export interface LiminalSnapshot {
  accounts: LiminalAccount[];
  codex: LiminalCodexAccount[];
  /** Accounts Liminal will not route new work, failover or rebalance to, with why. */
  excluded: Map<string, string>;
  /** `accountPins.workers.claude`: the account new work prefers until it is known to be at zero. */
  pinned: string | undefined;
  /** Why the registry could not be read, when it could not. */
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function expandHome(value: string) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readOptional(file: string): unknown {
  try {
    return readJson(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// connectors/claude/dashboard-claude.mts: the terminal's own Claude login (~/.claude) is never an account home, whether
// named directly or reached through a symlink.
export function ownedClaudeHome(home: string) {
  if (!path.isAbsolute(home)) return false;
  const terminal = path.join(os.homedir(), ".claude");
  try {
    const real = fs.realpathSync(home);
    return real !== fs.realpathSync(terminal) && path.resolve(home) !== terminal;
  } catch {
    return path.resolve(home) !== terminal;
  }
}

export function readLiminal(dataDir: string): LiminalSnapshot {
  const root = expandHome(dataDir);
  const excluded = new Map<string, string>();
  let raw: unknown;
  try {
    raw = readJson(path.join(root, "plugins/ai/state/accounts.json"));
  } catch (error) {
    return { accounts: [], codex: [], excluded, pinned: undefined, error: `Could not read Liminal Tools' accounts in ${root}: ${(error as Error).message}` };
  }
  const listed = isRecord(raw) && Array.isArray(raw.accounts) ? raw.accounts : [];
  // Liminal's loader keeps only well-formed records (accounts.mts); the AI package lists them in this order.
  const accounts = listed.flatMap((item): LiminalAccount[] =>
    isRecord(item) && item.provider === "claude" && typeof item.id === "string" && UUID.test(item.id)
      && typeof item.label === "string" && typeof item.home === "string" && path.isAbsolute(item.home)
      ? [{ id: item.id, label: item.label, home: item.home }]
      : []);

  // accounts.mts `main`: this Mac's own Codex login is listed first under its Liminal label unless it was removed.
  const record = isRecord(raw) ? raw : {};
  const mainLabels = isRecord(record.mainLabels) ? record.mainLabels : {};
  const removed = Array.isArray(record.removed) ? record.removed : [];
  const mainRemoved = removed.some(item => isRecord(item) && item.provider === "codex" && item.id === "codex");
  const codex: LiminalCodexAccount[] = [
    ...(mainRemoved ? [] : [{ id: "codex", label: typeof mainLabels.codex === "string" ? mainLabels.codex : "Main", home: null, main: true }]),
    ...listed.flatMap((item): LiminalCodexAccount[] =>
      isRecord(item) && item.provider === "codex" && typeof item.id === "string" && UUID.test(item.id)
        && typeof item.label === "string" && typeof item.home === "string" && path.isAbsolute(item.home)
        ? [{ id: item.id, label: item.label, home: item.home, main: false }]
        : []),
  ];

  // Connections' switches: `core/connections/accounts.json` keyed `<provider>:<id>`.
  try {
    const settings = readOptional(path.join(root, "core/connections/accounts.json"));
    const disabled = isRecord(settings) && isRecord(settings.disabled) ? settings.disabled : {};
    for (const account of accounts) if (Object.hasOwn(disabled, `claude:${account.id}`)) excluded.set(account.id, "Switched off in Liminal's Connections");
    for (const account of codex) if (Object.hasOwn(disabled, `codex:${account.id}`)) excluded.set(account.id, "Switched off in Liminal's Connections");
  } catch { /* A damaged file counts every account as enabled, as Liminal reads it. */ }

  // keychain-move.mts: an `error` receipt blocks the account until it signs in again.
  try {
    const moves = readOptional(path.join(root, "plugins/ai/state/claude-keychain-moves.json"));
    if (isRecord(moves)) for (const account of accounts) {
      const receipt = moves[account.id];
      if (isRecord(receipt) && receipt.status === "error") excluded.set(account.id, "Its Keychain login failed to move; sign in again in Liminal");
    }
  } catch { /* Unreadable receipts block nothing. */ }

  for (const account of accounts) if (!ownedClaudeHome(account.home)) excluded.set(account.id, "Its home is the terminal's own Claude login");

  let pinned: string | undefined;
  try {
    const assistant = readOptional(path.join(root, "plugins/assistant/state/assistant.json"));
    const pins = isRecord(assistant) && isRecord(assistant.accountPins) && isRecord(assistant.accountPins.workers) ? assistant.accountPins.workers : {};
    if (typeof pins.claude === "string") pinned = pins.claude;
  } catch { /* No pin. */ }

  return { accounts, codex, excluded, pinned };
}

/** An account named by its id or by its label, in any case (account-preference.mts `namedAccount`). */
export function namedAccount(accounts: LiminalAccount[], value: string) {
  const direct = accounts.find(item => item.id === value);
  if (direct) return direct;
  const matches = accounts.filter(item => item.label.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`“${value}” matches several Claude accounts. Use an account ID.`);
  throw new Error(`Unknown Claude account “${value}”. Run \`bb liminal-pool status\` for labels.`);
}
