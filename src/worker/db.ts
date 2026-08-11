import type {
  CollectorHealth,
  DatasetCapability,
  DatasetName,
  PaginatedResult,
  SampledRequest,
  SecurityEvent,
  ZoneSummary,
} from "@/shared/contracts";
import { DATASETS, datasetSchema } from "@/shared/contracts";
import {
  asNumber,
  asRecord,
  asString,
  asStringArray,
  dayKey,
  decodeCursor,
  encodeCursor,
  nowMs,
  parseCsv,
} from "@/worker/utils";

interface ZoneRow {
  id: string;
  name: string;
  account_id: string | null;
  enabled: number;
  poll_interval_minutes: number;
  detail_retention_days: number;
  last_scheduled_at: number | null;
}

interface CapabilityRow {
  zone_id: string;
  dataset: string;
  enabled: number;
  available_fields: string;
  max_page_size: number | null;
  max_number_of_fields: number | null;
  not_older_than: number | null;
  max_duration: number | null;
  checked_at: number;
}

interface RequestRow extends Record<string, unknown> {
  id: string;
  zone_id: string;
  occurred_at: number;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  zone_id: string;
  occurred_at: number;
}

export function mapZone(row: ZoneRow): ZoneSummary {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    enabled: row.enabled === 1,
    pollIntervalMinutes: row.poll_interval_minutes,
    detailRetentionDays: row.detail_retention_days,
    lastScheduledAt: row.last_scheduled_at,
  };
}

export function mapCapability(row: CapabilityRow): DatasetCapability {
  const dataset = datasetSchema.parse(row.dataset);
  let fields: string[] = [];
  try {
    fields = asStringArray(JSON.parse(row.available_fields));
  } catch {
    fields = [];
  }
  return {
    zoneId: row.zone_id,
    dataset,
    enabled: row.enabled === 1,
    availableFields: fields,
    maxPageSize: row.max_page_size,
    maxNumberOfFields: row.max_number_of_fields,
    notOlderThan: row.not_older_than,
    maxDuration: row.max_duration,
    checkedAt: row.checked_at,
  };
}

export async function listZones(database: D1Database): Promise<ZoneSummary[]> {
  const result = await database
    .prepare(
      `SELECT id, name, account_id, enabled, poll_interval_minutes, detail_retention_days, last_scheduled_at
       FROM zones ORDER BY name`,
    )
    .all<ZoneRow>();
  return result.results.map(mapZone);
}

export async function getZone(database: D1Database, zoneId: string): Promise<ZoneSummary | null> {
  const row = await database
    .prepare(
      `SELECT id, name, account_id, enabled, poll_interval_minutes, detail_retention_days, last_scheduled_at
       FROM zones WHERE id = ?`,
    )
    .bind(zoneId)
    .first<ZoneRow>();
  return row ? mapZone(row) : null;
}

export async function listCapabilities(database: D1Database, zoneId?: string): Promise<DatasetCapability[]> {
  const query = zoneId
    ? database
        .prepare(
          `SELECT zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields,
                  not_older_than, max_duration, checked_at
           FROM dataset_capabilities WHERE zone_id = ? ORDER BY dataset`,
        )
        .bind(zoneId)
    : database.prepare(
        `SELECT zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields,
                not_older_than, max_duration, checked_at
         FROM dataset_capabilities ORDER BY zone_id, dataset`,
      );
  const result = await query.all<CapabilityRow>();
  return result.results.map(mapCapability);
}

export async function getCapability(
  database: D1Database,
  zoneId: string,
  dataset: DatasetName,
): Promise<DatasetCapability | null> {
  const row = await database
    .prepare(
      `SELECT zone_id, dataset, enabled, available_fields, max_page_size, max_number_of_fields,
              not_older_than, max_duration, checked_at
       FROM dataset_capabilities WHERE zone_id = ? AND dataset = ?`,
    )
    .bind(zoneId, dataset)
    .first<CapabilityRow>();
  return row ? mapCapability(row) : null;
}

export async function recordD1Usage(database: D1Database, meta: D1Meta | D1Meta[]): Promise<void> {
  const entries = Array.isArray(meta) ? meta : [meta];
  const rowsRead = entries.reduce((sum, item) => sum + item.rows_read, 0);
  const rowsWritten = entries.reduce((sum, item) => sum + item.rows_written, 0);
  const sizeAfter = entries.reduce((maximum, item) => Math.max(maximum, item.size_after), 0);
  const timestamp = nowMs();
  await database
    .prepare(
      `INSERT INTO usage_daily (day, d1_rows_read, d1_rows_written, d1_size_after, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         d1_rows_read = d1_rows_read + excluded.d1_rows_read,
         d1_rows_written = d1_rows_written + excluded.d1_rows_written,
         d1_size_after = MAX(d1_size_after, excluded.d1_size_after),
         updated_at = excluded.updated_at`,
    )
    .bind(dayKey(timestamp), rowsRead, rowsWritten, sizeAfter, timestamp)
    .run();
}

export async function incrementUsage(
  database: D1Database,
  columns: Partial<{
    workerInvocations: number;
    queueMessages: number;
    graphqlQueries: number;
    r2ClassA: number;
    r2ClassB: number;
    r2BytesWritten: number;
  }>,
): Promise<void> {
  const timestamp = nowMs();
  await database
    .prepare(
      `INSERT INTO usage_daily (
         day, worker_invocations, queue_messages, graphql_queries,
         r2_class_a, r2_class_b, r2_bytes_written, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         worker_invocations = worker_invocations + excluded.worker_invocations,
         queue_messages = queue_messages + excluded.queue_messages,
         graphql_queries = graphql_queries + excluded.graphql_queries,
         r2_class_a = r2_class_a + excluded.r2_class_a,
         r2_class_b = r2_class_b + excluded.r2_class_b,
         r2_bytes_written = r2_bytes_written + excluded.r2_bytes_written,
         updated_at = excluded.updated_at`,
    )
    .bind(
      dayKey(timestamp),
      columns.workerInvocations ?? 0,
      columns.queueMessages ?? 0,
      columns.graphqlQueries ?? 0,
      columns.r2ClassA ?? 0,
      columns.r2ClassB ?? 0,
      columns.r2BytesWritten ?? 0,
      timestamp,
    )
    .run();
}

interface ListFilterInput {
  zoneIds: string[];
  from: number;
  to: number;
  limit: number;
  cursor?: string;
  clientIp?: string;
  country?: string;
  asn?: number;
  host?: string;
  path?: string;
  query?: string;
  method?: string;
  status?: number;
  cacheStatus?: string;
  securityAction?: string;
  securitySource?: string;
  rayId?: string;
  userAgent?: string;
  requestSource?: string;
}

function buildWhere(
  input: ListFilterInput,
  columns: {
    action: string;
    source: string;
    requestSource?: string;
    status?: string;
    cacheStatus?: string;
  },
): { sql: string; bindings: unknown[] } {
  const conditions = ["occurred_at >= ?", "occurred_at < ?"];
  const bindings: unknown[] = [input.from, input.to];
  if (input.zoneIds.length > 0) {
    conditions.push(`zone_id IN (${input.zoneIds.map(() => "?").join(",")})`);
    bindings.push(...input.zoneIds);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) {
    conditions.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
    bindings.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  const equals: Array<[unknown, string]> = [
    [input.clientIp, "client_ip"],
    [input.country, "country"],
    [input.asn, "asn"],
    [input.method, "method"],
    [input.status, columns.status ?? ""],
    [input.cacheStatus, columns.cacheStatus ?? ""],
    [input.securityAction, columns.action],
    [input.securitySource, columns.source],
    [input.rayId, "ray_id"],
    [input.requestSource, columns.requestSource ?? ""],
  ];
  for (const [value, column] of equals) {
    if (value !== undefined && column) {
      conditions.push(`${column} = ?`);
      bindings.push(value);
    }
  }
  const prefixes: Array<[string | undefined, string]> = [
    [input.host, "host"],
    [input.path, "path"],
  ];
  for (const [value, column] of prefixes) {
    if (value) {
      conditions.push(`${column} LIKE ? ESCAPE '\\'`);
      bindings.push(`${escapeLike(value)}%`);
    }
  }
  const contains: Array<[string | undefined, string]> = [
    [input.query, "query"],
    [input.userAgent, "user_agent"],
  ];
  for (const [value, column] of contains) {
    if (value) {
      conditions.push(`${column} LIKE ? ESCAPE '\\'`);
      bindings.push(`%${escapeLike(value)}%`);
    }
  }
  return { sql: conditions.join(" AND "), bindings };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function listRequests(database: D1Database, input: ListFilterInput): Promise<PaginatedResult<SampledRequest>> {
  const where = buildWhere(input, {
    action: "security_action",
    source: "security_source",
    requestSource: "request_source",
    status: "edge_status",
    cacheStatus: "cache_status",
  });
  const result = await database
    .prepare(`SELECT * FROM request_samples WHERE ${where.sql} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .bind(...where.bindings, input.limit + 1)
    .all<RequestRow>();
  const hasMore = result.results.length > input.limit;
  const selected = result.results.slice(0, input.limit);
  const items = selected.map(mapRequest);
  const last = selected.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurred_at, id: last.id }) : null,
  };
}

export async function getRequest(database: D1Database, id: string): Promise<SampledRequest | null> {
  const row = await database.prepare("SELECT * FROM request_samples WHERE id = ?").bind(id).first<RequestRow>();
  return row ? mapRequest(row) : null;
}

export async function listSecurityEvents(
  database: D1Database,
  input: ListFilterInput,
): Promise<PaginatedResult<SecurityEvent>> {
  const where = buildWhere(input, { action: "action", source: "source" });
  const result = await database
    .prepare(`SELECT * FROM security_events WHERE ${where.sql} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .bind(...where.bindings, input.limit + 1)
    .all<EventRow>();
  const hasMore = result.results.length > input.limit;
  const selected = result.results.slice(0, input.limit);
  const items = selected.map(mapEvent);
  const last = selected.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurred_at, id: last.id }) : null,
  };
}

export async function getSecurityEvent(database: D1Database, id: string): Promise<SecurityEvent | null> {
  const row = await database.prepare("SELECT * FROM security_events WHERE id = ?").bind(id).first<EventRow>();
  return row ? mapEvent(row) : null;
}

export function mapRequest(row: RequestRow): SampledRequest {
  return {
    id: row.id,
    zoneId: row.zone_id,
    occurredAt: row.occurred_at,
    rayId: asString(row.ray_id),
    clientIp: asString(row.client_ip),
    country: asString(row.country),
    asn: asNumber(row.asn),
    asnDescription: asString(row.asn_description),
    userAgent: asString(row.user_agent),
    referer: asString(row.referer),
    deviceType: asString(row.device_type),
    host: asString(row.host),
    path: asString(row.path),
    query: asString(row.query),
    method: asString(row.method),
    protocol: asString(row.protocol),
    requestSource: asString(row.request_source),
    colo: asString(row.colo),
    cacheStatus: asString(row.cache_status),
    originStatus: asNumber(row.origin_status),
    edgeStatus: asNumber(row.edge_status),
    securityAction: asString(row.security_action),
    securitySource: asString(row.security_source),
    securityRuleId: asString(row.security_rule_id),
    botScore: asNumber(row.bot_score),
    botScoreSource: asString(row.bot_score_source),
    botTags: parseJsonStringArray(row.bot_tags),
    verifiedBotCategory: asString(row.verified_bot_category),
    attackScore: asNumber(row.attack_score),
    contentScanResult: parseJsonUnknown(row.content_scan_result),
    leakedCredentialResult: asString(row.leaked_credential_result),
    sampleInterval: asNumber(row.sample_interval),
    extra: parseJsonRecord(row.extra),
  };
}

export function mapEvent(row: EventRow): SecurityEvent {
  return {
    id: row.id,
    zoneId: row.zone_id,
    occurredAt: row.occurred_at,
    rayId: asString(row.ray_id),
    action: asString(row.action),
    source: asString(row.source),
    ruleId: asString(row.rule_id),
    ruleDescription: asString(row.rule_description),
    rulesetId: asString(row.ruleset_id),
    kind: asString(row.kind),
    clientIp: asString(row.client_ip),
    country: asString(row.country),
    asn: asNumber(row.asn),
    host: asString(row.host),
    path: asString(row.path),
    query: asString(row.query),
    method: asString(row.method),
    userAgent: asString(row.user_agent),
    sampleInterval: asNumber(row.sample_interval),
    extra: parseJsonRecord(row.extra),
  };
}

function parseJsonUnknown(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return asRecord(parseJsonUnknown(value));
}

function parseJsonStringArray(value: unknown): string[] {
  return asStringArray(parseJsonUnknown(value));
}

interface HealthCursorRow {
  zone_id: string;
  zone_name: string;
  dataset: string;
  cursor_at: number;
  last_success_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
}

interface GapRow {
  id: string;
  zone_id: string;
  dataset: string;
  range_start: number;
  range_end: number;
  reason: string;
}

interface UsageRow {
  graphql_queries: number;
  d1_rows_read: number;
  d1_rows_written: number;
  d1_size_after: number;
  queue_messages: number;
  r2_bytes_written: number;
}

export async function getHealth(database: D1Database, warningBytes: number): Promise<CollectorHealth> {
  const [cursorResult, gapResult, usage] = await Promise.all([
    database
      .prepare(
        `SELECT c.zone_id, z.name AS zone_name, c.dataset, c.cursor_at, c.last_success_at,
                c.consecutive_failures, c.last_error
         FROM sync_cursors c JOIN zones z ON z.id = c.zone_id
         WHERE z.enabled = 1 ORDER BY z.name, c.dataset`,
      )
      .all<HealthCursorRow>(),
    database
      .prepare(
        `SELECT id, zone_id, dataset, range_start, range_end, reason
         FROM data_gaps WHERE resolved_at IS NULL ORDER BY detected_at DESC LIMIT 100`,
      )
      .all<GapRow>(),
    database
      .prepare(
        `SELECT graphql_queries, d1_rows_read, d1_rows_written, d1_size_after,
                queue_messages, r2_bytes_written FROM usage_daily WHERE day = ?`,
      )
      .bind(dayKey())
      .first<UsageRow>(),
  ]);
  const cursorDatasets = new Set(DATASETS);
  const cursors = cursorResult.results.flatMap((row) => {
    const parsed = datasetSchema.safeParse(row.dataset);
    if (!parsed.success || !cursorDatasets.has(parsed.data)) return [];
    return [
      {
        zoneId: row.zone_id,
        zoneName: row.zone_name,
        dataset: parsed.data,
        cursorAt: row.cursor_at,
        lastSuccessAt: row.last_success_at,
        consecutiveFailures: row.consecutive_failures,
        lastError: row.last_error,
      },
    ];
  });
  const gaps = gapResult.results.flatMap((row) => {
    const parsed = datasetSchema.safeParse(row.dataset);
    return parsed.success
      ? [
          {
            id: row.id,
            zoneId: row.zone_id,
            dataset: parsed.data,
            rangeStart: row.range_start,
            rangeEnd: row.range_end,
            reason: row.reason,
          },
        ]
      : [];
  });
  const usageToday = {
    graphqlQueries: usage?.graphql_queries ?? 0,
    d1RowsRead: usage?.d1_rows_read ?? 0,
    d1RowsWritten: usage?.d1_rows_written ?? 0,
    d1SizeAfter: usage?.d1_size_after ?? 0,
    queueMessages: usage?.queue_messages ?? 0,
    r2BytesWritten: usage?.r2_bytes_written ?? 0,
  };
  const configured = cursors.length > 0;
  const degraded = gaps.length > 0 || cursors.some((cursor) => cursor.consecutiveFailures >= 3);
  return {
    status: !configured ? "unconfigured" : degraded ? "degraded" : "healthy",
    now: nowMs(),
    d1WarningBytes: warningBytes,
    usageToday,
    cursors,
    gaps,
  };
}

export function filtersFromUrl(url: URL): ListFilterInput {
  const from = Date.parse(url.searchParams.get("from") ?? new Date(nowMs() - 86_400_000).toISOString());
  const to = Date.parse(url.searchParams.get("to") ?? new Date().toISOString());
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("时间范围无效");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
  const asnValue = url.searchParams.get("asn");
  const statusValue = url.searchParams.get("status");
  return {
    zoneIds: parseCsv(url.searchParams.get("zones") ?? undefined),
    from,
    to,
    limit,
    cursor: url.searchParams.get("cursor") ?? undefined,
    clientIp: url.searchParams.get("ip") ?? undefined,
    country: url.searchParams.get("country") ?? undefined,
    asn: asnValue && Number.isFinite(Number(asnValue)) ? Number(asnValue) : undefined,
    host: url.searchParams.get("host") ?? undefined,
    path: url.searchParams.get("path") ?? undefined,
    query: url.searchParams.get("query") ?? undefined,
    method: url.searchParams.get("method") ?? undefined,
    status: statusValue && Number.isFinite(Number(statusValue)) ? Number(statusValue) : undefined,
    cacheStatus: url.searchParams.get("cacheStatus") ?? undefined,
    securityAction: url.searchParams.get("securityAction") ?? undefined,
    securitySource: url.searchParams.get("securitySource") ?? undefined,
    rayId: url.searchParams.get("rayId") ?? undefined,
    userAgent: url.searchParams.get("userAgent") ?? undefined,
    requestSource: url.searchParams.get("requestSource") ?? undefined,
  };
}
