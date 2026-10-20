import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createMessageBatch } from "cloudflare:test";
import worker from "@/worker/index";
import { collectorJobSchema } from "@/shared/contracts";
import { indexLogpushObject, reconcileLogpush, scheduleLogpushScans } from "@/worker/logpush";
import { incrementUsage } from "@/worker/db";

afterEach(() => vi.restoreAllMocks());
const sentResponse = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };

async function addZone(id: string) {
  await env.DB.prepare("INSERT INTO zones (id, name, enabled, created_at, updated_at) VALUES (?, ?, 1, 0, 0)")
    .bind(id, `${id}.example`).run();
}

async function putLog(key: string, rayId = "test-ray") {
  const row = { RayID: rayId, EdgeStartTimestamp: "2026-10-20T00:00:00Z" };
  await env.ARCHIVES.put(key, await new Response(
    new Blob([JSON.stringify(row)]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());
}

describe("Logpush 批量扫描的额度与恢复", () => {
  it("一条消息索引多个文件，页内余下文件通过单条续传处理且不会漏项", async () => {
    const zoneId = "8".repeat(32);
    await addZone(zoneId);
    for (let i = 0; i < 9; i++) await putLog(`logpush/${zoneId}/http_requests/20261020/${i}.log.gz`);
    const send = vi.spyOn(env.COLLECTOR_QUEUE, "send").mockResolvedValue(sentResponse);
    const sendBatch = vi.spyOn(env.COLLECTOR_QUEUE, "sendBatch").mockResolvedValue(sentResponse);
    await reconcileLogpush(env, zoneId, "http_requests");
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM archive_manifests WHERE zone_id = ?").bind(zoneId).first("n")).toBe(7);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    const next = collectorJobSchema.parse(send.mock.calls[0]?.[0]);
    if (next.type !== "reconcile-logpush") throw new Error("续传任务类型错误");
    expect(next.after).toContain("/6.log.gz");
    await reconcileLogpush(env, zoneId, "http_requests", next.cursor, next.after);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM archive_manifests WHERE zone_id = ?").bind(zoneId).first("n")).toBe(9);
    expect(send).toHaveBeenCalledOnce();
    const get = vi.spyOn(env.ARCHIVES, "get");
    await reconcileLogpush(env, zoneId, "http_requests");
    expect(get).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("使用列表 ETag 跳过旧文件，修改过的对象会重新索引", async () => {
    const zoneId = "9".repeat(32);
    await addZone(zoneId);
    const key = `logpush/${zoneId}/http_requests/20261020/changed.log.gz`;
    await putLog(key, "before");
    await indexLogpushObject(env, key);
    const before = await env.DB.prepare("SELECT etag FROM archive_manifests WHERE r2_key = ?").bind(key).first("etag");
    await putLog(key, "after");
    await reconcileLogpush(env, zoneId, "http_requests");
    expect(await env.DB.prepare("SELECT etag FROM archive_manifests WHERE r2_key = ?").bind(key).first("etag")).not.toBe(before);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM archive_manifests WHERE zone_id = ?").bind(zoneId).first("n")).toBe(1);
  });

  it("即使当前列表页没有待处理文件，也会沿 R2 cursor 继续扫描", async () => {
    const zoneId = "a".repeat(32);
    await addZone(zoneId);
    const send = vi.spyOn(env.COLLECTOR_QUEUE, "send").mockResolvedValue(sentResponse);
    vi.spyOn(env.ARCHIVES, "list").mockResolvedValueOnce({
      objects: [], truncated: true, cursor: "next-page", delimitedPrefixes: [],
    });
    await reconcileLogpush(env, zoneId, "http_requests");
    expect(send).toHaveBeenCalledWith({ version: 1, type: "reconcile-logpush", zoneId, dataset: "http_requests", cursor: "next-page" });
  });

  it("损坏文件独立重试，不阻塞同页其他文件，也不伪造成功索引", async () => {
    const zoneId = "b".repeat(32);
    await addZone(zoneId);
    const bad = `logpush/${zoneId}/http_requests/20261020/0.log.gz`;
    await env.ARCHIVES.put(bad, "invalid gzip");
    await putLog(`logpush/${zoneId}/http_requests/20261020/1.log.gz`);
    const send = vi.spyOn(env.COLLECTOR_QUEUE, "send").mockResolvedValue(sentResponse);
    await reconcileLogpush(env, zoneId, "http_requests");
    expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1, type: "index-logpush", key: bad });
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM archive_manifests WHERE zone_id = ?").bind(zoneId).first("n")).toBe(1);
    expect(await env.ARCHIVES.head(bad)).not.toBeNull();
  });

  it("每五分钟跨日重叠检查，UTC 每日全量核对补回很早的漏索引文件", async () => {
    const zoneId = "c".repeat(32);
    await addZone(zoneId);
    const send = vi.spyOn(env.COLLECTOR_QUEUE, "send").mockResolvedValue(sentResponse);
    await scheduleLogpushScans(env, Date.parse("2026-10-20T00:05:00Z"));
    const regular = send.mock.calls.map(([body]) => collectorJobSchema.parse(body))
      .find((job) => job.type === "reconcile-logpush" && job.zoneId === zoneId && job.dataset === "http_requests");
    expect(regular).toMatchObject({ after: `logpush/${zoneId}/http_requests/20261019/20261019T220500Z` });
    const old = `logpush/${zoneId}/http_requests/20261017/20261017T120000Z_old.log.gz`;
    await putLog(old);
    if (regular?.type !== "reconcile-logpush") throw new Error("缺少定时扫描任务");
    await reconcileLogpush(env, zoneId, "http_requests", regular.cursor, regular.after);
    expect(await env.DB.prepare("SELECT 1 FROM archive_manifests WHERE r2_key = ?").bind(old).first()).toBeNull();
    send.mockClear();
    await scheduleLogpushScans(env, Date.parse("2026-10-20T00:17:00Z"));
    const full = send.mock.calls.map(([body]) => collectorJobSchema.parse(body))
      .find((job) => job.type === "reconcile-logpush" && job.zoneId === zoneId && job.dataset === "http_requests");
    if (full?.type !== "reconcile-logpush") throw new Error("缺少每日全量扫描任务");
    expect(full.after).toBeUndefined();
    await reconcileLogpush(env, zoneId, "http_requests", full.cursor, full.after);
    expect(await env.DB.prepare("SELECT 1 FROM archive_manifests WHERE r2_key = ?").bind(old).first()).not.toBeNull();
    send.mockClear();
    expect(await scheduleLogpushScans(env, Date.parse("2026-10-20T00:18:00Z"))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("发送、读取、确认合计三次操作；重试读取单独计数", async () => {
    const zoneId = "d".repeat(32);
    await addZone(zoneId);
    const usage = async () => Number(await env.DB.prepare("SELECT COALESCE(SUM(queue_messages), 0) n FROM usage_daily").first("n"));
    const before = await usage();
    await incrementUsage(env.DB, { queueMessages: 1 });
    await worker.queue(createMessageBatch("cf-activity-observatory", [{
      id: "batch-accounting", timestamp: new Date(), attempts: 1,
      body: { version: 1, type: "reconcile-logpush", zoneId, dataset: "http_requests" },
    }]), env);
    expect(await usage() - before).toBe(3);
    const failed = createMessageBatch("cf-activity-observatory", [{
      id: "retry-accounting", timestamp: new Date(), attempts: 2,
      body: { version: 1, type: "index-logpush", key: `logpush/${zoneId}/http_requests/20261020/missing.log.gz` },
    }]);
    const retry = vi.spyOn(failed.messages[0], "retry");
    await worker.queue(failed, env);
    expect(retry).toHaveBeenCalledOnce();
    expect(await usage() - before).toBe(4);
  });
});
