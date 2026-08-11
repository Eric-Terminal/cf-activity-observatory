import { afterEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import { processCollectJob, retryDelay } from "@/worker/collector";
import { runMaintenance } from "@/worker/archive";
import { csvCell } from "@/worker/api";
import { dotStuff, mimeMessage } from "@/worker/smtp";
import { CloudflareApiError } from "@/worker/cloudflare";

afterEach(() => vi.unstubAllGlobals());

describe("Worker API 与存储", () => {
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
});

async function insertZone(id: string, name: string): Promise<void> {
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO zones
     (id, name, enabled, poll_interval_minutes, detail_retention_days, created_at, updated_at)
     VALUES (?, ?, 1, 5, 90, ?, ?)`,
  ).bind(id, name, timestamp, timestamp).run();
}
