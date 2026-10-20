import { api } from "@/worker/api";
import { runMaintenance } from "@/worker/archive";
import { dispatchScheduled, processCollectJob, retryDelay } from "@/worker/collector";
import { collectorJobSchema } from "@/shared/contracts";
import { incrementUsage } from "@/worker/db";
import { sanitizeError, stableId } from "@/worker/utils";
import { indexLogpushObject, r2NotificationSchema, reconcileLogpush } from "@/worker/logpush";

export default {
  async fetch(request, env, context): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1")) {
      return api.fetch(request, env, context);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "same-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  scheduled(controller, env, context): void {
    context.waitUntil(dispatchScheduled(env, controller.scheduledTime));
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const notification = r2NotificationSchema.safeParse(message.body);
      const parsed = collectorJobSchema.safeParse(message.body);
      const nativeJob = parsed.success && (parsed.data.type === "index-logpush" || parsed.data.type === "reconcile-logpush") ? parsed.data : null;
      if (notification.success || nativeJob) {
        const key = notification.success ? notification.data.object.key : nativeJob?.type === "index-logpush" ? nativeJob.key : null;
        try {
          if (notification.success && notification.data.bucket !== env.ARCHIVE_BUCKET_NAME) throw new Error("R2 通知来自未绑定的桶");
          // 普通任务的发送已在生产者计数；R2 通知的写入由平台完成，需要在首次读取时补计。
          await incrementUsage(env.DB, { workerInvocations: 1, queueMessages: notification.success && message.attempts === 1 ? 2 : 1 });
          if (key) await indexLogpushObject(env, key);
          if (nativeJob?.type === "reconcile-logpush") await reconcileLogpush(env, nativeJob.zoneId, nativeJob.dataset, nativeJob.cursor, nativeJob.after);
          await incrementUsage(env.DB, { queueMessages: 1 });
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({ event: "logpush_index_failed", error: sanitizeError(error) }));
          if (message.attempts >= 3) {
            await env.DB.prepare(
              `INSERT INTO alert_state (alert_key, status, first_seen_at, last_seen_at, details)
               VALUES (?, 'active', ?, ?, ?) ON CONFLICT(alert_key) DO UPDATE SET
               status = 'active', last_seen_at = excluded.last_seen_at, details = excluded.details`,
            ).bind(`logpush:${stableId(key ?? message.id)}`, Date.now(), Date.now(), JSON.stringify({ error: sanitizeError(error) })).run();
          }
          message.retry({ delaySeconds: retryDelay(error, message.attempts) });
        }
        continue;
      }
      if (!parsed.success) {
        console.error(JSON.stringify({ event: "invalid_queue_message", messageId: message.id }));
        message.ack();
        continue;
      }
      if (parsed.data.type !== "collect" && parsed.data.type !== "maintenance") continue;
      try {
        await incrementUsage(env.DB, { workerInvocations: 1, queueMessages: 1 });
        if (parsed.data.type === "collect") {
          const outcome = await processCollectJob(env, parsed.data);
          if (outcome !== "collected") {
            console.info(JSON.stringify({ event: "collection_deferred", outcome, jobId: parsed.data.id }));
          }
        } else await runMaintenance(env, parsed.data.scheduledAt);
        await incrementUsage(env.DB, { queueMessages: 1 });
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "queue_job_failed", jobId: parsed.data.id, error: sanitizeError(error) }));
        if (message.attempts >= 3) {
          const timestamp = Date.now();
          await env.DB.prepare(
            `INSERT INTO alert_state (alert_key, status, first_seen_at, last_seen_at, details)
             VALUES (?, 'active', ?, ?, ?)
             ON CONFLICT(alert_key) DO UPDATE SET status = 'active', last_seen_at = excluded.last_seen_at,
              details = excluded.details`,
          )
            .bind(`dlq:${parsed.data.id}`, timestamp, timestamp, JSON.stringify({
              jobType: parsed.data.type,
              ...(parsed.data.type === "collect" ? {
                zoneId: parsed.data.zoneId,
                dataset: parsed.data.dataset,
                rangeStart: parsed.data.start,
                rangeEnd: parsed.data.end,
              } : {}),
              error: sanitizeError(error),
            }))
            .run();
        }
        message.retry({ delaySeconds: retryDelay(error, message.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env>;
