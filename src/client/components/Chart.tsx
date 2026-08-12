import ReactECharts from "echarts-for-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/client/i18n";

export function Chart({ option, title, height = 320 }: { option: Record<string, unknown>; title: string; height?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const expandedChartRef = useRef<ReactECharts>(null);
  const serialized = JSON.stringify(option);
  const hasData = serialized.includes('"data":[') && !serialized.includes('"data":[]');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!expanded || !dialog) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    // dialog 在 showModal 前没有布局尺寸；下一帧重算，避免坐标轴已撑满而曲线仍停留在半宽画布。
    const frame = requestAnimationFrame(() => expandedChartRef.current?.getEchartsInstance().resize());
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      if (dialog.open) dialog.close();
    };
  }, [expanded]);

  if (!hasData) return <div className="empty-chart" style={{ height }}>{t("noData")}</div>;
  return <>
    <div className="chart-frame">
      <ReactECharts option={option} style={{ height }} opts={{ renderer: "svg" }} notMerge />
      <button className="chart-expand" type="button" aria-label={`${t("expandChart")}：${title}`} title={t("expandChart")} onClick={() => setExpanded(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4H4v4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5" /></svg>
      </button>
    </div>
    {expanded && <dialog ref={dialogRef} className="chart-dialog" aria-labelledby="expanded-chart-title" onClose={() => setExpanded(false)} onMouseDown={(event) => event.target === event.currentTarget && event.currentTarget.close()}>
      <section>
        <header><h2 id="expanded-chart-title">{title}</h2><button className="icon-button" type="button" aria-label={t("close")} onClick={() => dialogRef.current?.close()}>×</button></header>
        <ReactECharts ref={expandedChartRef} option={option} className="chart-expanded-canvas" opts={{ renderer: "svg" }} notMerge />
      </section>
    </dialog>}
  </>;
}
