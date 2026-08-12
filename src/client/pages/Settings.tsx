import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ZoneSummary } from "@/shared/contracts";
import { api, endpoints } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { Badge, ErrorState, formatBytes, formatTime, Loading } from "@/client/components/Ui";

interface SmtpState {
  enabled: boolean;
  host: string;
  port: 465 | 587;
  tlsMode: "implicit" | "starttls";
  authMethod: "plain" | "login";
  username: string;
  password: string;
  senderName: string;
  senderAddress: string;
  recipients: string;
  subjectPrefix: string;
}

interface SmtpResponse {
  configured: boolean;
  enabled: boolean;
  host?: string;
  port?: 465 | 587;
  tlsMode?: "implicit" | "starttls";
  authMethod?: "plain" | "login";
  username?: string;
  senderName?: string;
  senderAddress?: string;
  recipients?: string[];
  subjectPrefix?: string;
  updatedAt?: number;
}

const initialSmtp: SmtpState = { enabled: false, host: "", port: 465, tlsMode: "implicit", authMethod: "plain", username: "", password: "", senderName: "CF Activity Observatory", senderAddress: "", recipients: "", subjectPrefix: "[CF Activity Observatory]" };

export function Settings() {
  const { t } = useI18n();
  const client = useQueryClient();
  const zones = useQuery({ queryKey: ["zones"], queryFn: endpoints.zones });
  const settings = useQuery({ queryKey: ["settings"], queryFn: endpoints.settings });
  const health = useQuery({ queryKey: ["health"], queryFn: () => endpoints.health(), refetchInterval: 30_000 });
  const discover = useMutation({ mutationFn: () => api("/zones/discover", { method: "POST" }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["zones"] }); await client.invalidateQueries({ queryKey: ["settings"] }); } });
  return <>
    <PageHeader title={t("settings")} eyebrow="Cloudflare Workers · D1 · R2 · Queues" actions={<button className="primary" onClick={() => discover.mutate()} disabled={discover.isPending}>{discover.isPending ? t("discovering") : t("discoverZones")}</button>} />
    {discover.error && <Notice tone="warning">{discover.error.message}</Notice>}
    {(zones.isLoading || settings.isLoading) ? <Loading /> : zones.error || settings.error ? <ErrorState error={zones.error ?? settings.error} /> : <>
      <section className="settings-section"><header><div><h2>{t("zone")}</h2><p>{t("queueOperations")}: {settings.data?.estimatedDailyQueueOperations.toLocaleString()} / {settings.data?.safeDailyQueueOperations.toLocaleString()}</p></div></header><div className="zone-list">{zones.data?.zones.map((zone) => <ZoneCard key={zone.id} zone={zone} />)}{!zones.data?.zones.length && <div className="table-empty">{t("apiNotConfigured")}</div>}</div></section>
      <section className="settings-section"><header><div><h2>{t("capabilities")}</h2><p>{t("samplingHelp")}</p></div></header><div className="capability-grid">{zones.data?.capabilities.map((capability) => <article key={`${capability.zoneId}:${capability.dataset}`}><header><code>{capability.dataset}</code><Badge tone={capability.enabled ? "good" : "warn"}>{capability.enabled ? t("available") : t("unavailable")}</Badge></header><dl><dt>{t("fields")}</dt><dd>{capability.availableFields.length}</dd><dt>{t("maxHistory")}</dt><dd>{capability.notOlderThan ? `${Math.round(capability.notOlderThan / 86400)} ${t("days")}` : "—"}</dd><dt>maxPageSize</dt><dd>{capability.maxPageSize ?? "—"}</dd></dl></article>)}</div></section>
    </>}
    <HealthPanel health={health} />
    <SmtpPanel />
  </>;
}

function ZoneCard({ zone }: { zone: ZoneSummary }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [form, setForm] = useState({ enabled: zone.enabled, pollIntervalMinutes: zone.pollIntervalMinutes, detailRetentionDays: zone.detailRetentionDays });
  const save = useMutation({ mutationFn: () => api(`/zones/${zone.id}`, { method: "PUT", body: JSON.stringify(form) }), onSuccess: async () => client.invalidateQueries({ queryKey: ["zones"] }) });
  return <article className="zone-card"><header><div><strong>{zone.name}</strong><code>{zone.id}</code></div><label className="switch"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span /></label></header><div className="inline-fields"><label><span>{t("pollInterval")}</span><div><input type="number" min="1" max="1440" value={form.pollIntervalMinutes} onChange={(event) => setForm({ ...form, pollIntervalMinutes: Number(event.target.value) })} /><em>{t("minutes")}</em></div></label><label><span>{t("retention")}</span><div><input type="number" min="7" max="3650" value={form.detailRetentionDays} onChange={(event) => setForm({ ...form, detailRetentionDays: Number(event.target.value) })} /><em>{t("days")}</em></div></label></div>{save.error && <p className="form-error">{save.error.message}</p>}<footer><button onClick={() => save.mutate()} disabled={save.isPending}>{save.isSuccess ? t("saved") : t("save")}</button></footer></article>;
}

function HealthPanel({ health }: { health: ReturnType<typeof useQuery<Awaited<ReturnType<typeof endpoints.health>>>> }) {
  const { t } = useI18n();
  const data = health.data;
  return <section className="settings-section"><header><div><h2>{t("usage")}</h2><p>UTC {new Date().toISOString().slice(0, 10)}</p></div>{data && <Badge tone={data.status === "healthy" ? "good" : "warn"}>{t(data.status)}</Badge>}</header>{health.isLoading ? <Loading /> : health.error ? <ErrorState error={health.error} /> : data && <><div className="usage-grid"><Usage label={t("graphqlQueries")} value={data.usageToday.graphqlQueries.toLocaleString()} /><Usage label={t("queueMessages")} value={data.usageToday.queueMessages.toLocaleString()} /><Usage label={t("d1Reads")} value={data.usageToday.d1RowsRead.toLocaleString()} /><Usage label={t("d1Writes")} value={data.usageToday.d1RowsWritten.toLocaleString()} /><Usage label={t("d1Storage")} value={`${formatBytes(data.usageToday.d1SizeAfter)} / ${formatBytes(data.d1WarningBytes)}`} /><Usage label={t("r2Written")} value={formatBytes(data.usageToday.r2BytesWritten)} /></div><div className="table-scroll"><table><thead><tr><th>{t("zone")}</th><th>{t("dataset")}</th><th>{t("lag")}</th><th>{t("lastSuccess")}</th><th>{t("failures")}</th></tr></thead><tbody>{data.cursors.map((cursor) => <tr key={`${cursor.zoneId}:${cursor.dataset}`}><td>{cursor.zoneName}</td><td><code>{cursor.dataset}</code></td><td>{formatTime(cursor.cursorAt)}</td><td>{formatTime(cursor.lastSuccessAt)}</td><td><Badge tone={cursor.consecutiveFailures ? "warn" : "good"}>{cursor.consecutiveFailures}</Badge></td></tr>)}</tbody></table></div>{data.dlqJobs > 0 && <Notice tone="warning"><strong>{data.dlqJobs} {t("dlqJobs")}</strong></Notice>}{data.failingCursors > 0 && <Notice tone="warning"><strong>{data.failingCursors} {t("failingCursors")}</strong></Notice>}{data.gaps.length > 0 && <Notice tone="warning"><strong>{data.gaps.length} {t("gaps")}</strong><span>{data.gaps[0]?.reason}</span></Notice>}{data.historicalGaps.length > 0 && <Notice><strong>{data.historicalGaps.length} {t("historicalGaps")}</strong><span>{t("historicalGapHelp")}</span></Notice>}</>}</section>;
}

function Usage({ label, value }: { label: string; value: string }) { return <article><span>{label}</span><strong>{value}</strong></article>; }

function SmtpPanel() {
  const { t } = useI18n();
  const config = useQuery({ queryKey: ["smtp"], queryFn: () => api<SmtpResponse>("/settings/smtp") });
  if (config.isLoading) return <section className="settings-section"><Loading /></section>;
  if (config.error) return <section className="settings-section"><ErrorState error={config.error} /></section>;
  return <SmtpForm key={config.data?.updatedAt ?? 0} initial={smtpInitial(config.data)} configured={Boolean(config.data?.configured)} refresh={() => void config.refetch()} title={t("smtp")} help={t("smtpHelp")} />;
}

function SmtpForm({ initial, configured, refresh, title, help }: { initial: SmtpState; configured: boolean; refresh: () => void; title: string; help: string }) {
  const { t } = useI18n();
  const [form, setForm] = useState(initial);
  const save = useMutation({ mutationFn: () => api("/settings/smtp", { method: "PUT", body: JSON.stringify({ ...form, recipients: form.recipients.split(",").map((item) => item.trim()).filter(Boolean), password: form.password || undefined }) }), onSuccess: refresh });
  const clear = useMutation({ mutationFn: () => api("/settings/smtp", { method: "PUT", body: JSON.stringify({ ...form, recipients: form.recipients.split(",").map((item) => item.trim()).filter(Boolean), password: undefined, clearPassword: true }) }), onSuccess: refresh });
  const test = useMutation({ mutationFn: () => api("/settings/smtp/test", { method: "POST" }) });
  function update<K extends keyof SmtpState>(key: K, value: SmtpState[K]) { setForm((current) => ({ ...current, [key]: value })); }
  return <section className="settings-section"><header><div><h2>{title}</h2><p>{help}</p></div><label className="switch"><input type="checkbox" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span /></label></header><div className="form-grid"><label><span>{t("server")}</span><input value={form.host} onChange={(event) => update("host", event.target.value)} /></label><label><span>{t("port")}</span><select value={form.port} onChange={(event) => { const port = Number(event.target.value) as 465 | 587; update("port", port); update("tlsMode", port === 465 ? "implicit" : "starttls"); }}><option value="465">465 · TLS</option><option value="587">587 · STARTTLS</option></select></label><label><span>{t("authMethod")}</span><select value={form.authMethod} onChange={(event) => update("authMethod", event.target.value as "plain" | "login")}><option value="plain">AUTH PLAIN</option><option value="login">AUTH LOGIN</option></select></label><label><span>{t("username")}</span><input value={form.username} onChange={(event) => update("username", event.target.value)} /></label><label><span>{t("password")}</span><input type="password" value={form.password} placeholder={t("passwordHint")} onChange={(event) => update("password", event.target.value)} /></label><label><span>{t("senderName")}</span><input value={form.senderName} onChange={(event) => update("senderName", event.target.value)} /></label><label><span>{t("sender")}</span><input type="email" value={form.senderAddress} onChange={(event) => update("senderAddress", event.target.value)} /></label><label><span>{t("recipients")}</span><input value={form.recipients} onChange={(event) => update("recipients", event.target.value)} /></label><label><span>{t("subjectPrefix")}</span><input value={form.subjectPrefix} onChange={(event) => update("subjectPrefix", event.target.value)} /></label></div>{(save.error || test.error || clear.error) && <p className="form-error">{(save.error ?? test.error ?? clear.error)?.message}</p>}<div className="button-row"><button onClick={() => save.mutate()} disabled={save.isPending}>{save.isSuccess ? t("saved") : t("save")}</button><button className="primary" onClick={() => test.mutate()} disabled={test.isPending}>{test.isSuccess ? t("saved") : t("testEmail")}</button>{configured && <button className="ghost" onClick={() => clear.mutate()} disabled={clear.isPending}>{t("clearPassword")}</button>}</div></section>;
}

function smtpInitial(config?: SmtpResponse): SmtpState {
  if (!config?.host) return initialSmtp;
  return {
    enabled: config.enabled,
    host: config.host,
    port: config.port ?? 465,
    tlsMode: config.tlsMode ?? "implicit",
    authMethod: config.authMethod ?? "plain",
    username: config.username ?? "",
    password: "",
    senderName: config.senderName ?? "",
    senderAddress: config.senderAddress ?? "",
    recipients: config.recipients?.join(", ") ?? "",
    subjectPrefix: config.subjectPrefix ?? "[CF Activity Observatory]",
  };
}
