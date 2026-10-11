import type { MetricDocument, StoredMetric } from "@/shared/metrics";
import { incrementUsage, recordD1Usage } from "@/worker/db";
import { HOUR_MS, floorTo, nowMs } from "@/worker/utils";

export async function storeMetricRows(env: Pick<Env, "DB" | "ARCHIVES">, rows: StoredMetric[], preserveExisting = false): Promise<number> {
  const hours = new Map<string, StoredMetric[]>();
  for (const row of rows) {
    const key = `metrics/${row.zone_id}/${row.metric_kind}/${floorTo(row.bucket_start, HOUR_MS)}.json.gz`;
    const group = hours.get(key) ?? [];
    group.push(row);
    hours.set(key, group);
  }
  let changed = 0;
  // Collector Queue 的 max_concurrency=1 保证同一小时不会发生读改写覆盖。
  for (const [key, incoming] of hours) {
    const first = incoming[0];
    const hour = floorTo(first.bucket_start, HOUR_MS);
    const object = await env.ARCHIVES.get(key);
    const previous = object
      ? (await new Response(object.body.pipeThrough(new DecompressionStream("gzip"))).json<MetricDocument>()).rows
      : (await env.DB.prepare(
        `SELECT * FROM metric_buckets WHERE zone_id = ? AND metric_kind = ? AND bucket_start >= ? AND bucket_start < ?`,
      ).bind(first.zone_id, first.metric_kind, hour, hour + HOUR_MS).all<StoredMetric>()).results;
    // 首次接管小时必须带上旧 D1 行，读侧才能按小时排除旧表而不丢掉未重采的维度。
    const identity = (row: StoredMetric) => `${row.bucket_start}:${row.bucket_seconds}:${row.dimension_signature}`;
    const merged = new Map(previous.map((row) => [identity(row), row]));
    let hourChanged = false;
    for (const row of incoming) {
      const old = merged.get(identity(row));
      if (old && preserveExisting) continue;
      if (!old || JSON.stringify({ ...old, updated_at: 0 }) !== JSON.stringify({ ...row, updated_at: 0 })) {
        changed += 1;
        hourChanged = true;
        merged.set(identity(row), row);
      }
    }
    let etag = object?.etag;
    let size = object?.size;
    if (hourChanged || !object) {
      const document: MetricDocument = { version: 1, zoneId: first.zone_id, kind: first.metric_kind, hourStart: hour, rows: [...merged.values()] };
      const text = JSON.stringify(document);
      if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) throw new Error("单小时趋势超过 32 MiB，请减少同时采集的维度");
      const compressed = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
      const saved = await env.ARCHIVES.put(key, compressed, { httpMetadata: { contentType: "application/gzip" } });
      if (!saved) throw new Error("趋势归档写入失败");
      etag = saved.etag;
      size = compressed.byteLength;
      await incrementUsage(env.DB, { r2ClassA: 1, r2BytesWritten: size });
    }
    // R2 先成功，D1 后登记。失败重试仍会补清单，不能因内容未改变提前返回。
    const result = await env.DB.prepare(
      `INSERT INTO metric_archives (zone_id, metric_kind, hour_start, r2_key, etag, compressed_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(zone_id, metric_kind, hour_start) DO UPDATE SET
       etag = excluded.etag, compressed_bytes = excluded.compressed_bytes, updated_at = excluded.updated_at
       WHERE metric_archives.etag != excluded.etag`,
    ).bind(first.zone_id, first.metric_kind, hour, key, etag!, size!, nowMs()).run();
    await recordD1Usage(env.DB, result.meta);
  }
  return changed;
}
