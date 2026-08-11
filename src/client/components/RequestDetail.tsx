import type { SampledRequest } from "@/shared/contracts";
import { useI18n } from "@/client/i18n";
import { Badge, Field, formatTime } from "@/client/components/Ui";

export function RequestDetail({ item, close }: { item: SampledRequest; close: () => void }) {
  const { t } = useI18n();
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><aside className="drawer" role="dialog" aria-modal="true" aria-label={t("details")}>
    <header><div><Badge tone="blue">{t("sampledDetail")}</Badge><h2>{item.host ?? t("unknown")}{item.path ?? ""}</h2><p>{formatTime(item.occurredAt)}</p></div><button className="icon-button" onClick={close} aria-label={t("close")}>×</button></header>
    <DetailSection title={t("edgeResponse")}><Field label={t("action")} value={item.securityAction} /><Field label={t("cacheStatus")} value={item.cacheStatus} /><Field label={t("originStatus")} value={item.originStatus} /><Field label={t("edgeStatus")} value={item.edgeStatus} /></DetailSection>
    <DetailSection title={t("requestAnalysis")}><Field label={t("securitySource")} value={item.securitySource} /><Field label={t("ruleId")} value={item.securityRuleId} /><Field label={t("botScore")} value={item.botScore} /><Field label={t("botSource")} value={item.botScoreSource} /><Field label={t("botTags")} value={item.botTags.length ? item.botTags.join(", ") : null} /><Field label={t("verifiedBot")} value={item.verifiedBotCategory} /><Field label={t("attackScore")} value={item.attackScore} /><Field label={t("contentScan")} value={formatDetail(item.contentScanResult)} /><Field label={t("leakedCredential")} value={item.leakedCredentialResult} /></DetailSection>
    <DetailSection title={t("requestDetails")}><Field label={t("rayId")} value={item.rayId} /><Field label={t("ip")} value={item.clientIp} /><Field label={t("country")} value={item.country} /><Field label={t("asn")} value={item.asnDescription ? `${item.asn ?? ""} · ${item.asnDescription}` : item.asn} /><Field label={t("method")} value={item.method} /><Field label={t("protocol")} value={item.protocol} /><Field label={t("requestSource")} value={item.requestSource} /><Field label={t("colo")} value={item.colo} /><Field label={t("deviceType")} value={item.deviceType} /><Field label={t("referer")} value={item.referer} /><Field label={t("host")} value={item.host} /><Field label={t("path")} value={item.path} /><Field label={t("query")} value={item.query} wide /><Field label={t("userAgent")} value={item.userAgent} wide /></DetailSection>
  </aside></div>;
}

function formatDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3><dl>{children}</dl></section>;
}
