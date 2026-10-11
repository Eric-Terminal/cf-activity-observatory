import { z } from "zod";
import { LOGPUSH_DATASETS, logpushPrefix, parseLogpushKey, parseLogpushRecord, type LogpushDataset, type LogpushSource } from "@/shared/logpush";
import { readNdjson } from "@/shared/ndjson";
import { nowMs, stableId } from "@/worker/utils";
import { recordD1Usage } from "@/worker/db";

export const r2NotificationSchema = z.object({
  bucket: z.string(),
  action: z.enum(["PutObject", "CopyObject", "CompleteMultipartUpload"]),
  object: z.object({ key: z.string(), size: z.number().optional(), eTag: z.string().optional() }),
});

/** 每个投递文件只建一条清单；索引失败不会阻止 Cloudflare 继续向 R2 写原始日志。 */
export async function indexLogpushObject(env: Env, key: string): Promise<boolean> {
  const source = parseLogpushKey(key);
  if (!source) return false;
  const zone = await env.DB.prepare("SELECT id FROM zones WHERE id = ?").bind(source.zoneId).first();
  if (!zone) throw new Error("Logpush 的 Zone 尚未在应用中发现");
  const object = await env.ARCHIVES.get(key);
  if (!object) throw new Error("Logpush 文件不存在，可能已被外部生命周期删除");
  const existing = await env.DB.prepare("SELECT etag FROM archive_manifests WHERE r2_key = ? AND status = 'indexed'")
    .bind(key).first<{ etag: string }>();
  if (existing?.etag === object.etag) {
    await object.body.cancel();
    return false;
  }
  let count = 0;
  let start = Infinity;
  let end = -Infinity;
  for await (const value of readNdjson(new Response(object.body).body!)) {
    const record = parseLogpushRecord(source.dataset, source.zoneId, value);
    start = Math.min(start, record.occurredAt);
    end = Math.max(end, record.occurredAt);
    count += 1;
  }
  if (!count) return false;
  const timestamp = nowMs();
  const indexed = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO archive_manifests
       (id, zone_id, dataset, range_start, range_end, r2_key, record_count, compressed_bytes,
        sha256, etag, schema_version, status, archived_at, verified_at, pruned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, 3, 'indexed', ?, ?, NULL)
       ON CONFLICT(r2_key) DO UPDATE SET range_start = excluded.range_start, range_end = excluded.range_end,
        record_count = excluded.record_count, compressed_bytes = excluded.compressed_bytes,
        etag = excluded.etag, status = 'indexed', verified_at = excluded.verified_at`,
    ).bind(stableId("logpush", key), source.zoneId, LOGPUSH_DATASETS[source.dataset], start, end + 1,
      key, count, object.size, object.etag, object.uploaded.getTime(), timestamp),
    env.DB.prepare(
      `INSERT INTO logpush_sources (zone_id, dataset, last_received_at, last_indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(zone_id, dataset) DO UPDATE SET
        last_received_at = MAX(COALESCE(last_received_at, 0), excluded.last_received_at),
        last_indexed_at = excluded.last_indexed_at`,
    ).bind(source.zoneId, source.dataset, object.uploaded.getTime(), timestamp),
    env.DB.prepare("UPDATE alert_state SET status = 'recovered', last_seen_at = ?, recovered_at = ? WHERE alert_key = ? AND status = 'active'")
      .bind(timestamp, timestamp, `logpush:${stableId(key)}`),
  ]);
  await recordD1Usage(env.DB, indexed.map((result) => result.meta));
  return true;
}

export async function usesLogpush(database: D1Database, zoneId: string, dataset: string): Promise<boolean> {
  const native = dataset === "httpRequestsAdaptive" ? "http_requests" : dataset === "firewallEventsAdaptive" ? "firewall_events" : null;
  if (!native) return false;
  return Boolean(await database.prepare(
    "SELECT 1 FROM logpush_sources WHERE zone_id = ? AND dataset = ? AND activated_at IS NOT NULL",
  ).bind(zoneId, native).first());
}

export async function listLogpushSources(database: D1Database): Promise<LogpushSource[]> {
  const result = await database.prepare(
    `SELECT z.id AS zoneId, z.name AS zoneName, z.account_id AS accountId, d.dataset,
     s.activated_at AS activatedAt, s.last_received_at AS lastReceivedAt, s.last_indexed_at AS lastIndexedAt,
     COUNT(a.id) AS files, COALESCE(SUM(a.record_count), 0) AS records, COALESCE(SUM(a.compressed_bytes), 0) AS bytes
     FROM zones z CROSS JOIN (SELECT 'http_requests' AS dataset UNION ALL SELECT 'firewall_events') d
     LEFT JOIN logpush_sources s ON s.zone_id = z.id AND s.dataset = d.dataset
     LEFT JOIN archive_manifests a ON a.zone_id = z.id AND a.schema_version = 3 AND a.status = 'indexed'
      AND a.dataset = CASE d.dataset WHEN 'http_requests' THEN 'httpRequestsAdaptive' ELSE 'firewallEventsAdaptive' END
     GROUP BY z.id, d.dataset ORDER BY z.name, d.dataset`,
  ).all<Omit<LogpushSource, "prefix">>();
  return result.results.map((source) => ({ ...source, prefix: logpushPrefix(source.zoneId, source.dataset) }));
}

export async function reconcileLogpush(env: Env, zoneId: string, dataset: LogpushDataset, cursor?: string): Promise<void> {
  // 列表逐页续传，避免把第一个 R2 列表页误当成整个桶。
  const listed = await env.ARCHIVES.list({ prefix: logpushPrefix(zoneId, dataset), limit: 20, cursor });
  const messages = listed.objects.filter((object) => parseLogpushKey(object.key))
    .map((object) => ({ body: { version: 1 as const, type: "index-logpush" as const, key: object.key } }));
  if (messages.length) await env.COLLECTOR_QUEUE.sendBatch(messages);
  if (listed.truncated) await env.COLLECTOR_QUEUE.send({ version: 1, type: "reconcile-logpush", zoneId, dataset, cursor: listed.cursor });
}
