import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { collectorJobSchema } from "@/shared/contracts";
import { dispatchScheduled, processCollectJob } from "@/worker/collector";
import { D1_DAILY_BACKFILL_PAUSE, D1_DAILY_WRITE_PAUSE } from "@/worker/budgets";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function prepare(zoneId: string, caughtUp = false, writes = D1_DAILY_BACKFILL_PAUSE) {
  const now = Date.now();
  // 避开日志扫描和小时维护的分钟，仅验收实时趋势调度。
  const scheduledAt = Math.floor(now / 300_000) * 300_000 + 60_000;
  const end = scheduledAt - 300_000;
  const cursor = caughtUp ? end : end - 2 * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO zones (id,name,enabled,poll_interval_minutes,created_at,updated_at) VALUES (?, ?, 1, 5, ?, ?)")
      .bind(zoneId, `${zoneId}.example`, now, now),
    env.DB.prepare(`INSERT INTO dataset_capabilities
      (zone_id,dataset,enabled,available_fields,max_page_size,not_older_than,max_duration,checked_at)
      VALUES (?, 'httpRequestsAdaptiveGroups', 1, '["dimensions_datetimeFiveMinutes","count"]', 250, 604800, 3600, ?)`)
      .bind(zoneId, now),
    env.DB.prepare(`INSERT INTO sync_cursors (zone_id,dataset,cursor_at,in_flight_until,updated_at)
      VALUES (?, 'httpRequestsAdaptiveGroups', ?, ?, ?)`)
      .bind(zoneId, cursor, now + 86_400_000, now),
    env.DB.prepare(`INSERT INTO usage_daily (day,d1_rows_written,updated_at) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET d1_rows_written=excluded.d1_rows_written`)
      .bind(new Date(now).toISOString().slice(0, 10), writes, now),
  ]);
  const send = vi.spyOn(env.COLLECTOR_QUEUE, "send").mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
  const fetchMock = vi.fn(() => Promise.reject(new Error("调度不应发起数据采集请求")));
  vi.stubGlobal("fetch", fetchMock);
  return { scheduledAt, end, cursor, send, fetchMock };
}

describe("历史租约与实时调度", () => {
  it("历史补采预算暂停后仍调度最近五分钟，且保留原补采游标和租约", async () => {
    const zoneId = "live-despite-backfill-lease";
    const { scheduledAt, end, cursor, send, fetchMock } = await prepare(zoneId);
    expect(await processCollectJob(env, {
      version: 1, type: "collect", id: "paused-trend", zoneId,
      dataset: "httpRequestsAdaptiveGroups", start: cursor, end: cursor + 3_600_000,
      mode: "backfill", budgetClass: "backfill",
    })).toBe("budget-paused");
    const before = await env.DB.prepare("SELECT cursor_at,in_flight_until FROM sync_cursors WHERE zone_id=?")
      .bind(zoneId).first();
    send.mockClear();
    await dispatchScheduled(env, scheduledAt);
    const jobs = send.mock.calls.map(([body]) => collectorJobSchema.parse(body));
    expect(jobs).toEqual([expect.objectContaining({
      type: "collect", zoneId, dataset: "httpRequestsAdaptiveGroups", mode: "repair",
      budgetClass: "live", start: end - 300_000, end,
    })]);
    expect(await env.DB.prepare("SELECT cursor_at,in_flight_until FROM sync_cursors WHERE zone_id=?")
      .bind(zoneId).first()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } }))));
    const live = jobs[0];
    if (live.type !== "collect") throw new Error("未调度实时采集任务");
    expect(await processCollectJob(env, live)).toBe("collected");
    expect(await env.DB.prepare("SELECT cursor_at,in_flight_until FROM sync_cursors WHERE zone_id=?")
      .bind(zoneId).first()).toEqual(before);
    expect(await env.DB.prepare("SELECT last_success_at FROM sync_cursors WHERE zone_id=?")
      .bind(zoneId).first<number>("last_success_at")).toBeGreaterThan(0);
  });

  it("游标已追上当前稳定窗口时不重复发送实时任务", async () => {
    const { scheduledAt, send } = await prepare("live-already-current", true);
    await dispatchScheduled(env, scheduledAt);
    expect(send).not.toHaveBeenCalled();
  });

  it("总写入预算暂停仍阻止实时任务，不能绕过七万行保护线", async () => {
    const { scheduledAt, send } = await prepare("live-total-paused", false, D1_DAILY_WRITE_PAUSE);
    await dispatchScheduled(env, scheduledAt);
    expect(send).not.toHaveBeenCalled();
  });

  it("历史修复完成不会被当成实时采集恢复", async () => {
    const zoneId = "historical-repair-health";
    const { cursor } = await prepare(zoneId, false, 0);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } }))));
    expect(await processCollectJob(env, {
      version: 1, type: "collect", id: "old-repair", zoneId, dataset: "httpRequestsAdaptiveGroups",
      start: cursor, end: cursor + 300_000, mode: "repair", budgetClass: "backfill",
    })).toBe("collected");
    expect(await env.DB.prepare("SELECT last_success_at FROM sync_cursors WHERE zone_id=?")
      .bind(zoneId).first("last_success_at")).toBeNull();
  });
});
