// The Mana Bar, laid out as Liminal Tools' card (plugins/development/allowance/.../Mana.svelte) and painted in bb's
// theme: one row per account that can take work — provider icon, label, a bar of the weekly allowance LEFT, the
// percentage, and the countdown to the weekly reset, as the OpenCode Mana Bar draws it: blue bars, a thin light-blue
// 5-hour band above the week where the account has one, and a countdown that warms under 48h and reddens under 24h.
// Hovering a row lists every window. Shown in the sidebar footer and on the plugin's settings page.
import { cloneElement, useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, experimental_ProviderIcon as ProviderIcon, experimental_useProviders, useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Mana, ManaRow, Picker, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const HOUR = 3_600_000;
const RED = "#e5484d", YELLOW = "#e0ae1c", BLUE = "#60a5fa";

const leftHue = (left: number | null) => left === null ? null : left <= 5 ? RED : left <= 15 ? YELLOW : null;
const resetHue = (resetsAt: string | null) => {
  const left = resetsAt ? Date.parse(resetsAt) - Date.now() : Infinity;
  return left < 24 * HOUR ? RED : left < 48 * HOUR ? YELLOW : null;
};
const tint = (hue: string | null, base: string) => hue ? { color: `color-mix(in srgb, ${hue} 78%, ${base})` } : undefined;
const resetTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const PROVIDER_IDS = { claude: "claude-code", codex: "codex", antigravity: "acp-antigravity-acp", grok: "acp-grok", opencode: "acp-opencode" } as const;
const NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", grok: "Grok", opencode: "OpenCode" } as const;

function useMana() {
  const rpc = useRpc<typeof rpcContract>();
  const [mana, setMana] = useState<Mana | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("mana", null).then(value => { setMana(value); setError(null); }, cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);
  // Once a minute while visible, at once when the page comes back, and whenever the server reports a new reading.
  useEffect(() => {
    load();
    const poll = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  useRealtime("mana-changed", () => load());
  return { mana, error };
}

function Tip({ row, icon }: { row: ManaRow; icon: ReactNode }) {
  const label = (text: string) => <span style={{ color: BLUE }}>{text}: </span>;
  return (
    <>
      <div className="flex items-center gap-1.5 text-foreground">
        {icon}
        {[row.label, NAMES[row.provider]].filter((part, index, all) => all.indexOf(part) === index).join(" · ")}
      </div>
      {row.windows.map(window => (
        <div key={window.name}>
          {label(window.name)}
          <span style={tint(leftHue(window.left), "var(--popover-foreground)")}>{window.left}% left</span>
          {window.resetsAt && row.provider === "opencode" && (window.label === "Week" || window.label === "Monthly") ? (
            <time dateTime={window.resetsAt} className="text-subtle-foreground" style={tint(resetHue(window.resetsAt), "var(--subtle-foreground)")}> · resets {resetTime.format(new Date(window.resetsAt))}</time>
          ) : window.resets ? <span className="text-subtle-foreground" style={tint(resetHue(window.resetsAt), "var(--subtle-foreground)")}> · resets in {window.resets}</span> : null}
        </div>
      ))}
      {row.queued ? (
        <div>{label("Resets queued")}{row.queued.available}{row.queued.nextExpires ? ` · next expires in ${row.queued.nextExpires}` : ""}</div>
      ) : null}
      {row.error ? <div>{label("Last refresh failed")}{row.error}</div> : null}
    </>
  );
}

function HoverTip({ content, children }: { content: ReactNode; children: ReactElement<HTMLAttributes<HTMLElement>> }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = (event: React.MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAt({ left: box.right + 12, top: box.top + box.height / 2 }), 150);
  };
  const hide = () => { clearTimeout(timer.current); setAt(null); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      {cloneElement(children, { onMouseEnter: show, onMouseLeave: hide })}
      {at ? createPortal(
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-80 -translate-y-1/2 whitespace-pre-line rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs leading-[1.5] text-popover-foreground shadow-md"
          style={at}
        >
          {content}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function OpenCodeMeters({ row, monthlyLeft }: { row: ManaRow; monthlyLeft: number | null }) {
  const limits = [
    { label: "5-hour", left: row.session, height: 1, color: "#93c5fd" },
    { label: "monthly", left: monthlyLeft, height: 6, color: leftHue(monthlyLeft) ?? "#3b82f6" },
    { label: "weekly", left: row.left, height: 2, color: leftHue(row.left) ?? "#60a5fa" },
  ];
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {limits.map(({ label, left, height, color }) => (
        <span key={label} role="meter" aria-label={`OpenCode ${label} allowance left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left ?? undefined}
          className="relative overflow-hidden rounded-full bg-muted" style={{ height }}>
          {left != null ? <i className="absolute inset-y-0 left-0 rounded-[inherit]" style={{ width: `${left}%`, background: color }} /> : null}
        </span>
      ))}
    </span>
  );
}

function Rows({ rows }: { rows: ManaRow[] }) {
  const { providers } = experimental_useProviders();
  const record = (provider: ManaRow["provider"]) => providers.find(item => item.id === PROVIDER_IDS[provider]) ?? { id: PROVIDER_IDS[provider] };
  return (
    <div className="grid min-w-0 gap-x-[4px] text-[13px]" style={{ gridTemplateColumns: `15px minmax(0, ${Math.min(12, Math.max(6, ...rows.map(row => row.label.length + 1 + (row.queued?.available ? 3 : 0))))}ch) minmax(24px, 1fr) 4ch 5.5ch` }}>
      {rows.map(row => {
        const openCode = row.provider === "opencode";
        const monthly = openCode ? row.windows.find(window => window.label === "Monthly") : undefined;
        const left = openCode ? monthly?.left ?? null : row.left;
        const resetsAt = openCode ? monthly?.resetsAt ?? null : row.resetsAt;
        const countdown = openCode ? monthly?.resets ?? "" : row.countdown;
        const hue = leftHue(left);
        return (
          <HoverTip key={`${row.provider}:${row.id}`} content={<Tip row={row} icon={<ProviderIcon providerKind="agent" provider={record(row.provider)} className="size-3.5" aria-hidden />} />}>
          <div
            className="col-span-full grid min-h-[26px] grid-cols-subgrid items-center py-[3px] [&+&]:border-t [&+&]:border-border-hairline"
          >
            <span className="grid place-items-center text-subtle-foreground">
              <ProviderIcon providerKind="agent" provider={record(row.provider)} className="size-[15px]" aria-label={NAMES[row.provider]} />
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate text-[13px] font-[450] text-foreground">{row.label}</span>
              {row.queued?.available ? (
                <span className="shrink-0 rounded px-1 text-[10px] font-semibold leading-[14px] tabular-nums" style={{ color: "#60a5fa", background: "color-mix(in srgb, #3b82f6 16%, transparent)" }}>↻{row.queued.available}</span>
              ) : null}
            </span>
            {openCode ? <OpenCodeMeters row={row} monthlyLeft={left} /> : <span
              role="meter"
              aria-label={`${NAMES[row.provider]} ${row.label} weekly allowance left`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.left ?? undefined}
              className="flex min-w-0 flex-col gap-0.5"
            >
              {row.session !== null ? (
                <span className="relative h-[3px] overflow-hidden rounded-full bg-muted" aria-label={`${row.label} 5-hour allowance left: ${row.session}%`}>
                  {row.left !== 0 ? <i className="absolute inset-y-0 left-0 rounded-[inherit]" style={{ width: `${row.session}%`, background: "#93c5fd" }} /> : null}
                </span>
              ) : null}
              <span className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                {row.left !== null ? (
                  <i className="absolute inset-y-0 left-0 rounded-[inherit]" style={{ width: `${row.left}%`, background: hue ?? "#3b82f6" }} />
                ) : null}
              </span>
            </span>}
            <span className="whitespace-nowrap text-right text-[13px] tabular-nums text-foreground" style={tint(hue, "var(--foreground)")}>
              {left !== null ? `${left}%` : row.checkedAt ? "—" : ""}
            </span>
            <span className="whitespace-nowrap text-right text-xs tabular-nums text-subtle-foreground" style={tint(resetHue(resetsAt), "var(--subtle-foreground)")}>
              {openCode && resetsAt ? <time dateTime={resetsAt} aria-label={`Monthly reset ${resetTime.format(new Date(resetsAt))}`}>{countdown}</time> : countdown}
            </span>
          </div>
          </HoverTip>
        );
      })}
    </div>
  );
}

function ManaBar({ compact = false }: { compact?: boolean }) {
  const { mana, error } = useMana();
  // Liminal's card lists only accounts agents may run on: signed in and not switched off.
  const rows = mana?.rows.filter(row => row.status !== "excluded" && row.status !== "signed-out") ?? [];
  return (
    <div className={cn("flex flex-col gap-2", compact ? "w-full min-w-0 p-3" : "max-w-md")}>
      {mana?.conflict ? <p className="text-xs text-warning-text">{mana.conflict}</p> : null}
      {mana?.error ? <p className="text-xs text-destructive-text">{mana.error}</p> : null}
      {!mana ? (
        <p className="text-xs text-subtle-foreground">{error ? `Mana Bar could not load: ${error}` : "Checking allowance…"}</p>
      ) : rows.length ? (
        <Rows rows={rows} />
      ) : (
        <p className="text-xs text-subtle-foreground">No accounts connected. Add a Claude or Codex account in Liminal Tools to see its allowance here.</p>
      )}
    </div>
  );
}

const AUTOMATIC = "automatic";

function usePicker(provider: "claude" | "codex" | null, threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [picker, setPicker] = useState<Picker | null>(null);
  const fetchPicker = useCallback(() => provider === "codex" ? rpc.call("codexPicker", { threadId }) : rpc.call("picker", { threadId }), [provider, rpc, threadId]);
  const load = useCallback(() => { if (provider) void fetchPicker().then(setPicker, () => setPicker(null)); }, [provider, fetchPicker]);
  useEffect(load, [load]);
  useRealtime("mana-changed", () => load());
  const choose = useCallback(async (account: string | null) => {
    try {
      const input = { threadId, account };
      setPicker(await (provider === "codex" ? rpc.call("chooseCodex", input) : rpc.call("choose", input)));
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  }, [provider, rpc, threadId]);
  return { picker, choose };
}

function left(row: ManaRow) {
  return row.left === null ? "" : `${row.left}%`;
}

function AccountPicker() {
  const composer = useComposer();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const providerId = composer.selection?.providerId;
  const provider = providerId === PROVIDER_IDS.claude ? "claude" : providerId === PROVIDER_IDS.codex ? "codex" : null;
  const { mana } = useMana();
  const { picker, choose } = usePicker(provider, threadId);
  const { providers } = experimental_useProviders();
  if (!provider || scope.kind === "queued-message" || !mana) return null;
  if (provider === "claude" && !mana.routing) return null;
  // Switched-off accounts are hidden as on the Mana Bar; signed-out ones stay, unpickable, so a missing login is visible.
  const rows = mana.rows.filter(row => row.provider === provider && row.status !== "excluded");
  if (!rows.length) return null;
  const record = providers.find(item => item.id === PROVIDER_IDS[provider]) ?? { id: PROVIDER_IDS[provider] };

  const automatic = rows.find(row => row.id === picker?.automatic) ?? null;
  const current = rows.find(row => row.id === picker?.account) ?? automatic;
  const value = picker?.account ?? (provider === "codex" && threadId ? automatic?.id ?? "" : AUTOMATIC);
  const unpickable = (row: ManaRow) => row.status === "signed-out";
  const footer = threadId
    ? provider === "codex" ? "Applies to this thread from its next turn." : "Applies from this thread's next turn. Failover still moves it when an account runs out."
    : "Used for the thread you start next.";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
          aria-label={`${NAMES[provider]} account: ${current ? `${current.label}${current.left !== null ? `, ${current.left}% of the week left` : ""}` : "Automatic"}`}
        >
          <ProviderIcon providerKind="agent" provider={record} className="size-3.5" aria-hidden />
          <span className="max-w-[10ch] truncate">{current?.label ?? "Account"}</span>
          {current && current.left !== null ? (
            <span className="tabular-nums text-subtle-foreground" style={tint(leftHue(current.left), "var(--subtle-foreground)")}>{left(current)}</span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" mobileTitle={`${NAMES[provider]} account`}>
        <DropdownMenuLabel className="text-xs text-subtle-foreground">{NAMES[provider]} account</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={next => { void choose(next === AUTOMATIC ? null : next); }}>
          {threadId === null ? (
            <DropdownMenuRadioItem value={AUTOMATIC}>
              <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                <span>Automatic</span>
                <span className="truncate text-xs text-subtle-foreground">{provider === "codex" ? automatic?.label ?? "This Mac’s primary login" : automatic ? `Liminal picks ${automatic.label}` : "Liminal picks"}</span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          {rows.map(row => (
            <DropdownMenuRadioItem key={row.id} value={row.id} disabled={unpickable(row)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{row.label}{row.pinned ? " · pinned" : ""}</span>
                  <span className="tabular-nums text-xs text-subtle-foreground" style={tint(leftHue(row.left), "var(--subtle-foreground)")}>
                    {left(row)}{row.countdown ? ` · ${row.countdown}` : ""}
                  </span>
                </span>
                {row.status !== "ready" || row.plan ? (
                  <span className="truncate text-xs text-subtle-foreground">
                    {[row.plan, row.status === "ready" ? "" : row.statusLabel].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-subtle-foreground">{footer}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The Mana Bar stays open across reloads until the user closes it; a close is told apart from a page unload.
const MANA_BAR_CLOSED = "liminal-pool.mana-bar.closed";
let unloading = false;
addEventListener("pagehide", () => { unloading = true; });

function StayingManaBar() {
  useEffect(() => {
    localStorage.removeItem(MANA_BAR_CLOSED);
    return () => { if (!unloading) localStorage.setItem(MANA_BAR_CLOSED, "1"); };
  }, []);
  return <ManaBar compact />;
}

export default definePluginApp(app => {
  app.composer.customize({
    id: "account-picker",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "account", component: AccountPicker }],
  });
  const manaBar = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "mana-bar",
    label: "Mana Bar",
    icon: "Gauge",
    component: StayingManaBar,
  });
  if (localStorage.getItem(MANA_BAR_CLOSED) === null) queueMicrotask(() => manaBar.open());
  app.slots.settingsSection({
    id: "mana-bar",
    title: "Mana Bar",
    description: "Weekly allowance left on each Liminal account and the time to its weekly reset.",
    component: () => <ManaBar />,
  });
});
