import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface OpenCodeUsageEntry {
  modelId: string;
  routeProviderId: string;
  usedAt: number;
}

export function resolveOpenCodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  const baseDir = xdgDataHome || path.join(homedir(), ".local", "share");
  return path.join(baseDir, "opencode", "opencode.db");
}

export function readOpenCodeDbRecentModels(
  limit = 20,
  dbPath = resolveOpenCodeDbPath(),
): OpenCodeUsageEntry[] {
  if (!existsSync(dbPath)) return [];

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `
        SELECT
          json_extract(data, '$.model.providerID') AS providerId,
          json_extract(data, '$.model.id') AS modelId,
          time_created AS usedAt
        FROM session_message
        WHERE type = 'assistant'
        ORDER BY time_created DESC
        LIMIT 1000
      `,
      )
      .all() as Array<{
      providerId: unknown;
      modelId: unknown;
      usedAt: unknown;
    }>;

    const results: OpenCodeUsageEntry[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const routeProviderId = typeof row.providerId === "string" ? row.providerId.trim() : "";
      const rawModelId = typeof row.modelId === "string" ? row.modelId.trim() : "";
      const usedAt = typeof row.usedAt === "number" && Number.isFinite(row.usedAt) ? row.usedAt : 0;
      if (!routeProviderId || !rawModelId) continue;

      const modelId = rawModelId.includes("/") ? rawModelId : `${routeProviderId}/${rawModelId}`;
      const dedupeKey = modelId.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({ modelId, routeProviderId, usedAt });
      if (results.length >= limit) break;
    }

    return results;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
