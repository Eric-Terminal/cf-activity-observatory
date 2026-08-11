import { api } from "@/worker/api";
import { runMaintenance } from "@/worker/archive";
import { dispatchScheduled, processCollectJob, retryDelay } from "@/worker/collector";
import { collectorJobSchema } from "@/shared/contracts";
import { incrementUsage } from "@/worker/db";
import { sanitizeError } from "@/worker/utils";

export default {
  async fetch(request, env, context): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1")) {
      context.waitUntil(incrementUsage(env.DB, { workerInvocations: 1 }));
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
    await incrementUsage(env.DB, { workerInvocations: 1, queueMessages: batch.messages.length });
    for (const message of batch.messages) {
      const parsed = collectorJobSchema.safeParse(message.body);
      if (!parsed.success) {
        console.error(JSON.stringify({ event: "invalid_queue_message", messageId: message.id }));
        message.ack();
        continue;
      }
      try {
        if (parsed.data.type === "collect") await processCollectJob(env, parsed.data);
        else await runMaintenance(env, parsed.data.scheduledAt);
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
            .bind(`dlq:${parsed.data.id}`, timestamp, timestamp, JSON.stringify({ jobType: parsed.data.type, error: sanitizeError(error) }))
            .run();
        }
        message.retry({ delaySeconds: retryDelay(error, message.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env>;
