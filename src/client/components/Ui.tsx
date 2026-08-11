import { useI18n } from "@/client/i18n";

export function Loading() {
  const { t } = useI18n();
  return <div className="state"><span className="spinner" />{t("loading")}</div>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useI18n();
  return <div className="state error"><strong>{t("error")}</strong><span>{error instanceof Error ? error.message : String(error)}</span>{retry && <button onClick={retry}>{t("retry")}</button>}</div>;
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "blue" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 99_999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatTime(value: number | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(value) : "—";
}

export function Field({ label, value, wide = false }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return <div className={`detail-field${wide ? " wide" : ""}`}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>;
}
