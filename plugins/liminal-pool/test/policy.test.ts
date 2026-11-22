// Pins the ported Liminal policy: ranking, fallback eligibility, exhaustion markers, resume timing and the Mana Bar.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowanceReturns, claudeAccountBoundModel, claudeWindows, fallbackAvailability, fallbackBlocked, fallbackReset, manaWeek,
  preferredAccount, resetIn, type ProviderUsage,
} from "../src/policy.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const hours = (count: number) => new Date(NOW + count * 3600_000).toISOString();
function claude(fiveHourUsed: number, weekUsed: number, weekReset: string, checkedAt = new Date(NOW).toISOString()): ProviderUsage {
  return {
    provider: "claude", checkedAt,
    windows: claudeWindows({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: fiveHourUsed, resets_at: hours(3) },
      seven_day: { utilization: weekUsed, resets_at: weekReset },
      model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: weekReset }],
    } }),
  };
}
const models = [{ id: "opus", resolvedModel: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] }];
const session = { provider: "claude", model: "claude-opus-5-5", effort: "high" };

test("Claude's usage answer becomes allowance-left windows", () => {
  const usage = claude(1, 24, hours(80));
  const week = usage.windows.find(item => item.bucket === "seven_day")!;
  assert.equal(week.remaining, 76);
  assert.equal(week.shared, true);
  assert.equal(week.durationMinutes, 10080);
  const fable = usage.windows.find(item => item.scope === "Fable")!;
  assert.equal(fable.shared, false);
});

test("new work starts where weekly allowance resets soonest, spent logins last, pin holds until zero", () => {
  const candidates = [
    { id: "CLAW", usage: claude(0, 10, hours(100)) },
    { id: "CLEX", usage: claude(0, 90, hours(20)) },
  ];
  assert.equal(preferredAccount(candidates), "CLEX");
  assert.equal(preferredAccount(candidates, "CLAW"), "CLAW");
  const spent = [{ id: "CLAW", usage: claude(0, 10, hours(100)) }, { id: "CLEX", usage: claude(0, 100, hours(20)) }];
  assert.equal(preferredAccount(spent, "CLEX"), "CLAW");
  // Unknown usage ranks after known allowance; catalog order breaks ties.
  assert.equal(preferredAccount([{ id: "A" }, { id: "B", usage: claude(0, 50, hours(50)) }]), "B");
  assert.equal(preferredAccount([{ id: "A" }, { id: "B" }]), "A");
});

test("fallback needs a fresh snapshot with room and the exact model and effort", () => {
  assert.equal(fallbackAvailability(session, claude(10, 40, hours(50)), models, NOW), true);
  assert.equal(fallbackAvailability(session, claude(100, 40, hours(50)), models, NOW), false, "five-hour window spent");
  assert.equal(fallbackAvailability(session, claude(10, 40, hours(50), new Date(NOW - 120_000).toISOString()), models, NOW), false, "stale snapshot");
  assert.equal(fallbackAvailability({ ...session, model: "claude-mythos-5-1" }, claude(10, 40, hours(50)), models, NOW), false, "model not in catalog");
  assert.equal(fallbackAvailability({ ...session, effort: "ultra" }, claude(10, 40, hours(50)), models, NOW), false, "effort not offered");
  assert.equal(fallbackAvailability({ provider: "claude" }, claude(10, 40, hours(50)), [], NOW), true, "provider default model");
});

test("an exhausted account stays blocked until a fresh reading after its reset", () => {
  const exhaustedAt = new Date(NOW).toISOString();
  const spent = claude(10, 100, hours(30));
  const reset = fallbackReset(session, spent, exhaustedAt, NOW);
  assert.equal(reset, hours(30));
  const marker = { exhaustedAt, resetsAt: reset };
  assert.equal(fallbackBlocked(session, marker, claude(10, 0, hours(200)), NOW + 3600_000), true, "before reset");
  const after = NOW + 31 * 3600_000;
  assert.equal(fallbackBlocked(session, marker, claude(0, 0, hours(200), new Date(after).toISOString()), after), false, "fresh reading after reset");
});

test("a usage-limited thread resumes at the soonest return across accounts", () => {
  const at = allowanceReturns(session, [
    { marker: { resetsAt: hours(30) }, snapshot: claude(0, 100, hours(30)) },
    { snapshot: claude(100, 50, hours(90)) },
  ], NOW);
  assert.equal(at, hours(3));
  assert.equal(allowanceReturns(session, [{ snapshot: claude(0, 10, hours(30)) }], NOW), undefined);
});

test("Sonnet 5.5 thinking is account-bound", () => {
  assert.equal(claudeAccountBoundModel("claude-sonnet-5-5"), true);
  assert.equal(claudeAccountBoundModel("sonnet"), true);
  assert.equal(claudeAccountBoundModel("claude-opus-5-5"), false);
});

test("the Mana Bar counts allowance down with a reset countdown", () => {
  const shown = manaWeek(claude(0, 24, hours(84)), NOW)!;
  assert.equal(shown.left, 76);
  assert.equal(shown.countdown, "3d12h");
  assert.equal(resetIn({ resetsAt: hours(0.5) }, NOW), "30m");
});
