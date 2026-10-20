import { z } from "zod";
import { LOGPUSH_DATASETS, logpushPrefix, parseLogpushKey, parseLogpushRecord, type LogpushDataset, type LogpushSource } from "@/shared/logpush";
import { readNdjson } from "@/shared/ndjson";
import { HOUR_MS, nowMs, sanitizeError, stableId } from "@/worker/utils";
import { incrementUsage, recordD1Usage } from "@/worker/db";

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

/** 少量扫描任务代替逐文件 R2 通知；每天全量核对可找回配额耗尽或迟到的文件。 */
export async function scheduleLogpushScans(env: Env, scheduledAt: number): Promise<number> {
  const time = new Date(scheduledAt);
  const fullScan = time.getUTCHours() === 0 && time.getUTCMinutes() === 17;
  if (!fullScan && time.getUTCMinutes() % 5 !== 0) return 0;
  const zones = await env.DB.prepare("SELECT id FROM zones WHERE enabled = 1").all<{ id: string }>();
  let sent = 0;
  for (const zone of zones.results) {
    if (!/^[a-f0-9]{32}$/u.test(zone.id)) continue;
    for (const dataset of ["http_requests", "firewall_events"] as const) {
      // 标准 Logpush 文件名以 UTC 批次时间开头。两小时重叠涵盖乱序和跨日投递，
      // 更早的迟到文件以及非标准文件名由每日全量扫描兜底。
      const since = new Date(scheduledAt - 2 * HOUR_MS).toISOString().slice(0, 19).replace(/[-:]/gu, "") + "Z";
      const after = fullScan ? undefined : `${logpushPrefix(zone.id, dataset)}${since.slice(0, 8)}/${since}`;
      await env.COLLECTOR_QUEUE.send({ version: 1, type: "reconcile-logpush", zoneId: zone.id, dataset, after });
      sent += 1;
    }
  }
  return sent;
}

export async function reconcileLogpush(
  env: Env, zoneId: string, dataset: LogpushDataset, cursor?: string, after?: string,
): Promise<void> {
  const prefix = logpushPrefix(zoneId, dataset);
  if (after && !after.startsWith(prefix)) throw new Error("Logpush 扫描位置与来源不一致");
  const listed = await env.ARCHIVES.list({ prefix, limit: 1000, cursor, startAfter: after });
  const first = listed.objects[0];
  const last = listed.objects.at(-1);
  // 按唯一对象键索引查一页，避免每五分钟下载并解析已经入库的原件。
  const existing = first && last ? await env.DB.prepare(
    "SELECT r2_key, etag FROM archive_manifests WHERE r2_key >= ? AND r2_key <= ? AND status = 'indexed'",
  ).bind(first.key, last.key).all<{ r2_key: string; etag: string }>() : { results: [] };
  const indexed = new Map(existing.results.map((row) => [row.r2_key, row.etag]));
  let handled = 0;
  let sent = 0;
  let resumeAfter: string | undefined;
  for (const object of listed.objects) {
    if (!parseLogpushKey(object.key) || indexed.get(object.key) === object.etag) continue;
    // 每个文件最多六条 D1 语句；留出记账和续传余量，遵守免费 Worker 的 50 查询上限。
    if (handled === 7) {
      // 使用最后处理的键而非整页 cursor，不能跳过本页尚未处理的对象。
      break;
    }
    try {
      await indexLogpushObject(env, object.key);
    } catch (error) {
      // 一个损坏文件交给原有独立重试/告警路径，不阻塞后面整批正常日志。
      console.error(JSON.stringify({ event: "logpush_scan_file_failed", key: object.key, error: sanitizeError(error) }));
      await env.COLLECTOR_QUEUE.send({ version: 1, type: "index-logpush", key: object.key });
      sent += 1;
    }
    handled += 1;
    resumeAfter = object.key;
  }
  const pending = resumeAfter && listed.objects.some((object) =>
    object.key > resumeAfter && parseLogpushKey(object.key) && indexed.get(object.key) !== object.etag);
  if (pending) {
    await env.COLLECTOR_QUEUE.send({ version: 1, type: "reconcile-logpush", zoneId, dataset, after: resumeAfter });
    sent += 1;
  } else if (listed.truncated) {
    await env.COLLECTOR_QUEUE.send({ version: 1, type: "reconcile-logpush", zoneId, dataset, cursor: listed.cursor });
    sent += 1;
  }
  if (sent) await incrementUsage(env.DB, { queueMessages: sent });
  console.info(JSON.stringify({ event: "logpush_scan", zoneId, dataset, listed: listed.objects.length, handled, continued: Boolean(pending || listed.truncated) }));
}
