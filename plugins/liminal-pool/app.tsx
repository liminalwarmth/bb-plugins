// The Mana Bar, laid out as Liminal Tools' card (plugins/development/allowance/.../Mana.svelte) and painted in bb's
// theme: one row per account that can take work — provider icon, label, a bar of the weekly allowance LEFT, the
// percentage, and the countdown to the weekly reset. The tick marks where an even pace through the week would leave the
// fill; fill past it is allowance that will otherwise be lost at reset. Hovering a row lists every window. A row whose
// reading failed or went stale is dimmed. Shown in the sidebar footer and on the plugin's settings page.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, experimental_ProviderIcon as ProviderIcon, experimental_useProviders, useComposer, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Mana, ManaRow, Picker, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Liminal's card marks a bar low at 20% left.
const LOW_LEFT = 20;
const PROVIDER_IDS = { claude: "claude-code", codex: "codex" } as const;
const NAMES = { claude: "Claude", codex: "Codex" } as const;

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

function tip(row: ManaRow) {
  return [
    `${NAMES[row.provider]} · ${row.label}${row.plan ? ` (${row.plan})` : ""}`,
    row.pace === null ? "" : `The tick: an even pace would leave ${row.pace}% by now`,
    row.status === "exhausted" ? row.statusLabel : "",
    ...row.windows.map(window => `${window.label}: ${window.left}% left${window.resets ? `; resets in ${window.resets}` : ""}`),
    row.threads ? `${row.threads} bb thread${row.threads === 1 ? "" : "s"} on this account` : "",
    row.pinned ? "Pinned for new work in Liminal" : "",
    row.note ?? "",
    row.checkedAt ? `Last checked ${new Date(row.checkedAt).toLocaleString()}` : "Checking usage…",
  ].filter(Boolean).join("\n");
}

function Rows({ rows }: { rows: ManaRow[] }) {
  const { providers } = experimental_useProviders();
  const record = (provider: ManaRow["provider"]) => providers.find(item => item.id === PROVIDER_IDS[provider]) ?? { id: PROVIDER_IDS[provider] };
  return (
    <div className="grid gap-x-[7px]" style={{ gridTemplateColumns: "15px max-content minmax(32px, 1fr) 4ch 5.5ch" }}>
      {rows.map(row => {
        const low = row.left !== null && row.left <= LOW_LEFT;
        const dim = row.stale || row.status === "checking";
        return (
          <div
            key={`${row.provider}:${row.id}`}
            title={tip(row)}
            className="col-span-full grid min-h-[26px] grid-cols-subgrid items-center py-[3px] [&+&]:border-t [&+&]:border-border-hairline"
          >
            <span className="grid place-items-center text-subtle-foreground">
              <ProviderIcon providerKind="agent" provider={record(row.provider)} className="size-[15px]" aria-label={NAMES[row.provider]} />
            </span>
            <span className="min-w-0 truncate text-[13px] font-[450] text-foreground">{row.label}</span>
            <span
              role="meter"
              aria-label={`${NAMES[row.provider]} ${row.label} weekly allowance left`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.left ?? undefined}
              className={cn("relative h-1.5 rounded-[3px] bg-muted", dim && "opacity-50")}
            >
              {row.left !== null ? (
                <i className={cn("absolute inset-y-0 left-0 rounded-[inherit]", low ? "bg-warning" : "bg-primary")} style={{ width: `${row.left}%` }} />
              ) : null}
              {row.pace !== null ? (
                <i
                  className="absolute -inset-y-0.5 -ml-px w-0.5 rounded-[1px] bg-foreground opacity-55 shadow-[0_0_0_1px_var(--color-background)]"
                  style={{ left: `${row.pace}%` }}
                />
              ) : null}
            </span>
            <span className={cn("whitespace-nowrap text-right text-[13px] tabular-nums", low ? "text-warning-text" : "text-foreground", dim && "opacity-50")}>
              {row.left !== null ? `${row.left}%` : row.checkedAt ? "—" : ""}
            </span>
            <span className="whitespace-nowrap text-right text-xs tabular-nums text-subtle-foreground">{row.countdown}</span>
          </div>
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
      {compact ? <div className="text-sm font-semibold text-foreground">Mana Bar</div> : null}
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

// ── The account picker beside the composer's provider choice ─────────────────────────────────────────────────────
// Liminal's create and session settings put an Account picker under the provider; bb's composer takes it as an action.
// For Claude it moves the thread (from its next turn) or picks the account a new thread starts on. bb's Codex provider
// runs only on this Mac's own login, so for Codex it shows that login and lists the others without offering them.
const AUTOMATIC = "automatic";

function usePicker(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [picker, setPicker] = useState<Picker | null>(null);
  const load = useCallback(() => {
    rpc.call("picker", { threadId }).then(setPicker, () => setPicker(null));
  }, [rpc, threadId]);
  useEffect(load, [load]);
  useRealtime("mana-changed", () => load());
  const choose = useCallback(async (account: string | null) => {
    try { setPicker(await rpc.call("choose", { threadId, account })); } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc, threadId]);
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
  const { picker, choose } = usePicker(threadId);
  const { providers } = experimental_useProviders();
  if (!provider || scope.kind === "queued-message" || !mana) return null;
  if (provider === "claude" && !mana.routing) return null;
  // Switched-off accounts are hidden as on the Mana Bar; signed-out ones stay, unpickable, so a missing login is visible.
  const rows = mana.rows.filter(row => row.provider === provider && row.status !== "excluded");
  if (!rows.length) return null;
  const record = providers.find(item => item.id === PROVIDER_IDS[provider]) ?? { id: PROVIDER_IDS[provider] };

  const codexInUse = rows.find(row => row.note !== null) ?? null;
  const automatic = rows.find(row => row.id === picker?.automatic) ?? null;
  const current = provider === "codex" ? codexInUse : rows.find(row => row.id === picker?.account) ?? automatic;
  const value = provider === "codex" ? codexInUse?.id ?? "" : picker?.account ?? AUTOMATIC;
  const unpickable = (row: ManaRow) => provider === "codex" ? row.id !== codexInUse?.id : row.status === "signed-out";
  const footer = provider === "codex"
    ? "bb's Codex threads run on this Mac's own Codex login. Change it with codex login."
    : threadId ? "Applies from this thread's next turn. Failover still moves it when an account runs out." : "Used for the thread you start next.";

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
            <span className={cn("tabular-nums", current.left <= LOW_LEFT ? "text-warning-text" : "text-subtle-foreground")}>{left(current)}</span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" mobileTitle={`${NAMES[provider]} account`}>
        <DropdownMenuLabel className="text-xs text-subtle-foreground">{NAMES[provider]} account</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={next => { void choose(next === AUTOMATIC ? null : next); }}>
          {provider === "claude" && threadId === null ? (
            <DropdownMenuRadioItem value={AUTOMATIC}>
              <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                <span>Automatic</span>
                <span className="truncate text-xs text-subtle-foreground">{automatic ? `Liminal picks ${automatic.label}` : "Liminal picks"}</span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          {rows.map(row => (
            <DropdownMenuRadioItem key={row.id} value={row.id} disabled={unpickable(row)} title={tip(row)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{row.label}{row.pinned ? " · pinned" : ""}</span>
                  <span className={cn("tabular-nums text-xs", row.left !== null && row.left <= LOW_LEFT ? "text-warning-text" : "text-subtle-foreground")}>
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

export default definePluginApp(app => {
  app.composer.customize({
    id: "account-picker",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "account", component: AccountPicker }],
  });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "mana-bar",
    label: "Mana Bar",
    icon: "Gauge",
    component: () => <ManaBar compact />,
  });
  app.slots.settingsSection({
    id: "mana-bar",
    title: "Mana Bar",
    description: "Weekly allowance left on each Liminal account and the time to its weekly reset. The tick marks an even pace.",
    component: () => <ManaBar />,
  });
});
