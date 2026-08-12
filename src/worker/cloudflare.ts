import type { DatasetCapability, DatasetName } from "@/shared/contracts";
import { DATASETS, GROUP_DATASETS } from "@/shared/contracts";
import { asNumber, asRecord, asString, asStringArray, sanitizeError, toIso } from "@/worker/utils";

interface GraphqlEnvelope {
  data?: unknown;
  errors?: Array<{ message?: string }>;
}

interface ApiEnvelope {
  success?: boolean;
  result?: unknown;
  errors?: Array<{ message?: string }>;
  result_info?: { page?: number; total_pages?: number };
}

export interface CloudflareZone {
  id: string;
  name: string;
  accountId: string | null;
}

export interface DatasetResult {
  rows: Record<string, unknown>[];
  queryCount: number;
  saturated: boolean;
}

interface RankingSelection {
  fields: string[];
  dimensionType: "path" | "ip" | "asn" | "userAgent" | "rule";
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly status = 502,
  ) {
    super(message);
  }
}

const SETTINGS_FIELDS = "enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan";

/** 首选字段按调查价值排序，能力发现会在发出查询前删除当前 Zone 不支持的字段。 */
export const PREFERRED_FIELDS: Record<DatasetName, string[]> = {
  httpRequestsAdaptive: [
    "datetime",
    "rayName",
    "clientIP",
    "clientCountryName",
    "clientAsn",
    "clientASNDescription",
    "userAgent",
    "clientRefererHost",
    "clientDeviceType",
    "clientRequestHTTPHost",
    "clientRequestPath",
    "clientRequestQuery",
    "clientRequestHTTPMethodName",
    "clientRequestHTTPProtocol",
    "requestSource",
    "coloCode",
    "cacheStatus",
    "originResponseStatus",
    "edgeResponseStatus",
    "securityAction",
    "securitySource",
    "securityRuleID",
    "botManagementScore",
    "botManagementScoreSrc",
    "botManagementScoreSrcName",
    "botManagementTags",
    "botManagementVerifiedBot",
    "verifiedBotCategory",
    "botManagementJA3Hash",
    "botManagementJA4",
    "wafAttackScore",
    "contentScanObjResults",
    "leakedCredentialCheckResult",
    "sampleInterval",
  ],
  firewallEventsAdaptive: [
    "datetime",
    "rayName",
    "action",
    "source",
    "ruleId",
    "description",
    "rulesetId",
    "kind",
    "clientIP",
    "clientCountryName",
    "clientAsn",
    "clientRequestHTTPHost",
    "clientRequestPath",
    "clientRequestQuery",
    "clientRequestHTTPMethodName",
    "userAgent",
    "sampleInterval",
  ],
  httpRequestsAdaptiveGroups: [
    "dimensions_datetimeFiveMinutes",
    "count",
    "avg_sampleInterval",
    "confidence_count_estimate",
    "confidence_count_lower",
    "confidence_count_upper",
    "confidence_count_sampleSize",
    "dimensions_clientRequestHTTPHost",
    "dimensions_clientCountryName",
    "dimensions_clientRequestHTTPMethodName",
    "dimensions_clientRequestHTTPProtocol",
    "dimensions_edgeResponseStatus",
    "dimensions_originResponseStatus",
    "dimensions_cacheStatus",
    "dimensions_securityAction",
    "dimensions_securitySource",
    "dimensions_requestSource",
    "sum_edgeResponseBytes",
    "sum_visits",
  ],
  firewallEventsAdaptiveGroups: [
    "dimensions_datetimeFiveMinutes",
    "count",
    "avg_sampleInterval",
    "confidence_count_estimate",
    "confidence_count_lower",
    "confidence_count_upper",
    "confidence_count_sampleSize",
    "dimensions_action",
    "dimensions_source",
    "dimensions_ruleId",
    "dimensions_description",
  ],
};

export async function listCloudflareZones(env: Env): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];
  let page = 1;
  for (;;) {
    const url = new URL(`${env.CLOUDFLARE_API_URL}/zones`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    });
    const payload = await response.json<ApiEnvelope>();
    if (!response.ok || !payload.success || !Array.isArray(payload.result)) {
      throw new CloudflareApiError(apiErrorMessage(payload, response.status), retryAfter(response), response.status);
    }
    for (const value of payload.result) {
      const zone = asRecord(value);
      const account = asRecord(zone.account);
      const id = asString(zone.id);
      const name = asString(zone.name);
      if (id && name) zones.push({ id, name, accountId: asString(account.id) });
    }
    const totalPages = payload.result_info?.total_pages ?? page;
    if (page >= totalPages) break;
    page += 1;
  }
  return zones;
}

export async function getDatasetCapabilities(env: Env, zoneId: string): Promise<DatasetCapability[]> {
  const selections = DATASETS.map((dataset) => `${dataset} { ${SETTINGS_FIELDS} }`).join("\n");
  const query = `query ObservatorySettings($zoneTag: string!) {
    viewer { zones(filter: { zoneTag: $zoneTag }) { settings { ${selections} } } }
  }`;
  const data = await graphql(env, query, { zoneTag: zoneId });
  const settings = asRecord(firstZoneNode(data, "settings"));
  const checkedAt = Date.now();
  return DATASETS.map((dataset) => {
    const value = asRecord(settings[dataset]);
    return {
      zoneId,
      dataset,
      enabled: value.enabled === true,
      availableFields: normalizeFields(value.availableFields),
      maxPageSize: asNumber(value.maxPageSize),
      maxNumberOfFields: asNumber(value.maxNumberOfFields),
      notOlderThan: asNumber(value.notOlderThan),
      maxDuration: asNumber(value.maxDuration),
      checkedAt,
    };
  });
}

export function selectedFields(capability: DatasetCapability): string[] {
  const available = new Set(capability.availableFields);
  const preferred = PREFERRED_FIELDS[capability.dataset];
  const intersected = preferred.filter((field) => available.size === 0 || available.has(field));
  const maximum = capability.maxNumberOfFields ?? intersected.length;
  return intersected.slice(0, maximum);
}

export function buildDatasetQuery(
  dataset: DatasetName,
  fields: string[],
  limit: number,
): string {
  const selection = GROUP_DATASETS.includes(dataset as (typeof GROUP_DATASETS)[number])
    ? nestedSelection(fields)
    : fields.join("\n");
  const orderBy = GROUP_DATASETS.includes(dataset as (typeof GROUP_DATASETS)[number])
    ? "datetimeFiveMinutes_DESC"
    : "datetime_DESC";
  return `query ObservatoryRows($zoneTag: string!, $start: Time!, $end: Time!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        ${dataset}(
          filter: { datetime_geq: $start, datetime_lt: $end }
          limit: ${limit}
          orderBy: [${orderBy}]
        ) { ${selection} }
      }
    }
  }`;
}

export async function fetchDatasetWindow(
  env: Env,
  capability: DatasetCapability,
  start: number,
  end: number,
): Promise<DatasetResult> {
  if (!capability.enabled) return { rows: [], queryCount: 0, saturated: false };
  const fields = selectedFields(capability);
  if (fields.length === 0) throw new Error(`${capability.dataset} 没有可查询字段`);
  const configured = Number(env.SAFE_PAGE_SIZE);
  const safeLimit = Number.isFinite(configured) ? configured : 250;
  const limit = Math.max(1, Math.min(capability.maxPageSize ?? safeLimit, safeLimit));
  const selections: Array<{ fields: string[]; dimensionType: RankingSelection["dimensionType"] | null }> = [
    { fields, dimensionType: null },
    ...rankingSelections(capability),
  ];
  const rows: Record<string, unknown>[] = [];
  let saturated = false;
  for (const selection of selections) {
    const query = buildDatasetQuery(capability.dataset, selection.fields, limit);
    const data = await graphql(env, query, {
      zoneTag: capability.zoneId,
      start: toIso(start),
      end: toIso(end),
    });
    const result = firstZoneNode(data, capability.dataset);
    if (Array.isArray(result)) {
      rows.push(...result.map((value) => ({
        ...asRecord(value),
        ...(selection.dimensionType ? { __observatoryDimensionType: selection.dimensionType } : {}),
      })));
      saturated ||= result.length >= limit;
    }
  }
  return {
    rows,
    queryCount: selections.length,
    saturated,
  };
}

async function graphql(env: Env, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(env.GRAPHQL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  let payload: GraphqlEnvelope;
  try {
    payload = await response.json<GraphqlEnvelope>();
  } catch (error) {
    throw new CloudflareApiError(`Cloudflare GraphQL 返回了无效 JSON：${sanitizeError(error)}`, retryAfter(response));
  }
  if (!response.ok || payload.errors?.length || !payload.data) {
    const message = payload.errors?.map((error) => error.message).filter(Boolean).join("；");
    throw new CloudflareApiError(message || `Cloudflare GraphQL 请求失败（HTTP ${response.status}）`, retryAfter(response), response.status);
  }
  return asRecord(payload.data);
}

function nestedSelection(fields: string[]): string {
  interface SelectionNode { children: Map<string, SelectionNode> }
  const root: SelectionNode = { children: new Map() };
  for (const field of fields) {
    let node = root;
    for (const segment of field.split("_")) {
      const child = node.children.get(segment) ?? { children: new Map<string, SelectionNode>() };
      node.children.set(segment, child);
      node = child;
    }
  }
  const render = (node: SelectionNode): string => [...node.children.entries()].map(([name, child]) => {
    const fieldName = name === "confidence" ? "confidence(level: 0.95)" : name;
    return child.children.size ? `${fieldName} { ${render(child)} }` : fieldName;
  }).join(" ");
  return render(root);
}

/** 高基数维度必须拆成独立 cube，否则路径、IP 与 UA 的笛卡尔组合会迅速耗尽页大小。 */
function rankingSelections(capability: DatasetCapability): RankingSelection[] {
  if (!GROUP_DATASETS.includes(capability.dataset as (typeof GROUP_DATASETS)[number])) return [];
  const available = new Set(capability.availableFields);
  const permitted = (field: string) => available.size === 0 || available.has(field);
  const time = permitted("dimensions_datetimeFiveMinutes") ? "dimensions_datetimeFiveMinutes" : null;
  const count = permitted("count") ? "count" : null;
  if (!time || !count) return [];
  const dimensions: Array<[string, RankingSelection["dimensionType"]]> = capability.dataset === "httpRequestsAdaptiveGroups"
    ? [["dimensions_clientRequestPath", "path"], ["dimensions_clientIP", "ip"], ["dimensions_clientAsn", "asn"], ["dimensions_userAgent", "userAgent"]]
    : [["dimensions_ruleId", "rule"]];
  return dimensions.filter(([dimension]) => permitted(dimension)).map(([dimension, dimensionType]) => ({
    fields: [time, dimension, count, ...(permitted("avg_sampleInterval") ? ["avg_sampleInterval"] : [])],
    dimensionType,
  }));
}

function firstZoneNode(data: Record<string, unknown>, key: string): unknown {
  const viewer = asRecord(data.viewer);
  const zones = viewer.zones;
  const first = Array.isArray(zones) ? asRecord(zones[0]) : {};
  return first[key] ?? (key === "settings" ? {} : []);
}

function normalizeFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((field) => {
      if (typeof field === "string") return [field];
      const record = asRecord(field);
      return asString(record.name) ? [String(record.name)] : [];
    });
  }
  return asStringArray(value);
}

function apiErrorMessage(payload: ApiEnvelope, status: number): string {
  return payload.errors?.map((error) => error.message).filter(Boolean).join("；") || `Cloudflare API 请求失败（HTTP ${status}）`;
}

function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get("Retry-After"));
  return Number.isFinite(value) && value > 0 ? value : null;
}
