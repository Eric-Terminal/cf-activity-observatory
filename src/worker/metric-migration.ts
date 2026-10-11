import type { MetricDocument, StoredMetric } from "@/shared/metrics";
import { d1RowsWrittenToday } from "@/worker/budgets";
import { recordD1Usage } from "@/worker/db";
import { storeMetricRows } from "@/worker/metric-archive";
import { canonicalJson, DAY_MS, HOUR_MS, floorTo } from "@/worker/utils";

/** 只从串行 Collector Queue 调用；历史回收不得与趋势读改写并发。 */
export async function migrateLegacyMetricHour(env: Env, timestamp: number): Promise<number> {
  // DELETE 同样计入 D1 写入额度，保留至少两万行给实时采集和控制状态。
  if (await d1RowsWrittenToday(env.DB) >= 50_000) return 0;
  const first = await env.DB.prepare(
    `SELECT zone_id, metric_kind, bucket_start FROM metric_buckets
     WHERE bucket_start < ? ORDER BY zone_id, bucket_start LIMIT 1`,
  ).bind(timestamp - 7 * DAY_MS).first<StoredMetric>();
  if (!first) return 0;
  const hour = floorTo(first.bucket_start, HOUR_MS);
  const rows = (await env.DB.prepare(
    `SELECT * FROM metric_buckets WHERE zone_id = ? AND metric_kind = ?
     AND bucket_start >= ? AND bucket_start < ? LIMIT 10001`,
  ).bind(first.zone_id, first.metric_kind, hour, hour + HOUR_MS).all<StoredMetric>()).results;
  if (rows.length > 10_000) throw new Error("历史小时超过迁移批次上限，请先单独备份处理");
  const key = `migration-backups/metrics/${first.zone_id}/${first.metric_kind}/${hour}.json.gz`;
  let backup = await env.ARCHIVES.get(key);
  if (!backup) {
    const text = JSON.stringify(rows);
    if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) throw new Error("历史小时备份超过 32 MiB");
    await env.ARCHIVES.put(key, await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    backup = await env.ARCHIVES.get(key);
  }
  if (!backup) throw new Error("无法回读历史趋势备份，拒绝回收 D1");
  const saved = await new Response(backup.body.pipeThrough(new DecompressionStream("gzip"))).json<StoredMetric[]>();
  const originals = new Set(saved.map((row) => canonicalJson(row)));
  if (rows.some((row) => !originals.has(canonicalJson(row)))) throw new Error("历史备份与 D1 不一致，拒绝回收");

  // 初始备份不会被后续小批删除覆盖；已有 R2 实时修复结果优先于旧 D1 副本。
  await storeMetricRows(env, rows, true);
  const active = await env.ARCHIVES.get(`metrics/${first.zone_id}/${first.metric_kind}/${hour}.json.gz`);
  if (!active) throw new Error("趋势归档无法回读，拒绝回收 D1");
  const document = await new Response(active.body.pipeThrough(new DecompressionStream("gzip"))).json<MetricDocument>();
  const identities = new Set(document.rows.map((row) => `${row.bucket_start}:${row.bucket_seconds}:${row.dimension_signature}`));
  if (rows.some((row) => !identities.has(`${row.bucket_start}:${row.bucket_seconds}:${row.dimension_signature}`))) {
    throw new Error("趋势归档缺少历史记录，拒绝回收 D1");
  }
  const result = await env.DB.prepare(
    `DELETE FROM metric_buckets WHERE (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature) IN
      (SELECT zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature FROM metric_buckets
       WHERE zone_id = ? AND metric_kind = ? AND bucket_start >= ? AND bucket_start < ? LIMIT 500)`,
  ).bind(first.zone_id, first.metric_kind, hour, hour + HOUR_MS).run();
  await recordD1Usage(env.DB, result.meta);
  return result.meta.changes;
}
