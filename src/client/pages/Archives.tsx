import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { endpoints } from "@/client/api";
import { exportArchive } from "@/client/archive";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { Badge, ErrorState, formatBytes, formatTime, Loading } from "@/client/components/Ui";
import { rangeDates } from "@/client/components/TimeControls";

export function Archives() {
  const { t } = useI18n();
  const archives = useQuery({ queryKey: ["archives"], queryFn: () => endpoints.archives() });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const dates = rangeDates("24h");
  async function runExport(type: "requests" | "security", format: "csv" | "json" | "ndjson") {
    setExporting(true);
    setExportError("");
    try { await exportArchive(type, format, new URLSearchParams({ limit: "500", ...dates })); }
    catch (error) { setExportError(error instanceof Error ? error.message : t("error")); }
    finally { setExporting(false); }
  }
  return <>
    <PageHeader title={t("archives")} eyebrow="R2 · NDJSON.gz" />
    <Notice>{t("archiveNote")}</Notice>
    {exportError && <Notice tone="warning">{exportError}</Notice>}
    <section className="panel export-panel"><div><h2>{t("exportRecent")}</h2><p>{t("last24h")} · 500 {t("records")} · {t("localExport")}</p></div><div className="button-row"><button disabled={exporting} onClick={() => void runExport("requests", "csv")}>{t("exportRequests")}</button><button disabled={exporting} onClick={() => void runExport("security", "csv")}>{t("exportSecurity")}</button><button disabled={exporting} onClick={() => void runExport("requests", "json")}>{t("requests")} · {t("exportJson")}</button><button disabled={exporting} onClick={() => void runExport("requests", "ndjson")}>{t("requests")} · {t("exportNdjson")}</button><button disabled={exporting} onClick={() => void runExport("security", "json")}>{t("security")} · {t("exportJson")}</button><button disabled={exporting} onClick={() => void runExport("security", "ndjson")}>{t("security")} · {t("exportNdjson")}</button></div></section>
    <section className="panel table-panel">{archives.isLoading ? <Loading /> : archives.error ? <ErrorState error={archives.error} retry={() => void archives.refetch()} /> : <div className="table-scroll"><table><thead><tr><th>{t("dataset")}</th><th>{t("zone")}</th><th>{t("range")}</th><th>{t("records")}</th><th>{t("size")}</th><th>{t("verification")}</th><th /></tr></thead><tbody>{archives.data?.items.map((item) => <tr key={item.id}><td><code>{item.dataset}</code></td><td><code>{item.zone_id.slice(0, 10)}…</code></td><td><span className="resource-cell"><strong>{formatTime(item.range_start)}</strong><small>{formatTime(item.range_end)}</small></span></td><td>{item.record_count.toLocaleString()}</td><td>{formatBytes(item.compressed_bytes)}</td><td><Badge tone={item.status === "verified" ? "good" : "warn"}>{item.status === "verified" ? t("verified") : item.status}</Badge>{item.pruned_at && <small className="path-inline">{t("onlinePruned")}</small>}</td><td><a className="button small" href={`/api/v1/archives/${encodeURIComponent(item.id)}/download`}>{t("download")}</a></td></tr>)}</tbody></table>{!archives.data?.items.length && <div className="table-empty">{t("noData")}</div>}</div>}</section>
  </>;
}
