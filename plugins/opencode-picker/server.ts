import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readOpenCodeDbRecentModels } from "./src/opencode-history.ts";
import {
  buildGoModelKeys,
  buildPriceMaps,
  buildScoreMap,
  DEFAULT_BENCHMARK_URL,
  isGoPlanModel,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_MODELS_URL,
  parseBenchmarkPayload,
  parseOpenCodeModelsPricing,
  recentModelKey,
  upsertRecentModel,
  type RawBenchmarkEntry,
  type RawPriceEntry,
  type RecentModel,
} from "./src/scoring.ts";

const OPENCODE_PROVIDER_ID = "acp-opencode";
const RECENT_KV_KEY = "opencode-recent-models-v2";
const CLEARED_AT_KV_KEY = "opencode-recent-cleared-at";
const BENCHMARK_KV_KEY = "benchmark-cache";
const PRICING_KV_KEY = "opencode-pricing-cache-v2";
const PICKER_UPDATED_CHANNEL = "picker-updated";
const ARTIFICIAL_ANALYSIS_API_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
const DB_HISTORY_CACHE_MS = 15_000;

const recentModelSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  routeProviderId: z.string(),
  modelId: z.string().nullable(),
  usedAt: z.number(),
});

const scoredModelSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  index: z.number(),
  aaName: z.string(),
  creator: z.string().nullable(),
});

const pricedModelSchema = z.object({
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  label: z.string(),
  input: z.number(),
  output: z.number(),
  blended: z.number(),
  goMonthlyLimit: z.number().nullable(),
  goAllowancePctPer1M: z.number().nullable(),
});

const pickerStateSchema = z.object({
  recent: z.array(recentModelSchema),
  recentCount: z.number().int().min(1).max(10),
  goModelsOnly: z.boolean(),
  goModelKeys: z.array(z.string()),
  scores: z.record(z.string(), scoredModelSchema),
  pricesByRoute: z.record(z.string(), pricedModelSchema),
  pricesByNorm: z.record(z.string(), pricedModelSchema),
  maxScore: z.number(),
  fetchedAt: z.number().nullable(),
  pricingFetchedAt: z.number().nullable(),
  source: z.string().nullable(),
  sourceDate: z.string().nullable(),
  attribution: z.string().nullable(),
  error: z.string().nullable(),
});

export type PickerState = z.infer<typeof pickerStateSchema>;

export const rpcContract = defineRpcContract({
  state: {
    input: z.null(),
    output: pickerStateSchema,
  },
  clearRecent: {
    input: z.null(),
    output: z.array(recentModelSchema),
  },
  refreshBenchmarks: {
    input: z.null(),
    output: pickerStateSchema,
  },
});

interface BenchmarkCacheRecord {
  fetchedAt: number;
  source: string;
  sourceDate: string | null;
  attribution: string;
  maxScore: number;
  entries: RawBenchmarkEntry[];
}

interface PricingCacheRecord {
  fetchedAt: number;
  entries: RawPriceEntry[];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    recentCount: {
      type: "number",
      label: "Pinned recent models",
      description:
        "How many recently used OpenCode models to pin under Recent at the top of the picker.",
      experimental_schema: z.number().int().min(1).max(10),
      default: 4,
    },
    goModelsOnly: {
      type: "boolean",
      label: "Go plan models only",
      description:
        "Only list models offered on the OpenCode Go plan, taken from OpenCode's live Go catalog. Hides Zen pay-per-token and Claude/OpenAI routes; if the catalog cannot be fetched, the full model list is shown.",
      default: true,
    },
    benchmarkUrl: {
      type: "string",
      label: "Benchmark JSON URL",
      description:
        "Free daily mirror of the Artificial Analysis Intelligence Index v5. Used automatically when no API key is set.",
      default: DEFAULT_BENCHMARK_URL,
    },
    artificialAnalysisApiKey: {
      type: "string",
      label: "Artificial Analysis API key (optional)",
      description:
        "Optional free API key from artificialanalysis.ai. When set, scores are fetched directly from Artificial Analysis first.",
      secret: true,
    },
    cacheHours: {
      type: "number",
      label: "Benchmark & pricing cache hours",
      description: "Hours to cache benchmark scores and pricing before refreshing in the background.",
      experimental_schema: z.number().int().min(1).max(168),
      default: 6,
    },
  });

  let lastBenchmarkError: string | null = null;
  let refreshInFlight: Promise<BenchmarkCacheRecord | null> | null = null;
  let pricingRefreshInFlight: Promise<PricingCacheRecord | null> | null = null;
  let catalogCache: Map<string, { displayName: string; routeProviderId: string }> | null = null;
  let catalogFetchedAt = 0;
  let dbHistoryCache: { fetchedAt: number; entries: RecentModel[] } | null = null;

  async function readStoredRecent(): Promise<RecentModel[]> {
    const stored = await bb.storage.kv.get<RecentModel[]>(RECENT_KV_KEY);
    return Array.isArray(stored) ? stored : [];
  }

  async function readClearedAt(): Promise<number> {
    const clearedAt = await bb.storage.kv.get<number>(CLEARED_AT_KV_KEY);
    return typeof clearedAt === "number" && Number.isFinite(clearedAt) ? clearedAt : 0;
  }

  async function writeStoredRecent(items: RecentModel[]): Promise<RecentModel[]> {
    await bb.storage.kv.set(RECENT_KV_KEY, items);
    bb.realtime.publish(PICKER_UPDATED_CHANNEL, null);
    return items;
  }

  async function getOpenCodeCatalogMap(): Promise<
    Map<string, { displayName: string; routeProviderId: string }>
  > {
    if (catalogCache && Date.now() - catalogFetchedAt < 10 * 60_000) {
      return catalogCache;
    }
    const map = new Map<string, { displayName: string; routeProviderId: string }>();
    try {
      const response = (await bb.sdk.providers.models({
        providerId: OPENCODE_PROVIDER_ID,
      })) as unknown;
      const models = Array.isArray(response)
        ? response
        : response && typeof response === "object" && Array.isArray((response as { models?: unknown }).models)
          ? (response as { models: Array<{ id?: unknown; displayName?: unknown; routeProviderId?: unknown }> }).models
          : [];
      for (const model of models) {
        if (typeof model?.id === "string" && typeof model?.displayName === "string") {
          const routeProviderId =
            typeof model.routeProviderId === "string" && model.routeProviderId
              ? model.routeProviderId
              : model.id.includes("/")
                ? model.id.split("/")[0]
                : "opencode";
          map.set(model.id, { displayName: model.displayName, routeProviderId });
        }
      }
      catalogCache = map;
      catalogFetchedAt = Date.now();
    } catch (error) {
      bb.log.warn(`Could not read OpenCode model catalog: ${String(error)}`);
    }
    return map;
  }

  function resolveCatalogEntry(
    catalog: Map<string, { displayName: string; routeProviderId: string }>,
    modelId: string,
    fallbackRouteProviderId?: string,
  ): { displayName: string; routeProviderId: string } {
    const resolved = catalog.get(modelId);
    if (resolved) return resolved;
    const routeProviderId =
      fallbackRouteProviderId || (modelId.includes("/") ? modelId.split("/")[0] : "opencode");
    const displayName = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
    return { displayName, routeProviderId };
  }

  async function readDbRecentModels(force = false): Promise<RecentModel[]> {
    if (!force && dbHistoryCache && Date.now() - dbHistoryCache.fetchedAt < DB_HISTORY_CACHE_MS) {
      return dbHistoryCache.entries;
    }

    const rawEntries = readOpenCodeDbRecentModels(20);
    if (rawEntries.length === 0) {
      dbHistoryCache = { fetchedAt: Date.now(), entries: [] };
      return [];
    }

    const catalog = await getOpenCodeCatalogMap();
    const entries: RecentModel[] = rawEntries.map((entry) => {
      const { displayName, routeProviderId } = resolveCatalogEntry(
        catalog,
        entry.modelId,
        entry.routeProviderId,
      );
      return {
        key: recentModelKey(displayName, routeProviderId),
        displayName,
        routeProviderId,
        modelId: entry.modelId,
        usedAt: entry.usedAt,
      };
    });

    dbHistoryCache = { fetchedAt: Date.now(), entries };
    return entries;
  }

  async function getMergedRecent(forceDb = false): Promise<RecentModel[]> {
    const [stored, dbEntries, clearedAt] = await Promise.all([
      readStoredRecent(),
      readDbRecentModels(forceDb),
      readClearedAt(),
    ]);

    const byKey = new Map<string, RecentModel>();
    for (const item of [...dbEntries, ...stored]) {
      if (clearedAt > 0 && item.usedAt <= clearedAt) continue;
      const existing = byKey.get(item.key);
      if (!existing || item.usedAt > existing.usedAt) {
        byKey.set(item.key, item);
      }
    }

    return [...byKey.values()].sort((a, b) => b.usedAt - a.usedAt);
  }

  async function recordModelById(modelId: string | null | undefined, usedAt = Date.now()) {
    if (!modelId) return;
    const catalog = await getOpenCodeCatalogMap();
    const { displayName, routeProviderId } = resolveCatalogEntry(catalog, modelId);
    const current = await readStoredRecent();
    const updated = upsertRecentModel(current, {
      displayName,
      routeProviderId,
      modelId,
      usedAt,
    });
    dbHistoryCache = null;
    await writeStoredRecent(updated);
  }

  async function recordModelForThread(threadId: string, usedAt = Date.now()) {
    try {
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      const modelId = typeof options?.model === "string" ? options.model : null;
      if (modelId) {
        await recordModelById(modelId, usedAt);
      }
    } catch (error) {
      bb.log.debug(`Could not read execution options for thread ${threadId}: ${String(error)}`);
    }
  }

  async function seedRecentFromBbThreadsIfNeeded() {
    const dbEntries = await readDbRecentModels(true);
    if (dbEntries.length >= 4) return;

    const existing = await readStoredRecent();
    if (existing.length >= 4) return;

    try {
      const [activeThreads, archivedThreads] = await Promise.all([
        bb.sdk.threads.list({ archived: false, limit: 80 }),
        bb.sdk.threads.list({ archived: true, limit: 80 }),
      ]);
      const opencodeThreads = [
        ...(Array.isArray(activeThreads) ? activeThreads : []),
        ...(Array.isArray(archivedThreads) ? archivedThreads : []),
      ]
        .filter((thread) => thread.providerId === OPENCODE_PROVIDER_ID)
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
        .slice(0, 20);

      if (opencodeThreads.length === 0) return;

      const catalog = await getOpenCodeCatalogMap();
      let seeded = existing;

      for (const thread of opencodeThreads.reverse()) {
        try {
          const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: thread.id });
          const modelId = typeof options?.model === "string" ? options.model : null;
          if (!modelId) continue;
          const { displayName, routeProviderId } = resolveCatalogEntry(catalog, modelId);
          const usedAt = thread.updatedAt ?? thread.createdAt ?? Date.now();
          seeded = upsertRecentModel(seeded, {
            displayName,
            routeProviderId,
            modelId,
            usedAt,
          });
        } catch {
          continue;
        }
      }

      if (seeded.length > existing.length) {
        await writeStoredRecent(seeded);
      }
    } catch (error) {
      bb.log.warn(`Failed to seed recent OpenCode models from BB threads: ${String(error)}`);
    }
  }

  async function fetchBenchmarksFromSource(): Promise<BenchmarkCacheRecord> {
    const { benchmarkUrl, artificialAnalysisApiKey } = await settings.get();
    const apiKey =
      typeof artificialAnalysisApiKey === "string" ? artificialAnalysisApiKey.trim() : "";

    const attempts: Array<{ url: string; headers: Record<string, string>; label: string }> = [];
    if (apiKey) {
      attempts.push({
        url: ARTIFICIAL_ANALYSIS_API_URL,
        headers: { "x-api-key": apiKey, accept: "application/json" },
        label: "Artificial Analysis API",
      });
    }
    const mirrorUrl = benchmarkUrl.trim() || DEFAULT_BENCHMARK_URL;
    attempts.push({
      url: mirrorUrl,
      headers: { accept: "application/json" },
      label: mirrorUrl,
    });

    let lastError: Error | null = null;
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url, {
          headers: attempt.headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(`${attempt.label} returned HTTP ${response.status}`);
        }
        const json = (await response.json()) as unknown;
        const parsed = parseBenchmarkPayload(json);
        if (parsed.entries.length === 0) {
          throw new Error(`${attempt.label} returned no scored models`);
        }
        const record: BenchmarkCacheRecord = {
          fetchedAt: Date.now(),
          source: parsed.source,
          sourceDate: parsed.sourceDate,
          attribution: parsed.attribution,
          maxScore: parsed.maxScore,
          entries: parsed.entries,
        };
        await bb.storage.kv.set(BENCHMARK_KV_KEY, record);
        lastBenchmarkError = null;
        bb.realtime.publish(PICKER_UPDATED_CHANNEL, null);
        return record;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        bb.log.warn(`Benchmark fetch failed (${attempt.label}): ${lastError.message}`);
      }
    }

    throw lastError ?? new Error("Unable to fetch benchmark dataset");
  }

  async function fetchPricingFromSource(): Promise<PricingCacheRecord> {
    const [zenRes, goRes] = await Promise.all([
      fetch(OPENCODE_ZEN_MODELS_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      }),
      fetch(OPENCODE_GO_MODELS_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      }),
    ]);

    const entries: RawPriceEntry[] = [];
    if (zenRes.ok) {
      entries.push(...parseOpenCodeModelsPricing(await zenRes.json(), "opencode"));
    }
    if (goRes.ok) {
      entries.push(...parseOpenCodeModelsPricing(await goRes.json(), "opencode-go"));
    }

    if (entries.length === 0) {
      throw new Error(`opencode.ai returned no priced models (zen ${zenRes.status}, go ${goRes.status})`);
    }
    const record: PricingCacheRecord = {
      fetchedAt: Date.now(),
      entries,
    };
    await bb.storage.kv.set(PRICING_KV_KEY, record);
    bb.realtime.publish(PICKER_UPDATED_CHANNEL, null);
    return record;
  }

  async function ensureBenchmarks(force = false): Promise<BenchmarkCacheRecord | null> {
    const cached = await bb.storage.kv.get<BenchmarkCacheRecord>(BENCHMARK_KV_KEY);
    const { cacheHours } = await settings.get();
    const ttlMs = Math.max(1, cacheHours) * 60 * 60 * 1000;
    const isFresh = cached && Date.now() - cached.fetchedAt < ttlMs;

    if (!force && isFresh) {
      return cached;
    }

    if (!refreshInFlight) {
      refreshInFlight = fetchBenchmarksFromSource()
        .catch((error) => {
          lastBenchmarkError = error instanceof Error ? error.message : String(error);
          return cached ?? null;
        })
        .finally(() => {
          refreshInFlight = null;
        });
    }

    if (cached && !force) {
      return cached;
    }

    return refreshInFlight;
  }

  async function ensurePricing(force = false): Promise<PricingCacheRecord | null> {
    const cached = await bb.storage.kv.get<PricingCacheRecord>(PRICING_KV_KEY);
    const { cacheHours } = await settings.get();
    const ttlMs = Math.max(1, cacheHours) * 60 * 60 * 1000;
    const isFresh = cached && Date.now() - cached.fetchedAt < ttlMs;

    if (!force && isFresh) {
      return cached;
    }

    if (!pricingRefreshInFlight) {
      pricingRefreshInFlight = fetchPricingFromSource()
        .catch((error) => {
          bb.log.warn(`Pricing fetch failed: ${String(error)}`);
          return cached ?? null;
        })
        .finally(() => {
          pricingRefreshInFlight = null;
        });
    }

    if (cached && !force) {
      return cached;
    }

    return pricingRefreshInFlight;
  }

  async function buildState(forceRefresh = false): Promise<PickerState> {
    const [{ recentCount, goModelsOnly }, recent, benchmarks, pricing] = await Promise.all([
      settings.get(),
      getMergedRecent(forceRefresh),
      ensureBenchmarks(forceRefresh),
      ensurePricing(forceRefresh),
    ]);

    const goEntries = pricing
      ? pricing.entries.filter((entry) => entry.routeProviderId === "opencode-go")
      : [];
    const goModelKeys = goModelsOnly ? buildGoModelKeys(goEntries) : [];
    const goKeySet = new Set(goModelKeys);
    const filteredRecent =
      goModelsOnly && goKeySet.size > 0
        ? recent.filter((item) =>
            isGoPlanModel(goKeySet, item.displayName, item.routeProviderId, item.modelId),
          )
        : recent;

    const priceMaps = pricing
      ? buildPriceMaps(pricing.entries)
      : { byRoute: {}, byNorm: {} };

    return {
      recent: filteredRecent.slice(0, recentCount),
      recentCount,
      goModelsOnly,
      goModelKeys,
      scores: benchmarks ? buildScoreMap(benchmarks.entries, benchmarks.maxScore) : {},
      pricesByRoute: priceMaps.byRoute,
      pricesByNorm: priceMaps.byNorm,
      maxScore: benchmarks?.maxScore ?? 0,
      fetchedAt: benchmarks?.fetchedAt ?? null,
      pricingFetchedAt: pricing?.fetchedAt ?? null,
      source: benchmarks?.source ?? null,
      sourceDate: benchmarks?.sourceDate ?? null,
      attribution: benchmarks?.attribution ?? null,
      error: lastBenchmarkError,
    };
  }

  bb.events.on("thread.active", ({ thread }) => {
    if (thread.providerId === OPENCODE_PROVIDER_ID) {
      void recordModelForThread(thread.id);
    }
  });

  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.providerId === OPENCODE_PROVIDER_ID) {
      dbHistoryCache = null;
      bb.realtime.publish(PICKER_UPDATED_CHANNEL, null);
    }
  });

  settings.onChange(() => {
    bb.realtime.publish(PICKER_UPDATED_CHANNEL, null);
  });

  bb.rpc.register(rpcContract, {
    state: async () => buildState(false),
    clearRecent: async () => {
      dbHistoryCache = null;
      await bb.storage.kv.set(CLEARED_AT_KV_KEY, Date.now());
      await writeStoredRecent([]);
      return [];
    },
    refreshBenchmarks: async () => buildState(true),
  });

  bb.background.service("warmup", {
    start: async (signal) => {
      if (signal.aborted) return;
      await Promise.all([
        seedRecentFromBbThreadsIfNeeded(),
        ensureBenchmarks(false),
        ensurePricing(false),
      ]);
    },
  });
}
