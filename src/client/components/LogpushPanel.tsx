import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Badge, ErrorState, formatBytes, formatTime, Loading } from "@/client/components/Ui";
import { Notice } from "@/client/components/Layout";
import type { LogpushDataset, LogpushSource } from "@/shared/logpush";

interface LogpushConfig {
  bucket: string;
  sources: LogpushSource[];
  fields: Record<LogpushDataset, string[]>;
}

export function LogpushPanel() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ["logpush"], queryFn: () => api<LogpushConfig>("/logpush"), refetchInterval: 30_000 });
  return <section className="settings-section">
    <header><div><h2>{t("logIngestion")}</h2><p>{t("logpushHelp")}</p></div><Badge tone="blue">Logpush → R2</Badge></header>
    {query.isLoading ? <Loading /> : query.error ? <ErrorState error={query.error} /> : <>
      <Notice>{t("logpushBoundary")}</Notice>
      <div className="source-grid">{query.data && query.data.sources.map((source) => <SourceCard key={`${source.zoneId}:${source.dataset}`} source={source} bucket={query.data.bucket} fields={query.data.fields[source.dataset]} now={query.dataUpdatedAt} />)}</div>
      {!query.data?.sources.length && <p className="table-empty">{t("apiNotConfigured")}</p>}
    </>}
  </section>;
}

function SourceCard({ source, bucket, fields, now }: { source: LogpushSource; bucket: string; fields: string[]; now: number }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (action: "activate" | "deactivate" | "reconcile") => api(`/logpush/${source.zoneId}/${source.dataset}/${action}`, { method: "POST" }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["logpush"] }); await client.invalidateQueries({ queryKey: ["health"] }); },
  });
  const recent = source.lastReceivedAt !== null && now - source.lastReceivedAt < 86_400_000;
  return <article className="source-card">
    <header><div><strong>{source.zoneName}</strong><code>{source.dataset}</code></div><Badge tone={source.activatedAt ? "good" : recent ? "blue" : "neutral"}>{source.activatedAt ? "Logpush" : t("graphqlSource")}</Badge></header>
    <div className="source-stats"><div><span>{t("indexedFiles")}</span><strong>{source.files.toLocaleString()}</strong></div><div><span>{t("size")}</span><strong>{formatBytes(source.bytes)}</strong></div></div>
    <p className="source-received">{source.lastReceivedAt ? `${t("lastDelivery")} · ${formatTime(source.lastReceivedAt)}` : t("awaitingLogs")}</p>
    {source.activatedAt && !recent && <Notice tone="warning">{t("deliveryStale")}</Notice>}
    <details className="source-setup"><summary>{t("connectionDetails")}</summary>
      <dl><dt>{t("bucket")}</dt><dd><code>{bucket}</code></dd><dt>{t("objectPrefix")}</dt><dd><code>{source.prefix}{"{DATE}"}</code></dd></dl>
      <p>{t("logpushSetupHelp")}</p>
      <button onClick={() => { void navigator.clipboard.writeText(`${source.prefix}{DATE}`).then(() => { setCopied(true); setCopyError(undefined); }).catch((error: unknown) => setCopyError(String(error))); }}>{copied ? t("copied") : t("copyPrefix")}</button>
      {copyError && <p role="alert">{copyError}</p>}
      <details><summary>{t("deliveryFields")}</summary><p className="source-fields">{fields.join(", ")}</p></details>
      <a className="button" href={`https://dash.cloudflare.com/${source.accountId ?? ""}/${source.zoneName}/analytics/logs`} target="_blank" rel="noreferrer">{t("openCloudflare")}</a>
    </details>
    {mutation.error && <p className="form-error">{mutation.error.message}</p>}
    {mutation.isSuccess && mutation.variables === "reconcile" && <p role="status">{t("reindexQueued")}</p>}
    <footer><button disabled={mutation.isPending} onClick={() => mutation.mutate("reconcile")}>{t("reindex")}</button>
      <button className={source.activatedAt ? "ghost" : "primary"} disabled={mutation.isPending || (!source.activatedAt && !recent)} onClick={() => mutation.mutate(source.activatedAt ? "deactivate" : "activate")}>{t(source.activatedAt ? "restoreGraphql" : "activateLogpush")}</button>
    </footer>
  </article>;
}
