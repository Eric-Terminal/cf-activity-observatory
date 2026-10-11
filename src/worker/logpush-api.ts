import { Hono } from "hono";
import { logpushDatasetSchema, LOGPUSH_FIELDS } from "@/shared/logpush";
import { listLogpushSources } from "@/worker/logpush";
import { nowMs } from "@/worker/utils";

export const logpushApi = new Hono<{ Bindings: Env }>();

logpushApi.get("/", async (context) => context.json({
  bucket: context.env.ARCHIVE_BUCKET_NAME,
  fields: LOGPUSH_FIELDS,
  sources: await listLogpushSources(context.env.DB),
}));

logpushApi.post("/:zone/:dataset/:action", async (context) => {
  const zoneId = context.req.param("zone");
  const parsed = logpushDatasetSchema.safeParse(context.req.param("dataset"));
  if (!/^[a-f0-9]{32}$/u.test(zoneId) || !parsed.success) return context.json({ error: { code: "INVALID_SOURCE", message: "日志来源无效" } }, 422);
  const source = (await listLogpushSources(context.env.DB)).find((item) => item.zoneId === zoneId && item.dataset === parsed.data);
  if (!source) return context.json({ error: { code: "ZONE_NOT_FOUND", message: "请先发现 Zone" } }, 404);
  const action = context.req.param("action");
  if (action === "reconcile") {
    await context.env.COLLECTOR_QUEUE.send({ version: 1, type: "reconcile-logpush", zoneId, dataset: parsed.data });
    return context.json({ queued: true }, 202);
  }
  if (action === "activate") {
    if (!source.files || !source.lastReceivedAt || nowMs() - source.lastReceivedAt > 86_400_000) {
      return context.json({ error: { code: "LOGPUSH_NOT_READY", message: "尚未索引过去 24 小时收到的日志，请检查投递或重建索引后再切换" } }, 409);
    }
    await context.env.DB.prepare("UPDATE logpush_sources SET activated_at = COALESCE(activated_at, ?) WHERE zone_id = ? AND dataset = ?")
      .bind(nowMs(), zoneId, parsed.data).run();
    return context.json({ activated: true });
  }
  if (action === "deactivate") {
    await context.env.DB.prepare("UPDATE logpush_sources SET activated_at = NULL WHERE zone_id = ? AND dataset = ?")
      .bind(zoneId, parsed.data).run();
    return context.json({ activated: false });
  }
  return context.json({ error: { code: "INVALID_ACTION", message: "不支持的日志来源操作" } }, 422);
});
