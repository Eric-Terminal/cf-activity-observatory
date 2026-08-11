import { useI18n } from "@/client/i18n";

export type RangeKey = "24h" | "7d" | "30d";

export function rangeDates(range: RangeKey): { from: string; to: string } {
  const to = Date.now();
  const durations: Record<RangeKey, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
  return { from: new Date(to - durations[range]).toISOString(), to: new Date(to).toISOString() };
}

export function TimeControls({ range, setRange }: { range: RangeKey; setRange: (range: RangeKey) => void }) {
  const { t } = useI18n();
  return <div className="segmented" aria-label={t("timeRange")}>
    {(["24h", "7d", "30d"] as const).map((value) => <button key={value} className={range === value ? "active" : ""} onClick={() => setRange(value)}>{t(value === "24h" ? "last24h" : value === "7d" ? "last7d" : "last30d")}</button>)}
  </div>;
}
