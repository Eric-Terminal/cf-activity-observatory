import { afterEach, expect, it, vi } from "vitest";
import { loadMetricBundle, mergeMetrics } from "@/client/metrics";

afterEach(() => vi.unstubAllGlobals());

it("所有图表共用归档，基础总量不重复计算独立排名维度", async () => {
  const hour = Date.UTC(2026, 9, 10, 12);
  const common = { zone_id: "zone", metric_kind: "http", bucket_seconds: 300, sample_interval: 2, confidence_lower: null, confidence_upper: null, edge_response_bytes: 100, visits: null };
  const rows = [0, 1].flatMap((i) => [
    { ...common, bucket_start: hour + i * 300_000, dimension_type: null, dimension_value: null, host: "example.com", edge_status: 200, estimated_count: 10 },
    { ...common, bucket_start: hour + i * 300_000, dimension_type: "path", dimension_value: "/ranked", estimated_count: 8 },
  ]);
  const fetcher = vi.fn((url: string | URL) => Promise.resolve(String(url).includes("metric-archives?")
    ? Response.json({ items: [{ zone_id: "zone", metric_kind: "http", hour_start: hour, etag: "etag", compressed_bytes: 100 }] })
    : new Response(new Blob([JSON.stringify({ version: 1, zoneId: "zone", kind: "http", hourStart: hour, rows })]).stream().pipeThrough(new CompressionStream("gzip")))));
  vi.stubGlobal("fetch", fetcher);
  const bundle = await loadMetricBundle(new URLSearchParams({ kind: "http", from: new Date(hour).toISOString(), to: new Date(hour + 3_600_000).toISOString() }), new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(bundle.total.series[0].points.map((row) => row.estimated_count)).toEqual([10, 10]);
  expect(bundle.host.series[0].name).toBe("example.com");
  expect(bundle.path.series).toMatchObject([{ name: "/ranked", points: [{ estimated_count: 16 }] }]);
  expect(mergeMetrics({ bucketSeconds: 300, series: [] }, bundle.total)).toEqual(bundle.total);
});
