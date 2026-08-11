import { decryptSecret } from "@/worker/crypto";
import { sendSmtp } from "@/worker/smtp";
import { asRecord, nowMs, sanitizeError } from "@/worker/utils";
import { smtpConfigSchema, type SmtpConfigInput } from "@/shared/contracts";

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

interface SmtpRow {
  enabled: number;
  host: string;
  port: 465 | 587;
  tls_mode: "implicit" | "starttls";
  auth_method: "plain" | "login";
  username: string;
  encrypted_password: string | null;
  password_iv: string | null;
  encryption_version: 1 | null;
  sender_name: string | null;
  sender_address: string;
  recipients: string;
  subject_prefix: string;
}

interface AlertStateRow {
  status: string;
  last_sent_at: number | null;
}

export async function evaluateAlerts(env: Env): Promise<void> {
  const timestamp = nowMs();
  const failing = await env.DB.prepare(
    `SELECT c.zone_id, z.name AS zone_name, c.dataset, c.consecutive_failures, c.last_success_at,
      c.last_error, z.poll_interval_minutes
     FROM sync_cursors c JOIN zones z ON z.id = c.zone_id
     WHERE z.enabled = 1 AND (c.consecutive_failures >= 3 OR c.last_success_at < ?)`,
  )
    .bind(timestamp - 15 * 60_000)
    .all<Record<string, unknown>>();
  const active = new Map<string, { title: string; details: string }>();
  for (const raw of failing.results) {
    const row = asRecord(raw);
    const threshold = Math.max(Number(row.poll_interval_minutes) * 3, 15) * 60_000;
    const lastSuccess = Number(row.last_success_at ?? 0);
    if (Number(row.consecutive_failures) >= 3 || timestamp - lastSuccess > threshold) {
      const key = `collector:${String(row.zone_id)}:${String(row.dataset)}`;
      active.set(key, {
        title: `采集异常：${String(row.zone_name)} / ${String(row.dataset)}`,
        details: `连续失败 ${String(row.consecutive_failures)} 次，最后成功时间：${lastSuccess ? new Date(lastSuccess).toISOString() : "从未成功"}。`,
      });
    }
  }
  const usage = await env.DB.prepare(
    `SELECT d1_rows_written, d1_size_after, queue_messages, graphql_queries
     FROM usage_daily WHERE day = ?`,
  )
    .bind(new Date(timestamp).toISOString().slice(0, 10))
    .first<Record<string, unknown>>();
  if (Number(usage?.d1_rows_written ?? 0) >= 80_000) {
    active.set("budget:d1-writes", { title: "D1 写入额度达到 80%", details: "采集已停止推进游标，UTC 零点后自动恢复。" });
  }
  if (Number(usage?.d1_size_after ?? 0) >= Number(env.D1_WARNING_BYTES)) {
    active.set("storage:d1", { title: "D1 存储达到安全水位", details: "系统将优先归档并清理最旧的完整小时。" });
  }
  if (Number(usage?.queue_messages ?? 0) >= 8_000) {
    active.set("budget:queue", { title: "Queue 每日安全预算已用尽", details: "当日 Queue 操作估算已达到预留 20% 后的安全水位。" });
  }
  for (const [key, alert] of active) await transitionAlert(env, key, true, alert.title, alert.details, timestamp);

  const open = await env.DB.prepare("SELECT alert_key FROM alert_state WHERE status = 'active'")
    .all<{ alert_key: string }>();
  for (const state of open.results) {
    // DLQ 没有可靠的自动清空信号；保留状态，直到运维确认并显式处理对应记录。
    if (!state.alert_key.startsWith("dlq:") && !active.has(state.alert_key)) {
      await transitionAlert(env, state.alert_key, false, "状态已恢复", state.alert_key, timestamp);
    }
  }
}

async function transitionAlert(
  env: Env,
  key: string,
  active: boolean,
  title: string,
  details: string,
  timestamp: number,
): Promise<void> {
  const current = await env.DB.prepare("SELECT status, last_sent_at FROM alert_state WHERE alert_key = ?")
    .bind(key)
    .first<AlertStateRow>();
  const status = active ? "active" : "recovered";
  const shouldSend = !current || current.status !== status || !current.last_sent_at || timestamp - current.last_sent_at >= ALERT_COOLDOWN_MS;
  await env.DB.prepare(
    `INSERT INTO alert_state (alert_key, status, first_seen_at, last_seen_at, recovered_at, details)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(alert_key) DO UPDATE SET status = excluded.status, last_seen_at = excluded.last_seen_at,
      recovered_at = excluded.recovered_at, details = excluded.details`,
  )
    .bind(key, status, timestamp, timestamp, active ? null : timestamp, JSON.stringify({ title, details }))
    .run();
  if (!shouldSend) return;
  try {
    const loaded = await loadSmtp(env);
    if (!loaded) return;
    await sendSmtp(loaded.config, loaded.password, { subject: title, text: details });
    await env.DB.prepare("UPDATE alert_state SET last_sent_at = ? WHERE alert_key = ?").bind(timestamp, key).run();
  } catch (error) {
    console.error(JSON.stringify({ event: "smtp_alert_failed", alertKey: key, error: sanitizeError(error) }));
  }
}

export async function loadSmtp(env: Env): Promise<{ config: SmtpConfigInput; password: string } | null> {
  const row = await env.DB.prepare("SELECT * FROM smtp_settings WHERE id = 1").first<SmtpRow>();
  if (!row || row.enabled !== 1 || !row.encrypted_password || !row.password_iv || row.encryption_version !== 1) return null;
  const config = smtpConfigSchema.parse({
    enabled: true,
    host: row.host,
    port: row.port,
    tlsMode: row.tls_mode,
    authMethod: row.auth_method,
    username: row.username,
    senderName: row.sender_name ?? "",
    senderAddress: row.sender_address,
    recipients: JSON.parse(row.recipients) as unknown,
    subjectPrefix: row.subject_prefix,
  });
  const password = await decryptSecret(
    { ciphertext: row.encrypted_password, iv: row.password_iv, version: row.encryption_version },
    env.CONFIG_ENCRYPTION_KEY,
  );
  return { config, password };
}
