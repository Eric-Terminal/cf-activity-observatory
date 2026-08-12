import { afterEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { createMessageBatch } from "cloudflare:test";
import {
  collectionWindowDuration,
  dispatchScheduled,
  oldestQueryableAt,
  processCollectJob,
  retryDelay,
} from "@/worker/collector";
import { runMaintenance } from "@/worker/archive";
import { csvCell, estimateDailyQueueOperations } from "@/worker/api";
import { dotStuff, mimeMessage } from "@/worker/smtp";
import { CloudflareApiError } from "@/worker/cloudflare";
import { evaluateAlerts } from "@/worker/alerts";
import worker from "@/worker/index";

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

  it("重复采集同一明细时补齐 ASN 且不产生重复记录", async () => {
    const timestamp = Date.now() - 10 * 60_000;
    await insertZone("zone-collect", "collect.example");
    await env.DB.prepare(
      `INSERT INTO dataset_capabilities
       (zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields, not_older_than, max_duration, checked_at)
       VALUES ('zone-collect', 'httpRequestsAdaptive', 1, '["datetime","rayName","clientIP","clientAsn","clientASNDescription"]', 1000, 10, 604800, 86400, ?)`,
    ).bind(Date.now()).run();
    const initialPayload = {
      data: { viewer: { zones: [{ httpRequestsAdaptive: [{ datetime: new Date(timestamp).toISOString(), rayName: "same-ray", clientIP: "198.51.100.2", clientASNDescription: "Example Network" }] }] } },
    };
    const repairedPayload = {
      data: { viewer: { zones: [{ httpRequestsAdaptive: [{ datetime: new Date(timestamp).toISOString(), rayName: "same-ray", clientIP: "198.51.100.2", clientAsn: 64500, clientASNDescription: "Example Network" }] }] } },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify(initialPayload), { status: 200, headers: { "Content-Type": "application/json" } })))
      .mockImplementationOnce((_input, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("GraphQL 测试请求缺少 JSON body");
        expect(init.body).toContain("clientAsn");
        return Promise.resolve(new Response(JSON.stringify(repairedPayload), { status: 200, headers: { "Content-Type": "application/json" } }));
      }));
    const base = { version: 1 as const, type: "collect" as const, zoneId: "zone-collect", dataset: "httpRequestsAdaptive" as const, start: timestamp - 1000, end: timestamp + 1000, mode: "repair" as const };
    await processCollectJob(env, { ...base, id: "collect-one" });
    await processCollectJob(env, { ...base, id: "collect-two" });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS count, MAX(asn) AS asn FROM request_samples WHERE zone_id = 'zone-collect'").first<{ count: number; asn: number | null }>();
    expect(stored).toEqual({ count: 1, asn: 64500 });
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

  it("D1 写入预算暂停时不再调度采集任务", async () => {
    const scheduledAt = Date.UTC(2026, 7, 12, 10, 20);
    await insertZone("zone-budget-dispatch", "budget-dispatch.example");
    await setD1Writes(80_000);
    const fetchMock = vi.fn(() => Promise.reject(new Error("预算暂停时不应请求 Cloudflare")));
    vi.stubGlobal("fetch", fetchMock);

    await dispatchScheduled(env, scheduledAt);

    expect(fetchMock).not.toHaveBeenCalled();
    const zone = await env.DB.prepare(
      "SELECT last_scheduled_at FROM zones WHERE id = 'zone-budget-dispatch'",
    ).first<{ last_scheduled_at: number | null }>();
    expect(zone?.last_scheduled_at).toBeNull();
    const cursors = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sync_cursors WHERE zone_id = 'zone-budget-dispatch'",
    ).first<{ count: number }>();
    expect(cursors?.count).toBe(0);
  });

  it("预算暂停会正常跳过队列任务并释放回填租约", async () => {
    const timestamp = Date.now();
    await insertZone("zone-budget-consumer", "budget-consumer.example");
    await env.DB.prepare(
      `INSERT INTO sync_cursors
       (zone_id, dataset, cursor_at, last_success_at, consecutive_failures, in_flight_until, last_error, updated_at)
       VALUES ('zone-budget-consumer', 'httpRequestsAdaptive', ?, ?, 2, ?, '此前的真实错误', ?)`,
    ).bind(timestamp - 60_000, timestamp - 120_000, timestamp + 15 * 60_000, timestamp).run();
    await setD1Writes(80_000, timestamp);
    const fetchMock = vi.fn(() => Promise.reject(new Error("预算暂停时不应请求 Cloudflare")));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await processCollectJob(env, {
      version: 1,
      type: "collect",
      id: "budget-paused-job",
      zoneId: "zone-budget-consumer",
      dataset: "httpRequestsAdaptive",
      start: timestamp - 60_000,
      end: timestamp,
      mode: "backfill",
    });

    expect(outcome).toBe("budget-paused");
    expect(fetchMock).not.toHaveBeenCalled();
    const cursor = await env.DB.prepare(
      `SELECT consecutive_failures, in_flight_until, last_error FROM sync_cursors
       WHERE zone_id = 'zone-budget-consumer' AND dataset = 'httpRequestsAdaptive'`,
    ).first<{ consecutive_failures: number; in_flight_until: number | null; last_error: string | null }>();
    expect(cursor).toEqual({ consecutive_failures: 2, in_flight_until: null, last_error: "此前的真实错误" });
    const run = await env.DB.prepare(
      "SELECT id FROM collector_runs WHERE id = 'budget-paused-job'",
    ).first<{ id: string }>();
    expect(run).toBeNull();
  });

  it("Queue 消费者会确认预算暂停任务而不是重试", async () => {
    const timestamp = Date.now();
    await insertZone("zone-budget-queue", "budget-queue.example");
    await env.DB.prepare(
      `INSERT INTO sync_cursors (zone_id, dataset, cursor_at, consecutive_failures, in_flight_until, updated_at)
       VALUES ('zone-budget-queue', 'httpRequestsAdaptive', ?, 0, ?, ?)`,
    ).bind(timestamp - 60_000, timestamp + 15 * 60_000, timestamp).run();
    await setD1Writes(80_000, timestamp);

    const batch = createMessageBatch("cf-activity-observatory", [{
      id: "budget-queue-message",
      timestamp: new Date(timestamp),
      attempts: 1,
      body: {
        version: 1,
        type: "collect",
        id: "budget-queue-job",
        zoneId: "zone-budget-queue",
        dataset: "httpRequestsAdaptive",
        start: timestamp - 60_000,
        end: timestamp,
        mode: "backfill",
      },
    }]);
    const message = batch.messages[0];
    if (!message) throw new Error("队列测试消息创建失败");
    const ack = vi.spyOn(message, "ack");
    const retry = vi.spyOn(message, "retry");
    await worker.queue(batch, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("Queue 消费者仍会重试真正的采集错误", async () => {
    const timestamp = Date.now();
    await insertZone("zone-real-failure", "real-failure.example");
    await env.DB.prepare(
      `INSERT INTO sync_cursors (zone_id, dataset, cursor_at, consecutive_failures, in_flight_until, updated_at)
       VALUES ('zone-real-failure', 'httpRequestsAdaptive', ?, 0, ?, ?)`,
    ).bind(timestamp - 60_000, timestamp + 15 * 60_000, timestamp).run();
    await setD1Writes(0, timestamp);
    const batch = createMessageBatch("cf-activity-observatory", [{
      id: "real-failure-message",
      timestamp: new Date(timestamp),
      attempts: 1,
      body: {
        version: 1,
        type: "collect",
        id: "real-failure-job",
        zoneId: "zone-real-failure",
        dataset: "httpRequestsAdaptive",
        start: timestamp - 60_000,
        end: timestamp,
        mode: "backfill",
      },
    }]);
    const message = batch.messages[0];
    if (!message) throw new Error("队列测试消息创建失败");
    const ack = vi.spyOn(message, "ack");
    const retry = vi.spyOn(message, "retry");

    await worker.queue(batch, env);

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("预算暂停期间不会把陈旧游标重复报告为采集故障", async () => {
    const timestamp = Date.now();
    await insertZone("zone-budget-alert", "budget-alert.example");
    await env.DB.prepare(
      `INSERT INTO sync_cursors
       (zone_id, dataset, cursor_at, last_success_at, consecutive_failures, last_error, updated_at)
       VALUES ('zone-budget-alert', 'httpRequestsAdaptive', ?, ?, 9, '旧采集错误', ?)`,
    ).bind(timestamp - 3_600_000, timestamp - 3_600_000, timestamp).run();
    await env.DB.prepare(
      `INSERT INTO alert_state (alert_key, status, first_seen_at, last_seen_at, details)
       VALUES ('collector:zone-budget-alert:httpRequestsAdaptive', 'active', ?, ?, '{}')`,
    ).bind(timestamp - 60_000, timestamp - 60_000).run();
    await setD1Writes(80_000, timestamp);

    await evaluateAlerts(env);

    const alerts = await env.DB.prepare(
      `SELECT alert_key, status FROM alert_state
       WHERE alert_key IN ('collector:zone-budget-alert:httpRequestsAdaptive', 'budget:d1-writes')
       ORDER BY alert_key`,
    ).all<{ alert_key: string; status: string }>();
    expect(alerts.results).toEqual([
      { alert_key: "budget:d1-writes", status: "active" },
      { alert_key: "collector:zone-budget-alert:httpRequestsAdaptive", status: "recovered" },
    ]);
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

async function setD1Writes(rows: number, timestamp = Date.now()): Promise<void> {
  const day = new Date(timestamp).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO usage_daily (day, d1_rows_written, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET d1_rows_written = excluded.d1_rows_written, updated_at = excluded.updated_at`,
  ).bind(day, rows, timestamp).run();
}
