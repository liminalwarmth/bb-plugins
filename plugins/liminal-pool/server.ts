// Liminal Pool — runs bb's Claude Code threads on Liminal Tools' Claude accounts, the way Liminal runs its own
// conversations: each account is a Claude Code home (CLAUDE_CONFIG_DIR) whose login Claude Code alone owns and
// refreshes, so nothing is proxied and no token is copied. A thread keeps the account it started on; when that account's
// allowance is exhausted it moves to another account with verified room for the same model and effort, and resumes the
// same native session (every home's projects/ is the shared ~/.claude/projects). With no such account it waits until
// the soonest reset plus a minute. The policy is src/policy.ts, ported from Liminal; this file wires it into bb.
import { defineRpcContract, type BbPluginApi, type PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { claudeAvailability, readClaude, type Availability } from "./src/claude.ts";
import { readCodex } from "./src/codex.ts";
import { namedAccount, readLiminal, type LiminalAccount, type LiminalCodexAccount, type LiminalSnapshot } from "./src/liminal.ts";
import {
  ALLOWANCE_MARGIN_MS, RESUME_DELAYS, allowanceReturns, claudeAccountBoundModel, fallbackAvailability, fallbackBlocked,
  fallbackPrompt, fallbackReset, manaWeek, preferredAccount, resetIn, resumePrompt, tightest, usageRefreshInterval, usageShortLabel,
  usageStale, type Configuration, type UsageWindow, type ExhaustionMarker, type ProviderModel, type ProviderUsage,
} from "./src/policy.ts";

const PROVIDER = "claude-code";
const MANA_CHANGED = "mana-changed";
const IDENTITY_TTL_MS = 5 * 60_000;
const NEXT_THREAD = "next-thread";
// A new-thread pick goes to a thread whose first message arrives within this long of its creation.
const NEW_THREAD_MS = 2 * 60_000;

/** What the plugin remembers per routed thread (Liminal's Session fields of the same names). */
interface ThreadState {
  account: string;
  exhaustedAccounts: Record<string, ExhaustionMarker>;
  autoResume?: { count: number; requestId?: string; allowance?: boolean; at?: string };
  waiting?: string;
}

const manaRowSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  id: z.string(),
  label: z.string(),
  plan: z.string().nullable(),
  status: z.enum(["ready", "exhausted", "excluded", "signed-out", "checking"]),
  statusLabel: z.string(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  slots: z.array(z.object({ key: z.string(), label: z.string(), left: z.number().nullable() })),
  threads: z.number(),
  pinned: z.boolean(),
  left: z.number().nullable(),
  pace: z.number().nullable(),
  countdown: z.string(),
  stale: z.boolean(),
  windows: z.array(z.object({ label: z.string(), left: z.number(), resets: z.string() })),
  checkedAt: z.string().nullable(),
});
export type ManaRow = z.infer<typeof manaRowSchema>;
const manaSchema = z.object({ rows: z.array(manaRowSchema), error: z.string().nullable(), routing: z.boolean(), conflict: z.string().nullable() });
export type Mana = z.infer<typeof manaSchema>;

// The composer's account picker. `threadId` null is the new-thread composer, whose pick waits for the thread it starts.
// `account` is the thread's account, or the new-thread pick (null: Liminal chooses); `automatic` is Liminal's choice now.
const pickerSchema = z.object({ account: z.string().nullable(), automatic: z.string().nullable() });
export type Picker = z.infer<typeof pickerSchema>;
const pickerTarget = z.object({ threadId: z.string().min(1).nullable() });

export const rpcContract = defineRpcContract({
  mana: { input: z.null(), output: manaSchema },
  refresh: { input: z.null(), output: manaSchema },
  picker: { input: pickerTarget, output: pickerSchema },
  choose: { input: pickerTarget.extend({ account: z.string().min(1).nullable() }), output: pickerSchema },
});
// Provider Retry asks every source for this before it schedules a rate-limit retry (builtin provider-retry plugin).
const retryAvailability = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-routed") }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("blocked"), retryAt: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("unavailable"), reason: z.enum(["no-enabled-account", "authentication", "reset-unknown", "source-unavailable"]) }),
]);
const retryContract = defineRpcContract({
  "provider-retry.v1.availability": {
    input: z.object({ threadId: z.string().min(1), requestId: z.string().min(1) }),
    output: retryAvailability,
  },
});

// bb's reasoning levels as Claude Code's efforts (provider-claude-code `toSdkEffort`).
function sdkEffort(level: string | null | undefined) {
  switch (level) {
    case "ultracode": return "xhigh";
    case "none": return "low";
    case "ultra": return "max";
    case "low": case "medium": case "high": case "xhigh": case "max": return level;
    default: return undefined;
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    liminalDataDir: {
      type: "string",
      label: "Liminal Tools data folder",
      description: "Where Liminal Tools keeps its records (LIMINAL_TOOLS_STATE_ROOT). Accounts, labels, Connections switches and worker pins are read from here and never written.",
      default: "~/GitHub/liminal-tools/data",
    },
    routing: {
      type: "boolean",
      label: "Route Claude Code threads through Liminal accounts",
      description: "Off leaves every thread on this Mac's own Claude login; the Mana Bar keeps reporting.",
      default: true,
    },
  });

  // ── Liminal's records and each login's state ───────────────────────────────────────────────────────────────────
  let liminal: LiminalSnapshot = { accounts: [], codex: [], excluded: new Map(), pinned: undefined };
  const refreshLiminal = async () => { liminal = readLiminal((await settings.get()).liminalDataDir); return liminal; };
  const account = (id: string | undefined) => liminal.accounts.find(item => item.id === id);

  const identities = new Map<string, { at: number; value: Availability; plan: string | null }>();
  async function availability(item: LiminalAccount, refresh = false) {
    const known = identities.get(item.id);
    if (!refresh && known && Date.now() - known.at < IDENTITY_TTL_MS) return known.value;
    const { availability: value, plan } = await claudeAvailability(item.home);
    identities.set(item.id, { at: Date.now(), value, plan: plan ?? known?.plan ?? null });
    return value;
  }
  // accounts.mts `eligible`: listed, not switched off or blocked, and signed in.
  const excludedReason = (id: string) => liminal.excluded.get(id);
  const eligibleNow = (id: string) => Boolean(account(id)) && !excludedReason(id) && identities.get(id)?.value === "signed-in";
  async function eligible(id: string) {
    const item = account(id);
    if (!item || excludedReason(id)) return false;
    return await availability(item) === "signed-in";
  }

  // shared/provider-usage.mts: plan usage per login, read at most once a minute unless forced, concurrent reads coalesced,
  // and a failed read keeping the last windows marked stale.
  const snapshots = new Map<string, { at: number; value: ProviderUsage }>();
  const catalogs = new Map<string, ProviderModel[]>();
  const pending = new Map<string, { dirty: boolean; promise: Promise<ProviderUsage> | null }>();
  async function usage(item: LiminalAccount, refresh = false): Promise<ProviderUsage> {
    const active = pending.get(item.id);
    if (active) { if (refresh) active.dirty = true; return active.promise!; }
    const previous = snapshots.get(item.id);
    if (!refresh && previous && Date.now() - previous.at < 60_000) return previous.value;
    const record: { dirty: boolean; promise: Promise<ProviderUsage> | null } = { dirty: false, promise: null };
    record.promise = (async () => {
      let value: ProviderUsage;
      do {
        record.dirty = false;
        try {
          const read = await readClaude(item.home);
          catalogs.set(item.id, read.models);
          value = { provider: "claude", account: item.id, windows: read.windows, checkedAt: new Date().toISOString(),
            ...(read.windows.length ? {} : { error: "Plan usage is unavailable for this login." }) };
        } catch {
          const last = snapshots.get(item.id)?.value;
          value = { provider: "claude", account: item.id, windows: last?.windows || [], checkedAt: last?.checkedAt || null, stale: true, error: "Could not refresh plan usage." };
        }
        value.attemptedAt = new Date().toISOString();
        snapshots.set(item.id, { at: Date.now(), value });
      } while (record.dirty);
      bb.realtime.publish(MANA_CHANGED, { account: item.id });
      return value;
    })();
    pending.set(item.id, record);
    try { return await record.promise; } finally { pending.delete(item.id); }
  }

  // ── Threads ────────────────────────────────────────────────────────────────────────────────────────────────────
  const threadKey = (threadId: string) => `thread:${threadId}`;
  const readThread = (threadId: string) => bb.storage.kv.get<ThreadState>(threadKey(threadId));
  const writeThread = async (threadId: string, state: ThreadState) => {
    await bb.storage.kv.set(threadKey(threadId), state);
    bb.realtime.publish(MANA_CHANGED, { thread: threadId });
  };
  async function routedThreads() {
    const keys = await bb.storage.kv.list("thread:");
    const rows = await Promise.all(keys.map(async key => ({ threadId: key.slice("thread:".length), state: await bb.storage.kv.get<ThreadState>(key) })));
    return rows.filter((row): row is { threadId: string; state: ThreadState } => row.state != null);
  }

  // server.mts `preferred`: new work starts on the eligible account Liminal's ranking prefers, in its accounts' order,
  // honouring the worker pin; with none eligible, the first listed account.
  function preferred() {
    const choices = liminal.accounts.filter(item => eligibleNow(item.id));
    return preferredAccount(choices.map(item => ({ id: item.id, usage: snapshots.get(item.id)?.value })), liminal.pinned) || choices[0]?.id;
  }

  let primaryHostId: string | null | undefined;
  async function onPrimaryHost(hostId: string) {
    if (primaryHostId === undefined) {
      const config = await bb.sdk.system.config() as { primaryHostId?: string | null };
      primaryHostId = config.primaryHostId ?? null;
    }
    // Liminal's homes live on this Mac; a thread on another machine keeps that machine's own login.
    return primaryHostId === null || hostId === primaryHostId;
  }

  bb.providers.experimental_contributeEnv(PROVIDER, async ({ threadId, hostId }) => {
    if (!(await settings.get()).routing || !(await onPrimaryHost(hostId))) return [];
    await refreshLiminal();
    // Model listing serves no thread: list models with the account new work would start on, and keep no state.
    if (threadId === null) {
      const chosen = preferred();
      return chosen ? homeEntries(account(chosen)!) : [];
    }
    let state = await readThread(threadId);
    // A thread keeps its account while that account stays usable; one that was removed, switched off or signed out
    // is reassigned the way new work is.
    const usable = (id: string) => Boolean(account(id)) && !excludedReason(id) && identities.get(id)?.value !== "signed-out";
    if (!state || !usable(state.account)) {
      const chosen = preferred();
      if (!chosen) return [];
      if (state?.account && state.account !== chosen) bb.log.info(`Thread ${threadId} moved from ${account(state.account)?.label ?? state.account} to ${account(chosen)!.label}: its account is no longer usable.`);
      state = { exhaustedAccounts: {}, ...state, account: chosen };
      await writeThread(threadId, state);
    }
    return homeEntries(account(state.account)!);
  });
  function homeEntries(chosen: LiminalAccount) {
    const entries = [{ name: "CLAUDE_CONFIG_DIR", value: chosen.home, reason: `Liminal account ${chosen.label}` }];
    // An account's home replaces every inherited login variable (providerEnvironment).
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) if (process.env[name]) entries.push({ name, value: "", reason: `Liminal account ${chosen.label} supplies the login` });
    return entries;
  }
  bb.providers.experimental_contributeEnvHealth(PROVIDER, async ({ hostId }) => {
    if (!(await settings.get()).routing || !(await onPrimaryHost(hostId))) return null;
    await refreshLiminal();
    const ready = liminal.accounts.filter(item => eligibleNow(item.id));
    return ready.length ? { label: "Liminal accounts", statusMessage: ready.map(item => item.label).join(", ") } : null;
  });

  // ── Picking an account by hand ─────────────────────────────────────────────────────────────────────────────────
  // The composer's account picker and `bb liminal-pool switch`. A thread takes the account from its next turn and still
  // fails over from it like any other; Liminal's records are never touched.
  async function pickable(id: string) {
    const target = account(id);
    if (!target) throw new Error("That account is no longer in Liminal Tools.");
    if (!(await eligible(id))) throw new Error(`${target.label} can't take work: ${excludedReason(id) ?? "it is not signed in"}.`);
    return target;
  }
  async function assignThread(threadId: string, id: string) {
    const target = await pickable(id);
    const state = (await readThread(threadId)) ?? { account: target.id, exhaustedAccounts: {} };
    state.account = target.id;
    delete state.exhaustedAccounts[target.id];
    await writeThread(threadId, state);
    return target;
  }
  const readNext = () => bb.storage.kv.get<{ account: string }>(NEXT_THREAD);
  async function picker(threadId: string | null): Promise<Picker> {
    await refreshLiminal();
    const chosen = threadId === null ? (await readNext())?.account : (await readThread(threadId))?.account;
    return { account: chosen && account(chosen) ? chosen : null, automatic: preferred() ?? null };
  }
  async function choose(threadId: string | null, id: string | null): Promise<Picker> {
    await refreshLiminal();
    if (threadId !== null) {
      if (id === null) throw new Error("Pick an account for this thread.");
      await assignThread(threadId, id);
    } else if (id === null) {
      await bb.storage.kv.delete(NEXT_THREAD);
    } else {
      await pickable(id);
      await bb.storage.kv.set(NEXT_THREAD, { account: id });
    }
    bb.realtime.publish(MANA_CHANGED, {});
    return picker(threadId);
  }
  // The new-thread composer's pick goes to the Claude Code thread the user starts next: its first message, by a person,
  // before the provider launches. Never blocks a message.
  bb.experimental_hooks.on("message.dispatch", async ctx => {
    try {
      if (ctx.attempt !== "start-turn" || ctx.initiator !== "user" || ctx.senderThreadId !== null) return { action: "proceed" };
      if (ctx.requestedExecution.providerId !== PROVIDER || Date.now() - ctx.thread.createdAt > NEW_THREAD_MS) return { action: "proceed" };
      const next = await readNext();
      if (!next || (await readThread(ctx.thread.id))) return { action: "proceed" };
      if (!(await settings.get()).routing || (ctx.host && !(await onPrimaryHost(ctx.host.id)))) return { action: "proceed" };
      await bb.storage.kv.delete(NEXT_THREAD);
      await refreshLiminal();
      const target = await assignThread(ctx.thread.id, next.account);
      bb.log.info(`Thread ${ctx.thread.id} starts on ${target.label}, picked in the composer.`);
    } catch (error) {
      bb.log.warn(`The composer's account pick was not applied: ${(error as Error).message}`);
    }
    return { action: "proceed" };
  });

  // server.mts `chooseFallback` for Claude: mark the source account exhausted until its own reset, then the first
  // account in Liminal's order that is eligible, not blocked by its own marker, and verified fresh to have room for this
  // exact model and effort.
  async function chooseFallback(state: ThreadState, session: Configuration) {
    const source = account(state.account);
    const blocked = state.exhaustedAccounts ||= {};
    const sourceUsage = source ? await usage(source, true).catch(() => snapshots.get(source.id)?.value) : undefined;
    if (!blocked[state.account] || Date.parse(blocked[state.account]!.resetsAt || "") <= Date.now()) {
      const exhaustedAt = new Date().toISOString();
      blocked[state.account] = { exhaustedAt, resetsAt: fallbackReset(session, sourceUsage, exhaustedAt) };
    }
    for (const candidate of liminal.accounts) {
      if (candidate.id === state.account || !(await eligible(candidate.id))) continue;
      const snapshot = await usage(candidate, true).catch(() => undefined);
      if (!snapshot || fallbackBlocked(session, blocked[candidate.id], snapshot, Date.now())) continue;
      if (!fallbackAvailability(session, snapshot, catalogs.get(candidate.id), Date.now())) continue;
      delete blocked[candidate.id];
      return candidate.id;
    }
    return null;
  }

  // claude.mts: a usage limit (rejected allowance) fails over; any other rate limit is a transient interruption.
  const rateLimited = (event: PluginTurnFailedEvent) => event.errorInfo?.category === "rate-limit" || event.errorInfo?.httpStatusCode === 429;
  const usageLimited = (event: PluginTurnFailedEvent) => event.rateLimits?.status === "blocked" || Boolean(event.rateLimits?.windows.some(window => window.status === "blocked"));

  async function continueTurn(threadId: string, event: PluginTurnFailedEvent, prompt: string, sendAt: number | undefined, reason: string) {
    // Accepted input is already in the conversation: continue it with Liminal's own continuation. Input the provider
    // never took runs again as it was.
    if (event.inputAccepted) {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: prompt, mentions: [] }], ...(sendAt ? { sendAt } : {}) });
    } else {
      await bb.sdk.threads.retry({ threadId, turnRequestId: event.requestId, ...(sendAt ? { sendAt } : {}), reason });
    }
  }

  bb.events.on("turn.failed", async event => {
    const state = await readThread(event.threadId);
    if (!state || !rateLimited(event)) return;
    await refreshLiminal();
    const source = account(state.account);
    const label = source?.label ?? state.account;
    if (source) void usage(source, true).catch(() => undefined);
    try {
      if (!usageLimited(event)) {
        // sessions-messages.mts `continueAfterFailure`: RATE_LIMIT resumes after 30s, 2m, then 10m.
        const resumes = state.autoResume ||= { count: 0 };
        if (resumes.requestId === event.requestId && resumes.at) return;
        const delay = RESUME_DELAYS[resumes.count];
        if (delay === undefined) { bb.log.warn(`${label} stayed rate limited for thread ${event.threadId}; leaving it for triage.`); return; }
        resumes.count++;
        resumes.requestId = event.requestId;
        resumes.at = new Date(Date.now() + delay).toISOString();
        await writeThread(event.threadId, state);
        await continueTurn(event.threadId, event, resumePrompt({ allowance: false, count: resumes.count, stopped: `${label} was rate limited` }), Date.now() + delay, `Liminal: ${label} rate limited`);
        return;
      }
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: event.threadId });
      const session: Configuration = { provider: "claude", model: options?.model ?? undefined, effort: sdkEffort(options?.reasoningLevel) };
      // handoff.mts: Sonnet's thinking is bound to its account, and bb cannot open a fresh native session inside the
      // thread, so a Sonnet thread waits for its own allowance instead of moving.
      const target = claudeAccountBoundModel(session.model) ? null : await chooseFallback(state, session);
      if (target) {
        state.account = target;
        delete state.waiting;
        delete state.autoResume;
        await writeThread(event.threadId, state);
        bb.log.info(`Thread ${event.threadId} moved from ${label} to ${account(target)!.label}: ${label} reached its usage limit.`);
        await continueTurn(event.threadId, event, fallbackPrompt, undefined, `Liminal: moved to ${account(target)!.label}`);
        return;
      }
      // sessions-messages.mts `awaitAllowance`: resume a minute after the soonest any account regains allowance.
      if (!state.exhaustedAccounts[state.account]) state.exhaustedAccounts[state.account] = { exhaustedAt: new Date().toISOString(), resetsAt: null };
      const reset = allowanceReturns(session, liminal.accounts.map(item => ({ marker: state.exhaustedAccounts[item.id], snapshot: snapshots.get(item.id)?.value })));
      if (!reset) {
        delete state.waiting;
        await writeThread(event.threadId, state);
        bb.log.warn(`No Liminal account has verified allowance for thread ${event.threadId}, and none reports a reset; continue it once usage returns.`);
        return;
      }
      const at = Date.parse(reset) + ALLOWANCE_MARGIN_MS;
      state.waiting = new Date(at).toISOString();
      state.autoResume = { count: 0, allowance: true, requestId: event.requestId, at: state.waiting };
      await writeThread(event.threadId, state);
      await continueTurn(event.threadId, event, resumePrompt({ allowance: true, count: 0, stopped: `${label} reached its usage limit` }), at, "Liminal: allowance returns");
    } catch (error) {
      bb.log.error(`Liminal failover for thread ${event.threadId} failed: ${String(error)}`);
    }
  });
  // A completed turn ends an interruption's resume count.
  bb.events.on("thread.idle", async ({ thread }) => {
    const state = await readThread(thread.id);
    if (state?.autoResume || state?.waiting) { delete state.autoResume; delete state.waiting; await writeThread(thread.id, state); }
  });
  bb.events.on("thread.deleted", async ({ thread }) => { await bb.storage.kv.delete(threadKey(thread.id)); });

  // Liminal owns rate-limit retries for the threads it routes; Provider Retry still handles overloads.
  bb.rpc.register(retryContract, {
    "provider-retry.v1.availability": async ({ threadId }) =>
      (await readThread(threadId)) ? { kind: "unavailable" as const, reason: "no-enabled-account" as const } : { kind: "not-routed" as const },
  });

  // ── The Mana Bar ───────────────────────────────────────────────────────────────────────────────────────────────
  async function conflict() {
    try {
      const listed = await bb.sdk.plugins.list() as unknown;
      const plugins = (Array.isArray(listed) ? listed : (listed as { plugins?: unknown[] }).plugins ?? []) as { id: string; enabled?: boolean }[];
      return plugins.some(item => item.id === "account-pool" && item.enabled === true)
        ? "bb's built-in Account Pooler is enabled; its proxy overrides Liminal accounts. Disable it with `bb plugin disable account-pool`."
        : null;
    } catch { return null; }
  }
  // Codex logins are shown, never routed: bb's Codex provider runs every thread on this Mac's own ~/.codex login.
  const codexReads = new Map<string, { at: number; signedIn: boolean | null; email: string | null; plan: string | null; value: ProviderUsage }>();
  const codexPending = new Map<string, Promise<void>>();
  function readCodexAccount(item: LiminalCodexAccount) {
    const active = codexPending.get(item.id);
    if (active) return active;
    const promise = (async () => {
      const last = codexReads.get(item.id);
      try {
        const read = await readCodex(item.home);
        codexReads.set(item.id, { at: Date.now(), signedIn: read.signedIn, email: read.email, plan: read.plan,
          value: { provider: "codex", account: item.id, windows: read.windows, checkedAt: new Date().toISOString(),
            ...(read.signedIn && !read.windows.length ? { error: "Plan usage is unavailable for this login." } : {}) } });
      } catch {
        codexReads.set(item.id, { at: Date.now(), signedIn: last?.signedIn ?? null, email: last?.email ?? null, plan: last?.plan ?? null,
          value: { provider: "codex", account: item.id, windows: last?.value.windows || [], checkedAt: last?.value.checkedAt || null, stale: true, error: "Could not refresh plan usage." } });
      }
      bb.realtime.publish(MANA_CHANGED, { account: item.id });
    })();
    codexPending.set(item.id, promise);
    return promise.finally(() => codexPending.delete(item.id));
  }
  // accounts.mts `fold`: this Mac's own login signed in as an added account is that account, so it isn't listed twice.
  function codexFolded(item: LiminalCodexAccount) {
    const main = codexReads.get(item.id);
    if (!item.main || !main?.email) return false;
    return liminal.codex.some(other => !other.main && codexReads.get(other.id)?.email === main.email && codexReads.get(other.id)?.plan === main.plan);
  }

  // The bb Account Pooler's slot labels (5H, 7D, FABLE), showing what is left.
  function slotLabel(window: UsageWindow) {
    if (window.scope && !window.shared) return window.scope.toUpperCase();
    const minutes = window.durationMinutes;
    return minutes === undefined ? "LIMIT" : minutes % 1440 === 0 ? `${minutes / 1440}D` : minutes % 60 === 0 ? `${minutes / 60}H` : `${minutes}M`;
  }
  function manaRow(provider: "claude" | "codex", item: { id: string; label: string }, value: ProviderUsage | undefined, identity: Availability, plan: string | null, threads: number, note: string | null, now: number): ManaRow {
    const shown = manaWeek(value, now), reason = excludedReason(item.id) ?? null;
    const weekly = tightest(value?.windows, 10080), session = tightest(value?.windows, 300);
    const spentWindow = [weekly, session].filter((window): window is NonNullable<typeof window> => Boolean(window) && window!.remaining <= 0)
      .sort((a, b) => Date.parse(b.resetsAt || "") - Date.parse(a.resetsAt || ""))[0];
    const status = reason ? "excluded" : identity === "signed-out" ? "signed-out" : identity !== "signed-in" ? "checking" : spentWindow ? "exhausted" : "ready";
    const statusLabel = {
      excluded: reason ?? "Switched off",
      "signed-out": "Signed out · sign in again in Liminal",
      checking: "Checking…",
      exhausted: `Exhausted${spentWindow?.resetsAt ? ` · resets in ${resetIn(spentWindow, now)}` : ""}`,
      ready: "Ready",
    }[status];
    const slots = (value?.windows || []).filter(window => window.shared || window.scope)
      .sort((a, b) => Number(Boolean(a.scope) && !a.shared) - Number(Boolean(b.scope) && !b.shared) || (a.durationMinutes ?? 0) - (b.durationMinutes ?? 0))
      .map(window => ({ key: window.bucket ?? window.name, label: slotLabel(window), left: Math.round(window.remaining) }));
    return {
      provider, id: item.id, label: item.label, plan, status, statusLabel, reason, note,
      slots: slots.length ? slots : [{ key: "week", label: "7D", left: null }],
      threads, pinned: provider === "claude" && liminal.pinned === item.id,
      left: shown?.left ?? null, pace: shown?.pace ?? null, countdown: shown?.countdown ?? "",
      stale: usageStale(value, now),
      windows: (value?.windows || []).map(window => ({ label: usageShortLabel(window), left: Math.round(window.remaining), resets: window.resetsAt ? resetIn(window, now) : "" })),
      checkedAt: value?.checkedAt ?? null,
    };
  }
  async function mana(): Promise<Mana> {
    await refreshLiminal();
    const now = Date.now(), threads = await routedThreads();
    const claudeRows = liminal.accounts.map(item => {
      const identity = identities.get(item.id);
      return manaRow("claude", item, snapshots.get(item.id)?.value, identity?.value ?? "unknown", identity?.plan ?? null,
        threads.filter(row => row.state.account === item.id).length, null, now);
    });
    const codexRows = liminal.codex.filter(item => !codexFolded(item)).map(item => {
      const read = codexReads.get(item.id);
      return manaRow("codex", item, read?.value, read?.signedIn === true ? "signed-in" : read?.signedIn === false ? "signed-out" : "unknown", read?.plan ?? null,
        0, item.main ? "This Mac's login · bb's Codex threads use it" : null, now);
    });
    return { rows: [...claudeRows, ...codexRows], error: liminal.error ?? null, routing: (await settings.get()).routing, conflict: await conflict() };
  }
  async function refreshAll(force: boolean) {
    await refreshLiminal();
    const running = new Set((await bb.sdk.threads.listRunning()).map(row => row.id));
    const active = new Set((await routedThreads()).filter(row => running.has(row.threadId)).map(row => row.state.account));
    await Promise.all([
      ...liminal.accounts.filter(item => !excludedReason(item.id)).map(async item => {
        if (await availability(item, force) !== "signed-in") return;
        const age = Date.now() - (snapshots.get(item.id)?.at ?? 0);
        // ai.mts `usageRefreshInterval`: logins in use refresh each minute, idle logins every fifteen.
        if (force || age >= usageRefreshInterval(!active.has(item.id))) await usage(item, force).catch(() => undefined);
      }),
      // No bb thread is routed to a Codex login here, so each is read at the resting interval.
      ...liminal.codex.filter(item => !excludedReason(item.id)).map(async item => {
        const age = Date.now() - (codexReads.get(item.id)?.at ?? 0);
        if (force || age >= usageRefreshInterval(true)) await readCodexAccount(item);
      }),
    ]);
    bb.realtime.publish(MANA_CHANGED, {});
  }
  bb.rpc.register(rpcContract, {
    mana: () => mana(),
    refresh: async () => { await refreshAll(true); return mana(); },
    picker: ({ threadId }) => picker(threadId),
    choose: ({ threadId, account: id }) => choose(threadId, id),
  });
  bb.background.service("usage", {
    async start(signal) {
      while (!signal.aborted) {
        await refreshAll(false).catch(error => bb.log.warn(`Usage refresh failed: ${String(error)}`));
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 60_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  // ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const bar = (left: number | null, pace: number | null) => {
    if (left === null) return "·".repeat(20);
    const cells: string[] = Array.from({ length: 20 }, (_, index) => (index < Math.round(left / 5) ? "█" : "░"));
    if (pace !== null) cells[Math.min(19, Math.round(pace / 5))] = "│";
    return cells.join("");
  };
  function renderMana(value: Mana) {
    const width = Math.max(5, ...value.rows.map(row => row.label.length));
    const lines = value.rows.map(row => {
      const head = `${row.label.padEnd(width)}  ${bar(row.left, row.pace)}  ${row.left === null ? "  —" : `${String(row.left).padStart(3)}%`}  ${row.countdown.padStart(6)}`;
      const notes = [row.provider === "codex" ? "Codex" : "", row.plan ?? "", row.pinned ? "pinned" : "", row.status === "exhausted" ? row.statusLabel : "", row.note ?? "", row.threads ? `${row.threads} thread${row.threads === 1 ? "" : "s"}` : "", row.stale ? "stale" : "", row.reason ?? ""].filter(Boolean);
      const windows = row.windows.map(window => `${window.label} ${window.left}% left${window.resets ? ` · ${window.resets}` : ""}`).join("   ");
      return `${head}${notes.length ? `  (${notes.join(", ")})` : ""}${windows ? `\n${" ".repeat(width + 2)}${windows}` : ""}`;
    });
    return [
      ...(value.error ? [value.error] : []),
      ...(value.conflict ? [`Warning: ${value.conflict}`] : []),
      ...(value.routing ? [] : ["Routing is off; threads use this Mac's own Claude login."]),
      lines.length ? lines.join("\n") : "No Claude accounts in Liminal Tools.",
    ].join("\n");
  }
  bb.cli.register({
    name: "liminal-pool",
    summary: "Liminal Tools' Claude accounts in bb: Mana Bar, thread accounts and failover",
    commands: [
      { name: "status", summary: "Mana Bar: weekly allowance left per Liminal account, counting down to each reset", usage: "bb liminal-pool status [--refresh] [--json]" },
      { name: "thread", summary: "Which Liminal account a thread runs on, and its exhaustion markers", usage: "bb liminal-pool thread [<thread-id>] [--json]" },
      { name: "switch", summary: "Move a thread to a named Liminal account from its next turn", usage: "bb liminal-pool switch <label-or-id> [--thread <thread-id>]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter(arg => arg !== "--json");
      const [command, ...rest] = args;
      const out = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text });
      try {
        if (command === undefined || command === "status") {
          if (rest.includes("--refresh")) await refreshAll(true);
          const value = await mana();
          return out(value, renderMana(value));
        }
        if (command === "thread") {
          const threadId = rest[0] ?? ctx.threadId;
          if (!threadId) return { exitCode: 1, stderr: "Name a thread: bb liminal-pool thread <thread-id>" };
          await refreshLiminal();
          const state = await readThread(threadId);
          if (!state) return out({ threadId, routed: false }, `Thread ${threadId} has not run on a Liminal account yet.`);
          const markers = Object.entries(state.exhaustedAccounts).map(([id, marker]) => `  ${account(id)?.label ?? id} exhausted ${marker.exhaustedAt}${marker.resetsAt ? `, resets ${marker.resetsAt}` : ""}`);
          return out({ threadId, routed: true, ...state, label: account(state.account)?.label ?? null },
            [`Thread ${threadId} runs on ${account(state.account)?.label ?? state.account}.`, ...(state.waiting ? [`Waiting for allowance until ${state.waiting}.`] : []), ...markers].join("\n"));
        }
        if (command === "switch") {
          const name = rest.find(arg => !arg.startsWith("--") && rest[rest.indexOf(arg) - 1] !== "--thread");
          const flag = rest.indexOf("--thread");
          const threadId = flag >= 0 ? rest[flag + 1] : ctx.threadId;
          if (!name || !threadId) return { exitCode: 1, stderr: "Usage: bb liminal-pool switch <label-or-id> [--thread <thread-id>]" };
          await refreshLiminal();
          const target = await assignThread(threadId, namedAccount(liminal.accounts, name).id);
          return out({ threadId, account: target.id, label: target.label }, `Thread ${threadId} runs on ${target.label} from its next turn.`);
        }
        return { exitCode: 1, stderr: `Unknown command "${command}". Try: bb liminal-pool status | thread | switch` };
      } catch (error) {
        return { exitCode: 1, stderr: (error as Error).message };
      }
    },
  });
}
