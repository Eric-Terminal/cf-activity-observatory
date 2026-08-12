import ReactECharts from "echarts-for-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/client/i18n";

export function Chart({ option, title, height = 320 }: { option: Record<string, unknown>; title: string; height?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [selectedSeries, setSelectedSeries] = useState<string[] | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const expandedChartRef = useRef<ReactECharts>(null);
  const seriesNames = useMemo(() => [...new Set((Array.isArray(option.series) ? option.series : [])
    .map((series) => typeof (series as { name?: unknown }).name === "string" ? (series as { name: string }).name : "")
    .filter(Boolean))], [option.series]);
  const matchingSeries = selectedSeries?.filter((name) => seriesNames.includes(name)) ?? [];
  const visibleSeries = selectedSeries === null || (selectedSeries.length > 0 && matchingSeries.length === 0) ? seriesNames : matchingSeries;
  const displayedOption = useMemo(() => withSeriesSelection(option, seriesNames, visibleSeries), [option, seriesNames, visibleSeries]);
  const serialized = JSON.stringify(displayedOption);
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
  const seriesPicker = seriesNames.length > 1 && <SeriesPicker
    title={title}
    names={seriesNames}
    selected={visibleSeries}
    onChange={(names) => setSelectedSeries(names.length === seriesNames.length ? null : names)}
  />;
  const syncLegendSelection = (value: unknown) => {
    const selected = (value as { selected?: Record<string, boolean> }).selected;
    if (!selected) return;
    const names = seriesNames.filter((name) => selected[name]);
    setSelectedSeries(names.length === seriesNames.length ? null : names);
  };
  return <>
    <div className="chart-frame">
      <ReactECharts option={displayedOption} style={{ height }} opts={{ renderer: "svg" }} onEvents={{ legendselectchanged: syncLegendSelection }} notMerge />
      <div className="chart-actions">{seriesPicker}<button className="chart-expand" type="button" aria-label={`${t("expandChart")}：${title}`} title={t("expandChart")} onClick={() => setExpanded(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4H4v4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5" /></svg>
        </button></div>
    </div>
    {expanded && <dialog ref={dialogRef} className="chart-dialog" aria-labelledby="expanded-chart-title" onClose={() => setExpanded(false)} onMouseDown={(event) => event.target === event.currentTarget && event.currentTarget.close()}>
      <section>
        <header><h2 id="expanded-chart-title">{title}</h2><div className="chart-dialog-actions">{seriesPicker}<button className="icon-button" type="button" aria-label={t("close")} onClick={() => dialogRef.current?.close()}>×</button></div></header>
        <ReactECharts ref={expandedChartRef} option={displayedOption} className="chart-expanded-canvas" opts={{ renderer: "svg" }} onEvents={{ legendselectchanged: syncLegendSelection }} notMerge />
      </section>
    </dialog>}
  </>;
}

function SeriesPicker({ title, names, selected, onChange }: { title: string; names: string[]; selected: string[]; onChange: (names: string[]) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = (name: string, checked: boolean) => {
    const next = checked ? [...selected, name] : selected.filter((item) => item !== name);
    onChange(names.filter((item) => next.includes(item)));
  };
  return <div className="series-picker" ref={rootRef}>
    <button ref={triggerRef} className="series-trigger" type="button" aria-label={`${t("seriesFilter")}：${title}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg><span>{selected.length}/{names.length}</span>
    </button>
    {open && <section className="series-menu" aria-label={t("seriesFilter")}>
      <header><strong>{t("seriesFilter")}</strong><button type="button" className="series-show-all" onClick={() => onChange(names)}>{t("showAllSeries")}</button></header>
      <ul>{names.map((name) => <li key={name}>
        <label><input type="checkbox" checked={selected.includes(name)} onChange={(event) => toggle(name, event.target.checked)} /><span>{name}</span></label>
        <button type="button" onClick={() => onChange([name])} aria-label={`${t("onlyShowSeries")} ${name}`}>{t("onlyShowSeries")}</button>
      </li>)}</ul>
    </section>}
  </div>;
}

function withSeriesSelection(option: Record<string, unknown>, names: string[], visible: string[]): Record<string, unknown> {
  if (names.length < 2) return option;
  const selected = Object.fromEntries(names.map((name) => [name, visible.includes(name)]));
  const apply = (legend: unknown): unknown => legend && typeof legend === "object"
    ? { ...legend, selected: { ...((legend as { selected?: Record<string, boolean> }).selected ?? {}), ...selected } }
    : legend;
  // 仅切换 legend 的选中态，保留原始系列顺序，避免筛选后颜色重新分配。
  return { ...option, legend: Array.isArray(option.legend) ? option.legend.map(apply) : apply(option.legend) };
}
