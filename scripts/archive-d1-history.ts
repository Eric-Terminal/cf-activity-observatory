import type { ArchiveRecord, RawArchiveDataset } from "@/shared/archive-records";
import {
  archiveStoredDetailRows,
  type ArchiveManifestRow,
  verifyArchiveObject,
} from "@/worker/archive";
import { mapEvent, mapRequest } from "@/worker/db";
import { HOUR_MS, sanitizeError } from "@/worker/utils";

type HistoryEnv = Pick<Env, "DB" | "ARCHIVES"> & { HISTORY_TOKEN?: string };
type HistoryCursor = { dataset: RawArchiveDataset; zoneId: string; hourStart: number };

interface HistoryHourRow {
  dataset: RawArchiveDataset;
  zone_id: string;
  hour_start: number;
}

const MAX_BACKFILL_HOURS = 1;
const MAX_VERIFY_OBJECTS = 20;

export default {
  async fetch(request: Request, env: HistoryEnv): Promise<Response> {
    const url = new URL(request.url);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!local && (!env.HISTORY_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.HISTORY_TOKEN}`)) {
      return json({ error: "历史补档凭据无效" }, 403);
    }
    try {
      if (request.method === "POST" && url.pathname === "/backfill") {
        return json(await backfillPage(env, await request.json()));
      }
      if (request.method === "GET" && url.pathname === "/verify") {
        return json(await verifyPage(env, url.searchParams.get("after") ?? ""));
      }
      return json({ error: "运维端点不存在" }, 404);
    } catch (error) {
      return json({ error: sanitizeError(error) }, 500);
    }
  },
} satisfies ExportedHandler<HistoryEnv>;

async function backfillPage(env: HistoryEnv, input: unknown): Promise<{
  items: Array<HistoryCursor & { d1Records: number; changedRecords: number }>;
  next: HistoryCursor | null;
}> {
  const after = parseCursor(input);
  const hours = await env.DB.prepare(
    `SELECT dataset, zone_id, hour_start FROM (
       SELECT 'httpRequestsAdaptive' AS dataset, zone_id,
         occurred_at - (occurred_at % 3600000) AS hour_start
       FROM request_samples
       UNION ALL
       SELECT 'firewallEventsAdaptive' AS dataset, zone_id,
         occurred_at - (occurred_at % 3600000) AS hour_start
       FROM security_events
     ) GROUP BY dataset, zone_id, hour_start
     ORDER BY dataset, zone_id, hour_start`,
  ).all<HistoryHourRow>();
  const selected = hours.results
    .filter((item) => !after || compareCursor(toCursor(item), after) > 0)
    .slice(0, MAX_BACKFILL_HOURS);
  const items = [];
  for (const hour of selected) {
    const records = await readD1Hour(env.DB, hour);
    const changedRecords = await archiveStoredDetailRows(env, hour.dataset, hour.zone_id, records);
    items.push({ ...toCursor(hour), d1Records: records.length, changedRecords });
  }
  return { items, next: selected.length === MAX_BACKFILL_HOURS ? toCursor(selected.at(-1)!) : null };
}

async function readD1Hour(database: D1Database, hour: HistoryHourRow): Promise<ArchiveRecord[]> {
  const end = hour.hour_start + HOUR_MS;
  if (hour.dataset === "httpRequestsAdaptive") {
    const result = await database.prepare(
      `SELECT * FROM request_samples
       WHERE zone_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at, id`,
    ).bind(hour.zone_id, hour.hour_start, end).all<Parameters<typeof mapRequest>[0]>();
    return result.results.map(mapRequest);
  }
  const result = await database.prepare(
    `SELECT * FROM security_events
     WHERE zone_id = ? AND occurred_at >= ? AND occurred_at < ?
     ORDER BY occurred_at, id`,
  ).bind(hour.zone_id, hour.hour_start, end).all<Parameters<typeof mapEvent>[0]>();
  return result.results.map(mapEvent);
}

async function verifyPage(env: HistoryEnv, after: string): Promise<{
  objects: number;
  records: number;
  compressedBytes: number;
  next: string | null;
}> {
  const result = await env.DB.prepare(
    `SELECT id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, schema_version, status, archived_at, verified_at, pruned_at
     FROM archive_manifests
     WHERE status = 'verified' AND id > ?
     ORDER BY id LIMIT ?`,
  ).bind(after, MAX_VERIFY_OBJECTS).all<ArchiveManifestRow>();
  let records = 0;
  let compressedBytes = 0;
  for (const manifest of result.results) {
    const verification = await verifyArchiveObject(env.ARCHIVES, manifest);
    records += verification.records;
    compressedBytes += verification.compressedBytes;
  }
  return {
    objects: result.results.length,
    records,
    compressedBytes,
    next: result.results.length === MAX_VERIFY_OBJECTS ? result.results.at(-1)!.id : null,
  };
}

function parseCursor(value: unknown): HistoryCursor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const after = (value as { after?: unknown }).after;
  if (after === undefined || after === null) return null;
  if (typeof after !== "object" || after === null || Array.isArray(after)) throw new Error("补档游标无效");
  const cursor = after as Partial<HistoryCursor>;
  if (
    (cursor.dataset !== "httpRequestsAdaptive" && cursor.dataset !== "firewallEventsAdaptive")
    || typeof cursor.zoneId !== "string"
    || typeof cursor.hourStart !== "number"
    || !Number.isInteger(cursor.hourStart)
  ) throw new Error("补档游标无效");
  return cursor as HistoryCursor;
}

function toCursor(row: HistoryHourRow): HistoryCursor {
  return { dataset: row.dataset, zoneId: row.zone_id, hourStart: row.hour_start };
}

function compareCursor(left: HistoryCursor, right: HistoryCursor): number {
  return left.dataset.localeCompare(right.dataset)
    || left.zoneId.localeCompare(right.zoneId)
    || left.hourStart - right.hourStart;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
