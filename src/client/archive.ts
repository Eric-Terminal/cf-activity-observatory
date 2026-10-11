import type { DetailFilter, PaginatedResult, SampledRequest, SecurityEvent } from "@/shared/contracts";
import {
  compareArchiveRecords,
  encodeArchiveCursor,
  matchesArchiveFilter,
  parseArchiveHeader,
  parseArchiveRecord,
  type ArchiveRecord,
  type RawArchiveDataset,
} from "@/shared/archive-records";
import { ApiError, endpoints } from "@/client/api";
import { parseLogpushRecord } from "@/shared/logpush";
import { readNdjson } from "@/shared/ndjson";

export async function queryArchivedRequests(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<PaginatedResult<SampledRequest>> {
  return queryArchive("httpRequestsAdaptive", params, signal) as Promise<PaginatedResult<SampledRequest>>;
}

export async function queryArchivedEvents(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<PaginatedResult<SecurityEvent>> {
  return queryArchive("firewallEventsAdaptive", params, signal) as Promise<PaginatedResult<SecurityEvent>>;
}

export async function exportArchive(
  type: "requests" | "security",
  format: "csv" | "json" | "ndjson",
  params: URLSearchParams,
): Promise<void> {
  const query = new URLSearchParams(params);
  query.set("limit", "500");
  query.delete("cursor");
  const result = type === "requests"
    ? await queryArchivedRequests(query)
    : await queryArchivedEvents(query);
  const body = format === "json"
    ? JSON.stringify(result.items, null, 2)
    : format === "ndjson"
      ? `${result.items.map((item) => JSON.stringify(item)).join("\n")}\n`
      : toCsv(result.items);
  const mime = format === "csv" ? "text/csv;charset=utf-8" : format === "json" ? "application/json" : "application/x-ndjson";
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${type}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function queryArchive(
  dataset: RawArchiveDataset,
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<PaginatedResult<ArchiveRecord>> {
  const filter = filterFromParams(params);
  const manifestQuery = new URLSearchParams({
    dataset,
    from: new Date(filter.from).toISOString(),
    to: new Date(filter.to).toISOString(),
    limit: "5000",
  });
  if (filter.zoneIds.length) manifestQuery.set("zones", filter.zoneIds.join(","));
  const manifests = (await endpoints.archives(manifestQuery, signal)).items;
  if (manifests.length === 5_000) throw new Error("所选范围包含过多归档文件，请缩短时间范围或指定 Zone");
  let best = new Map<string, ArchiveRecord>();
  let downloaded = 0;
  const requestedSource = params.get("dataSource");
  for (const manifest of manifests) {
    signal?.throwIfAborted();
    if (requestedSource === "logpush" && manifest.schema_version !== 3) continue;
    if (requestedSource === "graphql" && manifest.schema_version === 3) continue;
    const retained = [...best.values()].sort(compareArchiveRecords);
    // Logpush 批次时间范围可能重叠；只能跳过确定比整页都旧的文件，不能按文件顺序提前结束。
    if (retained.length > filter.limit && manifest.range_end <= retained[filter.limit].occurredAt) continue;
    downloaded += manifest.compressed_bytes;
    if (downloaded > 64 * 1024 * 1024) throw new Error("本次扫描超过 64 MiB，请缩短时间范围或选择单个 Zone；未返回不完整结果");
    const response = await fetch(`/api/v1/archives/${encodeURIComponent(manifest.id)}/download`, { signal });
    if (!response.ok || !response.body) throw new ApiError(`读取 R2 归档失败（HTTP ${response.status}）`, "ARCHIVE_DOWNLOAD_FAILED", response.status);
    let header: ReturnType<typeof parseArchiveHeader> = null;
    for await (const value of readNdjson(response.body)) {
      let item: ArchiveRecord | null;
      if (manifest.schema_version === 3) {
        item = parseLogpushRecord(dataset === "httpRequestsAdaptive" ? "http_requests" : "firewall_events", manifest.zone_id, value);
      } else if (!header) {
        header = parseArchiveHeader(value);
        if (!header || header.dataset !== dataset || header.zoneId !== manifest.zone_id) throw new Error("归档头与清单不一致");
        continue;
      } else item = parseArchiveRecord(dataset, header.schemaVersion, value);
      if (!item) throw new Error("归档记录无效");
      const key = archiveIdentity(item);
      // 游标使用跨来源稳定的身份，避免上一页原生日志在下一页又以 GraphQL 记录出现。
      item = { ...item, id: key };
      if (!matchesArchiveFilter(item, filter)) continue;
      const previous = best.get(key);
      if (!previous || item.dataSource === "logpush") best.set(key, item);
      if (best.size > (filter.limit + 1) * 2) {
        best = new Map([...best.values()].sort(compareArchiveRecords).slice(0, filter.limit + 1).map((record) => [archiveIdentity(record), record]));
      }
    }
    if (manifest.schema_version !== 3 && !header) throw new Error("归档缺少元数据行");
  }
  const matched = [...best.values()].sort(compareArchiveRecords);
  const hasMore = matched.length > filter.limit;
  const items = matched.slice(0, filter.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeArchiveCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
  };
}

function archiveIdentity(item: ArchiveRecord): string {
  if (!item.rayId) return item.id;
  return JSON.stringify("edgeStatus" in item
    ? [item.zoneId, item.rayId]
    : [item.zoneId, item.rayId, item.source, item.ruleId, item.action]);
}

export async function decodeArchiveResponse(
  response: Response,
  dataset: RawArchiveDataset,
): Promise<ArchiveRecord[]> {
  if (!response.body) throw new Error("浏览器未提供归档响应流");
  const reader = response.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  let header: ReturnType<typeof parseArchiveHeader> = null;
  const items: ArchiveRecord[] = [];
  while (true) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const value = JSON.parse(line) as unknown;
      if (!header) {
        header = parseArchiveHeader(value);
        if (!header || header.dataset !== dataset) throw new Error("R2 归档头与清单不一致");
        continue;
      }
      const item = parseArchiveRecord(dataset, header.schemaVersion, value);
      if (item) items.push(item);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    if (!header) throw new Error("R2 归档缺少元数据行");
    const item = parseArchiveRecord(dataset, header.schemaVersion, JSON.parse(buffer) as unknown);
    if (item) items.push(item);
  }
  if (!header) throw new Error("R2 归档为空或格式无效");
  return items;
}

function filterFromParams(params: URLSearchParams): DetailFilter {
  const to = Date.parse(params.get("to") ?? new Date().toISOString());
  const from = Date.parse(params.get("from") ?? new Date(to - 86_400_000).toISOString());
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error("时间范围无效");
  const numberParam = (name: string): number | undefined => {
    const value = params.get(name);
    return value !== null && Number.isFinite(Number(value)) ? Number(value) : undefined;
  };
  const text = (name: string): string | undefined => params.get(name) || undefined;
  return {
    zoneIds: (params.get("zones") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    from,
    to,
    limit: Math.min(Math.max(numberParam("limit") ?? 100, 1), 500),
    cursor: text("cursor"), clientIp: text("ip"), country: text("country"), asn: numberParam("asn"),
    host: text("host"), path: text("path"), query: text("query"), method: text("method"),
    protocol: text("protocol"), status: numberParam("status"), cacheStatus: text("cacheStatus"),
    securityAction: text("securityAction"), securitySource: text("securitySource"), rayId: text("rayId"),
    userAgent: text("userAgent"), requestSource: text("requestSource"), ruleId: text("ruleId"),
  };
}

function toCsv(rows: Array<Record<string, unknown>> | ArchiveRecord[]): string {
  const records = rows as Array<Record<string, unknown>>;
  if (!records.length) return "";
  const columns = [...new Set(records.flatMap((row) => Object.keys(row)))];
  return `\uFEFF${columns.map(archiveCsvCell).join(",")}\r\n${records.map((row) => columns.map((column) => archiveCsvCell(row[column])).join(",")).join("\r\n")}\r\n`;
}

export function archiveCsvCell(value: unknown): string {
  let text = value === null || value === undefined
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
        ? String(value)
        : "";
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
