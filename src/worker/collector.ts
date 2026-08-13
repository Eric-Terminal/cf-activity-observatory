import type { CollectorJob, DatasetCapability, DatasetName } from "@/shared/contracts";
import { DATASETS, GROUP_DATASETS } from "@/shared/contracts";
import {
  CloudflareApiError,
  fetchDatasetWindow,
  getDatasetCapabilities,
  type DatasetResult,
} from "@/worker/cloudflare";
import { getCapability, incrementUsage, recordD1Usage } from "@/worker/db";
import {
  D1_DAILY_BACKFILL_PAUSE,
  D1_DAILY_WRITE_PAUSE,
  d1RowsWrittenToday,
  d1WritesPaused,
} from "@/worker/budgets";
import {
  asNumber,
  asRecord,
  asString,
  canonicalJson,
  DAY_MS,
  floorTo,
  HOUR_MS,
  MINUTE_MS,
  nowMs,
  parseCloudflareTime,
  sanitizeError,
  stableId,
} from "@/worker/utils";

const DATA_DELAY_MS = 5 * MINUTE_MS;
const RETENTION_BOUNDARY_MARGIN_MS = 15 * MINUTE_MS;
const MAX_COLLECTION_WINDOW_MS = HOUR_MS;
const CAPABILITY_MAX_AGE_MS = DAY_MS;
const MIN_SPLIT_WINDOW_MS = 1_000;
const GRAPHQL_BUDGET_PER_FIVE_MINUTES = 240;
const SPLIT_GAP_REASON = "高密度窗口已拆分，等待续传任务完成";
const BUDGET_GAP_REASON = "D1 写入预算暂停，等待下个 UTC 日自动补采";

type CollectOutcome = "collected" | "split" | "budget-paused" | "rate-paused";

interface CollectStats {
  queries: number;
  returned: number;
  inserted: number;
  saturatedWindows: number;
}

export async function dispatchScheduled(env: Env, scheduledAt = nowMs()): Promise<void> {
  const collectionPaused = await d1WritesPaused(env.DB);
  if (collectionPaused) await rememberPausedWindow(env.DB, scheduledAt);
  else await enqueuePausedRepairs(env, scheduledAt);
  const due = collectionPaused
    ? { results: [] as Array<{ id: string; poll_interval_minutes: number }> }
    : await env.DB.prepare(
      `SELECT id, poll_interval_minutes
       FROM zones
       WHERE enabled = 1
         AND (last_scheduled_at IS NULL OR last_scheduled_at <= ? - poll_interval_minutes * 60000)
       ORDER BY COALESCE(last_scheduled_at, 0) ASC`,
    )
      .bind(scheduledAt)
      .all<{ id: string; poll_interval_minutes: number }>();

  let sent = 0;
  for (const zone of due.results) {
    await ensureCapabilities(env, zone.id);
    for (const dataset of DATASETS) {
      const capability = await getCapability(env.DB, zone.id, dataset);
      if (!capability?.enabled) continue;
      const acquired = await acquireWindow(env, zone.id, dataset, capability, scheduledAt);
      if (!acquired) continue;
      if (acquired.mode === "backfill") {
        const liveEnd = floorTo(scheduledAt - DATA_DELAY_MS, MINUTE_MS);
        const liveStart = Math.max(liveEnd - zone.poll_interval_minutes * MINUTE_MS, acquired.end);
        if (liveStart < liveEnd) {
          await env.COLLECTOR_QUEUE.send({
            version: 1,
            type: "collect",
            id: crypto.randomUUID(),
            zoneId: zone.id,
            dataset,
            start: liveStart,
            end: liveEnd,
            mode: "repair",
            budgetClass: "live",
          });
          sent += 1;
        }
      }
      const job: CollectorJob = {
        version: 1,
        type: "collect",
        id: crypto.randomUUID(),
        zoneId: zone.id,
        dataset,
        start: acquired.start,
        end: acquired.end,
        mode: acquired.mode,
        budgetClass: acquired.mode === "backfill" ? "backfill" : "live",
      };
      await env.COLLECTOR_QUEUE.send(job);
      sent += 1;
    }
    await env.DB.prepare("UPDATE zones SET last_scheduled_at = ?, updated_at = ? WHERE id = ?")
      .bind(scheduledAt, scheduledAt, zone.id)
      .run();
  }

  if (!collectionPaused && new Date(scheduledAt).getUTCMinutes() === 12) {
    await enqueueHourlyRepairs(env, scheduledAt);
  }
  if (new Date(scheduledAt).getUTCMinutes() === 42) {
    await env.COLLECTOR_QUEUE.send({ version: 1, type: "maintenance", id: crypto.randomUUID(), scheduledAt });
    sent += 1;
  }
  // 进入写入保护后，空 Cron 不再为了记账继续消耗 D1；真正发送维护任务时仍保留统计。
  if (!collectionPaused || sent > 0) {
    await incrementUsage(env.DB, { workerInvocations: 1, queueMessages: sent });
  }
}

export async function processCollectJob(
  env: Env,
  job: Extract<CollectorJob, { type: "collect" }>,
): Promise<CollectOutcome> {
  const rowsWritten = await d1RowsWrittenToday(env.DB);
  const budgetClass = job.budgetClass ?? (job.mode === "backfill" ? "backfill" : "live");
  if (rowsWritten >= D1_DAILY_WRITE_PAUSE || (budgetClass === "backfill" && rowsWritten >= D1_DAILY_BACKFILL_PAUSE)) {
    await deferCollectJob(env, job, secondsUntilUtcReset(nowMs()));
    return "budget-paused";
  }
  const startedAt = nowMs();
  const stats: CollectStats = { queries: 0, returned: 0, inserted: 0, saturatedWindows: 0 };
  try {
    const capability = await getCapability(env.DB, job.zoneId, job.dataset);
    if (!capability?.enabled) throw new Error(`${job.dataset} 当前不可用`);
    const maximumWindow = collectionWindowDuration(capability.maxDuration);
    if (job.end - job.start > maximumWindow) {
      await startRun(env.DB, job, startedAt);
      await enqueueSplitWindows(env, job);
      await advanceCursor(env.DB, job);
      await finishRun(env.DB, job.id, "split", stats, null);
      await resolveJobAlert(env.DB, job.id);
      return "split";
    }
    if (!(await reserveGraphqlBudget(env.DB, expectedGraphqlQueries(job.dataset)))) {
      await deferCollectJob(env, job, secondsUntilNextGraphqlBucket(nowMs()));
      return "rate-paused";
    }
    await startRun(env.DB, job, startedAt);
    const result = await collectWindow(env, capability, job, stats);
    await advanceCursor(env.DB, job);
    await finishRun(env.DB, job.id, result === "split" ? "split" : "success", stats, null);
    await resolveJobAlert(env.DB, job.id);
    return result === "split" ? "split" : "collected";
  } catch (error) {
    const message = sanitizeError(error);
    await Promise.all([
      finishRun(env.DB, job.id, "failed", stats, message),
      env.DB.prepare(
        `UPDATE sync_cursors SET consecutive_failures = consecutive_failures + 1, in_flight_until = NULL,
         last_error = ?, updated_at = ? WHERE zone_id = ? AND dataset = ?`,
      )
        .bind(message, nowMs(), job.zoneId, job.dataset)
        .run(),
    ]);
    throw error;
  }
}

export async function refreshZoneCapabilities(env: Env, zoneId: string): Promise<DatasetCapability[]> {
  const capabilities = await getDatasetCapabilities(env, zoneId);
  const timestamp = nowMs();
  const statements = capabilities.map((capability) =>
    env.DB.prepare(
      `INSERT INTO dataset_capabilities
       (zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields,
        not_older_than, max_duration, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(zone_id, dataset) DO UPDATE SET enabled = excluded.enabled,
        available_fields = excluded.available_fields, max_page_size = excluded.max_page_size,
        max_number_of_fields = excluded.max_number_of_fields, not_older_than = excluded.not_older_than,
        max_duration = excluded.max_duration, checked_at = excluded.checked_at`,
    ).bind(
      zoneId,
      capability.dataset,
      capability.enabled ? 1 : 0,
      JSON.stringify(capability.availableFields),
      capability.maxPageSize,
      capability.maxNumberOfFields,
      capability.notOlderThan,
      capability.maxDuration,
      timestamp,
    ),
  );
  if (statements.length) {
    const result = await env.DB.batch(statements);
    await recordD1Usage(env.DB, result.map((item) => item.meta));
  }
  return capabilities;
}

async function ensureCapabilities(env: Env, zoneId: string): Promise<void> {
  const latest = await env.DB.prepare("SELECT MAX(checked_at) AS checked_at FROM dataset_capabilities WHERE zone_id = ?")
    .bind(zoneId)
    .first<{ checked_at: number | null }>();
  if (!latest?.checked_at || latest.checked_at < nowMs() - CAPABILITY_MAX_AGE_MS) {
    await refreshZoneCapabilities(env, zoneId);
  }
}

async function acquireWindow(
  env: Env,
  zoneId: string,
  dataset: DatasetName,
  capability: DatasetCapability,
  scheduledAt: number,
): Promise<{ start: number; end: number; mode: "realtime" | "backfill" } | null> {
  const stableEnd = floorTo(scheduledAt - DATA_DELAY_MS, MINUTE_MS);
  if (stableEnd <= 0) return null;
  const oldest = oldestQueryableAt(scheduledAt, capability.notOlderThan ?? DAY_MS / 1000);
  const timestamp = nowMs();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_cursors
     (zone_id, dataset, cursor_at, consecutive_failures, updated_at) VALUES (?, ?, ?, 0, ?)`,
  )
    .bind(zoneId, dataset, oldest, timestamp)
    .run();
  const cursor = await env.DB.prepare(
    `SELECT cursor_at, in_flight_until FROM sync_cursors WHERE zone_id = ? AND dataset = ?`,
  )
    .bind(zoneId, dataset)
    .first<{ cursor_at: number; in_flight_until: number | null }>();
  if (!cursor || (cursor.in_flight_until && cursor.in_flight_until > timestamp)) return null;
  let cursorAt = cursor.cursor_at;
  if (cursorAt < oldest) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO data_gaps
         (id, zone_id, dataset, range_start, range_end, reason, detected_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        stableId(zoneId, dataset, cursorAt, oldest, "retention"),
        zoneId,
        dataset,
        cursorAt,
        oldest,
        "停机区间已超出 Cloudflare 当前数据集可回看窗口",
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        "UPDATE sync_cursors SET cursor_at = ?, updated_at = ? WHERE zone_id = ? AND dataset = ?",
      ).bind(oldest, timestamp, zoneId, dataset),
    ]);
    cursorAt = oldest;
  }
  if (cursorAt >= stableEnd) return null;
  const maxDuration = collectionWindowDuration(capability.maxDuration);
  const end = Math.min(cursorAt + maxDuration, stableEnd);
  const acquired = await env.DB.prepare(
    `UPDATE sync_cursors SET in_flight_until = ?, updated_at = ?
     WHERE zone_id = ? AND dataset = ? AND (in_flight_until IS NULL OR in_flight_until <= ?)`,
  )
    .bind(timestamp + 15 * MINUTE_MS, timestamp, zoneId, dataset, timestamp)
    .run();
  if (!acquired.meta.changes) return null;
  return { start: cursorAt, end, mode: end < stableEnd ? "backfill" : "realtime" };
}

export function oldestQueryableAt(scheduledAt: number, notOlderThanSeconds: number): number {
  const historyWindow = Math.max(0, notOlderThanSeconds) * 1000;
  // Cloudflare 按请求时刻计算滚动保留边界；队列等待会让恰好贴边的首次回填在执行前过期。
  const safetyMargin = Math.min(
    RETENTION_BOUNDARY_MARGIN_MS,
    Math.max(MINUTE_MS, historyWindow / 100),
  );
  return floorTo(
    Math.min(scheduledAt - DATA_DELAY_MS, scheduledAt - historyWindow + safetyMargin),
    MINUTE_MS,
  );
}

export function collectionWindowDuration(maxDurationSeconds: number | null): number {
  // 数据集声明的是服务端允许上限；高基数查询还需限制单次 Worker 调用的 GraphQL 子请求数量。
  return Math.max(
    MINUTE_MS,
    Math.min((maxDurationSeconds ?? 300) * 1000, MAX_COLLECTION_WINDOW_MS),
  );
}

async function collectWindow(
  env: Env,
  capability: DatasetCapability,
  job: Extract<CollectorJob, { type: "collect" }>,
  stats: CollectStats,
): Promise<"complete" | "split"> {
  const result = await fetchDatasetWindow(env, capability, job.start, job.end);
  stats.queries += result.queryCount;
  stats.returned += result.rows.length;
  await incrementUsage(env.DB, { graphqlQueries: result.queryCount });
  if (result.saturated && job.end - job.start > MIN_SPLIT_WINDOW_MS) {
    stats.saturatedWindows += 1;
    await enqueueSplitWindows(env, job);
    return "split";
  }
  if (result.saturated) {
    const detectedAt = nowMs();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO data_gaps
       (id, zone_id, dataset, range_start, range_end, reason, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        stableId(capability.zoneId, capability.dataset, job.start, job.end, "saturated"),
        capability.zoneId,
        capability.dataset,
        job.start,
        job.end,
        "最小时间窗口仍达到 API 行数上限，无法保证采样明细完整",
        detectedAt,
      )
      .run();
  }
  stats.inserted += await persistRows(env.DB, capability.dataset, capability.zoneId, result, job.id);
  if (!result.saturated) {
    // 完整查询覆盖缺口后才关闭它；更大的小时修复窗口也能修复先前切分出的叶子区间。
    await env.DB.prepare(
      `UPDATE data_gaps SET resolved_at = ?
       WHERE zone_id = ? AND dataset = ? AND range_start >= ? AND range_end <= ?
         AND resolved_at IS NULL AND acknowledged_at IS NULL`,
    )
      .bind(nowMs(), capability.zoneId, capability.dataset, job.start, job.end)
      .run();
  }
  return "complete";
}

async function persistRows(
  database: D1Database,
  dataset: DatasetName,
  zoneId: string,
  result: DatasetResult,
  batchId: string,
): Promise<number> {
  const statements = result.rows.flatMap((row) => {
    if (dataset === "httpRequestsAdaptive") return [requestStatement(database, zoneId, row, batchId)];
    if (dataset === "firewallEventsAdaptive") return [eventStatement(database, zoneId, row, batchId)];
    return [metricStatement(database, dataset, zoneId, row)];
  });
  let changes = 0;
  for (let index = 0; index < statements.length; index += 80) {
    const batch = await database.batch(statements.slice(index, index + 80));
    changes += batch.reduce((sum, item) => sum + item.meta.changes, 0);
    await recordD1Usage(database, batch.map((item) => item.meta));
  }
  return changes;
}

function requestStatement(database: D1Database, zoneId: string, row: Record<string, unknown>, batchId: string): D1PreparedStatement {
  const occurredAt = parseCloudflareTime(row.datetime) ?? nowMs();
  const rayId = asString(row.rayName);
  // ASN 字段曾因大小写错误而未被查询；排除它可保持旧记录 ID 稳定，让修复后的回采原位补齐号码。
  const identityRow = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "clientAsn"));
  const id = stableId(zoneId, occurredAt, rayId, canonicalJson(identityRow));
  const known = new Set([
    "datetime", "rayName", "clientIP", "clientCountryName", "clientAsn", "clientASNDescription", "userAgent",
    "clientRefererHost", "clientDeviceType", "clientRequestHTTPHost", "clientRequestPath", "clientRequestQuery",
    "clientRequestHTTPMethodName", "clientRequestHTTPProtocol", "requestSource", "coloCode", "cacheStatus",
    "originResponseStatus", "edgeResponseStatus", "securityAction", "securitySource", "securityRuleID",
    "botManagementScore", "botManagementScoreSrc", "botManagementScoreSrcName", "botManagementTags",
    "botManagementVerifiedBot", "verifiedBotCategory", "wafAttackScore", "contentScanObjResults",
    "leakedCredentialCheckResult", "sampleInterval",
  ]);
  return database.prepare(
    `INSERT INTO request_samples
     (id, zone_id, occurred_at, ray_id, client_ip, country, asn, asn_description, user_agent, referer,
      device_type, host, path, query, method, protocol, request_source, colo, cache_status, origin_status,
      edge_status, security_action, security_source, security_rule_id, bot_score, bot_score_source, bot_tags,
      verified_bot_category, attack_score, content_scan_result, leaked_credential_result, sample_interval,
      collected_at, batch_id, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET asn = excluded.asn
     WHERE request_samples.asn IS NULL AND excluded.asn IS NOT NULL`,
  ).bind(
    id, zoneId, occurredAt, rayId, asString(row.clientIP), asString(row.clientCountryName), asNumber(row.clientAsn),
    asString(row.clientASNDescription), asString(row.userAgent), asString(row.clientRefererHost), asString(row.clientDeviceType),
    asString(row.clientRequestHTTPHost), asString(row.clientRequestPath), asString(row.clientRequestQuery),
    asString(row.clientRequestHTTPMethodName), asString(row.clientRequestHTTPProtocol), asString(row.requestSource),
    asString(row.coloCode), asString(row.cacheStatus), asNumber(row.originResponseStatus), asNumber(row.edgeResponseStatus),
    asString(row.securityAction), asString(row.securitySource), asString(row.securityRuleID), asNumber(row.botManagementScore),
    asString(row.botManagementScoreSrc ?? row.botManagementScoreSrcName), JSON.stringify(row.botManagementTags ?? []),
    row.botManagementVerifiedBot === true ? "verified" : asString(row.verifiedBotCategory), asNumber(row.wafAttackScore),
    JSON.stringify(row.contentScanObjResults ?? null), asString(row.leakedCredentialCheckResult), asNumber(row.sampleInterval),
    nowMs(), batchId, JSON.stringify(remaining(row, known)),
  );
}

function eventStatement(database: D1Database, zoneId: string, row: Record<string, unknown>, batchId: string): D1PreparedStatement {
  const occurredAt = parseCloudflareTime(row.datetime) ?? nowMs();
  const rayId = asString(row.rayName);
  const id = stableId(zoneId, occurredAt, rayId, asString(row.source), asString(row.ruleId), asString(row.action));
  const known = new Set([
    "datetime", "rayName", "action", "source", "ruleId", "description", "rulesetId", "kind", "clientIP",
    "clientCountryName", "clientAsn", "clientRequestHTTPHost", "clientRequestPath", "clientRequestQuery",
    "clientRequestHTTPMethodName", "userAgent", "sampleInterval",
  ]);
  return database.prepare(
    `INSERT INTO security_events
     (id, zone_id, occurred_at, ray_id, action, source, rule_id, rule_description, ruleset_id, kind,
      client_ip, country, asn, host, path, query, method, user_agent, sample_interval, collected_at, batch_id, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET asn = excluded.asn
     WHERE security_events.asn IS NULL AND excluded.asn IS NOT NULL`,
  ).bind(
    id, zoneId, occurredAt, rayId, asString(row.action), asString(row.source), asString(row.ruleId),
    asString(row.description), asString(row.rulesetId), asString(row.kind), asString(row.clientIP),
    asString(row.clientCountryName), asNumber(row.clientAsn), asString(row.clientRequestHTTPHost),
    asString(row.clientRequestPath), asString(row.clientRequestQuery), asString(row.clientRequestHTTPMethodName),
    asString(row.userAgent), asNumber(row.sampleInterval), nowMs(), batchId, JSON.stringify(remaining(row, known)),
  );
}

function metricStatement(database: D1Database, dataset: DatasetName, zoneId: string, row: Record<string, unknown>): D1PreparedStatement {
  const dimensions = asRecord(row.dimensions);
  const sum = asRecord(row.sum);
  const average = asRecord(row.avg);
  const confidence = asRecord(row.confidence);
  const confidenceMetric = asRecord(confidence.requests ?? confidence.count);
  const bucketStart = parseCloudflareTime(dimensions.datetimeFiveMinutes ?? dimensions.datetimeHour ?? dimensions.date) ?? nowMs();
  const bucketSeconds = dimensions.datetimeFiveMinutes ? 300 : dimensions.datetimeHour ? 3600 : 86400;
  const metricKind = dataset === "httpRequestsAdaptiveGroups" ? "http" : "security";
  const estimated = asNumber(row.count ?? confidenceMetric.estimate) ?? 0;
  const host = asString(dimensions.clientRequestHTTPHost);
  const country = asString(dimensions.clientCountryName);
  const asn = asNumber(dimensions.clientAsn);
  const method = asString(dimensions.clientRequestHTTPMethodName);
  const protocol = asString(dimensions.clientRequestHTTPProtocol);
  const edgeStatus = asNumber(dimensions.edgeResponseStatus);
  const originStatus = asNumber(dimensions.originResponseStatus);
  const status = statusClass(edgeStatus);
  const cacheStatus = asString(dimensions.cacheStatus);
  const securityAction = asString(dimensions.securityAction ?? dimensions.action);
  const securitySource = asString(dimensions.securitySource ?? dimensions.source);
  const requestSource = asString(dimensions.requestSource);
  const dimensionType = asString(row.__observatoryDimensionType);
  const dimensionValue = rankingValue(dimensions, dimensionType);
  // 时间属于桶的身份，而不是序列维度；排除它后，同一序列才能在老化时正确合并。
  const signature = canonicalJson({
    asn,
    cacheStatus,
    country,
    dimensionType,
    dimensionValue,
    edgeStatus,
    host,
    method,
    originStatus,
    protocol,
    requestSource,
    securityAction,
    securitySource,
    statusClass: status,
  });
  return database.prepare(
    `INSERT INTO metric_buckets
     (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, host, country, asn,
      method, protocol, edge_status, origin_status, status_class, cache_status, security_action, security_source, request_source,
      dimension_type, dimension_value, estimated_count, sample_interval, confidence_estimate, confidence_lower,
      confidence_upper, confidence_sample_size, edge_response_bytes, visits, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature) DO UPDATE SET
      estimated_count = excluded.estimated_count, sample_interval = excluded.sample_interval,
      confidence_estimate = excluded.confidence_estimate, confidence_lower = excluded.confidence_lower,
      confidence_upper = excluded.confidence_upper, confidence_sample_size = excluded.confidence_sample_size,
      edge_response_bytes = excluded.edge_response_bytes, visits = excluded.visits, updated_at = excluded.updated_at
     WHERE metric_buckets.estimated_count IS NOT excluded.estimated_count
        OR metric_buckets.sample_interval IS NOT excluded.sample_interval
        OR metric_buckets.confidence_estimate IS NOT excluded.confidence_estimate
        OR metric_buckets.confidence_lower IS NOT excluded.confidence_lower
        OR metric_buckets.confidence_upper IS NOT excluded.confidence_upper
        OR metric_buckets.confidence_sample_size IS NOT excluded.confidence_sample_size
        OR metric_buckets.edge_response_bytes IS NOT excluded.edge_response_bytes
        OR metric_buckets.visits IS NOT excluded.visits`,
  ).bind(
    zoneId, bucketStart, bucketSeconds, metricKind, signature, host, country, asn, method, protocol, edgeStatus,
    originStatus, status, cacheStatus, securityAction, securitySource, requestSource, dimensionType, dimensionValue,
    estimated, asNumber(average.sampleInterval), asNumber(confidenceMetric.estimate), asNumber(confidenceMetric.lower),
    asNumber(confidenceMetric.upper), asNumber(confidenceMetric.sampleSize), asNumber(sum.edgeResponseBytes), asNumber(sum.visits), nowMs(),
  );
}

function rankingValue(dimensions: Record<string, unknown>, type: string | null): string | null {
  const field = { path: "clientRequestPath", ip: "clientIP", asn: "clientAsn", userAgent: "userAgent", rule: "ruleId" }[type ?? ""];
  const value = field ? dimensions[field] : null;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function statusClass(status: number | null): number | null {
  return status === null ? null : Math.floor(status / 100);
}

function remaining(row: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key)));
}

async function reserveGraphqlBudget(database: D1Database, amount: number): Promise<boolean> {
  const bucket = floorTo(nowMs(), 5 * MINUTE_MS);
  const key = `graphql_budget:${bucket}`;
  await database.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT), updated_at = excluded.updated_at`,
  )
    .bind(key, String(amount), nowMs(), amount)
    .run();
  const row = await database.prepare("SELECT CAST(value AS INTEGER) AS value FROM app_settings WHERE key = ?")
    .bind(key)
    .first<{ value: number }>();
  return (row?.value ?? 1) <= GRAPHQL_BUDGET_PER_FIVE_MINUTES;
}

async function finishRun(
  database: D1Database,
  id: string,
  status: "success" | "split" | "failed",
  stats: CollectStats,
  error: string | null,
): Promise<void> {
  await database.prepare(
    `UPDATE collector_runs SET status = ?, finished_at = ?, graphql_queries = ?, returned_rows = ?,
     inserted_rows = ?, error_summary = ? WHERE id = ?`,
  )
    .bind(status, nowMs(), stats.queries, stats.returned, stats.inserted, error, id)
    .run();
}

async function enqueueHourlyRepairs(env: Env, scheduledAt: number): Promise<void> {
  const end = floorTo(scheduledAt - DATA_DELAY_MS, MINUTE_MS);
  const start = end - HOUR_MS;
  const rows = await env.DB.prepare(
    `SELECT c.zone_id, c.dataset FROM dataset_capabilities c
     JOIN zones z ON z.id = c.zone_id WHERE z.enabled = 1 AND c.enabled = 1`,
  ).all<{ zone_id: string; dataset: string }>();
  let sent = 0;
  for (const row of rows.results) {
    if (!DATASETS.includes(row.dataset as DatasetName)) continue;
    await env.COLLECTOR_QUEUE.send({
      version: 1,
      type: "collect",
      id: crypto.randomUUID(),
      zoneId: row.zone_id,
      dataset: row.dataset as DatasetName,
      start,
      end,
      mode: "repair",
      budgetClass: "live",
    });
    sent += 1;
  }
  if (sent) await incrementUsage(env.DB, { queueMessages: sent });
}

export function retryDelay(error: unknown, attempts: number): number {
  if (error instanceof CloudflareApiError && error.retryAfterSeconds) return Math.min(error.retryAfterSeconds, 900);
  return Math.min(2 ** Math.max(0, attempts) * 15, 900);
}

async function startRun(
  database: D1Database,
  job: Extract<CollectorJob, { type: "collect" }>,
  startedAt: number,
): Promise<void> {
  await database.prepare(
    `INSERT OR REPLACE INTO collector_runs
       (id, parent_id, zone_id, dataset, job_type, range_start, range_end, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  )
    .bind(job.id, job.parentId ?? null, job.zoneId, job.dataset, job.mode, job.start, job.end, startedAt)
    .run();
}

async function advanceCursor(
  database: D1Database,
  job: Extract<CollectorJob, { type: "collect" }>,
): Promise<void> {
  if (job.mode === "repair") return;
  const timestamp = nowMs();
  await database.prepare(
    `UPDATE sync_cursors SET cursor_at = MAX(cursor_at, ?), last_success_at = ?, consecutive_failures = 0,
      in_flight_until = NULL, last_error = NULL, updated_at = ? WHERE zone_id = ? AND dataset = ?`,
  )
    .bind(job.end, timestamp, timestamp, job.zoneId, job.dataset)
    .run();
}

async function enqueueSplitWindows(
  env: Env,
  job: Extract<CollectorJob, { type: "collect" }>,
): Promise<void> {
  const middle = floorTo(job.start + (job.end - job.start) / 2, MIN_SPLIT_WINDOW_MS);
  const ranges = [[job.start, middle], [middle, job.end]] as const;
  const timestamp = nowMs();
  const children = ranges.map(([start, end]) => ({
    version: 1 as const,
    type: "collect" as const,
    id: stableId("split-job", job.zoneId, job.dataset, start, end),
    parentId: job.id,
    zoneId: job.zoneId,
    dataset: job.dataset,
    start,
    end,
    mode: "repair" as const,
    budgetClass: job.budgetClass ?? (job.mode === "backfill" ? "backfill" as const : "live" as const),
  }));
  const gapStatements = [
    env.DB.prepare(
      `UPDATE data_gaps SET resolved_at = ?
       WHERE zone_id = ? AND dataset = ? AND range_start >= ? AND range_end <= ?
         AND resolved_at IS NULL AND acknowledged_at IS NULL`,
    ).bind(timestamp, job.zoneId, job.dataset, job.start, job.end),
    ...children.map((child) => env.DB.prepare(
      `INSERT OR IGNORE INTO data_gaps
       (id, zone_id, dataset, range_start, range_end, reason, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      stableId("split-gap", child.zoneId, child.dataset, child.start, child.end),
      child.zoneId,
      child.dataset,
      child.start,
      child.end,
      SPLIT_GAP_REASON,
      timestamp,
    )),
  ];
  await env.DB.batch(gapStatements);
  await env.COLLECTOR_QUEUE.sendBatch(children.map((body) => ({ body })));
  await incrementUsage(env.DB, { queueMessages: children.length });
}

async function deferCollectJob(
  env: Env,
  job: Extract<CollectorJob, { type: "collect" }>,
  delaySeconds: number,
): Promise<void> {
  await env.COLLECTOR_QUEUE.send(job, { delaySeconds });
  if (job.mode !== "repair") {
    const timestamp = nowMs();
    await env.DB.prepare(
      `UPDATE sync_cursors SET in_flight_until = ?, updated_at = ?
       WHERE zone_id = ? AND dataset = ?`,
    )
      .bind(timestamp + (delaySeconds + 15 * 60) * 1000, timestamp, job.zoneId, job.dataset)
      .run();
  }
  await incrementUsage(env.DB, { queueMessages: 1 });
}

function expectedGraphqlQueries(dataset: DatasetName): number {
  return GROUP_DATASETS.includes(dataset as (typeof GROUP_DATASETS)[number]) ? 5 : 1;
}

function secondsUntilNextGraphqlBucket(timestamp: number): number {
  const next = floorTo(timestamp, 5 * MINUTE_MS) + 5 * MINUTE_MS;
  return Math.max(5, Math.ceil((next - timestamp) / 1000) + 5);
}

function secondsUntilUtcReset(timestamp: number): number {
  const date = new Date(timestamp);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.min(24 * 60 * 60, Math.max(60, Math.ceil((next - timestamp) / 1000) + 30));
}

async function rememberPausedWindow(database: D1Database, scheduledAt: number): Promise<void> {
  const day = new Date(scheduledAt).toISOString().slice(0, 10);
  const key = `collection_pause:${day}`;
  const stableEnd = floorTo(scheduledAt - DATA_DELAY_MS, MINUTE_MS);
  const inserted = await database.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
  )
    .bind(key, JSON.stringify({ start: stableEnd }), scheduledAt)
    .run();
  if (!inserted.meta.changes) return;
  const latest = await database.prepare(
    `SELECT MIN(latest) AS latest FROM (
       SELECT MAX(occurred_at) AS latest FROM request_samples
       UNION ALL SELECT MAX(occurred_at) FROM security_events
       UNION ALL SELECT MAX(bucket_start) FROM metric_buckets WHERE bucket_seconds = 300
     ) WHERE latest IS NOT NULL`,
  ).first<{ latest: number | null }>();
  const start = Math.min(stableEnd, latest?.latest ?? stableEnd);
  await database.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?")
    .bind(JSON.stringify({ start }), scheduledAt, key)
    .run();
}

async function enqueuePausedRepairs(env: Env, scheduledAt: number): Promise<void> {
  const markers = await env.DB.prepare(
    "SELECT key, value FROM app_settings WHERE key LIKE 'collection_pause:%' ORDER BY key",
  ).all<{ key: string; value: string }>();
  if (!markers.results.length) return;
  const capabilities = await env.DB.prepare(
    `SELECT c.zone_id, c.dataset FROM dataset_capabilities c
     JOIN zones z ON z.id = c.zone_id WHERE z.enabled = 1 AND c.enabled = 1`,
  ).all<{ zone_id: string; dataset: string }>();
  const end = floorTo(scheduledAt - DATA_DELAY_MS, MINUTE_MS);
  for (const marker of markers.results) {
    const parsed = asRecord(JSON.parse(marker.value));
    const start = asNumber(parsed.start);
    if (start === null || start >= end) {
      await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(marker.key).run();
      continue;
    }
    const jobs = capabilities.results.flatMap((capability) => {
      if (!DATASETS.includes(capability.dataset as DatasetName)) return [];
      const dataset = capability.dataset as DatasetName;
      return [{
        version: 1 as const,
        type: "collect" as const,
        id: stableId("budget-resume", capability.zone_id, dataset, start, end),
        zoneId: capability.zone_id,
        dataset,
        start,
        end,
        mode: "repair" as const,
        budgetClass: "live" as const,
      }];
    });
    if (jobs.length) {
      await env.DB.batch(jobs.map((job) => env.DB.prepare(
        `INSERT OR IGNORE INTO data_gaps
         (id, zone_id, dataset, range_start, range_end, reason, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        stableId("budget-gap", job.zoneId, job.dataset, start, end),
        job.zoneId,
        job.dataset,
        start,
        end,
        BUDGET_GAP_REASON,
        scheduledAt,
      )));
      await env.COLLECTOR_QUEUE.sendBatch(jobs.map((body) => ({ body })));
      await incrementUsage(env.DB, { queueMessages: jobs.length });
    }
    await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(marker.key).run();
  }
}

async function resolveJobAlert(database: D1Database, jobId: string): Promise<void> {
  const timestamp = nowMs();
  await database.prepare(
    `UPDATE alert_state SET status = 'recovered', recovered_at = ?, last_seen_at = ?
     WHERE alert_key = ? AND status = 'active'`,
  )
    .bind(timestamp, timestamp, `dlq:${jobId}`)
    .run();
}
