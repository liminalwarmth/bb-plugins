import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readOpenCodeDbRecentModels } from "../src/opencode-history.ts";
import {
  blendedCostToTier,
  buildPriceMaps,
  buildScoreMap,
  lookupPrice,
  lookupScore,
  normalizeModelName,
  parseBenchmarkPayload,
  parseModelsDevPricing,
  parseOptionTitle,
  scoreToTier,
  upsertRecentModel,
} from "../src/scoring.ts";

test("normalizeModelName aligns OpenCode display names and Artificial Analysis names", () => {
  assert.equal(normalizeModelName("Claude Fable 5.2 (Max, Default Fallback)"), "fable 5.2");
  assert.equal(normalizeModelName("Fable 5.2"), "fable 5.2");
  assert.equal(normalizeModelName("Claude 4.5 Haiku (Reasoning)"), "haiku 4.5");
  assert.equal(normalizeModelName("Haiku 4.5"), "haiku 4.5");
  assert.equal(normalizeModelName("DeepSeek V4.1 Flash 1017 (Max)"), "deepseek v4.1 flash");
  assert.equal(normalizeModelName("DeepSeek V4.1 Flash Free"), "deepseek v4.1 flash");
  assert.equal(normalizeModelName("GPT-5.6 Luna Fast"), "gpt 5.6 luna");
  assert.equal(normalizeModelName("Tencent Hy4"), "hy4");
  assert.equal(normalizeModelName("Beam 1.0"), "beam");
  assert.equal(normalizeModelName("Beam Free"), "beam");
});

test("parseBenchmarkPayload keeps the highest score per normalized model and maps tiers relatively", () => {
  const dataset = parseBenchmarkPayload({
    fetched_at: "2026-11-22T06:45:09.783Z",
    source: "artificialanalysis.ai",
    models: [
      { name: "Claude Fable 5.2 (Low)", index: 53.9, creator: "Anthropic" },
      { name: "Claude Fable 5.2 (Max)", index: 64.6, creator: "Anthropic" },
      { name: "Claude Fable 5.1 (High)", index: 47.2, creator: "Anthropic" },
      { name: "Claude Haiku 5.5 (Max)", index: 36.5, creator: "Anthropic" },
      { name: "Mistral Large 4 (High)", index: 26.1, creator: "Mistral" },
      { name: "Nemotron 3.5 Lightning", index: 5.5, creator: "NVIDIA" },
    ],
  });

  assert.equal(dataset.maxScore, 64.6);
  assert.equal(dataset.entries.length, 5);

  const scores = buildScoreMap(dataset.entries, dataset.maxScore);
  assert.equal(lookupScore(scores, "Fable 5.2")?.tier, 5);
  assert.equal(lookupScore(scores, "Fable 5.1")?.tier, 4);
  assert.equal(lookupScore(scores, "Haiku 5.5")?.tier, 3);
  assert.equal(lookupScore(scores, "Mistral Large 4")?.tier, 2);
  assert.equal(lookupScore(scores, "Nemotron 3.5 Lightning Free")?.tier, 1);
  assert.equal(scoreToTier(0, 64.6), 1);
});

test("parseOptionTitle extracts display name and route provider", () => {
  assert.deepEqual(parseOptionTitle("GPT-5.6 Luna · openai"), {
    displayName: "GPT-5.6 Luna",
    routeProviderId: "openai",
  });
  assert.equal(parseOptionTitle("Plain Model"), null);
});

test("upsertRecentModel deduplicates and moves latest pick to the top", () => {
  let list = upsertRecentModel([], {
    displayName: "Fable 5.2",
    routeProviderId: "claude-agent",
    modelId: "claude-agent/fable",
    usedAt: 1,
  });
  list = upsertRecentModel(list, {
    displayName: "GPT-6.2 Sol",
    routeProviderId: "openai",
    modelId: "openai/gpt-6.2-sol",
    usedAt: 2,
  });
  list = upsertRecentModel(list, {
    displayName: "Fable 5.2",
    routeProviderId: "claude-agent",
    modelId: "claude-agent/fable",
    usedAt: 3,
  });

  assert.equal(list.length, 2);
  assert.equal(list[0]?.displayName, "Fable 5.2");
  assert.equal(list[1]?.displayName, "GPT-6.2 Sol");
});

test("readOpenCodeDbRecentModels reads only assistant turns ordered by most recent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ocp-test-"));
  const dbPath = path.join(dir, "opencode.db");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("m1", "s1", "assistant", 1, 1000, 1000, JSON.stringify({ model: { providerID: "opencode-go", id: "glm-5.3" } }));
    insert.run("m2", "s1", "model-switched", 2, 2000, 2000, JSON.stringify({ model: { providerID: "openai", id: "gpt-6.2-sol" } }));
    insert.run("m3", "s1", "assistant", 3, 3000, 3000, JSON.stringify({ model: { providerID: "opencode-go", id: "deepseek-v4-pro" } }));
    insert.run("m4", "s1", "assistant", 4, 4000, 4000, JSON.stringify({ model: { providerID: "opencode-go", id: "glm-5.3" } }));
    db.close();

    const recent = readOpenCodeDbRecentModels(4, dbPath);
    assert.deepEqual(recent, [
      { modelId: "opencode-go/glm-5.3", routeProviderId: "opencode-go", usedAt: 4000 },
      { modelId: "opencode-go/deepseek-v4-pro", routeProviderId: "opencode-go", usedAt: 3000 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseModelsDevPricing and lookupPrice resolve route-specific and fallback cost tiers", () => {
  const entries = parseModelsDevPricing({
    opencode: {
      models: {
        "glm-5.3": { name: "GLM-5.3", cost: { input: 0.56, output: 1.76 } },
        "claude-fable-5-2": { name: "Claude Fable 5.2", cost: { input: 8, output: 40 } },
        "beam-free": { name: "Beam Free", cost: { input: 0, output: 0 } },
      },
    },
    "opencode-go": {
      models: {
        "glm-5.3": { name: "GLM-5.3", cost: { input: 1.4, output: 4.4 } },
      },
    },
  });

  const { byRoute, byNorm } = buildPriceMaps(entries);
  assert.equal(lookupPrice(byRoute, byNorm, "GLM-5.3", "opencode")?.label, "$");
  assert.equal(lookupPrice(byRoute, byNorm, "GLM-5.3", "opencode-go")?.label, "$$");
  assert.equal(lookupPrice(byRoute, byNorm, "Fable 5.2", "claude-agent")?.label, "$$$$");
  assert.equal(lookupPrice(byRoute, byNorm, "Beam Free", "opencode")?.label, "Free");
  assert.equal(blendedCostToTier(0), 0);
  assert.equal(blendedCostToTier(0.5), 1);
  assert.equal(blendedCostToTier(2.15), 2);
  assert.equal(blendedCostToTier(6), 3);
  assert.equal(blendedCostToTier(16), 4);
});
