import type { DatasetName } from "@/shared/contracts";
import { incrementUsage, recordD1Usage } from "@/worker/db";
import { evaluateAlerts } from "@/worker/alerts";
import { d1WritesPaused } from "@/worker/budgets";
import { bytesToBase64Url, DAY_MS, floorTo, HOUR_MS, nowMs, stableId } from "@/worker/utils";

const ARCHIVE_SCHEMA_VERSION = 1;
const REWRITE_WINDOW_MS = 48 * HOUR_MS;

interface ArchiveCandidate {
  zone_id: string;
  dataset: "httpRequestsAdaptive" | "firewallEventsAdaptive";
  hour_start: number;
}

interface ArchiveManifestRow {
  id: string;
  zone_id: string;
  dataset: DatasetName;
  range_start: number;
  range_end: number;
  r2_key: string;
  record_count: number;
  compressed_bytes: number;
  sha256: string;
  etag: string | null;
  status: string;
  archived_at: number;
  verified_at: number | null;
  pruned_at: number | null;
}

export async function runMaintenance(env: Env, scheduledAt = nowMs()): Promise<void> {
  if (!(await d1WritesPaused(env.DB))) {
    await rollupMetrics(env.DB, scheduledAt);
    const candidates = await findArchiveCandidates(env.DB, scheduledAt);
    for (const candidate of candidates) await archiveHour(env, candidate, scheduledAt);
    await pruneArchivedDetails(env, scheduledAt);
  }
  await evaluateAlerts(env);
  await env.DB.prepare("DELETE FROM app_settings WHERE key LIKE 'graphql_budget:%' AND updated_at < ?")
    .bind(scheduledAt - DAY_MS)
    .run();
}

export async function listArchives(database: D1Database, limit = 200): Promise<ArchiveManifestRow[]> {
  const result = await database.prepare(
    `SELECT id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, status, archived_at, verified_at, pruned_at
     FROM archive_manifests ORDER BY range_start DESC LIMIT ?`,
  )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<ArchiveManifestRow>();
  return result.results;
}

export async function getArchive(database: D1Database, id: string): Promise<ArchiveManifestRow | null> {
  return database.prepare(
    `SELECT id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, status, archived_at, verified_at, pruned_at FROM archive_manifests WHERE id = ?`,
  )
    .bind(id)
    .first<ArchiveManifestRow>();
}

async function findArchiveCandidates(database: D1Database, timestamp: number): Promise<ArchiveCandidate[]> {
  const completeHour = floorTo(timestamp, HOUR_MS);
  const requests = await database.prepare(
    `WITH hours AS (
       SELECT zone_id, CAST(occurred_at / 3600000 AS INTEGER) * 3600000 AS hour_start
       FROM request_samples WHERE occurred_at < ? GROUP BY zone_id, hour_start
     )
     SELECT h.zone_id, 'httpRequestsAdaptive' AS dataset, h.hour_start
     FROM hours h LEFT JOIN archive_manifests m
       ON m.zone_id = h.zone_id AND m.dataset = 'httpRequestsAdaptive' AND m.range_start = h.hour_start
     WHERE m.status IS NULL OR h.hour_start >= ?
     ORDER BY CASE WHEN m.status IS NULL THEN 0 ELSE 1 END, h.hour_start ASC LIMIT 12`,
  )
    .bind(completeHour, timestamp - REWRITE_WINDOW_MS)
    .all<ArchiveCandidate>();
  const remaining = Math.max(0, 24 - requests.results.length);
  const events = remaining
    ? await database.prepare(
        `WITH hours AS (
           SELECT zone_id, CAST(occurred_at / 3600000 AS INTEGER) * 3600000 AS hour_start
           FROM security_events WHERE occurred_at < ? GROUP BY zone_id, hour_start
         )
         SELECT h.zone_id, 'firewallEventsAdaptive' AS dataset, h.hour_start
         FROM hours h LEFT JOIN archive_manifests m
           ON m.zone_id = h.zone_id AND m.dataset = 'firewallEventsAdaptive' AND m.range_start = h.hour_start
         WHERE m.status IS NULL OR h.hour_start >= ?
         ORDER BY CASE WHEN m.status IS NULL THEN 0 ELSE 1 END, h.hour_start ASC LIMIT ?`,
      )
        .bind(completeHour, timestamp - REWRITE_WINDOW_MS, remaining)
        .all<ArchiveCandidate>()
    : { results: [] as ArchiveCandidate[] };
  return [...requests.results, ...events.results];
}

async function archiveHour(env: Env, candidate: ArchiveCandidate, timestamp: number): Promise<void> {
  const end = candidate.hour_start + HOUR_MS;
  const key = archiveKey(candidate.zone_id, candidate.dataset, candidate.hour_start);
  const existing = await env.DB.prepare("SELECT status, archived_at FROM archive_manifests WHERE r2_key = ?")
    .bind(key)
    .first<{ status: string; archived_at: number }>();
  if (existing?.status === "verified" && candidate.hour_start < timestamp - REWRITE_WINDOW_MS) return;

  const table = candidate.dataset === "httpRequestsAdaptive" ? "request_samples" : "security_events";
  const rows = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE zone_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id`,
  )
    .bind(candidate.zone_id, candidate.hour_start, end)
    .all<Record<string, unknown>>();
  if (!rows.results.length) return;
  const header = {
    type: "cf-activity-observatory/archive",
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    zoneId: candidate.zone_id,
    dataset: candidate.dataset,
    rangeStart: new Date(candidate.hour_start).toISOString(),
    rangeEnd: new Date(end).toISOString(),
    generatedAt: new Date(timestamp).toISOString(),
  };
  const ndjson = `${JSON.stringify(header)}\n${rows.results.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const compressed = await gzip(new TextEncoder().encode(ndjson));
  const checksum = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", exactBuffer(compressed))));
  const object = await env.ARCHIVES.put(key, compressed, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    customMetadata: {
      schemaVersion: String(ARCHIVE_SCHEMA_VERSION),
      zoneId: candidate.zone_id,
      dataset: candidate.dataset,
      sha256: checksum,
      records: String(rows.results.length),
    },
  });
  const head = await env.ARCHIVES.head(key);
  if (!head || head.size !== compressed.byteLength) throw new Error(`归档写入后校验失败：${key}`);
  const manifestId = stableId(candidate.zone_id, candidate.dataset, candidate.hour_start);
  await env.DB.prepare(
    `INSERT INTO archive_manifests
     (id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, schema_version, status, archived_at, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)
     ON CONFLICT(r2_key) DO UPDATE SET record_count = excluded.record_count,
      compressed_bytes = excluded.compressed_bytes, sha256 = excluded.sha256, etag = excluded.etag,
      schema_version = excluded.schema_version, status = 'verified', archived_at = excluded.archived_at,
      verified_at = excluded.verified_at`,
  )
    .bind(
      manifestId,
      candidate.zone_id,
      candidate.dataset,
      candidate.hour_start,
      end,
      key,
      rows.results.length,
      compressed.byteLength,
      checksum,
      object?.etag ?? head.etag,
      ARCHIVE_SCHEMA_VERSION,
      timestamp,
      timestamp,
    )
    .run();
  await incrementUsage(env.DB, { r2ClassA: 1, r2ClassB: 1, r2BytesWritten: compressed.byteLength });
}

async function pruneArchivedDetails(env: Env, timestamp: number): Promise<void> {
  const zones = await env.DB.prepare("SELECT id, detail_retention_days FROM zones")
    .all<{ id: string; detail_retention_days: number }>();
  const d1Size = await env.DB.prepare("SELECT MAX(d1_size_after) AS size FROM usage_daily")
    .first<{ size: number | null }>();
  const overWaterline = (d1Size?.size ?? 0) >= Number(env.D1_WARNING_BYTES);
  for (const zone of zones.results) {
    const cutoff = overWaterline
      ? floorTo(timestamp, HOUR_MS)
      : floorTo(timestamp - zone.detail_retention_days * DAY_MS, HOUR_MS);
    for (const [dataset, table] of [
      ["httpRequestsAdaptive", "request_samples"],
      ["firewallEventsAdaptive", "security_events"],
    ] as const) {
      const manifests = await env.DB.prepare(
        `SELECT id, range_start, range_end FROM archive_manifests
         WHERE zone_id = ? AND dataset = ? AND status = 'verified' AND pruned_at IS NULL AND range_end <= ?
         ORDER BY range_start LIMIT 24`,
      )
        .bind(zone.id, dataset, cutoff)
        .all<{ id: string; range_start: number; range_end: number }>();
      for (const manifest of manifests.results) {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM ${table} WHERE zone_id = ? AND occurred_at >= ? AND occurred_at < ?`).bind(
            zone.id,
            manifest.range_start,
            manifest.range_end,
          ),
          env.DB.prepare("UPDATE archive_manifests SET pruned_at = ? WHERE id = ?").bind(timestamp, manifest.id),
        ]);
      }
    }
  }
}

async function rollupMetrics(database: D1Database, timestamp: number): Promise<void> {
  await compactMetricTier(database, timestamp, 300, 3600, 90);
  await compactMetricTier(database, timestamp, 3600, 86400, 730);
}

async function compactMetricTier(
  database: D1Database,
  timestamp: number,
  sourceSeconds: 300 | 3600,
  targetSeconds: 3600 | 86400,
  minimumAgeDays: number,
): Promise<void> {
  const targetMs = targetSeconds * 1000;
  const cutoff = floorTo(timestamp - minimumAgeDays * DAY_MS, targetMs);
  const noFinerData = sourceSeconds === 3600
    ? `AND NOT EXISTS (
        SELECT 1 FROM metric_buckets finer
        WHERE finer.bucket_seconds = 300
          AND finer.bucket_start >= CAST(source.bucket_start / 86400000 AS INTEGER) * 86400000
          AND finer.bucket_start < (CAST(source.bucket_start / 86400000 AS INTEGER) + 1) * 86400000
      )`
    : "";
  const oldest = await database.prepare(
    `SELECT MIN(source.bucket_start) AS bucket_start
     FROM metric_buckets source
     WHERE source.bucket_seconds = ? AND source.bucket_start < ? ${noFinerData}`,
  )
    .bind(sourceSeconds, cutoff)
    .first<{ bucket_start: number | null }>();
  if (oldest?.bucket_start === null || oldest?.bucket_start === undefined) return;

  const targetStart = floorTo(oldest.bucket_start, targetMs);
  const targetEnd = targetStart + targetMs;
  // 插入与删除同处一个 D1 batch，老化过程中不会出现双份数据，也不会因中途失败丢失源桶。
  const results = await database.batch([
    database.prepare(
      `INSERT INTO metric_buckets
       (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, host, country, asn,
        method, protocol, edge_status, origin_status, status_class, cache_status, security_action, security_source,
        request_source, dimension_type, dimension_value, estimated_count, sample_interval, confidence_estimate,
        confidence_lower, confidence_upper, confidence_sample_size, edge_response_bytes, visits, updated_at)
       SELECT zone_id, ?, ?, metric_kind, dimension_signature, host, country, asn,
        method, protocol, edge_status, origin_status, status_class, cache_status, security_action, security_source,
        request_source, dimension_type, dimension_value, SUM(estimated_count), AVG(sample_interval),
        SUM(confidence_estimate), SUM(confidence_lower), SUM(confidence_upper), SUM(confidence_sample_size),
        SUM(edge_response_bytes), SUM(visits), ?
       FROM metric_buckets
       WHERE bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?
       GROUP BY zone_id, metric_kind, dimension_signature
       ON CONFLICT(zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature) DO UPDATE SET
        estimated_count = excluded.estimated_count, sample_interval = excluded.sample_interval,
        confidence_estimate = excluded.confidence_estimate, confidence_lower = excluded.confidence_lower,
        confidence_upper = excluded.confidence_upper, confidence_sample_size = excluded.confidence_sample_size,
        edge_response_bytes = excluded.edge_response_bytes, visits = excluded.visits, updated_at = excluded.updated_at`,
    ).bind(targetStart, targetSeconds, timestamp, sourceSeconds, targetStart, targetEnd),
    database.prepare(
      "DELETE FROM metric_buckets WHERE bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?",
    ).bind(sourceSeconds, targetStart, targetEnd),
  ]);
  await recordD1Usage(database, results.map((result) => result.meta));
}

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([exactBuffer(input)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function archiveKey(zoneId: string, dataset: string, timestamp: number): string {
  const date = new Date(timestamp);
  const parts = [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0"),
  ];
  return `archives/${zoneId}/${dataset}/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}.ndjson.gz`;
}
