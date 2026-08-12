import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { endpoints, type MetricResponse } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { ErrorState, formatNumber, Loading } from "@/client/components/Ui";
import { Chart } from "@/client/components/Chart";
import { rangeDates, TimeControls, type RangeKey } from "@/client/components/TimeControls";
import { countryMapOption } from "@/client/worldMap";

export function Overview() {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<RangeKey>("24h");
  const [selectedZones, setSelectedZones] = useState<string[]>([]);
  const dates = rangeDates(range);
  const duration = Date.parse(dates.to) - Date.parse(dates.from);
  const previousDates = { from: new Date(Date.parse(dates.from) - duration).toISOString(), to: dates.from };
  const zones = useQuery({ queryKey: ["zones"], queryFn: endpoints.zones });
  const http = useMetric("http", "total", dates, selectedZones);
  const security = useMetric("security", "securityAction", dates, selectedZones);
  const previousHttp = useMetric("http", "total", previousDates, selectedZones);
  const previousSecurity = useMetric("security", "securityAction", previousDates, selectedZones);
  const edgeStatuses = useMetric("http", "status", dates, selectedZones);
  const originStatuses = useMetric("http", "originStatus", dates, selectedZones);
  const cacheStatuses = useMetric("http", "cache", dates, selectedZones);
  const countries = useMetric("http", "country", dates, selectedZones);
  const hosts = useMetric("http", "host", dates, selectedZones);
  const paths = useMetric("http", "path", dates, selectedZones);
  const ips = useMetric("http", "ip", dates, selectedZones);
  const asns = useMetric("http", "asn", dates, selectedZones);
  const userAgents = useMetric("http", "userAgent", dates, selectedZones);
  const health = useQuery({
    queryKey: ["health", range, zoneKey(selectedZones)],
    queryFn: () => {
      const query = new URLSearchParams({ ...dates });
      const selected = zoneKey(selectedZones);
      if (selected) query.set("zones", selected);
      return endpoints.health(query);
    },
    refetchInterval: 60_000,
  });

  const requestTotal = metricTotal(http.data);
  const mitigatedTotal = metricTotal(security.data);
  const previousRequestTotal = metricTotal(previousHttp.data);
  const previousMitigatedTotal = metricTotal(previousSecurity.data);
  const edgeErrors = matchingMetricTotal(edgeStatuses.data, (name) => /^5\d\d$/.test(name));
  const originResponses = matchingMetricTotal(originStatuses.data, (name) => /^\d{3}$/.test(name));
  const originErrors = matchingMetricTotal(originStatuses.data, (name) => /^5\d\d$/.test(name));
  const cacheResponses = metricTotal(cacheStatuses.data);
  const cacheHits = matchingMetricTotal(cacheStatuses.data, (name) => /^(hit|stale|revalidated)$/i.test(name));
  const collectorIssues = (health.data?.dlqJobs ?? 0) + (health.data?.failingCursors ?? 0);
  const cards = [
    [t("estimatedRequests"), formatNumber(requestTotal), "blue", periodDelta(requestTotal, previousRequestTotal, t("vsPrevious"))],
    [t("mitigatedRequests"), formatNumber(mitigatedTotal), "amber", periodDelta(mitigatedTotal, previousMitigatedTotal, t("vsPrevious"))],
    [t("mitigationRate"), requestTotal ? `${((mitigatedTotal / requestTotal) * 100).toFixed(2)}%` : "—", "violet", t("adjustedTrend")],
    [t("edgeErrorRate"), requestTotal ? `${((edgeErrors / requestTotal) * 100).toFixed(2)}%` : "—", "red", t("adjustedTrend")],
    [t("originErrorRate"), originResponses ? `${((originErrors / originResponses) * 100).toFixed(2)}%` : "—", "red", t("adjustedTrend")],
    [t("cacheHitRate"), cacheResponses ? `${((cacheHits / cacheResponses) * 100).toFixed(2)}%` : "—", "green", t("adjustedTrend")],
    [t("dataHealth"), health.data?.dataStatus === "complete" ? t("complete") : health.data?.dataStatus === "gaps" ? t("gapsDetected") : t("unconfigured"), health.data?.dataStatus === "complete" ? "green" : "red", health.data?.dataStatus === "complete" ? t("selectedRangeComplete") : `${health.data?.gaps.length ?? 0} ${t("gaps")}`],
    [t("collectionHealth"), t(health.data?.collectorStatus ?? "unconfigured"), health.data?.collectorStatus === "healthy" ? "green" : "amber", collectorIssues ? `${health.data?.dlqJobs ?? 0} ${t("dlqJobs")} · ${health.data?.failingCursors ?? 0} ${t("failingCursors")}` : t("noCollectorIssues")],
  ];
  const loading = http.isLoading || security.isLoading || previousHttp.isLoading || previousSecurity.isLoading || edgeStatuses.isLoading || originStatuses.isLoading || cacheStatuses.isLoading || countries.isLoading || hosts.isLoading || paths.isLoading || ips.isLoading || asns.isLoading || userAgents.isLoading;
  const error = http.error ?? security.error ?? previousHttp.error ?? previousSecurity.error ?? edgeStatuses.error ?? originStatuses.error ?? cacheStatuses.error ?? countries.error ?? hosts.error ?? paths.error ?? ips.error ?? asns.error ?? userAgents.error;
  return <>
    <PageHeader title={t("overview")} eyebrow="CF Activity Observatory" actions={<><ZonePicker zones={zones.data?.zones.filter((item) => item.enabled) ?? []} selected={selectedZones} setSelected={setSelectedZones} /><TimeControls range={range} setRange={setRange} /></>} />
    <Notice><strong>{t("sampling")}</strong><span>{t("samplingHelp")}</span></Notice>
    {!zones.isLoading && !zones.data?.zones.length && <Notice tone="warning">{t("apiNotConfigured")}</Notice>}
    <section className="metric-grid">{cards.map(([label, value, tone, detail]) => <article className={`metric-card ${tone}`} key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>)}</section>
    {loading ? <Loading /> : error ? <ErrorState error={error} /> : <div className="dashboard-grid">
      <article className="panel span-2"><PanelTitle title={t("requestTrend")} badge={metricQuality(http.data, t("averageSampleInterval"), t("confidenceAvailable"))} /><Chart title={t("requestTrend")} option={trendOption(http.data, security.data, t("estimatedRequests"), t("mitigatedRequests"))} /></article>
      <article className="panel"><PanelTitle title={t("securityActions")} badge={t("adjustedTrend")} /><Chart title={t("securityActions")} option={donutOption(security.data)} /></article>
      <article className="panel"><PanelTitle title={t("countryDistribution")} badge={t("adjustedTrend")} /><Chart title={t("countryDistribution")} option={countryMapOption(countries.data, locale)} /></article>
      <article className="panel"><PanelTitle title={t("statusTrend")} badge={t("adjustedTrend")} /><Chart title={t("statusTrend")} option={stackedOption(edgeStatuses.data)} /></article>
      <article className="panel"><PanelTitle title={t("cacheTrend")} badge={t("adjustedTrend")} /><Chart title={t("cacheTrend")} option={stackedOption(cacheStatuses.data)} /></article>
      <section className="rank-grid span-2">
        <Ranking title={t("topHosts")} data={hosts.data} />
        <Ranking title={t("topPaths")} data={paths.data} />
        <Ranking title={t("topIps")} data={ips.data} />
        <Ranking title={t("topAsns")} data={asns.data} />
        <Ranking title={t("topUserAgents")} data={userAgents.data} />
      </section>
    </div>}
  </>;
}

function useMetric(kind: string, dimension: string, dates: { from: string; to: string }, zones: string[]) {
  const selected = zoneKey(zones);
  return useQuery({
    queryKey: ["metrics", kind, dimension, dates.from.slice(0, 13), selected],
    queryFn: () => {
      const query = new URLSearchParams({ kind, dimension, ...dates });
      if (selected) query.set("zones", selected);
      return endpoints.metrics(query);
    },
  });
}

function zoneKey(zones: string[]): string {
  return zones.join(",");
}

function ZonePicker({ zones, selected, setSelected }: { zones: Array<{ id: string; name: string }>; selected: string[]; setSelected: (ids: string[]) => void }) {
  const { t } = useI18n();
  return <details className="zone-picker"><summary>{selected.length ? `${selected.length} Zone` : t("allZones")}</summary><div><button type="button" className="ghost" onClick={() => setSelected([])}>{t("allZones")}</button>{zones.map((zone) => <label key={zone.id}><input type="checkbox" checked={selected.includes(zone.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, zone.id] : selected.filter((id) => id !== zone.id))} /><span>{zone.name}</span></label>)}</div></details>;
}

function metricTotal(data?: MetricResponse): number {
  return data?.series.reduce((total, series) => total + series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0), 0) ?? 0;
}

function matchingMetricTotal(data: MetricResponse | undefined, predicate: (name: string) => boolean): number {
  return data?.series.filter((series) => predicate(series.name)).reduce((total, series) => total + series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0), 0) ?? 0;
}

function periodDelta(current: number, previous: number, label: string): string {
  if (!previous) return label;
  const value = ((current - previous) / previous) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}% ${label}`;
}

function PanelTitle({ title, badge }: { title: string; badge: string }) {
  return <header className="panel-title"><h2>{title}</h2><span className="badge blue">{badge}</span></header>;
}

function trendOption(http: MetricResponse | undefined, security: MetricResponse | undefined, requestName: string, mitigatedName: string): Record<string, unknown> {
  const request = http?.series[0]?.points ?? [];
  const mitigated = security?.series.flatMap((series) => series.points) ?? [];
  const mitigatedByTime = new Map<number, number>();
  for (const point of mitigated) mitigatedByTime.set(point.bucket_start, (mitigatedByTime.get(point.bucket_start) ?? 0) + Number(point.estimated_count));
  return {
    tooltip: { trigger: "axis" }, legend: { bottom: 0 }, grid: { left: 54, right: 18, top: 18, bottom: 48 },
    xAxis: { type: "time", axisLabel: { hideOverlap: true } }, yAxis: { type: "value", splitLine: { lineStyle: { opacity: 0.18 } } },
    series: [
      { name: requestName, type: "line", smooth: 0.5, smoothMonotone: "x", showSymbol: false, areaStyle: { opacity: 0.1 }, data: request.map((point) => [point.bucket_start, Number(point.estimated_count)]) },
      { name: mitigatedName, type: "line", smooth: 0.5, smoothMonotone: "x", showSymbol: false, data: [...mitigatedByTime].map(([time, value]) => [time, value]) },
    ],
  };
}

function stackedOption(data?: MetricResponse): Record<string, unknown> {
  return {
    tooltip: { trigger: "axis" }, legend: { type: "scroll", bottom: 0 }, grid: { left: 54, right: 18, top: 18, bottom: 48 },
    xAxis: { type: "time", axisLabel: { hideOverlap: true } }, yAxis: { type: "value", splitLine: { lineStyle: { opacity: 0.18 } } },
    series: data?.series.filter((series) => series.name !== "未知" && series.name !== "Unknown").map((series) => ({ name: series.name, type: "line", smooth: 0.5, smoothMonotone: "x", stack: "total", areaStyle: { opacity: 0.18 }, showSymbol: false, data: series.points.map((point) => [point.bucket_start, Number(point.estimated_count)]) })) ?? [],
  };
}

function metricQuality(data: MetricResponse | undefined, sampleLabel: string, confidenceLabel: string): string {
  const points = data?.series.flatMap((series) => series.points) ?? [];
  const intervals = points.map((point) => Number(point.sample_interval)).filter(Number.isFinite);
  const average = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null;
  const confidence = points.some((point) => point.confidence_lower !== null && point.confidence_upper !== null);
  return `${average === null ? sampleLabel : `${sampleLabel} ×${average.toFixed(2)}`}${confidence ? ` · ${confidenceLabel}` : ""}`;
}

function donutOption(data?: MetricResponse): Record<string, unknown> {
  const values = data?.series.map((series) => ({ name: series.name || "unknown", value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0) })).sort((a, b) => b.value - a.value).slice(0, 8) ?? [];
  return { tooltip: { trigger: "item" }, legend: { type: "scroll", bottom: 0 }, series: [{ type: "pie", radius: ["48%", "72%"], center: ["50%", "43%"], padAngle: 2, itemStyle: { borderRadius: 5 }, label: { show: false }, data: values }] };
}

function Ranking({ title, data }: { title: string; data?: MetricResponse }) {
  const { t } = useI18n();
  const values = data?.series.map((series) => ({ name: series.name || t("unknown"), value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0) })).sort((left, right) => right.value - left.value).slice(0, 8) ?? [];
  return <article className="panel rank-panel"><PanelTitle title={title} badge={t("adjustedTrend")} />{values.length ? <ol>{values.map((item, index) => <li key={item.name}><span className="rank-index">{index + 1}</span><code title={item.name}>{item.name}</code><strong>{formatNumber(item.value)}</strong></li>)}</ol> : <div className="rank-empty">{t("noData")}</div>}</article>;
}
