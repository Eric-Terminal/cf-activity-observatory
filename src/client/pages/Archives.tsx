import { useQuery } from "@tanstack/react-query";
import { endpoints } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { Badge, ErrorState, formatBytes, formatTime, Loading } from "@/client/components/Ui";
import { rangeDates } from "@/client/components/TimeControls";

export function Archives() {
  const { t } = useI18n();
  const archives = useQuery({ queryKey: ["archives"], queryFn: endpoints.archives });
  const dates = rangeDates("24h");
  const requestExport = `/api/v1/export?${new URLSearchParams({ type: "requests", format: "csv", limit: "500", ...dates })}`;
  const securityExport = `/api/v1/export?${new URLSearchParams({ type: "security", format: "csv", limit: "500", ...dates })}`;
  return <>
    <PageHeader title={t("archives")} eyebrow="R2 · NDJSON.gz" />
    <Notice>{t("archiveNote")}</Notice>
    <section className="panel export-panel"><div><h2>{t("exportRecent")}</h2><p>{t("last24h")} · CSV · 500 {t("records")}</p></div><div className="button-row"><a className="button" href={requestExport}>{t("exportRequests")}</a><a className="button" href={securityExport}>{t("exportSecurity")}</a></div></section>
    <section className="panel table-panel">{archives.isLoading ? <Loading /> : archives.error ? <ErrorState error={archives.error} retry={() => void archives.refetch()} /> : <div className="table-scroll"><table><thead><tr><th>{t("dataset")}</th><th>{t("zone")}</th><th>{t("range")}</th><th>{t("records")}</th><th>{t("size")}</th><th>{t("verification")}</th><th /></tr></thead><tbody>{archives.data?.items.map((item) => <tr key={item.id}><td><code>{item.dataset}</code></td><td><code>{item.zone_id.slice(0, 10)}…</code></td><td><span className="resource-cell"><strong>{formatTime(item.range_start)}</strong><small>{formatTime(item.range_end)}</small></span></td><td>{item.record_count.toLocaleString()}</td><td>{formatBytes(item.compressed_bytes)}</td><td><Badge tone={item.status === "verified" ? "good" : "warn"}>{item.status === "verified" ? t("verified") : item.status}</Badge>{item.pruned_at && <small className="path-inline">{t("onlinePruned")}</small>}</td><td><a className="button small" href={`/api/v1/archives/${encodeURIComponent(item.id)}/download`}>{t("download")}</a></td></tr>)}</tbody></table>{!archives.data?.items.length && <div className="table-empty">{t("noData")}</div>}</div>}</section>
  </>;
}
