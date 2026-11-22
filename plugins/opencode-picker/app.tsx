import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { PickerState, rpcContract } from "./server";
import {
  computeModelSortWeight,
  COST_COLORS,
  COST_LABELS,
  isGoPlanModel,
  lookupPrice,
  lookupScore,
  OPENCODE_ROUTE_PROVIDERS,
  parseOptionTitle,
  recentModelKey,
  routeNormKey,
  TIER_COLORS,
  TIER_LABELS,
  type CostTier,
  type PricedModel,
  type ScoredModel,
  type StrengthTier,
} from "./src/scoring";

const RECENT_CONTAINER_ATTR = "data-ocp-recent";
const METRICS_ATTR = "data-ocp-metrics";
const METRICS_KEY_ATTR = "data-ocp-metrics-key";
const SORTED_LISTBOX_ATTR = "data-ocp-sorted";
const HIDDEN_OPTION_ATTR = "data-ocp-hidden";
const BAR_HEIGHTS = [4, 6, 8, 10, 12] as const;

function formatRate(value: number): string {
  if (value === 0) return "$0";
  return value < 1 ? `$${value.toFixed(2)}` : `$${Number(value.toFixed(2))}`;
}

function createCostBadgeElement(price: PricedModel): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.textContent = price.label;
  badge.setAttribute(
    "aria-label",
    price.tier === 0 ? "Free" : `Cost tier ${price.tier} of 4 (${price.label})`,
  );
  badge.title =
    price.tier === 0
      ? "Free · $0/1M tokens (opencode.ai)"
      : price.goAllowancePctPer1M !== null && price.goMonthlyLimit !== null
        ? `Go usage ${price.label} · ${price.goAllowancePctPer1M}% of monthly Go allowance / 1M blended (${formatRate(price.blended)}/1M on $${price.goMonthlyLimit} cap · ${formatRate(price.input)} in / ${formatRate(price.output)} out · opencode.ai)`
        : `OpenCode ${price.label} · ${formatRate(price.blended)}/1M blended (${formatRate(price.input)} in / ${formatRate(price.output)} out · opencode.ai)`;

  badge.style.fontSize = "10px";
  badge.style.lineHeight = "1";
  badge.style.fontWeight = "500";
  badge.style.letterSpacing = "-0.02em";
  badge.style.fontVariantNumeric = "tabular-nums";
  badge.style.color = COST_COLORS[price.tier];
  badge.style.textAlign = "right";
  badge.style.minWidth = "26px";
  badge.style.flexShrink = "0";

  return badge;
}

function createStrengthBarsElement(score: ScoredModel, sourceDate: string | null): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.setAttribute("aria-label", `Strength ${score.tier} of 5`);

  const dateSuffix = sourceDate ? `, ${sourceDate.slice(0, 10)}` : "";
  wrapper.title = `Strength ${score.tier}/5 (${TIER_LABELS[score.tier]}) · AA Index ${score.index} (${score.aaName} · Artificial Analysis${dateSuffix})`;

  wrapper.style.display = "inline-flex";
  wrapper.style.alignItems = "flex-end";
  wrapper.style.gap = "1.5px";
  wrapper.style.height = "12px";
  wrapper.style.width = "18.5px";
  wrapper.style.flexShrink = "0";

  const activeColor = TIER_COLORS[score.tier];

  for (let level = 1; level <= 5; level += 1) {
    const bar = document.createElement("span");
    bar.style.display = "block";
    bar.style.width = "2.5px";
    bar.style.height = `${BAR_HEIGHTS[level - 1]}px`;
    bar.style.borderRadius = "1px";
    bar.style.backgroundColor =
      level <= score.tier ? activeColor : "color-mix(in srgb, currentColor 18%, transparent)";
    wrapper.appendChild(bar);
  }

  return wrapper;
}

function createMetricsElement(
  price: PricedModel | null,
  score: ScoredModel | null,
  sourceDate: string | null,
  key: string,
): HTMLSpanElement {
  const group = document.createElement("span");
  group.setAttribute(METRICS_ATTR, "true");
  group.setAttribute(METRICS_KEY_ATTR, key);
  group.style.display = "inline-flex";
  group.style.alignItems = "baseline";
  group.style.gap = "6px";
  group.style.flexShrink = "0";
  group.style.marginRight = "2px";

  if (price) {
    group.appendChild(createCostBadgeElement(price));
  }

  if (score) {
    group.appendChild(createStrengthBarsElement(score, sourceDate));
  } else if (price) {
    const spacer = document.createElement("span");
    spacer.style.display = "inline-block";
    spacer.style.width = "18.5px";
    spacer.style.flexShrink = "0";
    spacer.setAttribute("aria-hidden", "true");
    group.appendChild(spacer);
  }

  return group;
}

function isOpenCodeDialog(dialog: Element): boolean {
  const providerTabs = [...dialog.querySelectorAll("button")].filter(
    (button) => !button.getAttribute("role") && button.querySelector("[data-provider-logo]"),
  );

  if (providerTabs.length > 0) {
    const activeTab = providerTabs.find((button) =>
      button.className.includes("border-foreground"),
    );
    const logo = activeTab?.querySelector("[data-provider-logo]")?.getAttribute("data-provider-logo");
    return Boolean(logo && logo.includes("/providers/acp-opencode/"));
  }

  const options = dialog.querySelectorAll('[role="listbox"] button[role="option"]');
  let checked = 0;
  for (const option of options) {
    const parsed = parseOptionTitle(option.querySelector("span[title]")?.getAttribute("title"));
    if (parsed && OPENCODE_ROUTE_PROVIDERS.has(parsed.routeProviderId)) {
      return true;
    }
    checked += 1;
    if (checked >= 8) break;
  }
  return false;
}

function getNativeOptions(listbox: Element): HTMLButtonElement[] {
  return [...listbox.querySelectorAll('button[role="option"]')].filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement && !element.closest(`[${RECENT_CONTAINER_ATTR}]`),
  );
}

function cleanupDialog(dialog: Element) {
  dialog.querySelectorAll(`[${RECENT_CONTAINER_ATTR}]`).forEach((node) => node.remove());
  dialog.querySelectorAll(`[${METRICS_ATTR}]`).forEach((node) => node.remove());
  dialog.querySelectorAll<HTMLElement>(`[${HIDDEN_OPTION_ATTR}]`).forEach((node) => {
    node.removeAttribute(HIDDEN_OPTION_ATTR);
    node.style.display = "";
  });
  const listbox = dialog.querySelector<HTMLElement>(`[${SORTED_LISTBOX_ATTR}]`);
  if (listbox) {
    listbox.removeAttribute(SORTED_LISTBOX_ATTR);
    listbox.style.display = "";
    listbox.style.flexDirection = "";
    for (const child of listbox.children) {
      if (child instanceof HTMLElement) {
        child.style.order = "";
      }
    }
  }
}

function createCheckSvg(selected: boolean): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute(
    "class",
    `size-4 shrink-0 max-md:pointer-coarse:size-5 text-subtle-foreground ${selected ? "opacity-100" : "opacity-0"}`,
  );
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M5 14L8.5 17.5L19 6.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "1.5");
  svg.appendChild(path);
  return svg;
}

function decorateDialog(dialog: Element, state: PickerState) {
  const listbox = dialog.querySelector('[role="listbox"]');
  if (!listbox) return;

  if (!isOpenCodeDialog(dialog)) {
    cleanupDialog(dialog);
    return;
  }

  const nativeOptions = getNativeOptions(listbox);
  const goModelKeys =
    state.goModelsOnly && state.goModelKeys.length > 0 ? new Set(state.goModelKeys) : null;
  const scoredOptions: Array<{
    button: HTMLButtonElement;
    displayName: string;
    routeProviderId: string;
    weight: number;
    originalIndex: number;
  }> = [];
  const optionByKey = new Map<
    string,
    {
      button: HTMLButtonElement;
      displayName: string;
      routeProviderId: string;
      selected: boolean;
      score: ScoredModel | null;
      price: PricedModel | null;
    }
  >();

  for (let index = 0; index < nativeOptions.length; index += 1) {
    const button = nativeOptions[index];
    const titleSpan = button.querySelector("span[title]");
    const parsed = parseOptionTitle(titleSpan?.getAttribute("title"));
    if (!parsed) continue;

    if (goModelKeys && !isGoPlanModel(goModelKeys, parsed.displayName, parsed.routeProviderId)) {
      button.setAttribute(HIDDEN_OPTION_ATTR, "true");
      button.style.display = "none";
      button.style.order = "";
      continue;
    }

    if (button.hasAttribute(HIDDEN_OPTION_ATTR)) {
      button.removeAttribute(HIDDEN_OPTION_ATTR);
      button.style.display = "";
    }

    const score = lookupScore(state.scores, parsed.displayName);
    const price = lookupPrice(
      state.pricesByRoute,
      state.pricesByNorm,
      parsed.displayName,
      parsed.routeProviderId,
    );
    const trailing = button.lastElementChild;
    const existingMetrics = button.querySelector(`[${METRICS_ATTR}]`);

    if ((score || price) && trailing instanceof HTMLElement) {
      const metricsKey = `${price?.tier ?? -1}:${price?.blended ?? -1}|${score?.tier ?? 0}:${score?.index ?? 0}`;
      if (existingMetrics?.getAttribute(METRICS_KEY_ATTR) !== metricsKey) {
        existingMetrics?.remove();
        const metrics = createMetricsElement(price, score, state.sourceDate, metricsKey);
        trailing.insertBefore(metrics, trailing.firstChild);
      }
    } else if (!score && !price && existingMetrics) {
      existingMetrics.remove();
    }

    const checkIcon = button.querySelector('[data-icon="Check"]');
    const isSelected =
      button.getAttribute("aria-selected") === "true" ||
      Boolean(checkIcon?.getAttribute("class")?.includes("opacity-100"));

    const key = recentModelKey(parsed.displayName, parsed.routeProviderId);
    const entryRecord = {
      button,
      displayName: parsed.displayName,
      routeProviderId: parsed.routeProviderId,
      selected: isSelected,
      score,
      price,
    };
    optionByKey.set(key, entryRecord);
    const normKey = routeNormKey(parsed.routeProviderId, parsed.displayName);
    if (!optionByKey.has(normKey)) {
      optionByKey.set(normKey, entryRecord);
    }

    scoredOptions.push({
      button,
      displayName: parsed.displayName,
      routeProviderId: parsed.routeProviderId,
      weight: computeModelSortWeight(score, price, state.maxScore),
      originalIndex: index,
    });
  }

  if (listbox instanceof HTMLElement && scoredOptions.length > 0) {
    listbox.setAttribute(SORTED_LISTBOX_ATTR, "true");
    listbox.style.display = "flex";
    listbox.style.flexDirection = "column";

    for (const child of listbox.children) {
      if (
        child instanceof HTMLElement &&
        !child.hasAttribute(RECENT_CONTAINER_ATTR) &&
        child.getAttribute("role") !== "option"
      ) {
        child.style.order = "-1";
      }
    }

    scoredOptions.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.originalIndex - b.originalIndex;
    });
    for (let rank = 0; rank < scoredOptions.length; rank += 1) {
      const rankStr = String(rank);
      if (scoredOptions[rank].button.style.order !== rankStr) {
        scoredOptions[rank].button.style.order = rankStr;
      }
    }
  }

  const searchInput = dialog.querySelector<HTMLInputElement>('input[role="combobox"]');
  const isSearching = Boolean(searchInput && searchInput.value.trim().length > 0);
  const matchingRecent = isSearching
    ? []
    : state.recent
        .slice(0, state.recentCount)
        .map((entry) => {
          const direct = optionByKey.get(entry.key);
          if (direct) return direct;
          const byName = optionByKey.get(routeNormKey(entry.routeProviderId, entry.displayName));
          if (byName) return byName;
          if (entry.modelId) {
            const slug = entry.modelId.includes("/")
              ? entry.modelId.split("/").slice(1).join("/")
              : entry.modelId;
            return optionByKey.get(routeNormKey(entry.routeProviderId, slug));
          }
          return undefined;
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const existingRecent = listbox.querySelector<HTMLElement>(`[${RECENT_CONTAINER_ATTR}]`);
  if (matchingRecent.length === 0) {
    existingRecent?.remove();
    return;
  }

  const signature = matchingRecent
    .map(
      (entry) =>
        `${entry.routeProviderId}:${entry.displayName}:${entry.selected ? 1 : 0}:${entry.price?.tier ?? -1}:${entry.score?.tier ?? 0}:${entry.score?.index ?? 0}`,
    )
    .join("|");

  if (existingRecent?.getAttribute("data-ocp-sig") === signature) {
    return;
  }

  const container = document.createElement("div");
  container.setAttribute(RECENT_CONTAINER_ATTR, "true");
  container.setAttribute("data-ocp-sig", signature);
  container.style.order = "-2";
  container.className = "mb-1 border-b border-border pb-1";

  const heading = document.createElement("div");
  heading.className =
    "sticky top-0 z-10 bg-background px-2 text-xs font-medium text-muted-foreground pb-[0.3125rem] pt-2 max-md:pointer-coarse:pb-1.5";
  heading.textContent = "Recent";
  container.appendChild(heading);

  for (const entry of matchingRecent) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-selected", entry.selected ? "true" : "false");
    button.className =
      "relative flex w-full cursor-default select-none items-center justify-between gap-3 rounded-sm px-2 text-xs outline-none hover:bg-state-hover hover:text-foreground transition-none focus-visible:bg-state-hover focus-visible:text-foreground py-[0.3125rem] max-md:pointer-coarse:py-2";

    const labelSpan = document.createElement("span");
    labelSpan.className = "truncate";
    labelSpan.title = `${entry.displayName} · ${entry.routeProviderId}`;
    labelSpan.appendChild(document.createTextNode(entry.displayName));

    const routeSpan = document.createElement("span");
    routeSpan.className = "ml-1.5 text-subtle-foreground";
    routeSpan.textContent = entry.routeProviderId;
    labelSpan.appendChild(routeSpan);

    const trailingSpan = document.createElement("span");
    trailingSpan.className = "flex shrink-0 items-center gap-1.5";
    if (entry.price || entry.score) {
      trailingSpan.appendChild(
        createMetricsElement(
          entry.price,
          entry.score,
          state.sourceDate,
          `${entry.price?.tier ?? -1}|${entry.score?.tier ?? 0}`,
        ),
      );
    }
    trailingSpan.appendChild(createCheckSvg(entry.selected));

    button.appendChild(labelSpan);
    button.appendChild(trailingSpan);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      entry.button.click();
    });

    container.appendChild(button);
  }

  if (existingRecent) {
    existingRecent.replaceWith(container);
  } else {
    listbox.insertBefore(container, listbox.firstChild);
  }
}

function usePickerState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<PickerState | null>(null);

  const load = useCallback(() => {
    rpc
      .call("state", null)
      .then((next) => setState(next))
      .catch(() => {});
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime("picker-updated", () => load());

  return { state, setState, load, rpc };
}

function OpenCodePickerEnhancer() {
  const { state, load } = usePickerState();
  const stateRef = useRef<PickerState | null>(state);
  const loadRef = useRef(load);
  const hadOpenCodeDialogRef = useRef(false);

  stateRef.current = state;
  loadRef.current = load;

  const syncAllDialogs = useCallback(() => {
    const currentState = stateRef.current;
    const dialogs = document.querySelectorAll('[role="dialog"]');
    let hasOpenCodeDialog = false;

    for (const dialog of dialogs) {
      if (isOpenCodeDialog(dialog)) {
        hasOpenCodeDialog = true;
      }
      if (currentState) {
        decorateDialog(dialog, currentState);
      }
    }

    if (hasOpenCodeDialog && !hadOpenCodeDialogRef.current) {
      loadRef.current();
    }
    hadOpenCodeDialogRef.current = hasOpenCodeDialog;
  }, []);

  useEffect(() => {
    syncAllDialogs();
  }, [state, syncAllDialogs]);

  useEffect(() => {
    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncAllDialogs();
      });
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "class"],
    });

    const onInput = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.getAttribute("role") === "combobox") {
        schedule();
      }
    };
    document.addEventListener("input", onInput, true);

    schedule();

    return () => {
      observer.disconnect();
      document.removeEventListener("input", onInput, true);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      document.querySelectorAll('[role="dialog"]').forEach((dialog) => cleanupDialog(dialog));
    };
  }, [syncAllDialogs]);

  return null;
}

function StrengthLegendBars({ tier }: { tier: StrengthTier }) {
  const color = TIER_COLORS[tier];
  return (
    <span className="inline-flex h-3 items-end gap-[1.5px]" aria-hidden="true">
      {BAR_HEIGHTS.map((height, index) => (
        <span
          key={height}
          className="block w-[2.5px] rounded-[1px]"
          style={{
            height,
            backgroundColor:
              index + 1 <= tier ? color : "color-mix(in srgb, currentColor 18%, transparent)",
          }}
        />
      ))}
    </span>
  );
}

function CostBadge({ tier }: { tier: CostTier }) {
  return (
    <span
      className="inline-block text-[10px] font-medium tabular-nums"
      style={{ color: COST_COLORS[tier] }}
    >
      {COST_LABELS[tier]}
    </span>
  );
}

function SettingsSection() {
  const { state, setState, rpc } = usePickerState();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const next = await rpc.call("refreshBenchmarks", null);
      setState(next);
      toast.success("Benchmark scores and pricing refreshed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to refresh data");
    } finally {
      setRefreshing(false);
    }
  };

  const handleClearRecent = async () => {
    try {
      await rpc.call("clearRecent", null);
      setState((current) => (current ? { ...current, recent: [] } : current));
      toast.success("Cleared recent OpenCode models");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear recent models");
    }
  };

  const scoreCount = state ? Object.keys(state.scores).length : 0;
  const priceCount = state ? Object.keys(state.pricesByNorm).length : 0;

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-md border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium text-foreground">Benchmarks & pricing cache</div>
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh now"}
          </Button>
        </div>
        <div className="text-muted-foreground space-y-1">
          <div>
            Benchmarks indexed: <span className="text-foreground">{scoreCount}</span>
            {state?.maxScore ? ` · Top AA Index: ${state.maxScore}` : ""}
            {priceCount ? ` · Priced models: ${priceCount}` : ""}
          </div>
          <div>
            Last fetched:{" "}
            <span className="text-foreground">
              {state?.fetchedAt ? new Date(state.fetchedAt).toLocaleString() : "Not fetched yet"}
            </span>
          </div>
          {state?.error ? (
            <div className="text-destructive">Last error: {state.error}</div>
          ) : null}
          <div>
            Strength from{" "}
            <UrlLink href="https://artificialanalysis.ai/" className="underline">
              Artificial Analysis
            </UrlLink>{" "}
            (Intelligence Index v5) · Pricing & Go allowance caps from{" "}
            <UrlLink href="https://opencode.ai/docs/go" className="underline">
              opencode.ai
            </UrlLink>
            .
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-1 text-muted-foreground">
          {([5, 4, 3, 2, 1] as const).map((tier) => (
            <span key={tier} className="inline-flex items-center gap-1.5">
              <StrengthLegendBars tier={tier} />
              <span>
                {tier} {TIER_LABELS[tier]}
              </span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
          {([0, 1, 2, 3, 4] as const).map((tier) => (
            <span key={tier} className="inline-flex items-center gap-1">
              <CostBadge tier={tier} />
              <span>
                {tier === 0
                  ? "$0"
                  : tier === 1
                    ? "<$1/1M"
                    : tier === 2
                      ? "$1–3.5"
                      : tier === 3
                        ? "$3.5–10"
                        : "$10+"}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="font-medium text-foreground">
            Recent OpenCode models ({state?.recent.length ?? 0}/{state?.recentCount ?? 4})
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleClearRecent}
            disabled={!state || state.recent.length === 0}
          >
            Clear recent
          </Button>
        </div>
        {state && state.recent.length > 0 ? (
          <ul className="space-y-1 text-muted-foreground">
            {state.recent.map((item) => {
              const score = lookupScore(state.scores, item.displayName, item.modelId);
              const price = lookupPrice(
                state.pricesByRoute,
                state.pricesByNorm,
                item.displayName,
                item.routeProviderId,
              );
              return (
                <li key={item.key} className="flex items-center justify-between gap-2">
                  <span className="truncate text-foreground">
                    {item.displayName}{" "}
                    <span className="text-subtle-foreground">{item.routeProviderId}</span>
                  </span>
                  <span className="inline-flex items-baseline gap-2 shrink-0">
                    {price ? <CostBadge tier={price.tier} /> : null}
                    {score ? <StrengthLegendBars tier={score.tier} /> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="text-muted-foreground">
            Run a turn through OpenCode to populate Recent.
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "opencode-picker-enhancer",
    component: OpenCodePickerEnhancer,
  });
  app.slots.settingsSection({
    id: "opencode-picker-status",
    title: "Status & recent models",
    description:
      "Cached Artificial Analysis strength ratings, official OpenCode Zen & Go allowance pricing, and the most recent models actually run through OpenCode.",
    component: SettingsSection,
  });
});
