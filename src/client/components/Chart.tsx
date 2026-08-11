import ReactECharts from "echarts-for-react";
import { useI18n } from "@/client/i18n";

export function Chart({ option, height = 320 }: { option: Record<string, unknown>; height?: number }) {
  const { t } = useI18n();
  const serialized = JSON.stringify(option);
  const hasData = serialized.includes('"data":[') && !serialized.includes('"data":[]');
  return hasData
    ? <ReactECharts option={option} style={{ height }} opts={{ renderer: "svg" }} notMerge />
    : <div className="empty-chart" style={{ height }}>{t("noData")}</div>;
}
