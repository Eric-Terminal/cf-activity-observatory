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
  const hourCutoff = floorTo(timestamp, HOUR_MS);
  const dayCutoff = floorTo(timestamp, DAY_MS);
  const watermark = await database.prepare(
    "SELECT CAST(value AS INTEGER) AS value FROM app_settings WHERE key = 'metric_rollup_watermark'",
  ).first<{ value: number }>();
  const changedSince = watermark?.value ?? timestamp - 2 * HOUR_MS;
  const metadata: D1Meta[] = [];
  const hourly = await database.prepare(
    `WITH changed AS (
       SELECT DISTINCT zone_id, CAST(bucket_start / 3600000 AS INTEGER) AS hour_key,
        metric_kind, dimension_signature
       FROM metric_buckets
       WHERE bucket_seconds = 300 AND bucket_start < ? AND updated_at > ?
     )
     INSERT INTO metric_buckets
     (id, zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, host, country, asn,
      method, protocol, edge_status, origin_status, status_class, cache_status, security_action, security_source, request_source,
      dimension_type, dimension_value, estimated_count, sample_interval, confidence_estimate, confidence_lower,
      confidence_upper, confidence_sample_size, edge_response_bytes, visits, updated_at)
     SELECT 'h:' || source.zone_id || ':' || changed.hour_key || ':' || source.metric_kind || ':' || source.dimension_signature,
      source.zone_id, changed.hour_key * 3600000, 3600, source.metric_kind, source.dimension_signature,
      source.host, source.country, source.asn, source.method, source.protocol, source.edge_status, source.origin_status,
      source.status_class, source.cache_status, source.security_action, source.security_source, source.request_source,
      source.dimension_type, source.dimension_value, SUM(source.estimated_count), AVG(source.sample_interval),
      SUM(source.confidence_estimate), SUM(source.confidence_lower), SUM(source.confidence_upper),
      SUM(source.confidence_sample_size), SUM(source.edge_response_bytes), SUM(source.visits), ?
     FROM metric_buckets source JOIN changed
       ON changed.zone_id = source.zone_id
      AND changed.hour_key = CAST(source.bucket_start / 3600000 AS INTEGER)
      AND changed.metric_kind = source.metric_kind
      AND changed.dimension_signature = source.dimension_signature
     WHERE source.bucket_seconds = 300
     GROUP BY source.zone_id, changed.hour_key, source.metric_kind, source.dimension_signature
     ON CONFLICT(zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature) DO UPDATE SET
      estimated_count = excluded.estimated_count, sample_interval = excluded.sample_interval,
      confidence_estimate = excluded.confidence_estimate, confidence_lower = excluded.confidence_lower,
      confidence_upper = excluded.confidence_upper, confidence_sample_size = excluded.confidence_sample_size,
      edge_response_bytes = excluded.edge_response_bytes, visits = excluded.visits, updated_at = excluded.updated_at
     WHERE metric_buckets.estimated_count IS NOT excluded.estimated_count
        OR metric_buckets.sample_interval IS NOT excluded.sample_interval
        OR metric_buckets.confidence_estimate IS NOT excluded.confidence_estimate
        OR metric_buckets.confidence_lower IS NOT excluded.confidence_lower
        OR metric_buckets.confidence_upper IS NOT excluded.confidence_upper
        OR metric_buckets.confidence_sample_size IS NOT excluded.confidence_sample_size
        OR metric_buckets.edge_response_bytes IS NOT excluded.edge_response_bytes
        OR metric_buckets.visits IS NOT excluded.visits`,
  )
    .bind(hourCutoff, changedSince, timestamp)
    .run();
  metadata.push(hourly.meta);
  const daily = await database.prepare(
    `WITH changed AS (
       SELECT DISTINCT zone_id, CAST(bucket_start / 86400000 AS INTEGER) AS day_key,
        metric_kind, dimension_signature
       FROM metric_buckets
       WHERE bucket_seconds = 3600 AND bucket_start < ? AND updated_at > ?
     )
     INSERT INTO metric_buckets
     (id, zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, host, country, asn,
      method, protocol, edge_status, origin_status, status_class, cache_status, security_action, security_source, request_source,
      dimension_type, dimension_value, estimated_count, sample_interval, confidence_estimate, confidence_lower,
      confidence_upper, confidence_sample_size, edge_response_bytes, visits, updated_at)
     SELECT 'd:' || source.zone_id || ':' || changed.day_key || ':' || source.metric_kind || ':' || source.dimension_signature,
      source.zone_id, changed.day_key * 86400000, 86400, source.metric_kind, source.dimension_signature,
      source.host, source.country, source.asn, source.method, source.protocol, source.edge_status, source.origin_status,
      source.status_class, source.cache_status, source.security_action, source.security_source, source.request_source,
      source.dimension_type, source.dimension_value, SUM(source.estimated_count), AVG(source.sample_interval),
      SUM(source.confidence_estimate), SUM(source.confidence_lower), SUM(source.confidence_upper),
      SUM(source.confidence_sample_size), SUM(source.edge_response_bytes), SUM(source.visits), ?
     FROM metric_buckets source JOIN changed
       ON changed.zone_id = source.zone_id
      AND changed.day_key = CAST(source.bucket_start / 86400000 AS INTEGER)
      AND changed.metric_kind = source.metric_kind
      AND changed.dimension_signature = source.dimension_signature
     WHERE source.bucket_seconds = 3600
     GROUP BY source.zone_id, changed.day_key, source.metric_kind, source.dimension_signature
     ON CONFLICT(zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature) DO UPDATE SET
      estimated_count = excluded.estimated_count, sample_interval = excluded.sample_interval,
      confidence_estimate = excluded.confidence_estimate, confidence_lower = excluded.confidence_lower,
      confidence_upper = excluded.confidence_upper, confidence_sample_size = excluded.confidence_sample_size,
      edge_response_bytes = excluded.edge_response_bytes, visits = excluded.visits, updated_at = excluded.updated_at
     WHERE metric_buckets.estimated_count IS NOT excluded.estimated_count
        OR metric_buckets.sample_interval IS NOT excluded.sample_interval
        OR metric_buckets.confidence_estimate IS NOT excluded.confidence_estimate
        OR metric_buckets.confidence_lower IS NOT excluded.confidence_lower
        OR metric_buckets.confidence_upper IS NOT excluded.confidence_upper
        OR metric_buckets.confidence_sample_size IS NOT excluded.confidence_sample_size
        OR metric_buckets.edge_response_bytes IS NOT excluded.edge_response_bytes
        OR metric_buckets.visits IS NOT excluded.visits`,
  )
    .bind(dayCutoff, changedSince, timestamp)
    .run();
  metadata.push(daily.meta);
  const oldFiveMinutes = await database.prepare("DELETE FROM metric_buckets WHERE bucket_seconds = 300 AND bucket_start < ?")
    .bind(timestamp - 90 * DAY_MS)
    .run();
  metadata.push(oldFiveMinutes.meta);
  const oldHourlyRankings = await database.prepare("DELETE FROM metric_buckets WHERE bucket_seconds = 3600 AND bucket_start < ? AND dimension_type IS NOT NULL")
    .bind(timestamp - 90 * DAY_MS)
    .run();
  metadata.push(oldHourlyRankings.meta);
  const oldHours = await database.prepare("DELETE FROM metric_buckets WHERE bucket_seconds = 3600 AND bucket_start < ?")
    .bind(timestamp - 730 * DAY_MS)
    .run();
  metadata.push(oldHours.meta);
  metadata.push((await trimHighCardinality(database, 3600, 100)).meta);
  metadata.push((await trimHighCardinality(database, 86400, 100)).meta);
  const oldRankings = await database.prepare(
    `DELETE FROM metric_buckets WHERE bucket_seconds = 300 AND dimension_type IS NOT NULL AND bucket_start < ?`,
  )
    .bind(hourCutoff)
    .run();
  metadata.push(oldRankings.meta);
  await recordD1Usage(database, metadata);
  await database.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('metric_rollup_watermark', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(String(timestamp), timestamp)
    .run();
}

async function trimHighCardinality(database: D1Database, bucketSeconds: number, defaultLimit: number) {
  return database.prepare(
    `DELETE FROM metric_buckets WHERE id IN (
       SELECT id FROM (
         SELECT id, dimension_type,
          ROW_NUMBER() OVER (
            PARTITION BY zone_id, bucket_start, metric_kind, dimension_type
            ORDER BY estimated_count DESC, dimension_value ASC
          ) AS rank
         FROM metric_buckets WHERE bucket_seconds = ? AND dimension_type IS NOT NULL
       ) ranked
       WHERE rank > CASE WHEN dimension_type = 'userAgent' THEN 50 ELSE ? END
     )`,
  )
    .bind(bucketSeconds, defaultLimit)
    .run();
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
