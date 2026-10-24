// Liminal Tools' account policy, ported verbatim in behaviour so bb threads pick, keep and fail over between Claude
// accounts exactly as Liminal's conversations do. Each function names its Liminal source; keep them in step.
// Pure: no I/O, so the tests in policy.test.ts pin the behaviour.

// app/sdk/ai.mts
export interface UsageWindow {
  name: string; remaining: number; resetsAt?: string | null; scope?: string; bucket?: string;
  shared?: boolean; durationMinutes?: number;
}
export interface ProviderUsage {
  provider: string; account?: string; windows: UsageWindow[]; checkedAt?: string | null;
  refreshIntervalMs?: number; attemptedAt?: string | null; stale?: boolean; error?: string;
}
export interface ProviderModel { id: string; resolvedModel?: string; efforts?: string[] }
export interface Configuration { provider: string; model?: string | undefined; effort?: string | undefined }
export interface ExhaustionMarker { exhaustedAt: string; resetsAt?: string | null }

// Plan allowance. Idle logins get a reset check every fifteen minutes; active logins refresh each minute.
export const usageRefreshInterval = (resting = false) => resting ? 15 * 60_000 : 60_000;

const duration = (minutes?: number) => minutes === 300 ? '5-hour' : minutes === 10080 ? 'Weekly' : `${minutes}-minute`;
// One window of a provider's allowance from the percentage used. `shared` marks the account-wide bucket; other buckets
// limit particular models. A reading without a number is no window.
export const usageWindow = (bucket: string, scope: string, minutes: number | undefined, used: number | null | undefined, resetsAt: string | null | undefined, shared: boolean): UsageWindow[] =>
  typeof used === 'number' && Number.isFinite(used) ? [{ bucket, scope, shared, ...(minutes === undefined ? {} : { durationMinutes: minutes }), name: `${duration(minutes)}${scope ? ` (${scope})` : ''}`,
    remaining: Math.max(0, Math.min(100, 100 - used)), resetsAt: resetsAt && Number.isFinite(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null }] : [];

// An exact catalog id wins; Claude's context suffix and resolved alias also locate its catalog entry.
export function catalogModel<T extends { id: string; resolvedModel?: string }>(models: T[], id: string | undefined) {
  if (!id) return undefined;
  const base = (value: string) => value.replace(/\[1m\]$/, '');
  return models.find(item => item.id === id) || models.find(item => base(item.id) === base(id))
    || models.find(item => item.resolvedModel === id) || models.find(item => item.resolvedModel && base(item.resolvedModel) === base(id));
}

// plugins/development/ai/connectors/claude/provider.mts: the plan windows Claude reports — five-hour and weekly, and
// weekly limits on particular models.
type ClaudeUsage = { rate_limits_available?: boolean; rate_limits?: { model_scoped?: { display_name: string; utilization?: number | null; resets_at?: string | null }[] | null } & Record<string, unknown> | null };
export function claudeWindows(raw: unknown) {
  const data = (raw ?? {}) as ClaudeUsage;
  if (!data.rate_limits_available) return [];
  const limits = data.rate_limits || {};
  const found = [
    ...Object.entries(limits).filter(([key]) => key === 'five_hour' || key === 'seven_day' || key.startsWith('seven_day_'))
      .flatMap(([key, value]) => { const limit = value as { utilization?: number | null; resets_at?: string | null } | undefined; return usageWindow(key, key.startsWith('seven_day_') ? key.slice(10).replaceAll('_', ' ') : '', key === 'five_hour' ? 300 : 10080, limit?.utilization, limit?.resets_at, !key.startsWith('seven_day_')); }),
    ...(limits.model_scoped || []).filter(item => item.display_name).flatMap(item => usageWindow(`seven_day_${item.display_name.toLowerCase()}`, item.display_name, 10080, item.utilization, item.resets_at, false)),
  ];
  return [...new Map(found.map(item => [item.bucket, item])).values()];
}

// plugins/development/assistant/apps/assistant/allowance-window.mts
// Claude leaves a window's reset empty until its full allowance is first used; an untouched window waits in reserve.
export const allowanceReset = (window?: Pick<UsageWindow, 'resetsAt'>) => {
  const reset = Date.parse(window?.resetsAt || '');
  return Number.isFinite(reset) ? reset : Infinity;
};
export function hasAllowanceRoom(window: Pick<UsageWindow, 'remaining' | 'resetsAt'>, now: number, reserve = 0, policy: 'routing' | 'fallback' = 'routing') {
  const reset = allowanceReset(window);
  return Number.isFinite(window.remaining) && window.remaining > reserve
    && (window.remaining === 100 && (policy === 'routing' || !window.resetsAt) || Number.isFinite(reset) && reset > now);
}

// plugins/development/assistant/apps/assistant/account-preference.mts
// Paid credits are Codex-only (credit-policy.mts), so for Claude `usableCredits` is always false and drops out.
type AllowanceUsage = { windows: Omit<UsageWindow, 'name'>[] };
export const tightest = (windows: Omit<UsageWindow, 'name'>[] | undefined, minutes: number) => (windows || []).filter(item => item.shared && item.durationMinutes === minutes && Number.isFinite(item.remaining))
  .reduce<Omit<UsageWindow, 'name'> | undefined>((lowest, item) => !lowest || item.remaining < lowest.remaining ? item : lowest, undefined);
// Whether a login's weekly allowance is known to be spent, so work started there would stall.
export const spent = (usage?: ProviderUsage | null) => (tightest(usage?.windows, 10080)?.remaining ?? 100) <= 3;
// Unspent weekly allowance is lost at reset, so new conversations start on the account whose shared weekly window
// resets soonest, however little is left; a login with none comes last, soonest to recover first. Candidates are in
// catalog order, which breaks ties and decides when usage is unknown. A pin holds until its login is known to be at zero.
export function preferredAccount(candidates: { id: string; usage?: ProviderUsage | AllowanceUsage | null | undefined }[], pinned?: string) {
  const rank = (usage?: ProviderUsage | AllowanceUsage | null): [number, number] => {
    const weekly = tightest(usage?.windows, 10080), session = tightest(usage?.windows, 300);
    if (!weekly) return [2, 0];
    const exhausted = weekly.remaining <= 0, stalled = Boolean(session) && session!.remaining <= 0;
    if (exhausted || stalled) return [3, Math.max(exhausted ? allowanceReset(weekly) : 0, stalled ? allowanceReset(session) : 0)];
    return [0, allowanceReset(weekly)];
  };
  const preferred = candidates.find(item => item.id === pinned);
  if (preferred && rank(preferred.usage)[0] !== 3) return preferred.id;
  return candidates.map((item, index) => ({ id: item.id, index, key: rank(item.usage) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)[0]?.id;
}

// plugins/development/assistant/apps/assistant/account-fallback.mts
// A quota error is evidence about the source account, never evidence that another login can run this exact
// configuration. Unknown windows/catalogs do not qualify.
export function freshSnapshot(session: Configuration, snapshot: ProviderUsage | null | undefined, now: number): snapshot is ProviderUsage {
  return !(!snapshot || snapshot.stale || snapshot.error || snapshot.provider !== session.provider || !snapshot.checkedAt
    || !Number.isFinite(Date.parse(snapshot.checkedAt!)) || now - Date.parse(snapshot.checkedAt!) > 90_000 || Date.parse(snapshot.checkedAt!) > now + 5000);
}
export function relevantWindows(session: Configuration, snapshot: ProviderUsage) {
  const family = (value: unknown) => String(value).toLowerCase().match(/fable|opus|sonnet|haiku|gpt[- ]?[\d.]+/)?.[0]?.replaceAll(' ', '-');
  const chosen = family(session.model);
  return (snapshot.windows || []).filter(item => item.shared || !family(item.scope) || family(item.scope) === chosen);
}
export function fallbackAvailability(session: Configuration, snapshot: ProviderUsage | null | undefined, models: ProviderModel[] | undefined, now = Date.now()) {
  if (!freshSnapshot(session, snapshot, now)) return false;
  // An empty model is the provider's own default, which every signed-in plan can run.
  const model = catalogModel(models || [], session.model);
  if (session.model && (!model || session.effort && !model.efforts?.includes(session.effort))) return false;
  const windows = snapshot.windows || [], shared = windows.filter(item => item.shared);
  if (!shared.length || session.provider === 'claude' && ![300, 10080].every(minutes => shared.some(item => item.durationMinutes === minutes))) return false;
  return relevantWindows(session, snapshot).every(item => hasAllowanceRoom(item, now, 0, 'fallback'));
}

export const fallbackPrompt = 'The previous execution stopped because its account allowance was exhausted. Authentication has changed; provider, model, effort, native context, and workspace are unchanged. Continue the pending task from existing findings and completed work. Do not replay the original task or repeat uncertain external effects; inspect their outcome first. The conversation usage guard remains active.';

// A lagging balance must not strand an exhausted account forever. Remember a real upcoming reset, but require a new
// positive snapshot after that boundary.
export function fallbackReset(session: Configuration, snapshot: ProviderUsage | null | undefined, exhaustedAt: string, now = Date.now()) {
  if (!freshSnapshot(session, snapshot, now)) return null;
  const windows = relevantWindows(session, snapshot);
  const empty = windows.filter(item => Number.isFinite(item.remaining) && item.remaining <= 0);
  const relevant = empty.length ? empty : windows;
  const resets = relevant.map(item => Date.parse(item.resetsAt!));
  const exhausted = Date.parse(exhaustedAt);
  if (!Number.isFinite(exhausted) || !resets.length || resets.some(reset => !Number.isFinite(reset) || reset < exhausted || reset <= now)) return null;
  return new Date(empty.length ? Math.max(...resets) : Math.min(...resets)).toISOString();
}
// When a usage-limited conversation can next run: the soonest any account of its provider regains allowance, from that
// account's exhaustion marker or the resets of its spent windows. Unknown when no account reports a reset to come.
export function allowanceReturns(session: Configuration, accounts: { marker?: { resetsAt?: string | null } | undefined; snapshot?: ProviderUsage | null | undefined }[], now = Date.now()) {
  const returns = accounts.flatMap(({ marker, snapshot }) => {
    const spentWindows = snapshot?.provider === session.provider ? relevantWindows(session, snapshot).filter(item => Number.isFinite(item.remaining) && item.remaining <= 0) : [];
    const known = [Date.parse(marker?.resetsAt || ''), spentWindows.length ? Math.max(...spentWindows.map(item => Date.parse(item.resetsAt!))) : NaN].filter(reset => reset > now);
    return known.slice(0, 1);
  });
  return returns.length ? new Date(Math.min(...returns)).toISOString() : undefined;
}
export function fallbackBlocked(session: Configuration, marker: ExhaustionMarker | undefined, snapshot: ProviderUsage | null | undefined, now = Date.now()) {
  if (!marker) return false;
  if (!marker.resetsAt) marker.resetsAt = fallbackReset(session, snapshot, marker.exhaustedAt, now);
  const reset = Date.parse(marker.resetsAt!);
  return !Number.isFinite(reset) || reset > now || !freshSnapshot(session, snapshot, now) || Date.parse(snapshot.checkedAt!) < reset;
}

// plugins/development/assistant/apps/assistant/handoff.mts: Sonnet keeps thinking bound to the account that produced it,
// so its native history cannot move to another account.
export const claudeAccountBoundModel = (model?: string | null) => /^(?:claude-)?sonnet(?:-5[.-]5(?:-|\[|$)|\[|$)/i.test(model || '');

// plugins/development/assistant/apps/assistant/sessions-messages.mts
export const RESUME_DELAYS = [30_000, 2 * 60_000, 10 * 60_000];
// A usage-limited resume waits a minute past the reset, so the provider has rolled its window over.
export const ALLOWANCE_MARGIN_MS = 60_000;
export function resumePrompt({ allowance, count, stopped }: { allowance: boolean; count: number; stopped: string }) {
  const text = stopped.trim();
  return `The dashboard resumed this conversation automatically (${allowance ? 'allowance has returned' : `attempt ${count} of ${RESUME_DELAYS.length}`}). Its last turn stopped: ${text}${/[.!?]$/.test(text) ? '' : '.'} That was an interruption, not a decision to revisit. Check what the stopped turn already did in your workspace, then continue the task from there.`;
}

// app/sdk/usage-format.mts: time until reset in days and hours, such as 3d20h; minutes only in the final hour.
export function resetIn(item: Pick<UsageWindow, 'resetsAt'>, now = Date.now()) {
  const left = Date.parse(item.resetsAt!) - now, hours = Math.ceil(left / 3600000);
  return !Number.isFinite(left) ? '' : hours <= 1 ? `${Math.max(0, Math.ceil(left / 60000))}m` : `${hours >= 24 ? `${Math.floor(hours / 24)}d` : ''}${hours % 24}h`;
}
export const usageStale = (value: ProviderUsage | undefined, now = Date.now()) => Boolean(value && (value.stale || value.error || !Number.isFinite(Date.parse(value.checkedAt!)) || now - Date.parse(value.checkedAt!) > 2 * (value.refreshIntervalMs || usageRefreshInterval())));
// Each window is named in a word: the model scope when a week is model-specific, otherwise Week or Session.
export function usageShortLabel(item: UsageWindow) {
  if (/5.hour/i.test(item.name)) return 'Session';
  if (/week/i.test(item.name)) return item.scope ? item.scope.charAt(0).toUpperCase() + item.scope.slice(1) : 'Week';
  return item.name;
}

// plugins/development/allowance/apps/allowance/widget/Mana.svelte: the shared weekly window that binds the account
// (the lowest when a provider reports more than one), its allowance left, an even-pace tick and the reset countdown.
const WEEK = 7 * 24 * 60;
export function manaWeek(value: ProviderUsage | undefined, now = Date.now()) {
  const item = (value?.windows || []).filter(window => window.shared && window.durationMinutes === WEEK && Number.isFinite(window.remaining))
    .sort((a, b) => a.remaining - b.remaining)[0];
  if (!item) return undefined;
  const left = Math.round(Math.max(0, Math.min(100, item.remaining))), reset = Date.parse(item.resetsAt!);
  // Where the fill would sit if the week were spent evenly: the share of the window still to run, left out at either end where it says nothing.
  const pace = Math.round((reset - now) / (WEEK * 600));
  return { left, pace: pace > 1 && pace < 99 ? pace : undefined, countdown: Number.isFinite(reset) ? resetIn(item, now) : '' };
}
