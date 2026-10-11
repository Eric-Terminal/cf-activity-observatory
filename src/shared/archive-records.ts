import type { DetailFilter, SampledRequest, SecurityEvent } from "@/shared/contracts";

export type RawArchiveDataset = "httpRequestsAdaptive" | "firewallEventsAdaptive";
export type ArchiveRecord = SampledRequest | SecurityEvent;

export interface ArchiveHeader {
  type: "cf-activity-observatory/archive";
  schemaVersion: number;
  zoneId: string;
  dataset: RawArchiveDataset;
  rangeStart: string;
  rangeEnd: string;
  generatedAt: string;
}

export function parseArchiveHeader(value: unknown): ArchiveHeader | null {
  const row = record(value);
  const dataset = row.dataset;
  if (
    row.type !== "cf-activity-observatory/archive"
    || (dataset !== "httpRequestsAdaptive" && dataset !== "firewallEventsAdaptive")
    || typeof row.schemaVersion !== "number"
    || typeof row.zoneId !== "string"
    || typeof row.rangeStart !== "string"
    || typeof row.rangeEnd !== "string"
    || typeof row.generatedAt !== "string"
  ) return null;
  return { ...row, dataset } as unknown as ArchiveHeader;
}

export function parseArchiveRecord(
  dataset: RawArchiveDataset,
  schemaVersion: number,
  value: unknown,
): ArchiveRecord | null {
  const row = record(value);
  if (typeof row.id !== "string") return null;
  const normalized = schemaVersion === 1 ? legacyRecord(dataset, row) : row;
  const zoneId = string(normalized.zoneId);
  const occurredAt = number(normalized.occurredAt);
  if (!zoneId || occurredAt === null) return null;
  return dataset === "httpRequestsAdaptive"
    ? requestRecord(normalized, row.id, zoneId, occurredAt)
    : eventRecord(normalized, row.id, zoneId, occurredAt);
}

export function matchesArchiveFilter(item: ArchiveRecord, filter: DetailFilter): boolean {
  if (item.occurredAt < filter.from || item.occurredAt >= filter.to) return false;
  if (filter.zoneIds.length && !filter.zoneIds.includes(item.zoneId)) return false;
  const cursor = decodeArchiveCursor(filter.cursor);
  if (cursor && (item.occurredAt > cursor.occurredAt || (item.occurredAt === cursor.occurredAt && item.id >= cursor.id))) {
    return false;
  }
  const request = "edgeStatus" in item ? item : null;
  const event = "action" in item ? item : null;
  const equals: Array<[unknown, unknown]> = [
    [filter.clientIp, item.clientIp],
    [filter.country, item.country],
    [filter.asn, item.asn],
    [filter.method, item.method],
    [filter.protocol, request?.protocol],
    [filter.status, request?.edgeStatus],
    [filter.cacheStatus, request?.cacheStatus],
    [filter.securityAction, request?.securityAction ?? event?.action],
    [filter.securitySource, request?.securitySource ?? event?.source],
    [filter.rayId, item.rayId],
    [filter.requestSource, request?.requestSource],
    [filter.ruleId, request?.securityRuleId ?? event?.ruleId],
  ];
  if (equals.some(([expected, actual]) => expected !== undefined && expected !== actual)) return false;
  if (filter.host && !startsWithIgnoreCase(item.host, filter.host)) return false;
  if (filter.path && !startsWithIgnoreCase(item.path, filter.path)) return false;
  if (filter.query && !includesIgnoreCase(item.query, filter.query)) return false;
  if (filter.userAgent && !includesIgnoreCase(item.userAgent, filter.userAgent)) return false;
  return true;
}

export function compareArchiveRecords(left: ArchiveRecord, right: ArchiveRecord): number {
  return right.occurredAt - left.occurredAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
}

export function encodeArchiveCursor(value: { occurredAt: number; id: string }): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeArchiveCursor(value: string | undefined): { occurredAt: number; id: string } | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))) as unknown;
    const row = record(decoded);
    const occurredAt = number(row.occurredAt);
    return occurredAt !== null && typeof row.id === "string" ? { occurredAt, id: row.id } : null;
  } catch {
    return null;
  }
}

function legacyRecord(dataset: RawArchiveDataset, row: Record<string, unknown>): Record<string, unknown> {
  const common = {
    id: row.id,
    zoneId: row.zone_id,
    occurredAt: row.occurred_at,
    rayId: row.ray_id,
    clientIp: row.client_ip,
    country: row.country,
    asn: row.asn,
    host: row.host,
    path: row.path,
    query: row.query,
    method: row.method,
    userAgent: row.user_agent,
    sampleInterval: row.sample_interval,
    extra: jsonRecord(row.extra),
  };
  if (dataset === "firewallEventsAdaptive") {
    return {
      ...common,
      action: row.action,
      source: row.source,
      ruleId: row.rule_id,
      ruleDescription: row.rule_description,
      rulesetId: row.ruleset_id,
      kind: row.kind,
    };
  }
  return {
    ...common,
    asnDescription: row.asn_description,
    referer: row.referer,
    deviceType: row.device_type,
    protocol: row.protocol,
    requestSource: row.request_source,
    colo: row.colo,
    cacheStatus: row.cache_status,
    originStatus: row.origin_status,
    edgeStatus: row.edge_status,
    securityAction: row.security_action,
    securitySource: row.security_source,
    securityRuleId: row.security_rule_id,
    botScore: row.bot_score,
    botScoreSource: row.bot_score_source,
    botTags: jsonStringArray(row.bot_tags),
    verifiedBotCategory: row.verified_bot_category,
    attackScore: row.attack_score,
    contentScanResult: jsonValue(row.content_scan_result),
    leakedCredentialResult: row.leaked_credential_result,
  };
}

function requestRecord(row: Record<string, unknown>, id: string, zoneId: string, occurredAt: number): SampledRequest {
  return {
    dataSource: row.dataSource === "logpush" ? "logpush" : "graphql",
    id, zoneId, occurredAt,
    rayId: string(row.rayId), clientIp: string(row.clientIp), country: string(row.country), asn: number(row.asn),
    asnDescription: string(row.asnDescription), userAgent: string(row.userAgent), referer: string(row.referer),
    deviceType: string(row.deviceType), host: string(row.host), path: string(row.path), query: string(row.query),
    method: string(row.method), protocol: string(row.protocol), requestSource: string(row.requestSource),
    colo: string(row.colo), cacheStatus: string(row.cacheStatus), originStatus: number(row.originStatus),
    edgeStatus: number(row.edgeStatus), securityAction: string(row.securityAction), securitySource: string(row.securitySource),
    securityRuleId: string(row.securityRuleId), botScore: number(row.botScore), botScoreSource: string(row.botScoreSource),
    botTags: stringArray(row.botTags), verifiedBotCategory: string(row.verifiedBotCategory), attackScore: number(row.attackScore),
    contentScanResult: row.contentScanResult ?? null, leakedCredentialResult: string(row.leakedCredentialResult),
    sampleInterval: number(row.sampleInterval), extra: record(row.extra),
  };
}

function eventRecord(row: Record<string, unknown>, id: string, zoneId: string, occurredAt: number): SecurityEvent {
  return {
    dataSource: row.dataSource === "logpush" ? "logpush" : "graphql",
    id, zoneId, occurredAt,
    rayId: string(row.rayId), action: string(row.action), source: string(row.source), ruleId: string(row.ruleId),
    ruleDescription: string(row.ruleDescription), rulesetId: string(row.rulesetId), kind: string(row.kind),
    clientIp: string(row.clientIp), country: string(row.country), asn: number(row.asn), host: string(row.host),
    path: string(row.path), query: string(row.query), method: string(row.method), userAgent: string(row.userAgent),
    sampleInterval: number(row.sampleInterval), extra: record(row.extra),
  };
}

function startsWithIgnoreCase(value: string | null, expected: string): boolean {
  return value?.toLocaleLowerCase().startsWith(expected.toLocaleLowerCase()) ?? false;
}

function includesIgnoreCase(value: string | null, expected: string): boolean {
  return value?.toLocaleLowerCase().includes(expected.toLocaleLowerCase()) ?? false;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return record(jsonValue(value));
}

function jsonStringArray(value: unknown): string[] {
  return stringArray(jsonValue(value));
}
