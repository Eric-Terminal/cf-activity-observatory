import type { DatasetName, SampledRequest, SecurityEvent } from "@/shared/contracts";
import {
  parseArchiveHeader,
  parseArchiveRecord,
  type ArchiveRecord,
  type RawArchiveDataset,
} from "@/shared/archive-records";
import { evaluateAlerts } from "@/worker/alerts";
import { d1WritesPaused } from "@/worker/budgets";
import { incrementUsage, recordD1Usage } from "@/worker/db";
import {
  asNumber,
  asString,
  bytesToBase64Url,
  canonicalJson,
  DAY_MS,
  floorTo,
  HOUR_MS,
  nowMs,
  parseCloudflareTime,
  stableId,
} from "@/worker/utils";

const ARCHIVE_SCHEMA_VERSION = 2;

export interface ArchiveManifestRow {
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
  schema_version: number;
  status: string;
  archived_at: number;
  verified_at: number | null;
  pruned_at: number | null;
}

interface ArchiveListFilter {
  dataset?: RawArchiveDataset;
  from?: number;
  to?: number;
  zoneIds?: string[];
  limit?: number;
}

export async function runMaintenance(env: Env, scheduledAt = nowMs()): Promise<void> {
  if (!(await d1WritesPaused(env.DB))) await rollupMetrics(env.DB, scheduledAt);
  await evaluateAlerts(env);
  await env.DB.prepare("DELETE FROM app_settings WHERE key LIKE 'graphql_budget:%' AND updated_at < ?")
    .bind(scheduledAt - DAY_MS)
    .run();
}

export async function archiveDetailRows(
  env: Env,
  dataset: RawArchiveDataset,
  zoneId: string,
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  const grouped = new Map<number, ArchiveRecord[]>();
  for (const row of rows) {
    const item = dataset === "httpRequestsAdaptive"
      ? requestFromCloudflare(zoneId, row)
      : eventFromCloudflare(zoneId, row);
    const hourStart = floorTo(item.occurredAt, HOUR_MS);
    const group = grouped.get(hourStart) ?? [];
    group.push(item);
    grouped.set(hourStart, group);
  }
  let changed = 0;
  for (const [hourStart, incoming] of grouped) {
    changed += await writeArchiveHour(env, dataset, zoneId, hourStart, incoming);
  }
  return changed;
}

export async function listArchives(
  database: D1Database,
  filter: ArchiveListFilter = {},
): Promise<ArchiveManifestRow[]> {
  const conditions = ["status = 'verified'"];
  const bindings: unknown[] = [];
  if (filter.dataset) {
    conditions.push("dataset = ?");
    bindings.push(filter.dataset);
  }
  if (filter.from !== undefined) {
    conditions.push("range_end > ?");
    bindings.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push("range_start < ?");
    bindings.push(filter.to);
  }
  if (filter.zoneIds?.length) {
    conditions.push(`zone_id IN (${filter.zoneIds.map(() => "?").join(",")})`);
    bindings.push(...filter.zoneIds);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 5_000);
  const result = await database.prepare(
    `SELECT id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, schema_version, status, archived_at, verified_at, pruned_at
     FROM archive_manifests WHERE ${conditions.join(" AND ")}
     ORDER BY range_start DESC, zone_id, id LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<ArchiveManifestRow>();
  return result.results;
}

export async function getArchive(database: D1Database, id: string): Promise<ArchiveManifestRow | null> {
  return database.prepare(
    `SELECT id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, schema_version, status, archived_at, verified_at, pruned_at
     FROM archive_manifests WHERE id = ?`,
  )
    .bind(id)
    .first<ArchiveManifestRow>();
}

async function writeArchiveHour(
  env: Env,
  dataset: RawArchiveDataset,
  zoneId: string,
  hourStart: number,
  incoming: ArchiveRecord[],
): Promise<number> {
  const key = archiveKey(zoneId, dataset, hourStart);
  const existingObject = await env.ARCHIVES.get(key);
  const existing = existingObject ? await readArchive(existingObject, dataset) : [];
  const merged = new Map(existing.map((item) => [item.id, item]));
  let changed = 0;
  for (const item of incoming) {
    const previous = merged.get(item.id);
    const next = previous ? mergeRepair(previous, item) : item;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) changed += 1;
    merged.set(item.id, next);
  }
  if (!changed && existingObject) {
    const manifest = await env.DB.prepare(
      "SELECT status, etag FROM archive_manifests WHERE r2_key = ?",
    )
      .bind(key)
      .first<{ status: string; etag: string | null }>();
    // 对象写入成功但 manifest 更新失败时，ETag 会不一致；重试必须把清单补齐，不能提前返回。
    if (manifest?.status === "verified" && manifest.etag === existingObject.etag) return 0;
  }

  const timestamp = nowMs();
  const records = [...merged.values()].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  const header = {
    type: "cf-activity-observatory/archive",
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    zoneId,
    dataset,
    rangeStart: new Date(hourStart).toISOString(),
    rangeEnd: new Date(hourStart + HOUR_MS).toISOString(),
    generatedAt: new Date(timestamp).toISOString(),
  } as const;
  const ndjson = `${JSON.stringify(header)}\n${records.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const compressed = await gzip(new TextEncoder().encode(ndjson));
  const checksum = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", exactBuffer(compressed))));
  const object = await env.ARCHIVES.put(key, compressed, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    customMetadata: {
      schemaVersion: String(ARCHIVE_SCHEMA_VERSION), zoneId, dataset, sha256: checksum, records: String(records.length),
    },
  });
  const head = await env.ARCHIVES.head(key);
  if (!head || head.size !== compressed.byteLength) throw new Error(`归档写入后校验失败：${key}`);
  const manifest = await env.DB.prepare(
    `INSERT INTO archive_manifests
     (id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
      sha256, etag, schema_version, status, archived_at, verified_at, pruned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)
     ON CONFLICT(r2_key) DO UPDATE SET record_count = excluded.record_count,
      compressed_bytes = excluded.compressed_bytes, sha256 = excluded.sha256, etag = excluded.etag,
      schema_version = excluded.schema_version, status = 'verified', archived_at = excluded.archived_at,
      verified_at = excluded.verified_at, pruned_at = excluded.pruned_at`,
  )
    .bind(
      stableId(zoneId, dataset, hourStart), zoneId, dataset, hourStart, hourStart + HOUR_MS, key,
      records.length, compressed.byteLength, checksum, object?.etag ?? head.etag, ARCHIVE_SCHEMA_VERSION,
      timestamp, timestamp, timestamp,
    )
    .run();
  await recordD1Usage(env.DB, manifest.meta);
  await incrementUsage(env.DB, { r2ClassA: 1, r2ClassB: 2, r2BytesWritten: compressed.byteLength });
  return changed;
}

async function readArchive(object: R2ObjectBody, expectedDataset: RawArchiveDataset): Promise<ArchiveRecord[]> {
  const compressed = new Uint8Array(await new Response(object.body).arrayBuffer());
  const text = new TextDecoder().decode(await gunzip(compressed));
  const lines = text.split("\n").filter(Boolean);
  const header = parseArchiveHeader(JSON.parse(lines.shift() ?? "null") as unknown);
  if (!header || header.dataset !== expectedDataset) throw new Error(`R2 归档头无效：${object.key}`);
  return lines.flatMap((line) => {
    const item = parseArchiveRecord(expectedDataset, header.schemaVersion, JSON.parse(line) as unknown);
    return item ? [item] : [];
  });
}

function mergeRepair(previous: ArchiveRecord, incoming: ArchiveRecord): ArchiveRecord {
  if ("edgeStatus" in previous && "edgeStatus" in incoming) {
    return { ...previous, asn: previous.asn ?? incoming.asn, asnDescription: previous.asnDescription ?? incoming.asnDescription };
  }
  if ("action" in previous && "action" in incoming) return { ...previous, asn: previous.asn ?? incoming.asn };
  return incoming;
}

function requestFromCloudflare(zoneId: string, row: Record<string, unknown>): SampledRequest {
  const occurredAt = parseCloudflareTime(row.datetime) ?? nowMs();
  const rayId = asString(row.rayName);
  // ASN 曾因字段大小写错误缺失；它不参与身份计算，修复回采才能在原记录上补齐。
  const identityRow = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "clientAsn"));
  const known = new Set([
    "datetime", "rayName", "clientIP", "clientCountryName", "clientAsn", "clientASNDescription", "userAgent",
    "clientRefererHost", "clientDeviceType", "clientRequestHTTPHost", "clientRequestPath", "clientRequestQuery",
    "clientRequestHTTPMethodName", "clientRequestHTTPProtocol", "requestSource", "coloCode", "cacheStatus",
    "originResponseStatus", "edgeResponseStatus", "securityAction", "securitySource", "securityRuleID",
    "botManagementScore", "botManagementScoreSrc", "botManagementScoreSrcName", "botManagementTags",
    "botManagementVerifiedBot", "verifiedBotCategory", "wafAttackScore", "contentScanObjResults",
    "leakedCredentialCheckResult", "sampleInterval",
  ]);
  return {
    id: stableId(zoneId, occurredAt, rayId, canonicalJson(identityRow)), zoneId, occurredAt, rayId,
    clientIp: asString(row.clientIP), country: asString(row.clientCountryName), asn: asNumber(row.clientAsn),
    asnDescription: asString(row.clientASNDescription), userAgent: asString(row.userAgent),
    referer: asString(row.clientRefererHost), deviceType: asString(row.clientDeviceType),
    host: asString(row.clientRequestHTTPHost), path: asString(row.clientRequestPath), query: asString(row.clientRequestQuery),
    method: asString(row.clientRequestHTTPMethodName), protocol: asString(row.clientRequestHTTPProtocol),
    requestSource: asString(row.requestSource), colo: asString(row.coloCode), cacheStatus: asString(row.cacheStatus),
    originStatus: asNumber(row.originResponseStatus), edgeStatus: asNumber(row.edgeResponseStatus),
    securityAction: asString(row.securityAction), securitySource: asString(row.securitySource),
    securityRuleId: asString(row.securityRuleID), botScore: asNumber(row.botManagementScore),
    botScoreSource: asString(row.botManagementScoreSrc ?? row.botManagementScoreSrcName),
    botTags: Array.isArray(row.botManagementTags) ? row.botManagementTags.filter((item): item is string => typeof item === "string") : [],
    verifiedBotCategory: row.botManagementVerifiedBot === true ? "verified" : asString(row.verifiedBotCategory),
    attackScore: asNumber(row.wafAttackScore), contentScanResult: row.contentScanObjResults ?? null,
    leakedCredentialResult: asString(row.leakedCredentialCheckResult), sampleInterval: asNumber(row.sampleInterval),
    extra: remaining(row, known),
  };
}

function eventFromCloudflare(zoneId: string, row: Record<string, unknown>): SecurityEvent {
  const occurredAt = parseCloudflareTime(row.datetime) ?? nowMs();
  const rayId = asString(row.rayName);
  const known = new Set([
    "datetime", "rayName", "action", "source", "ruleId", "description", "rulesetId", "kind", "clientIP",
    "clientCountryName", "clientAsn", "clientRequestHTTPHost", "clientRequestPath", "clientRequestQuery",
    "clientRequestHTTPMethodName", "userAgent", "sampleInterval",
  ]);
  return {
    id: stableId(zoneId, occurredAt, rayId, asString(row.source), asString(row.ruleId), asString(row.action)),
    zoneId, occurredAt, rayId, action: asString(row.action), source: asString(row.source), ruleId: asString(row.ruleId),
    ruleDescription: asString(row.description), rulesetId: asString(row.rulesetId), kind: asString(row.kind),
    clientIp: asString(row.clientIP), country: asString(row.clientCountryName), asn: asNumber(row.clientAsn),
    host: asString(row.clientRequestHTTPHost), path: asString(row.clientRequestPath), query: asString(row.clientRequestQuery),
    method: asString(row.clientRequestHTTPMethodName), userAgent: asString(row.userAgent),
    sampleInterval: asNumber(row.sampleInterval), extra: remaining(row, known),
  };
}

function remaining(row: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key)));
}

async function rollupMetrics(database: D1Database, timestamp: number): Promise<void> {
  const zones = await database.prepare("SELECT id FROM zones ORDER BY id").all<{ id: string }>();
  for (const zone of zones.results) await compactMetricTier(database, zone.id, timestamp, 300, 3600, 90);
  for (const zone of zones.results) await compactMetricTier(database, zone.id, timestamp, 3600, 86400, 730);
}

async function compactMetricTier(
  database: D1Database,
  zoneId: string,
  timestamp: number,
  sourceSeconds: 300 | 3600,
  targetSeconds: 3600 | 86400,
  minimumAgeDays: number,
): Promise<void> {
  const targetMs = targetSeconds * 1000;
  const cutoff = floorTo(timestamp - minimumAgeDays * DAY_MS, targetMs);
  const oldest = await database.prepare(
    `SELECT bucket_start FROM metric_buckets
     WHERE zone_id = ? AND bucket_start < ? AND bucket_seconds = ? ORDER BY bucket_start LIMIT 1`,
  )
    .bind(zoneId, cutoff, sourceSeconds)
    .first<{ bucket_start: number }>();
  if (!oldest) return;
  const targetStart = floorTo(oldest.bucket_start, targetMs);
  const targetEnd = targetStart + targetMs;
  if (sourceSeconds === 3600) {
    const finer = await database.prepare(
      `SELECT 1 FROM metric_buckets
       WHERE zone_id = ? AND bucket_start >= ? AND bucket_start < ? AND bucket_seconds = 300 LIMIT 1`,
    )
      .bind(zoneId, targetStart, targetEnd)
      .first();
    if (finer) return;
  }
  // 同一 batch 内先生成粗粒度再删除源桶，维护失败时不会留下半套趋势数据。
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
       WHERE zone_id = ? AND bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?
       GROUP BY zone_id, metric_kind, dimension_signature
       ON CONFLICT(zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature) DO UPDATE SET
        estimated_count = excluded.estimated_count, sample_interval = excluded.sample_interval,
        confidence_estimate = excluded.confidence_estimate, confidence_lower = excluded.confidence_lower,
        confidence_upper = excluded.confidence_upper, confidence_sample_size = excluded.confidence_sample_size,
        edge_response_bytes = excluded.edge_response_bytes, visits = excluded.visits, updated_at = excluded.updated_at`,
    ).bind(targetStart, targetSeconds, timestamp, zoneId, sourceSeconds, targetStart, targetEnd),
    database.prepare(
      `DELETE FROM metric_buckets
       WHERE zone_id = ? AND bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?`,
    ).bind(zoneId, sourceSeconds, targetStart, targetEnd),
  ]);
  await recordD1Usage(database, results.map((result) => result.meta));
}

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([exactBuffer(input)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([exactBuffer(input)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function archiveKey(zoneId: string, dataset: string, timestamp: number): string {
  const date = new Date(timestamp);
  const parts = [
    String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"), String(date.getUTCHours()).padStart(2, "0"),
  ];
  return `archives/${zoneId}/${dataset}/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}.ndjson.gz`;
}
