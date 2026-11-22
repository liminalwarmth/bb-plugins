import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { bbCodexHome, stateBackfillComplete } from "../src/codex-home.ts";

function writeStateDb(home: string, status: string) {
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS backfill_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      last_watermark TEXT,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT OR REPLACE INTO backfill_state (id, status, updated_at) VALUES (1, ?, 1)").run(status);
  db.close();
}

test("BB can select a secondary Codex login and resume shared history without replacing the primary login", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-codex-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  const secondary = path.join(root, "secondary");
  fs.mkdirSync(path.join(main, "sessions"), { recursive: true });
  fs.mkdirSync(secondary);
  fs.writeFileSync(path.join(main, "auth.json"), "main-login");
  fs.writeFileSync(path.join(secondary, "auth.json"), "secondary-login");
  fs.writeFileSync(path.join(main, "sessions", "rollout.jsonl"), "prior conversation");
  const primaryLogin = fs.statSync(path.join(main, "auth.json")).ino;
  const account = { id: "secondary", label: "Secondary", home: secondary, main: false };

  let initCalls = 0;
  const fakeInit = async (home: string) => {
    initCalls++;
    assert.equal(fs.existsSync(path.join(home, "sessions")), false, "sessions must not be linked before state db backfill completes");
    assert.equal(fs.existsSync(path.join(home, "archived_sessions")), false, "archived_sessions must not be linked before state db backfill completes");
    writeStateDb(home, "complete");
  };

  const selected = await bbCodexHome(account, main, fakeInit);
  assert.equal(initCalls, 1);
  assert.equal(stateBackfillComplete(selected), true);
  assert.equal(await bbCodexHome(account, main, fakeInit), selected);
  assert.equal(initCalls, 1, "already-initialized home does not re-initialize");
  assert.equal(await bbCodexHome({ id: "codex", label: "Main", home: null, main: true }, main, fakeInit), main);
  assert.equal(fs.realpathSync(path.join(selected, "auth.json")), fs.realpathSync(path.join(secondary, "auth.json")));
  assert.equal(fs.readFileSync(path.join(selected, "sessions", "rollout.jsonl"), "utf8"), "prior conversation");
  fs.writeFileSync(path.join(selected, "auth.json"), "secondary-refreshed");
  assert.equal(fs.readFileSync(path.join(secondary, "auth.json"), "utf8"), "secondary-refreshed");
  assert.equal(fs.readFileSync(path.join(main, "auth.json"), "utf8"), "main-login");
  assert.equal(fs.lstatSync(path.join(main, "auth.json")).ino, primaryLogin);
});

test("BB repairs a secondary Codex home whose state db is stuck in running backfill", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "liminal-codex-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main");
  const secondary = path.join(root, "secondary");
  fs.mkdirSync(path.join(main, "sessions"), { recursive: true });
  fs.mkdirSync(secondary);
  fs.writeFileSync(path.join(secondary, "auth.json"), "secondary-login");
  fs.writeFileSync(path.join(main, "sessions", "rollout.jsonl"), "prior conversation");
  const account = { id: "secondary", label: "Secondary", home: secondary, main: false };
  const home = path.join(main, "liminal-pool", "homes", account.id);
  fs.mkdirSync(home, { recursive: true });
  fs.symlinkSync(path.join(main, "sessions"), path.join(home, "sessions"));
  writeStateDb(home, "running");
  assert.equal(stateBackfillComplete(home), false);

  let initCalls = 0;
  const selected = await bbCodexHome(account, main, async dir => {
    initCalls++;
    assert.equal(fs.existsSync(path.join(dir, "sessions")), false);
    assert.equal(fs.existsSync(path.join(dir, "state_5.sqlite")), false);
    writeStateDb(dir, "complete");
  });

  assert.equal(selected, home);
  assert.equal(initCalls, 1);
  assert.equal(stateBackfillComplete(home), true);
  assert.equal(fs.readFileSync(path.join(home, "sessions", "rollout.jsonl"), "utf8"), "prior conversation");
});
