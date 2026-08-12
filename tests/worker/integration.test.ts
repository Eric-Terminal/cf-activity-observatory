import { afterEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import {
  collectionWindowDuration,
  oldestQueryableAt,
  processCollectJob,
  retryDelay,
} from "@/worker/collector";
import { runMaintenance } from "@/worker/archive";
import { csvCell, estimateDailyQueueOperations } from "@/worker/api";
import { dotStuff, mimeMessage } from "@/worker/smtp";
import { CloudflareApiError } from "@/worker/cloudflare";

afterEach(() => vi.unstubAllGlobals());

describe("Worker API 与存储", () => {
  it("公网请求没有 Access JWT 时拒绝访问", async () => {
    const response = await exports.default.fetch("https://observatory.example/api/v1/health");
    expect(response.status).toBe(401);
  });

  it("状态修改请求缺少同源 Origin 时拒绝执行", async () => {
    const response = await exports.default.fetch("http://localhost/api/v1/zones/discover", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("未配置时健康端点可用且不会绕过 API 身份逻辑", async () => {
    const response = await exports.default.fetch("http://localhost/api/v1/health");
    expect(response.status).toBe(200);
    const body = await response.json<{ status: string }>();
    expect(["unconfigured", "healthy"]).toContain(body.status);
  });

  it("请求列表使用键集分页并返回采样明细", async () => {
    const timestamp = Date.now();
    await insertZone("zone-list", "list.example");
    await env.DB.prepare(
      `INSERT INTO request_samples
       (id, zone_id, occurred_at, ray_id, client_ip, host, path, method, edge_status, collected_at, batch_id, extra)
       VALUES ('request-one', 'zone-list', ?, 'ray-one', '192.0.2.1', 'list.example', '/hello', 'GET', 200, ?, 'test', '{}')`,
    ).bind(timestamp - 1000, timestamp).run();
    const url = new URL("http://localhost/api/v1/requests");
    url.searchParams.set("from", new Date(timestamp - 60_000).toISOString());
    url.searchParams.set("to", new Date(timestamp + 60_000).toISOString());
    const response = await exports.default.fetch(url.toString());
    expect(response.status).toBe(200);
    const body = await response.json<{ items: Array<{ rayId: string }> }>();
    expect(body.items[0]?.rayId).toBe("ray-one");
  });

  it("重复采集同一明细不会产生重复记录", async () => {
    const timestamp = Date.now() - 10 * 60_000;
    await insertZone("zone-collect", "collect.example");
    await env.DB.prepare(
      `INSERT INTO dataset_capabilities
       (zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields, not_older_than, max_duration, checked_at)
       VALUES ('zone-collect', 'httpRequestsAdaptive', 1, '["datetime","rayName","clientIP"]', 1000, 10, 604800, 86400, ?)`,
    ).bind(Date.now()).run();
    const payload = {
      data: { viewer: { zones: [{ httpRequestsAdaptive: [{ datetime: new Date(timestamp).toISOString(), rayName: "same-ray", clientIP: "198.51.100.2" }] }] } },
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }))));
    const base = { version: 1 as const, type: "collect" as const, zoneId: "zone-collect", dataset: "httpRequestsAdaptive" as const, start: timestamp - 1000, end: timestamp + 1000, mode: "repair" as const };
    await processCollectJob(env, { ...base, id: "collect-one" });
    await processCollectJob(env, { ...base, id: "collect-two" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM request_samples WHERE zone_id = 'zone-collect'").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("聚合总量不会重复计入高基数排名 cube", async () => {
    const timestamp = Math.floor((Date.now() - 3 * 3_600_000) / 300_000) * 300_000;
    await insertZone("zone-metrics", "metrics.example");
    await env.DB.prepare(
      `INSERT INTO dataset_capabilities
       (zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields, not_older_than, max_duration, checked_at)
       VALUES ('zone-metrics', 'httpRequestsAdaptiveGroups', 1,
        '["dimensions_datetimeFiveMinutes","dimensions_clientRequestHTTPHost","dimensions_clientRequestPath","count","avg_sampleInterval"]',
        1000, 10, 604800, 86400, ?)`,
    ).bind(Date.now()).run();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_input, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("GraphQL 测试请求缺少 JSON body");
      const query = JSON.parse(init.body) as { query: string };
      const dimensions = query.query.includes("clientRequestPath")
        ? { datetimeFiveMinutes: new Date(timestamp).toISOString(), clientRequestPath: "/ranked" }
        : { datetimeFiveMinutes: new Date(timestamp).toISOString(), clientRequestHTTPHost: "metrics.example" };
      return Promise.resolve(new Response(JSON.stringify({
        data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ dimensions, count: 10, avg: { sampleInterval: 1 } }] }] } },
      }), { headers: { "Content-Type": "application/json" } }));
    }));
    await processCollectJob(env, {
      version: 1,
      type: "collect",
      id: "collect-metrics",
      zoneId: "zone-metrics",
      dataset: "httpRequestsAdaptiveGroups",
      start: timestamp,
      end: timestamp + 300_000,
      mode: "repair",
    });
    const stored = await env.DB.prepare(
      "SELECT dimension_type, dimension_value FROM metric_buckets WHERE zone_id = 'zone-metrics' AND bucket_seconds = 300 ORDER BY dimension_type",
    ).all<{ dimension_type: string | null; dimension_value: string | null }>();
    expect(stored.results).toEqual([
      { dimension_type: null, dimension_value: null },
      { dimension_type: "path", dimension_value: "/ranked" },
    ]);
    await runMaintenance(env);

    const range = `from=${encodeURIComponent(new Date(timestamp - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(timestamp + 3_600_000).toISOString())}`;
    const totalResponse = await exports.default.fetch(`http://localhost/api/v1/metrics?kind=http&dimension=total&${range}`);
    const total = await totalResponse.json<{ series: Array<{ points: Array<{ estimated_count: number }> }> }>();
    expect(total.series[0]?.points[0]?.estimated_count).toBe(10);
    const pathResponse = await exports.default.fetch(`http://localhost/api/v1/metrics?kind=http&dimension=path&${range}`);
    const paths = await pathResponse.json<{ bucketSeconds: number; series: Array<{ name: string }> }>();
    expect(paths.bucketSeconds).toBe(3600);
    expect(paths.series[0]?.name).toBe("/ranked");
  });

  it("归档经 R2 校验后写入 verified manifest", async () => {
    const occurredAt = Math.floor((Date.now() - 3 * 3_600_000) / 3_600_000) * 3_600_000;
    await insertZone("zone-archive", "archive.example");
    await env.DB.prepare(
      `INSERT INTO security_events
       (id, zone_id, occurred_at, ray_id, action, source, collected_at, batch_id, extra)
       VALUES ('archive-event', 'zone-archive', ?, 'archive-ray', 'block', 'firewallRules', ?, 'test', '{}')`,
    ).bind(occurredAt, Date.now()).run();
    await runMaintenance(env);
    const manifest = await env.DB.prepare("SELECT status, r2_key FROM archive_manifests WHERE zone_id = 'zone-archive'").first<{ status: string; r2_key: string }>();
    expect(manifest?.status).toBe("verified");
    expect(await env.ARCHIVES.head(manifest?.r2_key ?? "missing")).not.toBeNull();
  });
});

describe("安全边界与协议细节", () => {
  it("首次回填避开 Cloudflare 滚动保留窗口边界", () => {
    const scheduledAt = Date.UTC(2026, 7, 12, 8, 0);
    expect(oldestQueryableAt(scheduledAt, 8 * 86_400)).toBe(
      scheduledAt - 8 * 86_400_000 + 15 * 60_000,
    );
  });

  it("极短可回看窗口不会越过稳定数据终点", () => {
    const scheduledAt = Date.UTC(2026, 7, 12, 8, 0);
    expect(oldestQueryableAt(scheduledAt, 60)).toBe(scheduledAt - 5 * 60_000);
  });

  it("将服务端允许的超长窗口收紧到单次 Worker 可安全处理的一小时", () => {
    expect(collectionWindowDuration(86_400)).toBe(3_600_000);
    expect(collectionWindowDuration(300)).toBe(300_000);
  });

  it("Queue 预算估算包含四数据集实时任务和每小时修复", () => {
    expect(estimateDailyQueueOperations([{ enabled: true, pollIntervalMinutes: 5 }])).toBe(3_744);
    expect(estimateDailyQueueOperations([{ enabled: false, pollIntervalMinutes: 1 }])).toBe(0);
  });
  it("阻止 CSV 公式注入", () => expect(csvCell("=WEBSERVICE(\"bad\")")).toBe("\"'=WEBSERVICE(\"\"bad\"\")\""));
  it("执行 SMTP dot stuffing 并生成标准 MIME", () => {
    expect(dotStuff("a\n.hidden\n..double")).toBe("a\r\n..hidden\r\n...double");
    const mime = mimeMessage({ enabled: true, host: "smtp.example", port: 465, tlsMode: "implicit", authMethod: "plain", username: "u", senderName: "观测站", senderAddress: "from@example.com", recipients: ["to@example.com"], subjectPrefix: "[Test]", clearPassword: false }, { subject: "正常", text: "正文" });
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain("=?UTF-8?B?");
  });
  it("429 显式 Retry-After 优先于指数退避", () => {
    const error = new CloudflareApiError("rate", 75, 429);
    expect(retryDelay(error, 1)).toBe(75);
  });
  it("503 使用有上限的指数退避", () => {
    expect(retryDelay(new CloudflareApiError("temporary", null, 503), 3)).toBe(120);
    expect(retryDelay(new CloudflareApiError("temporary", null, 503), 20)).toBe(900);
  });
});

async function insertZone(id: string, name: string): Promise<void> {
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO zones
     (id, name, enabled, poll_interval_minutes, detail_retention_days, created_at, updated_at)
     VALUES (?, ?, 1, 5, 90, ?, ?)`,
  ).bind(id, name, timestamp, timestamp).run();
}
