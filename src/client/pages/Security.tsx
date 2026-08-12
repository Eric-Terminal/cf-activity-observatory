import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SecurityEvent } from "@/shared/contracts";
import { endpoints } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { Badge, ErrorState, Field, formatTime, Loading } from "@/client/components/Ui";
import { Chart } from "@/client/components/Chart";
import { rangeDates, TimeControls, type RangeKey } from "@/client/components/TimeControls";

export function Security() {
  const { t } = useI18n();
  const [range, setRange] = useState<RangeKey>("24h");
  const [selected, setSelected] = useState<SecurityEvent | null>(null);
  const [filters, setFilters] = useSearchParams();
  const [draft, setDraft] = useState({ action: filters.get("securityAction") ?? "", source: filters.get("securitySource") ?? "", ruleId: filters.get("ruleId") ?? "" });
  const dates = rangeDates(range);
  const metricParams = new URLSearchParams({ kind: "security", dimension: "securityAction", ...dates });
  const ruleParams = new URLSearchParams({ kind: "security", dimension: "rule", ...dates });
  const eventParams = new URLSearchParams({ ...dates, limit: "100" });
  for (const [key, value] of filters) if (value) eventParams.set(key, value);
  const metrics = useQuery({ queryKey: ["security-metrics", range], queryFn: () => endpoints.metrics(metricParams) });
  const rules = useQuery({ queryKey: ["security-rules", range], queryFn: () => endpoints.metrics(ruleParams) });
  const events = useQuery({ queryKey: ["security-events", range, filters.toString()], queryFn: () => endpoints.events(eventParams) });
  return <>
    <PageHeader title={t("security")} eyebrow={t("correctedSecurityTrend")} actions={<TimeControls range={range} setRange={setRange} />} />
    <Notice><strong>{t("sampling")}</strong><span>{t("samplingHelp")}</span></Notice>
    <form className="filter-panel" onSubmit={(event) => { event.preventDefault(); const next = new URLSearchParams(); if (draft.action) next.set("securityAction", draft.action); if (draft.source) next.set("securitySource", draft.source); if (draft.ruleId) next.set("ruleId", draft.ruleId); setFilters(next); }}><header><h2>{t("filters")}</h2><button type="button" className="ghost" onClick={() => { setDraft({ action: "", source: "", ruleId: "" }); setFilters(new URLSearchParams()); }}>{t("reset")}</button></header><div className="filter-grid"><label><span>{t("action")}</span><input value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></label><label><span>{t("source")}</span><input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label><label><span>{t("ruleId")}</span><input value={draft.ruleId} onChange={(event) => setDraft({ ...draft, ruleId: event.target.value })} /></label></div><footer><button className="primary" type="submit">{t("search")}</button></footer></form>
    <div className="dashboard-grid"><article className="panel"><header className="panel-title"><h2>{t("correctedSecurityTrend")}</h2><Badge tone="blue">{t("adjustedTrend")}</Badge></header>{metrics.isLoading ? <Loading /> : metrics.error ? <ErrorState error={metrics.error} /> : <Chart title={t("correctedSecurityTrend")} option={securityTrend(metrics.data)} />}</article><article className="panel"><header className="panel-title"><h2>{t("rule")}</h2><Badge tone="blue">{t("adjustedTrend")}</Badge></header>{rules.isLoading ? <Loading /> : rules.error ? <ErrorState error={rules.error} /> : <Chart title={t("rule")} option={ruleRanking(rules.data)} />}</article></div>
    <article className="panel table-panel"><header className="panel-title"><h2>{t("sampledEvents")}</h2><Badge tone="blue">{t("sampledDetail")}</Badge></header>{events.isLoading ? <Loading /> : events.error ? <ErrorState error={events.error} /> : <div className="table-scroll"><table><thead><tr><th>{t("occurredAt")}</th><th>{t("ip")}</th><th>{t("action")}</th><th>{t("source")}</th><th>{t("rule")}</th><th>{t("host")} / {t("path")}</th></tr></thead><tbody>{events.data?.items.map((event) => <tr key={event.id} onClick={() => setSelected(event)}><td>{formatTime(event.occurredAt)}</td><td><code>{event.clientIp ?? "—"}</code></td><td><Badge tone="warn">{event.action ?? "—"}</Badge></td><td>{event.source ?? "—"}</td><td><span className="resource-cell"><strong>{event.ruleId ?? "—"}</strong><small>{event.ruleDescription ?? ""}</small></span></td><td>{event.host ?? "—"}<small className="path-inline">{event.path}</small></td></tr>)}</tbody></table>{!events.data?.items.length && <div className="table-empty">{t("noData")}</div>}</div>}</article>
    {selected && <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}><aside className="drawer" role="dialog"><header><div><Badge tone="blue">{t("sampledDetail")}</Badge><h2>{selected.action ?? t("unknown")}</h2><p>{formatTime(selected.occurredAt)}</p></div><button className="icon-button" onClick={() => setSelected(null)}>×</button></header><section className="detail-section"><h3>{t("details")}</h3><dl><Field label={t("source")} value={selected.source} /><Field label={t("ruleId")} value={selected.ruleId} /><Field label={t("description")} value={selected.ruleDescription} wide /><Field label={t("rayId")} value={selected.rayId} /><Field label={t("ip")} value={selected.clientIp} /><Field label={t("country")} value={selected.country} /><Field label={t("host")} value={selected.host} /><Field label={t("path")} value={selected.path} /><Field label={t("query")} value={selected.query} wide /><Field label={t("userAgent")} value={selected.userAgent} wide /></dl>{selected.rayId && <Link className="primary link-button" to={`/requests?rayId=${encodeURIComponent(selected.rayId)}&${new URLSearchParams(dates)}`}>{t("relatedRequest")}</Link>}</section></aside></div>}
  </>;
}

function securityTrend(data: Awaited<ReturnType<typeof endpoints.metrics>> | undefined): Record<string, unknown> {
  return { tooltip: { trigger: "axis" }, legend: { bottom: 0 }, grid: { left: 54, right: 18, top: 18, bottom: 48 }, xAxis: { type: "time" }, yAxis: { type: "value", splitLine: { lineStyle: { opacity: 0.18 } } }, series: data?.series.map((series) => ({ name: series.name, type: "line", smooth: 0.5, smoothMonotone: "x", stack: "security", areaStyle: { opacity: 0.12 }, showSymbol: false, data: series.points.map((point) => [point.bucket_start, Number(point.estimated_count)]) })) ?? [] };
}

function ruleRanking(data: Awaited<ReturnType<typeof endpoints.metrics>> | undefined): Record<string, unknown> {
  const values = data?.series.map((series) => ({ name: series.name, value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0) })).sort((left, right) => right.value - left.value).slice(0, 10).reverse() ?? [];
  return { tooltip: { trigger: "axis" }, grid: { left: 100, right: 18, top: 12, bottom: 24 }, xAxis: { type: "value", splitLine: { lineStyle: { opacity: 0.18 } } }, yAxis: { type: "category", data: values.map((item) => item.name), axisLabel: { width: 82, overflow: "truncate" } }, series: [{ type: "bar", data: values.map((item) => item.value), itemStyle: { borderRadius: [0, 4, 4, 0] } }] };
}
