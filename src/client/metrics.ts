import { useQuery } from "@tanstack/react-query";
import { api, type MetricResponse, type MetricRow } from "@/client/api";
import { METRIC_COLUMNS, type MetricArchive, type MetricDocument } from "@/shared/metrics";

type MetricBundle = Record<string, MetricResponse>;
type MetricAccumulator = MetricRow & { samples: number; sampleSum: number };
const DIMENSIONS = ["total", ...Object.keys(METRIC_COLUMNS), "path", "ip", "asn", "userAgent", "rule"];

export function useMetric(kind: string, dimension: string, dates: { from: string; to: string }, zones: string[] = []) {
  const selected = [...zones].sort().join(",");
  const query = new URLSearchParams({ kind, dimension, ...dates, ...(selected ? { zones: selected } : {}) });
  const from = Date.parse(dates.from);
  const to = Date.parse(dates.to);
  const legacy = useQuery({
    queryKey: ["legacy-metrics", kind, dimension, dates.from, dates.to, selected],
    queryFn: ({ signal }) => api<MetricResponse>(`/metrics?${query}`, { signal }),
  });
  const archives = useQuery({
    // 同一范围的所有图表共享一次读取与聚合，不能为十三张图反复下载同一批 R2 文件。
    queryKey: ["metric-archives", kind, dates.from, dates.to, selected],
    queryFn: ({ signal }) => loadMetricBundle(new URLSearchParams({ kind, ...dates, ...(selected ? { zones: selected } : {}) }), signal),
    gcTime: 60_000,
  });
  const bucket = metricBucket(dimension, from, to);
  return {
    isLoading: legacy.isLoading || archives.isLoading,
    error: legacy.error ?? archives.error,
    data: legacy.data && archives.data ? mergeMetrics(legacy.data, archives.data[dimension] ?? { bucketSeconds: bucket, series: [] }) : undefined,
  };
}

export async function loadMetricBundle(params: URLSearchParams, signal: AbortSignal): Promise<MetricBundle> {
  const { items } = await api<{ items: MetricArchive[] }>(`/metric-archives?${params}`, { signal });
  if (items.reduce((sum, item) => sum + item.compressed_bytes, 0) > 64 * 1024 * 1024) {
    throw new Error("所选趋势归档超过 64 MiB，请缩短时间范围或选择单个 Zone");
  }
  const from = Date.parse(params.get("from")!);
  const to = Date.parse(params.get("to")!);
  const buckets = new Map<string, Map<string, MetricAccumulator>>();
  let decodedBytes = 0;
  for (const item of items) {
    signal.throwIfAborted();
    const response = await fetch(`/api/v1/metric-archives/${item.zone_id}/${item.metric_kind}/${item.hour_start}?etag=${encodeURIComponent(item.etag)}`, { signal });
    if (!response.ok || !response.body) throw new Error(`读取趋势归档失败（HTTP ${response.status}），请刷新重试`);
    const reader = response.body.pipeThrough(new DecompressionStream("gzip")).getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        decodedBytes += value?.byteLength ?? 0;
        if (decodedBytes > 128 * 1024 * 1024) throw new Error("趋势解压量超过 128 MiB，请缩短范围或选择单个 Zone");
        text += decoder.decode(value, { stream: !done });
        if (done) break;
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const document = JSON.parse(text) as MetricDocument;
    if (document.version !== 1 || document.zoneId !== item.zone_id || document.kind !== item.metric_kind || document.hourStart !== item.hour_start || !Array.isArray(document.rows)) {
      throw new Error("趋势归档与清单不一致");
    }
    for (const row of document.rows) {
      if (row.bucket_start < from || row.bucket_start >= to) continue;
      for (const dimension of DIMENSIONS) {
        const high = ["path", "ip", "asn", "userAgent", "rule"].includes(dimension);
        if (high ? row.dimension_type !== dimension : row.dimension_type !== null) continue;
        const seconds = metricBucket(dimension, from, to);
        if (row.bucket_seconds > seconds) continue;
        const name = dimension === "total" ? "" : String(high ? row.dimension_value ?? "未知" : row[METRIC_COLUMNS[dimension]] ?? "未知");
        const time = Math.floor(row.bucket_start / (seconds * 1000)) * seconds * 1000;
        const group = buckets.get(dimension) ?? new Map<string, MetricAccumulator>();
        const key = JSON.stringify([name, time]);
        const point = group.get(key) ?? { bucket_start: time, dimension: name, estimated_count: 0,
          sample_interval: null, confidence_lower: null, confidence_upper: null, edge_response_bytes: null, visits: null, samples: 0, sampleSum: 0 };
        point.estimated_count += row.estimated_count;
        for (const field of ["confidence_lower", "confidence_upper", "edge_response_bytes", "visits"] as const) {
          if (row[field] !== null) point[field] = (point[field] ?? 0) + row[field];
        }
        if (row.sample_interval !== null) { point.sampleSum += row.sample_interval; point.samples += 1; }
        point.sample_interval = point.samples ? point.sampleSum / point.samples : null;
        group.set(key, point);
        buckets.set(dimension, group);
      }
    }
  }
  return Object.fromEntries(DIMENSIONS.map((dimension) => {
    const series = new Map<string, MetricRow[]>();
    for (const point of buckets.get(dimension)?.values() ?? []) {
      const name = point.dimension ?? "未知";
      const points = series.get(name) ?? [];
      points.push(point);
      series.set(name, points);
    }
    return [dimension, { bucketSeconds: metricBucket(dimension, from, to), series: [...series].map(([name, points]) => ({ name, points: points.sort((a, b) => a.bucket_start - b.bucket_start) })) }];
  }));
}

function metricBucket(dimension: string, from: number, to: number): number {
  return ["path", "ip", "asn", "userAgent", "rule"].includes(dimension) ? 3600 : to - from <= 7 * 86_400_000 ? 300 : to - from <= 180 * 86_400_000 ? 3600 : 86400;
}

export function mergeMetrics(legacy: MetricResponse, archived: MetricResponse): MetricResponse {
  const series = new Map<string, Map<number, MetricRow>>();
  for (const source of [legacy, archived]) for (const group of source.series) {
    const points = series.get(group.name) ?? new Map<number, MetricRow>();
    for (const row of group.points) {
      const old = points.get(row.bucket_start);
      if (!old) points.set(row.bucket_start, { ...row });
      else {
        old.estimated_count += row.estimated_count;
        for (const field of ["confidence_lower", "confidence_upper", "edge_response_bytes", "visits"] as const) {
          if (row[field] !== null) old[field] = (old[field] ?? 0) + row[field];
        }
        old.sample_interval = old.sample_interval === null ? row.sample_interval : row.sample_interval === null ? old.sample_interval : (old.sample_interval + row.sample_interval) / 2;
      }
    }
    series.set(group.name, points);
  }
  return { bucketSeconds: legacy.bucketSeconds, series: [...series].map(([name, points]) => ({ name, points: [...points.values()].sort((a, b) => a.bucket_start - b.bucket_start) })) };
}
