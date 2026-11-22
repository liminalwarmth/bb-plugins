import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeCodexHome } from "./codex.ts";
import type { LiminalCodexAccount } from "./liminal.ts";

const STATE_DB = /^state_(\d+)\.sqlite$/;
const SHARED_HISTORY = ["sessions", "archived_sessions"] as const;
const preparing = new Map<string, Promise<string>>();

function link(home: string, name: string, source: string) {
  const target = path.join(home, name);
  try {
    fs.symlinkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !fs.lstatSync(target).isSymbolicLink() || fs.readlinkSync(target) !== source) throw error;
  }
}

function unlinkIfSymlink(target: string) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) fs.unlinkSync(target);
}

function stateDatabases(home: string) {
  return fs.readdirSync(home)
    .map(name => ({ name, match: STATE_DB.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]))
    .map(entry => path.join(home, entry.name));
}

export function stateBackfillComplete(home: string) {
  const latest = stateDatabases(home)[0];
  if (!latest) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(latest, { readOnly: true });
    const row = db.prepare("SELECT status FROM backfill_state WHERE id = 1").get() as { status?: unknown } | undefined;
    return row?.status === "complete";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function clearIncompleteStateDatabases(home: string) {
  for (const file of stateDatabases(home)) {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

export async function bbCodexHome(
  account: LiminalCodexAccount,
  main = path.join(os.homedir(), ".codex"),
  init: (home: string) => Promise<void> = initializeCodexHome,
) {
  if (account.main) return main;
  if (!account.home) throw new Error(`${account.label} has no Codex home.`);
  const auth = path.join(account.home, "auth.json");
  if (!fs.statSync(auth, { throwIfNoEntry: false })?.isFile()) throw new Error(`${account.label} is signed out. Sign in from Liminal Tools.`);
  const home = path.join(main, "liminal-pool", "homes", account.id);
  const inFlight = preparing.get(home);
  if (inFlight) return inFlight;
  const run = (async () => {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    link(home, "auth.json", auth);
    for (const name of ["config.toml", "AGENTS.md", "skills", "plugins", "rules", ".tmp"]) {
      const source = path.join(account.home!, name);
      if (fs.existsSync(source)) link(home, name, source);
    }
    if (!stateBackfillComplete(home)) {
      for (const name of SHARED_HISTORY) unlinkIfSymlink(path.join(home, name));
      clearIncompleteStateDatabases(home);
      await init(home);
    }
    for (const name of SHARED_HISTORY) {
      const source = path.join(main, name);
      fs.mkdirSync(source, { recursive: true, mode: 0o700 });
      link(home, name, source);
    }
    return home;
  })();
  preparing.set(home, run);
  try {
    return await run;
  } finally {
    preparing.delete(home);
  }
}
