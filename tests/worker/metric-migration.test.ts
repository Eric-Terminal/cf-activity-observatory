import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { migrateLegacyMetricHour } from "@/worker/metric-migration";
import type { StoredMetric } from "@/shared/metrics";

it("回读验证后小批回收，后续迁移保留完整原始备份", async () => {
  const now = Date.now();
  const hour = Math.floor((now - 10 * 86_400_000) / 3_600_000) * 3_600_000;
  await env.DB.prepare("INSERT INTO zones (id, name, created_at, updated_at) VALUES ('migration', 'migration.example', ?, ?)").bind(now, now).run();
  for (let start = 0; start < 501; start += 100) {
    await env.DB.batch(Array.from({ length: Math.min(100, 501 - start) }, (_, i) => env.DB.prepare(
      "INSERT INTO metric_buckets (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, estimated_count, updated_at) VALUES ('migration', ?, 300, 'http', ?, 1, ?)",
    ).bind(hour, `dimension-${start + i}`, now)));
  }
  expect(await migrateLegacyMetricHour(env, now)).toBe(500);
  const key = `migration-backups/metrics/migration/http/${hour}.json.gz`;
  const backup = await env.ARCHIVES.get(key);
  const rows = await new Response(backup!.body.pipeThrough(new DecompressionStream("gzip"))).json<StoredMetric[]>();
  expect(rows).toHaveLength(501);
  // 模拟运维误改剩余行：无法证明备份覆盖时必须停止删除。
  await env.DB.prepare("UPDATE metric_buckets SET estimated_count = 2 WHERE zone_id = 'migration'").run();
  await expect(migrateLegacyMetricHour(env, now)).rejects.toThrow("备份与 D1 不一致");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_buckets WHERE zone_id = 'migration'").first("n")).toBe(1);
  await env.DB.prepare("UPDATE metric_buckets SET estimated_count = 1 WHERE zone_id = 'migration'").run();
  expect(await migrateLegacyMetricHour(env, now)).toBe(1);
  expect((await env.ARCHIVES.head(key))?.etag).toBe(backup?.etag);
  expect(await migrateLegacyMetricHour(env, now)).toBe(0);
});
