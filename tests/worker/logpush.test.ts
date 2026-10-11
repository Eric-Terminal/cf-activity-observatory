import { describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { indexLogpushObject, reconcileLogpush, usesLogpush } from "@/worker/logpush";
import { storeMetricRows } from "@/worker/metric-archive";
import type { MetricDocument, StoredMetric } from "@/shared/metrics";

async function zone(id: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO zones (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
    .bind(id, `${id}.example`, Date.now(), Date.now()).run();
}

describe("Logpush 索引与切换", () => {
  it("同一文件重复通知幂等，且不向明细表写入", async () => {
    const id = "1".repeat(32);
    await zone(id);
    const key = `logpush/${id}/http_requests/20261011/one.log.gz`;
    const rows = [0, 1].map((offset) => ({ RayID: `ray-${offset}`, EdgeStartTimestamp: new Date(Date.now() + offset).toISOString(), EdgeResponseStatus: 200 }));
    await env.ARCHIVES.put(key, await new Response(new Blob([rows.map((row) => JSON.stringify(row)).join("\n")]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    expect(await indexLogpushObject(env, key)).toBe(true);
    expect(await indexLogpushObject(env, key)).toBe(false);
    const files = await env.DB.prepare("SELECT record_count, schema_version, status FROM archive_manifests WHERE zone_id = ?").bind(id).all();
    expect(files.results).toEqual([{ record_count: 2, schema_version: 3, status: "indexed" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM request_samples WHERE zone_id = ?").bind(id).first("n")).toBe(0);
    expect(await usesLogpush(env.DB, id, "httpRequestsAdaptive")).toBe(false);
    const activated = await exports.default.fetch(`http://localhost/api/v1/logpush/${id}/http_requests/activate`, { method: "POST", headers: { Origin: "http://localhost" } });
    expect(activated.status).toBe(200);
    expect(await usesLogpush(env.DB, id, "httpRequestsAdaptive")).toBe(true);
    expect(await usesLogpush(env.DB, id, "httpRequestsAdaptiveGroups")).toBe(false);
  });

  it("未收到日志时不允许切断旧采集，接入操作受 Access 与同源保护", async () => {
    const id = "2".repeat(32);
    await zone(id);
    const url = `http://localhost/api/v1/logpush/${id}/http_requests/activate`;
    expect((await exports.default.fetch(url, { method: "POST", headers: { Origin: "http://localhost" } })).status).toBe(409);
    expect((await exports.default.fetch(url, { method: "POST" })).status).toBe(403);
    expect((await exports.default.fetch("https://observatory.example/api/v1/logpush")).status).toBe(401);
  });

  it("无效文件不建立成功清单，原始对象仍在 R2", async () => {
    const id = "3".repeat(32);
    await zone(id);
    const key = `logpush/${id}/http_requests/20261011/bad.log.gz`;
    await env.ARCHIVES.put(key, await new Response(new Blob(['{"RayID":"bad"}']).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    await expect(indexLogpushObject(env, key)).rejects.toThrow("有效时间");
    expect(await env.ARCHIVES.head(key)).not.toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM archive_manifests WHERE r2_key = ?").bind(key).first()).toBeNull();
  });

  it("空目录可完成修复扫描，不伪造投递状态", async () => {
    const id = "4".repeat(32);
    await zone(id);
    await reconcileLogpush(env, id, "firewall_events");
    expect(await env.DB.prepare("SELECT 1 FROM logpush_sources WHERE zone_id = ?").bind(id).first()).toBeNull();
  });
});

describe("R2 趋势存储", () => {
  it("数百个维度只产生一个小时索引，重复窗口不会增加计数", async () => {
    const id = "5".repeat(32);
    await zone(id);
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const rows: StoredMetric[] = Array.from({ length: 400 }, (_, i) => ({ zone_id: id, metric_kind: "http", bucket_start: hour,
      bucket_seconds: 300, dimension_signature: `ip:${i}`, dimension_type: "ip", dimension_value: `192.0.2.${i}`,
      estimated_count: 3, sample_interval: 1, confidence_lower: null, confidence_upper: null, edge_response_bytes: null, visits: null }));
    expect(await storeMetricRows(env, rows)).toBe(400);
    expect(await storeMetricRows(env, rows)).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_buckets WHERE zone_id = ?").bind(id).first("n")).toBe(0);
    const manifest = await env.DB.prepare("SELECT r2_key FROM metric_archives WHERE zone_id = ?").bind(id).all<{ r2_key: string }>();
    expect(manifest.results).toHaveLength(1);
    const object = await env.ARCHIVES.get(manifest.results[0].r2_key);
    const doc = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).json<MetricDocument>();
    expect(doc.rows.reduce((sum, row) => sum + row.estimated_count, 0)).toBe(1200);
  });

  it("首次接管小时保留旧维度，旧接口不重复计入该小时", async () => {
    const id = "6".repeat(32);
    await zone(id);
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await env.DB.prepare(`INSERT INTO metric_buckets
      (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, estimated_count, updated_at)
      VALUES (?, ?, 300, 'http', 'legacy', 7, ?)`).bind(id, hour, Date.now()).run();
    const row: StoredMetric = { zone_id: id, metric_kind: "http", bucket_start: hour + 300_000,
      bucket_seconds: 300, dimension_signature: "new", dimension_type: null, dimension_value: null, estimated_count: 5,
      sample_interval: null, confidence_lower: null, confidence_upper: null, edge_response_bytes: null, visits: null };
    await storeMetricRows(env, [row]);
    const object = await env.ARCHIVES.get(`metrics/${id}/http/${hour}.json.gz`);
    const doc = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).json<MetricDocument>();
    expect(doc.rows.reduce((sum, item) => sum + item.estimated_count, 0)).toBe(12);
    const params = new URLSearchParams({ zones: id, from: new Date(hour).toISOString(), to: new Date(hour + 3_600_000).toISOString() });
    const response = await exports.default.fetch(`http://localhost/api/v1/metrics?${params}`);
    expect(await response.json()).toMatchObject({ series: [] });
  });
});
