import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import * as echarts from "echarts";
import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import { endpoints, type MetricResponse } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { ErrorState, formatNumber, Loading } from "@/client/components/Ui";
import { Chart } from "@/client/components/Chart";
import { rangeDates, TimeControls, type RangeKey } from "@/client/components/TimeControls";

export function Overview() {
  const { t } = useI18n();
  const [range, setRange] = useState<RangeKey>("24h");
  const [zone, setZone] = useState("");
  const dates = rangeDates(range);
  const zones = useQuery({ queryKey: ["zones"], queryFn: endpoints.zones });
  const http = useMetric("http", "total", dates, zone);
  const security = useMetric("security", "securityAction", dates, zone);
  const countries = useMetric("http", "country", dates, zone);
  const hosts = useMetric("http", "host", dates, zone);
  const paths = useMetric("http", "path", dates, zone);
  const ips = useMetric("http", "ip", dates, zone);
  const asns = useMetric("http", "asn", dates, zone);
  const userAgents = useMetric("http", "userAgent", dates, zone);
  const health = useQuery({ queryKey: ["health"], queryFn: endpoints.health, refetchInterval: 60_000 });

  const requestTotal = metricTotal(http.data);
  const mitigatedTotal = metricTotal(security.data);
  const cards = [
    [t("estimatedRequests"), formatNumber(requestTotal), "blue"],
    [t("mitigatedRequests"), formatNumber(mitigatedTotal), "amber"],
    [t("mitigationRate"), requestTotal ? `${((mitigatedTotal / requestTotal) * 100).toFixed(2)}%` : "—", "violet"],
    [t("dataHealth"), t(health.data?.status ?? "unconfigured"), health.data?.status === "healthy" ? "green" : "red"],
  ];
  const loading = http.isLoading || security.isLoading || countries.isLoading || hosts.isLoading || paths.isLoading || ips.isLoading || asns.isLoading || userAgents.isLoading;
  const error = http.error ?? security.error ?? countries.error ?? hosts.error ?? paths.error ?? ips.error ?? asns.error ?? userAgents.error;
  return <>
    <PageHeader title={t("overview")} eyebrow="CF Activity Observatory" actions={<><select aria-label={t("zone")} value={zone} onChange={(event) => setZone(event.target.value)}><option value="">{t("allZones")}</option>{zones.data?.zones.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><TimeControls range={range} setRange={setRange} /></>} />
    <Notice><strong>{t("sampling")}</strong><span>{t("samplingHelp")}</span></Notice>
    {!zones.isLoading && !zones.data?.zones.length && <Notice tone="warning">{t("apiNotConfigured")}</Notice>}
    <section className="metric-grid">{cards.map(([label, value, tone]) => <article className={`metric-card ${tone}`} key={label}><span>{label}</span><strong>{value}</strong><small>{label === t("dataHealth") ? `${health.data?.gaps.length ?? 0} ${t("gaps")}` : t("adjustedTrend")}</small></article>)}</section>
    {loading ? <Loading /> : error ? <ErrorState error={error} /> : <div className="dashboard-grid">
      <article className="panel span-2"><PanelTitle title={t("requestTrend")} badge={t("adjustedTrend")} /><Chart option={trendOption(http.data, security.data)} /></article>
      <article className="panel"><PanelTitle title={t("securityActions")} badge={t("adjustedTrend")} /><Chart option={donutOption(security.data)} /></article>
      <article className="panel"><PanelTitle title={t("countryDistribution")} badge={t("adjustedTrend")} /><Chart option={countryMapOption(countries.data)} /></article>
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

function useMetric(kind: string, dimension: string, dates: { from: string; to: string }, zone: string) {
  return useQuery({
    queryKey: ["metrics", kind, dimension, dates.from.slice(0, 13), zone],
    queryFn: () => {
      const query = new URLSearchParams({ kind, dimension, ...dates });
      if (zone) query.set("zones", zone);
      return endpoints.metrics(query);
    },
  });
}

function metricTotal(data?: MetricResponse): number {
  return data?.series.reduce((total, series) => total + series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0), 0) ?? 0;
}

function PanelTitle({ title, badge }: { title: string; badge: string }) {
  return <header className="panel-title"><h2>{title}</h2><span className="badge blue">{badge}</span></header>;
}

function trendOption(http?: MetricResponse, security?: MetricResponse): Record<string, unknown> {
  const request = http?.series[0]?.points ?? [];
  const mitigated = security?.series.flatMap((series) => series.points) ?? [];
  const mitigatedByTime = new Map<number, number>();
  for (const point of mitigated) mitigatedByTime.set(point.bucket_start, (mitigatedByTime.get(point.bucket_start) ?? 0) + Number(point.estimated_count));
  return {
    tooltip: { trigger: "axis" }, legend: { bottom: 0 }, grid: { left: 54, right: 18, top: 18, bottom: 48 },
    xAxis: { type: "time", axisLabel: { hideOverlap: true } }, yAxis: { type: "value", splitLine: { lineStyle: { opacity: 0.18 } } },
    series: [
      { name: "Requests", type: "line", smooth: 0.25, showSymbol: false, areaStyle: { opacity: 0.1 }, data: request.map((point) => [point.bucket_start, Number(point.estimated_count)]) },
      { name: "Mitigated", type: "line", smooth: 0.25, showSymbol: false, data: [...mitigatedByTime].map(([time, value]) => [time, value]) },
    ],
  };
}

function donutOption(data?: MetricResponse): Record<string, unknown> {
  const values = data?.series.map((series) => ({ name: series.name || "unknown", value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0) })).sort((a, b) => b.value - a.value).slice(0, 8) ?? [];
  return { tooltip: { trigger: "item" }, legend: { type: "scroll", bottom: 0 }, series: [{ type: "pie", radius: ["48%", "72%"], center: ["50%", "43%"], padAngle: 2, itemStyle: { borderRadius: 5 }, label: { show: false }, data: values }] };
}

let mapRegistered = false;
function countryMapOption(data?: MetricResponse): Record<string, unknown> {
  if (!mapRegistered) {
    const geo = feature(world as never, world.objects.countries as never);
    echarts.registerMap("observatory-world", geo as never);
    mapRegistered = true;
  }
  const values = data?.series.map((series) => ({ name: series.name || "unknown", value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0) })) ?? [];
  const max = Math.max(...values.map((item) => item.value), 1);
  return { tooltip: { trigger: "item" }, visualMap: { min: 0, max, left: "center", bottom: 0, orient: "horizontal", calculable: true, inRange: { color: ["#dbe7ff", "#306df5", "#17367e"] }, textStyle: { fontSize: 9 } }, series: [{ type: "map", map: "observatory-world", roam: true, selectedMode: false, emphasis: { label: { show: false } }, data: values }] };
}

function Ranking({ title, data }: { title: string; data?: MetricResponse }) {
  const { t } = useI18n();
  const values = data?.series.map((series) => ({ name: series.name || t("unknown"), value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0) })).sort((left, right) => right.value - left.value).slice(0, 8) ?? [];
  return <article className="panel rank-panel"><PanelTitle title={title} badge={t("adjustedTrend")} />{values.length ? <ol>{values.map((item, index) => <li key={item.name}><span className="rank-index">{index + 1}</span><code title={item.name}>{item.name}</code><strong>{formatNumber(item.value)}</strong></li>)}</ol> : <div className="rank-empty">{t("noData")}</div>}</article>;
}
