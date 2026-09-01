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
import { ApiError, endpoints, type ArchiveItem } from "@/client/api";

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
  const manifests = (await endpoints.archives(manifestQuery)).items;
  if (manifests.length === 5_000) throw new Error("所选范围包含过多归档文件，请缩短时间范围或指定 Zone");

  const matched: ArchiveRecord[] = [];
  for (let index = 0; index < manifests.length;) {
    const hour = manifests[index]?.range_start;
    const hourRecords: ArchiveRecord[] = [];
    while (index < manifests.length && manifests[index]?.range_start === hour) {
      hourRecords.push(...await readArchive(manifests[index], dataset, signal));
      index += 1;
    }
    const deduplicated = new Map(hourRecords.map((item) => [item.id, item]));
    for (const item of [...deduplicated.values()].sort(compareArchiveRecords)) {
      if (matchesArchiveFilter(item, filter)) matched.push(item);
      if (matched.length > filter.limit) break;
    }
    if (matched.length > filter.limit) break;
  }
  const hasMore = matched.length > filter.limit;
  const items = matched.slice(0, filter.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeArchiveCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
  };
}

async function readArchive(
  manifest: ArchiveItem,
  dataset: RawArchiveDataset,
  signal?: AbortSignal,
): Promise<ArchiveRecord[]> {
  const response = await fetch(`/api/v1/archives/${encodeURIComponent(manifest.id)}/download`, { signal });
  if (!response.ok) throw new ApiError(`读取 R2 归档失败（HTTP ${response.status}）`, "ARCHIVE_DOWNLOAD_FAILED", response.status);
  return decodeArchiveResponse(response, dataset);
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
