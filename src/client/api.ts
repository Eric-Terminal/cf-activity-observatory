import type {
  AccessIdentity,
  CollectorHealth,
  DatasetCapability,
  PaginatedResult,
  SampledRequest,
  SecurityEvent,
  ZoneSummary,
} from "@/shared/contracts";

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(payload?.error?.message ?? `HTTP ${response.status}`, payload?.error?.code ?? "HTTP_ERROR", response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json<T>();
}

export interface ZoneResponse {
  zones: ZoneSummary[];
  capabilities: DatasetCapability[];
}

export interface MetricRow {
  bucket_start: number;
  dimension: string | null;
  estimated_count: number;
  sample_interval: number | null;
  confidence_lower: number | null;
  confidence_upper: number | null;
  edge_response_bytes: number | null;
  visits: number | null;
}

export interface MetricResponse {
  bucketSeconds: number;
  series: Array<{ name: string; points: MetricRow[] }>;
}

export interface ArchiveItem {
  id: string;
  zone_id: string;
  dataset: string;
  range_start: number;
  range_end: number;
  r2_key: string;
  record_count: number;
  compressed_bytes: number;
  sha256: string;
  status: string;
  archived_at: number;
  verified_at: number | null;
  pruned_at: number | null;
}

export interface AppSettings {
  d1WarningBytes: number;
  estimatedDailyQueueOperations: number;
  safeDailyQueueOperations: number;
  capabilities: DatasetCapability[];
}

export const endpoints = {
  me: () => api<AccessIdentity>("/me"),
  zones: () => api<ZoneResponse>("/zones"),
  metrics: (query: URLSearchParams) => api<MetricResponse>(`/metrics?${query}`),
  requests: (query: URLSearchParams) => api<PaginatedResult<SampledRequest>>(`/requests?${query}`),
  request: (id: string) => api<SampledRequest>(`/requests/${encodeURIComponent(id)}`),
  events: (query: URLSearchParams) => api<PaginatedResult<SecurityEvent>>(`/security-events?${query}`),
  event: (id: string) => api<SecurityEvent>(`/security-events/${encodeURIComponent(id)}`),
  health: (query?: URLSearchParams) => api<CollectorHealth>(`/health${query?.size ? `?${query}` : ""}`),
  archives: () => api<{ items: ArchiveItem[] }>("/archives"),
  settings: () => api<AppSettings>("/settings"),
};
