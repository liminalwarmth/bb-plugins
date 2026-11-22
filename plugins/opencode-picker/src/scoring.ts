export type StrengthTier = 1 | 2 | 3 | 4 | 5;
export type CostTier = 0 | 1 | 2 | 3 | 4;

export interface RawBenchmarkEntry {
  normKey: string;
  name: string;
  index: number;
  creator: string | null;
}

export interface ScoredModel {
  tier: StrengthTier;
  index: number;
  aaName: string;
  creator: string | null;
}

export interface RawPriceEntry {
  routeProviderId: string;
  modelSlug: string;
  displayName: string;
  normKey: string;
  input: number;
  output: number;
  blended: number;
  goMonthlyLimit: number | null;
  goAllowancePctPer1M: number | null;
}

export interface PricedModel {
  tier: CostTier;
  label: string;
  input: number;
  output: number;
  blended: number;
  goMonthlyLimit: number | null;
  goAllowancePctPer1M: number | null;
}

export interface RecentModel {
  key: string;
  displayName: string;
  routeProviderId: string;
  modelId: string | null;
  usedAt: number;
}

export interface ParsedBenchmarkDataset {
  source: string;
  sourceDate: string | null;
  attribution: string;
  maxScore: number;
  entries: RawBenchmarkEntry[];
}

export const TIER_COLORS: Record<StrengthTier, string> = {
  5: "#22c55e",
  4: "#84cc16",
  3: "#facc15",
  2: "#d97706",
  1: "#ef4444",
};

export const TIER_LABELS: Record<StrengthTier, string> = {
  5: "Frontier",
  4: "Strong",
  3: "Capable",
  2: "Light",
  1: "Entry",
};

export const COST_LABELS: Record<CostTier, string> = {
  0: "Free",
  1: "$",
  2: "$$",
  3: "$$$",
  4: "$$$$",
};

export const COST_COLORS: Record<CostTier, string> = {
  0: "color-mix(in srgb, #22c55e 82%, var(--muted-foreground))",
  1: "var(--muted-foreground)",
  2: "color-mix(in srgb, var(--foreground) 72%, var(--muted-foreground))",
  3: "color-mix(in srgb, #f59e0b 78%, var(--muted-foreground))",
  4: "color-mix(in srgb, #ef4444 82%, var(--muted-foreground))",
};

export const DEFAULT_BENCHMARK_URL =
  "https://raw.githubusercontent.com/terryds/bestvaluemodel/main/data/models.json";

export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/inference/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

export const OPENCODE_ROUTE_PROVIDERS = new Set([
  "claude-agent",
  "openai",
  "opencode",
  "opencode-go",
]);

export function normalizeModelName(raw: string): string {
  let text = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(
      /\b(claude|tencent|fast|free|contributor|preview|next|reasoning|adaptive|thinking)\b/gi,
      " ",
    )
    .replace(/\b202\d{5}\b/g, " ")
    .replace(/\b0\d{3}\b/g, " ")
    .replace(/\b10\d{2}\b/g, " ")
    .replace(/\b1\.0\b/g, " ")
    .replace(/(\d+)-(\d+)/g, "$1.$2")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();

  text = text.replace(/^(\d+(?:\.\d+)?)\s+(haiku|sonnet|opus|fable)$/, "$2 $1");
  return text.replace(/\s+/g, " ").trim();
}

export function recentModelKey(displayName: string, routeProviderId: string): string {
  return `${routeProviderId.trim().toLowerCase()}::${displayName.trim().toLowerCase()}`;
}

export function routeNormKey(routeProviderId: string, name: string): string {
  return `${routeProviderId.trim().toLowerCase()}::${normalizeModelName(name)}`;
}

export function parseOptionTitle(
  title: string | null | undefined,
): { displayName: string; routeProviderId: string } | null {
  if (!title) return null;
  const separator = " · ";
  const splitIndex = title.lastIndexOf(separator);
  if (splitIndex <= 0) return null;
  const displayName = title.slice(0, splitIndex).trim();
  const routeProviderId = title.slice(splitIndex + separator.length).trim();
  if (!displayName || !routeProviderId) return null;
  return { displayName, routeProviderId };
}

export function scoreToTier(score: number, maxScore: number): StrengthTier {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) {
    return 1;
  }
  const ratio = score / maxScore;
  if (ratio >= 0.82) return 5;
  if (ratio >= 0.64) return 4;
  if (ratio >= 0.43) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

export function blendedCostToTier(blended: number): CostTier {
  if (!Number.isFinite(blended) || blended <= 0) return 0;
  if (blended < 1) return 1;
  if (blended < 3.5) return 2;
  if (blended < 10) return 3;
  return 4;
}

export function goAllowancePctToTier(pctPer1M: number): CostTier {
  if (!Number.isFinite(pctPer1M) || pctPer1M <= 0) return 0;
  if (pctPer1M < 1) return 1;
  if (pctPer1M < 5) return 2;
  if (pctPer1M < 16) return 3;
  return 4;
}

export function parseBenchmarkPayload(payload: unknown): ParsedBenchmarkDataset {
  const root =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rawModels = Array.isArray(root?.models)
    ? root.models
    : Array.isArray(root?.data)
      ? root.data
      : [];

  const byKey = new Map<string, RawBenchmarkEntry>();
  let maxScore = 0;

  for (const item of rawModels) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const evaluations =
      record.evaluations && typeof record.evaluations === "object"
        ? (record.evaluations as Record<string, unknown>)
        : null;
    const rawScore =
      typeof record.index === "number"
        ? record.index
        : typeof evaluations?.artificial_analysis_intelligence_index === "number"
          ? evaluations.artificial_analysis_intelligence_index
          : null;

    if (!name || rawScore === null || !Number.isFinite(rawScore) || rawScore <= 0) {
      continue;
    }

    const normKey = normalizeModelName(name);
    if (!normKey) continue;

    if (rawScore > maxScore) maxScore = rawScore;

    const creator =
      typeof record.creator === "string"
        ? record.creator
        : record.model_creator &&
            typeof record.model_creator === "object" &&
            typeof (record.model_creator as Record<string, unknown>).name === "string"
          ? ((record.model_creator as Record<string, unknown>).name as string)
          : null;

    const existing = byKey.get(normKey);
    if (!existing || rawScore > existing.index) {
      byKey.set(normKey, {
        normKey,
        name: name.replace(/\s*\([^)]*\)/g, "").trim() || name,
        index: Math.round(rawScore * 10) / 10,
        creator,
      });
    }
  }

  const fetchedAtStr = typeof root?.fetched_at === "string" ? root.fetched_at : null;
  const source =
    typeof root?.source === "string" && root.source.trim()
      ? root.source.trim()
      : "artificialanalysis.ai";
  const attribution =
    typeof root?.attribution === "string" && root.attribution.trim()
      ? root.attribution.trim()
      : "Data from Artificial Analysis (https://artificialanalysis.ai/).";

  return {
    source,
    sourceDate: fetchedAtStr,
    attribution,
    maxScore,
    entries: [...byKey.values()],
  };
}

export function parseOpenCodeModelsPricing(
  payload: unknown,
  routeProviderId: "opencode" | "opencode-go",
): RawPriceEntry[] {
  const root =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const data = Array.isArray(root?.data) ? root.data : [];
  const entries: RawPriceEntry[] = [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.type === "string" && record.type !== "chat") continue;

    const slug = typeof record.id === "string" ? record.id.trim() : "";
    if (!slug) continue;

    const cost = record.cost && typeof record.cost === "object"
      ? (record.cost as Record<string, unknown>)
      : null;
    const textCost = cost?.text && typeof cost.text === "object"
      ? (cost.text as Record<string, unknown>)
      : null;
    const inputObj = textCost?.input && typeof textCost.input === "object"
      ? (textCost.input as Record<string, unknown>)
      : null;
    const outputObj = textCost?.output && typeof textCost.output === "object"
      ? (textCost.output as Record<string, unknown>)
      : null;

    const input =
      typeof inputObj?.price === "number" && Number.isFinite(inputObj.price)
        ? inputObj.price
        : null;
    const output =
      typeof outputObj?.price === "number" && Number.isFinite(outputObj.price)
        ? outputObj.price
        : null;
    if (input === null && output === null) continue;

    const inRate = input ?? 0;
    const outRate = output ?? 0;
    const blended = Math.round(((3 * inRate + outRate) / 4) * 100) / 100;

    const goObj = record.go && typeof record.go === "object"
      ? (record.go as Record<string, unknown>)
      : null;
    const monthlyUsage = goObj?.monthly_usage && typeof goObj.monthly_usage === "object"
      ? (goObj.monthly_usage as Record<string, unknown>)
      : null;
    const goMonthlyLimit =
      routeProviderId === "opencode-go" &&
      typeof monthlyUsage?.go === "number" &&
      Number.isFinite(monthlyUsage.go) &&
      monthlyUsage.go > 0
        ? monthlyUsage.go
        : null;
    const goAllowancePctPer1M =
      goMonthlyLimit !== null && blended > 0
        ? Math.round((blended / goMonthlyLimit) * 10_000) / 100
        : goMonthlyLimit !== null && blended === 0
          ? 0
          : null;

    const displayName =
      typeof record.name === "string" && record.name.trim() ? record.name.trim() : slug;
    const normKey = normalizeModelName(displayName) || normalizeModelName(slug);

    entries.push({
      routeProviderId,
      modelSlug: slug,
      displayName,
      normKey,
      input: Math.round(inRate * 1000) / 1000,
      output: Math.round(outRate * 1000) / 1000,
      blended,
      goMonthlyLimit,
      goAllowancePctPer1M,
    });
  }

  return entries;
}

export function buildScoreMap(
  entries: RawBenchmarkEntry[],
  maxScore: number,
): Record<string, ScoredModel> {
  const scores: Record<string, ScoredModel> = {};
  for (const entry of entries) {
    scores[entry.normKey] = {
      tier: scoreToTier(entry.index, maxScore),
      index: entry.index,
      aaName: entry.name,
      creator: entry.creator,
    };
  }
  return scores;
}

export function buildPriceMaps(entries: RawPriceEntry[]): {
  byRoute: Record<string, PricedModel>;
  byNorm: Record<string, PricedModel>;
} {
  const byRoute: Record<string, PricedModel> = {};
  const byNorm: Record<string, PricedModel> = {};

  for (const entry of entries) {
    const tier =
      entry.goAllowancePctPer1M !== null
        ? goAllowancePctToTier(entry.goAllowancePctPer1M)
        : blendedCostToTier(entry.blended);
    const priced: PricedModel = {
      tier,
      label: COST_LABELS[tier],
      input: entry.input,
      output: entry.output,
      blended: entry.blended,
      goMonthlyLimit: entry.goMonthlyLimit,
      goAllowancePctPer1M: entry.goAllowancePctPer1M,
    };

    const exactRouteKey = recentModelKey(entry.displayName, entry.routeProviderId);
    byRoute[exactRouteKey] = priced;

    const normRoute = routeNormKey(entry.routeProviderId, entry.displayName);
    if (!byRoute[normRoute]) {
      byRoute[normRoute] = priced;
    }

    const slugRoute = routeNormKey(entry.routeProviderId, entry.modelSlug);
    if (!byRoute[slugRoute]) {
      byRoute[slugRoute] = priced;
    }

    if (entry.normKey && entry.routeProviderId === "opencode") {
      byNorm[entry.normKey] = priced;
    }
  }

  return { byRoute, byNorm };
}

export function lookupScore(
  scores: Record<string, ScoredModel>,
  displayName: string,
  modelId?: string | null,
): ScoredModel | null {
  const primary = normalizeModelName(displayName);
  if (primary && scores[primary]) return scores[primary];
  if (modelId) {
    const slug = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    const secondary = normalizeModelName(slug);
    if (secondary && scores[secondary]) return scores[secondary];
  }
  return null;
}

export function lookupPrice(
  pricesByRoute: Record<string, PricedModel>,
  pricesByNorm: Record<string, PricedModel>,
  displayName: string,
  routeProviderId: string,
): PricedModel | null {
  if (/\bfree\b/i.test(displayName)) {
    return {
      tier: 0,
      label: "Free",
      input: 0,
      output: 0,
      blended: 0,
      goMonthlyLimit: null,
      goAllowancePctPer1M: null,
    };
  }
  const exact = pricesByRoute[recentModelKey(displayName, routeProviderId)];
  if (exact) return exact;
  const routeNorm = pricesByRoute[routeNormKey(routeProviderId, displayName)];
  if (routeNorm) return routeNorm;
  const norm = normalizeModelName(displayName);
  if (norm && pricesByNorm[norm]) return pricesByNorm[norm];
  return null;
}

export function upsertRecentModel(
  current: RecentModel[],
  next: Omit<RecentModel, "key">,
  maxHistory = 20,
): RecentModel[] {
  const key = recentModelKey(next.displayName, next.routeProviderId);
  const filtered = current.filter((item) => item.key !== key);
  return [{ ...next, key }, ...filtered].slice(0, maxHistory);
}
