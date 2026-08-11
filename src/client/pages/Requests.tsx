import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { SampledRequest } from "@/shared/contracts";
import { api, endpoints } from "@/client/api";
import { useI18n } from "@/client/i18n";
import { Notice, PageHeader } from "@/client/components/Layout";
import { Badge, ErrorState, formatTime, Loading } from "@/client/components/Ui";
import { RequestDetail } from "@/client/components/RequestDetail";
import { rangeDates } from "@/client/components/TimeControls";

const column = createColumnHelper<SampledRequest>();

export function Requests() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams({ ...rangeDates("24h"), limit: "100" });
  const [draft, setDraft] = useState(() => Object.fromEntries(params));
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<SampledRequest | null>(null);
  const client = useQueryClient();
  const savedViews = useQuery({ queryKey: ["saved-views"], queryFn: () => api<{ items: Array<{ id: string; name: string; page: string; filters: Record<string, string> }> }>("/saved-views") });
  const saveView = useMutation({
    mutationFn: (name: string) => api("/saved-views", { method: "POST", body: JSON.stringify({ name, page: "requests", filters: Object.fromEntries(params) }) }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["saved-views"] }),
  });
  const query = useQuery({ queryKey: ["requests", params.toString()], queryFn: () => endpoints.requests(params), placeholderData: (previous) => previous });
  const columns = useMemo(() => [
    column.accessor("occurredAt", { header: t("occurredAt"), cell: (info) => formatTime(info.getValue()) }),
    column.accessor("clientIp", { header: t("ip"), cell: (info) => info.getValue() ?? "—" }),
    column.display({ id: "resource", header: `${t("host")} / ${t("path")}`, cell: (info) => <span className="resource-cell"><strong>{info.row.original.host ?? "—"}</strong><small>{info.row.original.path ?? "/"}</small></span> }),
    column.accessor("method", { header: t("method"), cell: (info) => <code>{info.getValue() ?? "—"}</code> }),
    column.accessor("edgeStatus", { header: t("status"), cell: (info) => <Badge tone={Number(info.getValue()) >= 500 ? "warn" : "neutral"}>{info.getValue() ?? "—"}</Badge> }),
    column.accessor("cacheStatus", { header: t("cacheStatus"), cell: (info) => info.getValue() ?? "—" }),
    column.accessor("securityAction", { header: t("action"), cell: (info) => info.getValue() ? <Badge tone="blue">{info.getValue()}</Badge> : "—" }),
  ], [t]);
  const table = useReactTable({ data: query.data?.items ?? [], columns, getCoreRowModel: getCoreRowModel() });

  function applyFilters(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams({ from: params.get("from") ?? rangeDates("24h").from, to: params.get("to") ?? rangeDates("24h").to, limit: "100" });
    for (const [key, value] of Object.entries(draft)) if (value && !["from", "to", "limit", "cursor"].includes(key)) next.set(key, value);
    setHistory([]);
    setParams(next);
  }
  function nextPage() {
    if (!query.data?.nextCursor) return;
    setHistory((items) => [...items, params.get("cursor") ?? ""]);
    const next = new URLSearchParams(params);
    next.set("cursor", query.data.nextCursor);
    setParams(next);
  }
  function previousPage() {
    const previous = history.at(-1);
    if (previous === undefined) return;
    const next = new URLSearchParams(params);
    if (previous) next.set("cursor", previous); else next.delete("cursor");
    setHistory((items) => items.slice(0, -1));
    setParams(next);
  }
  return <>
    <PageHeader title={t("requests")} eyebrow={t("sampledDetail")} actions={<div className="saved-view-actions"><select aria-label={t("savedViews")} defaultValue="" onChange={(event) => { const view = savedViews.data?.items.find((item) => item.id === event.target.value); if (view) { const next = new URLSearchParams(view.filters); setDraft(view.filters); setHistory([]); setParams(next); } }}><option value="">{t("savedViews")}</option>{savedViews.data?.items.filter((item) => item.page === "requests").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => { const name = window.prompt(t("viewName")); if (name?.trim()) saveView.mutate(name.trim()); }}>{t("saveCurrentView")}</button></div>} />
    <Notice><strong>{t("sampling")}</strong><span>{t("samplingHelp")}</span></Notice>
    <form className="filter-panel" onSubmit={applyFilters}>
      <header><h2>{t("filters")}</h2><button type="button" className="ghost" onClick={() => { const dates = rangeDates("24h"); setDraft({}); setParams(new URLSearchParams({ ...dates, limit: "100" })); }}>{t("reset")}</button></header>
      <div className="filter-grid">
        <Filter label={t("ip")} name="ip" value={draft.ip} set={setDraft} />
        <Filter label={t("host")} name="host" value={draft.host} set={setDraft} />
        <Filter label={t("path")} name="path" value={draft.path} set={setDraft} />
        <Filter label={t("method")} name="method" value={draft.method} set={setDraft} />
        <Filter label={t("status")} name="status" value={draft.status} set={setDraft} />
        <Filter label={t("rayId")} name="rayId" value={draft.rayId} set={setDraft} />
        <Filter label={t("action")} name="securityAction" value={draft.securityAction} set={setDraft} />
        <Filter label={t("userAgent")} name="userAgent" value={draft.userAgent} set={setDraft} />
      </div>
      <footer><button className="primary" type="submit">{t("search")}</button></footer>
    </form>
    <section className="panel table-panel">
      <div className="table-meta"><Badge tone="blue">{t("sampledDetail")}</Badge><span>{query.data?.items.length ?? 0} {t("records")}</span></div>
      {query.isLoading ? <Loading /> : query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <div className="table-scroll"><table><thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map((row) => <tr key={row.id} onClick={() => setSelected(row.original)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelected(row.original)}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table>{!query.data?.items.length && <div className="table-empty">{t("noData")}</div>}</div>}
      <div className="pagination"><button disabled={!history.length} onClick={previousPage}>{t("previousPage")}</button><button disabled={!query.data?.nextCursor} onClick={nextPage}>{t("nextPage")}</button></div>
    </section>
    {selected && <RequestDetail item={selected} close={() => setSelected(null)} />}
  </>;
}

function Filter({ label, name, value, set }: { label: string; name: string; value?: string; set: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
  return <label><span>{label}</span><input name={name} value={value ?? ""} onChange={(event) => set((current) => ({ ...current, [name]: event.target.value }))} /></label>;
}
