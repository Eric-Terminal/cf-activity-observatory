import { z } from "zod";
import { parseArchiveRecord, type ArchiveRecord, type RawArchiveDataset } from "@/shared/archive-records";

export const logpushDatasetSchema = z.enum(["http_requests", "firewall_events"]);
export type LogpushDataset = z.infer<typeof logpushDatasetSchema>;

export const LOGPUSH_DATASETS: Record<LogpushDataset, RawArchiveDataset> = {
  http_requests: "httpRequestsAdaptive",
  firewall_events: "firewallEventsAdaptive",
};

export interface LogpushSource {
  zoneId: string;
  zoneName: string;
  accountId: string | null;
  dataset: LogpushDataset;
  prefix: string;
  activatedAt: number | null;
  lastReceivedAt: number | null;
  lastIndexedAt: number | null;
  files: number;
  records: number;
  bytes: number;
}

export const LOGPUSH_FIELDS: Record<LogpushDataset, string[]> = {
  http_requests: ["EdgeStartTimestamp", "RayID", "ClientIP", "ClientCountry", "ClientASN", "ClientRequestHost", "ClientRequestPath", "ClientRequestURI", "ClientRequestMethod", "ClientRequestProtocol", "ClientRequestUserAgent", "ClientRequestReferer", "ClientDeviceType", "ClientRequestSource", "EdgeColoCode", "CacheCacheStatus", "OriginResponseStatus", "EdgeResponseStatus", "SecurityAction", "SecurityRuleID", "SecuritySources", "BotScore", "BotScoreSrc", "BotTags", "WAFScore"],
  firewall_events: ["Datetime", "RayID", "Action", "Source", "RuleID", "Description", "Kind", "ClientIP", "ClientCountryName", "ClientASN", "ClientRequestHost", "ClientRequestPath", "ClientRequestQuery", "ClientRequestMethod", "UserAgent"],
};

export function logpushPrefix(zoneId: string, dataset: LogpushDataset): string {
  return `logpush/${zoneId}/${dataset}/`;
}

export function parseLogpushKey(key: string): { zoneId: string; dataset: LogpushDataset } | null {
  const match = /^logpush\/([a-f0-9]{32})\/(http_requests|firewall_events)\/[^\0]+\.gz$/u.exec(key);
  return match ? { zoneId: match[1], dataset: logpushDatasetSchema.parse(match[2]) } : null;
}

/** Logpush 不带应用归档头；先规范化字段，再与历史归档共用筛选与详情模型。 */
export function parseLogpushRecord(dataset: LogpushDataset, zoneId: string, value: unknown): ArchiveRecord {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const timestamp = dataset === "http_requests" ? row.EdgeStartTimestamp : row.Datetime;
  const occurredAt = logpushTimestamp(timestamp);
  if (occurredAt === null || typeof row.RayID !== "string" || !row.RayID) {
    throw new Error("Logpush 缺少有效时间或 RayID，请检查投递字段");
  }
  if (row.ZoneID !== undefined && row.ZoneID !== zoneId) throw new Error("Logpush 记录与目标 Zone 不一致");
  const uri = typeof row.ClientRequestURI === "string" ? row.ClientRequestURI : "";
  const separator = uri.indexOf("?");
  const common = {
    // Ray ID 区分边缘请求；安全事件还必须区分同一请求触发的多条规则。
    id: `logpush:${zoneId}:${row.RayID}:${dataset === "http_requests" ? "http" : JSON.stringify([timestamp, row.Source, row.RuleID, row.Action])}`,
    zoneId, occurredAt, rayId: row.RayID, source: "logpush",
    clientIp: row.ClientIP, country: row.ClientCountry ?? row.ClientCountryName, asn: row.ClientASN,
    host: row.ClientRequestHost, path: row.ClientRequestPath ?? (separator >= 0 ? uri.slice(0, separator) : uri),
    query: row.ClientRequestQuery ?? (separator >= 0 ? uri.slice(separator + 1) : null),
    method: row.ClientRequestMethod, userAgent: row.ClientRequestUserAgent ?? row.UserAgent,
    // 来源只说明投递方式，无法从记录证明作业没有过滤或采样，因此不填伪造的采样率。
    sampleInterval: null, extra: {},
  };
  const normalized = dataset === "http_requests" ? {
    ...common, protocol: row.ClientRequestProtocol, referer: row.ClientRequestReferer,
    deviceType: row.ClientDeviceType, requestSource: row.ClientRequestSource, colo: row.EdgeColoCode,
    cacheStatus: row.CacheCacheStatus, originStatus: row.OriginResponseStatus, edgeStatus: row.EdgeResponseStatus,
    securityAction: row.SecurityAction, securitySource: Array.isArray(row.SecuritySources) ? row.SecuritySources.join(", ") : null,
    securityRuleId: row.SecurityRuleID, botScore: row.BotScore, botScoreSource: row.BotScoreSrc,
    botTags: row.BotTags, attackScore: row.WAFScore,
  } : {
    ...common, action: row.Action, source: row.Source, ruleId: row.RuleID,
    ruleDescription: row.Description, rulesetId: row.RulesetID, kind: row.Kind,
  };
  const result = parseArchiveRecord(LOGPUSH_DATASETS[dataset], 2, normalized);
  if (!result) throw new Error("Logpush 记录格式无效");
  return { ...result, dataSource: "logpush" };
}

export function logpushTimestamp(value: unknown): number | null {
  if (typeof value === "string" && !/^\d+$/u.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric > 1e17 ? numeric / 1e6 : numeric > 1e14 ? numeric / 1000 : numeric < 1e11 ? numeric * 1000 : numeric);
}
