export interface StoredMetric {
  [key: string]: string | number | null;
  zone_id: string;
  metric_kind: "http" | "security";
  bucket_start: number;
  bucket_seconds: number;
  dimension_signature: string;
  dimension_type: string | null;
  dimension_value: string | null;
  estimated_count: number;
  sample_interval: number | null;
  confidence_lower: number | null;
  confidence_upper: number | null;
  edge_response_bytes: number | null;
  visits: number | null;
}

export interface MetricArchive {
  zone_id: string;
  metric_kind: "http" | "security";
  hour_start: number;
  r2_key: string;
  etag: string;
  compressed_bytes: number;
}

export interface MetricDocument {
  version: 1;
  zoneId: string;
  kind: "http" | "security";
  hourStart: number;
  rows: StoredMetric[];
}

export const METRIC_COLUMNS: Record<string, string> = {
  country: "country", host: "host", method: "method", protocol: "protocol", status: "edge_status",
  originStatus: "origin_status", cache: "cache_status", securityAction: "security_action",
  securitySource: "security_source", requestSource: "request_source",
};
