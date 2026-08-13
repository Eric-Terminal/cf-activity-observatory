import { Hono } from "hono";
import { z } from "zod";
import type { AccessIdentity, SavedViewInput } from "@/shared/contracts";
import { savedViewSchema, smtpConfigSchema, zoneConfigSchema } from "@/shared/contracts";
import { getArchive, listArchives } from "@/worker/archive";
import { assertSameOrigin, authenticate, AuthError } from "@/worker/auth";
import { listCloudflareZones } from "@/worker/cloudflare";
import { refreshZoneCapabilities } from "@/worker/collector";
import { encryptSecret } from "@/worker/crypto";
import {
  filtersFromUrl,
  getHealth,
  getRequest,
  getSecurityEvent,
  listCapabilities,
  listRequests,
  listSecurityEvents,
  listZones,
} from "@/worker/db";
import { loadSmtp } from "@/worker/alerts";
import { sendSmtp } from "@/worker/smtp";
import { asRecord, jsonError, nowMs, parseCsv, parseTimeRange, sanitizeError } from "@/worker/utils";

type Variables = { identity: AccessIdentity };
const api = new Hono<{ Bindings: Env; Variables: Variables }>().basePath("/api/v1");

api.use("*", async (context, next) => {
  try {
    context.set("identity", await authenticate(context.req.raw, context.env));
    assertSameOrigin(context.req.raw);
    await next();
  } catch (error) {
    if (error instanceof AuthError) return context.json({ error: { code: "ACCESS_DENIED", message: error.message } }, error.status);
    throw error;
  }
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "same-origin");
  context.header("X-Frame-Options", "DENY");
  context.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

api.get("/me", (context) => context.json(context.get("identity")));

api.get("/zones", async (context) => {
  const zones = await listZones(context.env.DB);
  const capabilities = await listCapabilities(context.env.DB);
  return context.json({ zones, capabilities });
});

api.post("/zones/discover", async (context) => {
  const discovered = await listCloudflareZones(context.env);
  const timestamp = nowMs();
  const statements = discovered.map((zone) =>
    context.env.DB.prepare(
      `INSERT INTO zones
       (id, name, account_id, enabled, poll_interval_minutes, detail_retention_days, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, account_id = excluded.account_id,
        updated_at = excluded.updated_at`,
    ).bind(
      zone.id,
      zone.name,
      zone.accountId,
      Number(context.env.DEFAULT_POLL_INTERVAL_MINUTES),
      Number(context.env.DEFAULT_RETENTION_DAYS),
      timestamp,
      timestamp,
    ),
  );
  if (statements.length) await context.env.DB.batch(statements);
  for (const zone of discovered) await refreshZoneCapabilities(context.env, zone.id);
  return context.json({ zones: await listZones(context.env.DB), capabilities: await listCapabilities(context.env.DB) });
});

api.put("/zones/:id", async (context) => {
  const parsed = zoneConfigSchema.safeParse(await context.req.json());
  if (!parsed.success) return jsonError(context, 422, "INVALID_ZONE_CONFIG", "Zone 设置无效", parsed.error.flatten());
  const existing = await listZones(context.env.DB);
  if (!existing.some((zone) => zone.id === context.req.param("id"))) {
    return jsonError(context, 404, "ZONE_NOT_FOUND", "Zone 不存在，请先重新发现 Zone");
  }
  const projected = existing.map((zone) =>
    zone.id === context.req.param("id") ? { ...zone, ...parsed.data } : zone,
  );
  const estimate = estimateDailyQueueOperations(projected);
  if (estimate > 8_000) {
    return jsonError(context, 422, "QUEUE_BUDGET_EXCEEDED", "该频率会超过预留 20% 后的 Queue 每日安全预算", {
      estimatedDailyOperations: estimate,
      safeDailyOperations: 8_000,
    });
  }
  const timestamp = nowMs();
  await context.env.DB.prepare(
    `UPDATE zones SET enabled = ?, poll_interval_minutes = ?, detail_retention_days = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      parsed.data.enabled ? 1 : 0,
      parsed.data.pollIntervalMinutes,
      parsed.data.detailRetentionDays,
      timestamp,
      context.req.param("id"),
    )
    .run();
  return context.json({ zone: (await listZones(context.env.DB)).find((zone) => zone.id === context.req.param("id")), estimatedDailyOperations: estimate });
});

api.get("/requests", async (context) => {
  try {
    return context.json(await listRequests(context.env.DB, filtersFromUrl(new URL(context.req.url))));
  } catch (error) {
    return jsonError(context, 422, "INVALID_FILTER", sanitizeError(error));
  }
});

api.get("/requests/:id", async (context) => {
  const item = await getRequest(context.env.DB, context.req.param("id"));
  return item ? context.json(item) : jsonError(context, 404, "REQUEST_NOT_FOUND", "请求明细不存在或已进入归档");
});

api.get("/security-events", async (context) => {
  try {
    return context.json(await listSecurityEvents(context.env.DB, filtersFromUrl(new URL(context.req.url))));
  } catch (error) {
    return jsonError(context, 422, "INVALID_FILTER", sanitizeError(error));
  }
});

api.get("/security-events/:id", async (context) => {
  const item = await getSecurityEvent(context.env.DB, context.req.param("id"));
  return item ? context.json(item) : jsonError(context, 404, "EVENT_NOT_FOUND", "安全事件不存在或已进入归档");
});

api.get("/metrics", async (context) => {
  try {
    return context.json(await queryMetrics(context.env.DB, new URL(context.req.url)));
  } catch (error) {
    return jsonError(context, 422, "INVALID_METRIC_QUERY", sanitizeError(error));
  }
});

api.get("/archives", async (context) => context.json({ items: await listArchives(context.env.DB) }));

api.get("/archives/:id/download", async (context) => {
  const manifest = await getArchive(context.env.DB, context.req.param("id"));
  if (!manifest || manifest.status !== "verified") return jsonError(context, 404, "ARCHIVE_NOT_FOUND", "归档不存在或尚未通过校验");
  const object = await context.env.ARCHIVES.get(manifest.r2_key);
  if (!object) return jsonError(context, 404, "ARCHIVE_OBJECT_MISSING", "R2 对象不存在");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Content-Encoding": "gzip",
      "Content-Disposition": `attachment; filename="${manifest.dataset}-${manifest.range_start}.ndjson.gz"`,
      "Cache-Control": "private, no-store",
    },
  });
});

api.get("/saved-views", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, name, page, filters, owner_email, created_at, updated_at
     FROM saved_views WHERE owner_email = ? ORDER BY updated_at DESC`,
  )
    .bind(context.get("identity").email)
    .all<Record<string, unknown>>();
  return context.json({
    items: result.results.map((row) => ({ ...row, filters: JSON.parse(String(row.filters)) as unknown })),
  });
});

api.post("/saved-views", async (context) => {
  const parsed = savedViewSchema.safeParse(await context.req.json());
  if (!parsed.success) return jsonError(context, 422, "INVALID_SAVED_VIEW", "保存的调查视图无效", parsed.error.flatten());
  const timestamp = nowMs();
  const id = crypto.randomUUID();
  await saveView(context.env.DB, id, parsed.data, context.get("identity").email, timestamp);
  return context.json({ id }, 201);
});

api.put("/saved-views/:id", async (context) => {
  const parsed = savedViewSchema.safeParse(await context.req.json());
  if (!parsed.success) return jsonError(context, 422, "INVALID_SAVED_VIEW", "保存的调查视图无效", parsed.error.flatten());
  const existing = await context.env.DB.prepare("SELECT id FROM saved_views WHERE id = ? AND owner_email = ?")
    .bind(context.req.param("id"), context.get("identity").email)
    .first();
  if (!existing) return jsonError(context, 404, "SAVED_VIEW_NOT_FOUND", "调查视图不存在");
  await saveView(context.env.DB, context.req.param("id"), parsed.data, context.get("identity").email, nowMs());
  return context.json({ id: context.req.param("id") });
});

api.delete("/saved-views/:id", async (context) => {
  await context.env.DB.prepare("DELETE FROM saved_views WHERE id = ? AND owner_email = ?")
    .bind(context.req.param("id"), context.get("identity").email)
    .run();
  return context.body(null, 204);
});

api.get("/settings", async (context) => {
  const zones = await listZones(context.env.DB);
  return context.json({
    d1WarningBytes: Number(context.env.D1_WARNING_BYTES),
    estimatedDailyQueueOperations: estimateDailyQueueOperations(zones),
    safeDailyQueueOperations: 8_000,
    capabilities: await listCapabilities(context.env.DB),
  });
});

api.get("/settings/smtp", async (context) => {
  const row = await context.env.DB.prepare(
    `SELECT enabled, host, port, tls_mode, auth_method, username, encrypted_password,
      sender_name, sender_address, recipients, subject_prefix, updated_at FROM smtp_settings WHERE id = 1`,
  ).first<Record<string, unknown>>();
  if (!row) return context.json({ configured: false, enabled: false });
  return context.json({
    configured: Boolean(row.encrypted_password),
    enabled: row.enabled === 1,
    host: row.host,
    port: row.port,
    tlsMode: row.tls_mode,
    authMethod: row.auth_method,
    username: row.username,
    senderName: row.sender_name,
    senderAddress: row.sender_address,
    recipients: JSON.parse(String(row.recipients)) as unknown,
    subjectPrefix: row.subject_prefix,
    updatedAt: row.updated_at,
  });
});

api.put("/settings/smtp", async (context) => {
  const parsed = smtpConfigSchema.safeParse(await context.req.json());
  if (!parsed.success) return jsonError(context, 422, "INVALID_SMTP_CONFIG", "SMTP 设置无效", parsed.error.flatten());
  const current = await context.env.DB.prepare(
    "SELECT encrypted_password, password_iv, encryption_version FROM smtp_settings WHERE id = 1",
  ).first<{ encrypted_password: string | null; password_iv: string | null; encryption_version: number | null }>();
  let encrypted = current?.encrypted_password ?? null;
  let iv = current?.password_iv ?? null;
  let version = current?.encryption_version ?? null;
  if (parsed.data.clearPassword) {
    encrypted = null;
    iv = null;
    version = null;
  } else if (parsed.data.password) {
    const secret = await encryptSecret(parsed.data.password, context.env.CONFIG_ENCRYPTION_KEY);
    encrypted = secret.ciphertext;
    iv = secret.iv;
    version = secret.version;
  }
  await context.env.DB.prepare(
    `INSERT INTO smtp_settings
     (id, enabled, host, port, tls_mode, auth_method, username, encrypted_password, password_iv,
      encryption_version, sender_name, sender_address, recipients, subject_prefix, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, host = excluded.host, port = excluded.port,
      tls_mode = excluded.tls_mode, auth_method = excluded.auth_method, username = excluded.username,
      encrypted_password = excluded.encrypted_password, password_iv = excluded.password_iv,
      encryption_version = excluded.encryption_version, sender_name = excluded.sender_name,
      sender_address = excluded.sender_address, recipients = excluded.recipients,
      subject_prefix = excluded.subject_prefix, updated_at = excluded.updated_at`,
  )
    .bind(
      parsed.data.enabled ? 1 : 0,
      parsed.data.host,
      parsed.data.port,
      parsed.data.tlsMode,
      parsed.data.authMethod,
      parsed.data.username,
      encrypted,
      iv,
      version,
      parsed.data.senderName,
      parsed.data.senderAddress,
      JSON.stringify(parsed.data.recipients),
      parsed.data.subjectPrefix,
      nowMs(),
    )
    .run();
  return context.json({ saved: true, configured: Boolean(encrypted) });
});

api.post("/settings/smtp/test", async (context) => {
  const loaded = await loadSmtp(context.env);
  if (!loaded) return jsonError(context, 409, "SMTP_NOT_CONFIGURED", "请先保存已启用且包含密码的 SMTP 设置");
  await sendSmtp(loaded.config, loaded.password, {
    subject: "SMTP 测试成功",
    text: `这是一封来自 CF Activity Observatory 的测试邮件。\n发送时间：${new Date().toISOString()}`,
  });
  return context.json({ sent: true });
});

api.get("/health", async (context) => {
  try {
    const url = new URL(context.req.url);
    const hasRange = url.searchParams.has("from") || url.searchParams.has("to");
    const range = hasRange
      ? parseTimeRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined)
      : {};
    return context.json(await getHealth(context.env.DB, Number(context.env.D1_WARNING_BYTES), {
      ...range,
      zoneIds: parseCsv(url.searchParams.get("zones") ?? undefined),
    }));
  } catch (error) {
    return jsonError(context, 422, "INVALID_HEALTH_FILTER", sanitizeError(error));
  }
});

api.get("/export", async (context) => {
  const url = new URL(context.req.url);
  const type = url.searchParams.get("type") === "security" ? "security" : "requests";
  const format = z.enum(["csv", "json", "ndjson"]).catch("csv").parse(url.searchParams.get("format"));
  const filters = filtersFromUrl(url);
  filters.limit = Math.min(filters.limit, 500);
  const result = type === "security"
    ? await listSecurityEvents(context.env.DB, filters)
    : await listRequests(context.env.DB, filters);
  if (format === "json") return new Response(JSON.stringify(result.items, null, 2), { headers: exportHeaders("application/json", `${type}.json`) });
  if (format === "ndjson") return new Response(`${result.items.map((item) => JSON.stringify(item)).join("\n")}\n`, { headers: exportHeaders("application/x-ndjson", `${type}.ndjson`) });
  return new Response(toCsv(result.items), { headers: exportHeaders("text/csv; charset=utf-8", `${type}.csv`) });
});

api.notFound((context) => jsonError(context, 404, "API_NOT_FOUND", "API 路径不存在"));
api.onError((error, context) => {
  console.error(JSON.stringify({ event: "api_error", path: context.req.path, error: sanitizeError(error) }));
  return jsonError(context, 500, "INTERNAL_ERROR", "服务器处理请求时发生错误");
});

export { api };

async function queryMetrics(database: D1Database, url: URL): Promise<{ bucketSeconds: number; series: unknown[] }> {
  const { from, to } = parseTimeRange(url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
  const zones = parseCsv(url.searchParams.get("zones") ?? undefined);
  const kind = url.searchParams.get("kind") === "security" ? "security" : "http";
  const dimension = url.searchParams.get("dimension") ?? "total";
  const highCardinality = ["path", "ip", "asn", "userAgent", "rule"].includes(dimension);
  const columns: Record<string, string> = {
    total: "''",
    country: "country",
    host: "host",
    method: "method",
    protocol: "protocol",
    status: "CAST(edge_status AS TEXT)",
    originStatus: "CAST(origin_status AS TEXT)",
    cache: "cache_status",
    securityAction: "security_action",
    securitySource: "security_source",
    requestSource: "request_source",
  };
  let dimensionSql = columns[dimension];
  let dimensionFilter = " AND dimension_type IS NULL";
  const bindings: unknown[] = [kind, from, to];
  if (!dimensionSql && highCardinality) {
    dimensionSql = "dimension_value";
    dimensionFilter = " AND dimension_type = ?";
    bindings.push(dimension);
  }
  if (!dimensionSql) throw new Error("不支持的指标维度");
  const requestedBucket = Number(url.searchParams.get("bucket"));
  const bucketSeconds = [300, 3600, 86400].includes(requestedBucket)
    ? requestedBucket
    : highCardinality ? 3600 : to - from <= 7 * 86_400_000 ? 300 : to - from <= 180 * 86_400_000 ? 3600 : 86400;
  let zoneFilter = "";
  if (zones.length) {
    zoneFilter = ` AND zone_id IN (${zones.map(() => "?").join(",")})`;
    bindings.push(...zones);
  }
  bindings.push(bucketSeconds);
  const bucketMilliseconds = bucketSeconds * 1000;
  const bucketStartSql = `CAST(bucket_start / ${bucketMilliseconds} AS INTEGER) * ${bucketMilliseconds}`;
  const topDimensionsSql = highCardinality
    ? `WHERE dimension IN (
         SELECT dimension FROM bucketed
         GROUP BY dimension ORDER BY SUM(estimated_count) DESC, dimension ASC LIMIT 100
       )`
    : "";
  const result = await database.prepare(
    `WITH bucketed AS (
       SELECT ${bucketStartSql} AS bucket_start, ${dimensionSql} AS dimension,
        SUM(estimated_count) AS estimated_count, AVG(sample_interval) AS sample_interval,
        SUM(confidence_lower) AS confidence_lower, SUM(confidence_upper) AS confidence_upper,
        SUM(edge_response_bytes) AS edge_response_bytes, SUM(visits) AS visits
       FROM metric_buckets
       WHERE metric_kind = ? AND bucket_start >= ? AND bucket_start < ?${dimensionFilter}${zoneFilter}
         AND bucket_seconds <= ?
       GROUP BY ${bucketStartSql}, ${dimensionSql}
     )
     SELECT bucket_start, dimension, estimated_count, sample_interval, confidence_lower,
      confidence_upper, edge_response_bytes, visits
     FROM bucketed ${topDimensionsSql}
     ORDER BY bucket_start ASC, estimated_count DESC`,
  )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of result.results) {
    const key = typeof row.dimension === "string" || typeof row.dimension === "number" ? String(row.dimension) : "未知";
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return { bucketSeconds, series: [...grouped.entries()].map(([name, points]) => ({ name, points })) };
}

async function saveView(database: D1Database, id: string, input: SavedViewInput, email: string, timestamp: number): Promise<void> {
  await database.prepare(
    `INSERT INTO saved_views (id, name, page, filters, owner_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, page = excluded.page,
      filters = excluded.filters, updated_at = excluded.updated_at`,
  )
    .bind(id, input.name, input.page, JSON.stringify(input.filters), email, timestamp, timestamp)
    .run();
}

export function estimateDailyQueueOperations(zones: Array<{ enabled: boolean; pollIntervalMinutes: number }>): number {
  return Math.ceil(
    zones.filter((zone) => zone.enabled).reduce((total, zone) => total + (1440 / zone.pollIntervalMinutes) * 4 * 3 + 4 * 24 * 3, 0),
  );
}

export function csvCell(value: unknown): string {
  let text = typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? String(value)
      : "";
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(items: unknown[]): string {
  const records = items.map(asRecord);
  const fields = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return `\uFEFF${fields.map(csvCell).join(",")}\r\n${records.map((record) => fields.map((field) => csvCell(record[field])).join(",")).join("\r\n")}\r\n`;
}

function exportHeaders(contentType: string, filename: string): HeadersInit {
  return { "Content-Type": contentType, "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" };
}
