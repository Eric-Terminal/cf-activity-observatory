import { geoMercator } from "d3-geo";
import * as echarts from "echarts";
import { whereAlpha2, whereNumeric } from "iso-3166-1";
import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import type { MetricResponse } from "@/client/api";

const MAP_NAME = "observatory-world";
const mercator = geoMercator();
const regionLabels = new Map<string, string>();
let registered = false;

/** d3 投影流会在 180° 经线裁剪多边形，避免把俄罗斯两端横跨整张地图连接。 */
export const worldProjection = {
  project(point: number[]): number[] {
    return mercator([point[0] ?? 0, point[1] ?? 0]) ?? [0, 0];
  },
  unproject(point: number[]): number[] {
    return mercator.invert?.([point[0] ?? 0, point[1] ?? 0]) ?? [0, 0];
  },
  stream(output: Parameters<typeof mercator.stream>[0]): ReturnType<typeof mercator.stream> {
    return mercator.stream(output);
  },
};

export function countryMapOption(data: MetricResponse | undefined, locale: "zh-CN" | "en"): Record<string, unknown> {
  ensureMapRegistered();
  const displayNames = new Intl.DisplayNames([locale], { type: "region" });
  const values = data?.series.flatMap((series) => {
    const country = countryFromAlpha2(series.name);
    if (!country) return [];
    return [{
      name: country.numeric,
      code: country.alpha2,
      displayName: displayNames.of(country.alpha2) ?? country.country,
      value: series.points.reduce((sum, point) => sum + Number(point.estimated_count), 0),
    }];
  }) ?? [];
  const max = Math.max(...values.map((item) => item.value), 1);
  return {
    tooltip: {
      trigger: "item",
      formatter(value: unknown): string {
        const params = value as { name?: string; data?: { code?: string; displayName?: string; value?: number } };
        const fallback = whereNumeric(params.name ?? "");
        const name = params.data?.displayName
          ?? (fallback ? displayNames.of(fallback.alpha2) : undefined)
          ?? regionLabels.get(params.name ?? "")
          ?? params.name
          ?? "—";
        const count = params.data?.value;
        return `${name}<br/>${count === undefined ? "—" : count.toLocaleString(locale)}`;
      },
    },
    visualMap: { min: 0, max, left: "center", bottom: 0, orient: "horizontal", calculable: true, inRange: { color: ["#dbe7ff", "#306df5", "#17367e"] }, textStyle: { fontSize: 9 } },
    series: [{ type: "map", map: MAP_NAME, projection: worldProjection, roam: true, selectedMode: false, emphasis: { label: { show: false } }, data: values }],
  };
}

export function countryFromAlpha2(code: string): { alpha2: string; country: string; numeric: string } | null {
  if (code.toUpperCase() === "XK") return { alpha2: "XK", country: "Kosovo", numeric: "383" };
  return whereAlpha2(code) ?? null;
}

function ensureMapRegistered(): void {
  if (registered) return;
  const geo = feature(world as never, world.objects.countries as never) as unknown as {
    features: Array<{ id?: string | number; properties: Record<string, unknown> | null }>;
  };
  // Mercator 会无限放大极区；南极洲没有常规客户端流量，移除后有效国家能占据更多画布。
  geo.features = geo.features.filter((item) => String(item.id ?? "").padStart(3, "0") !== "010");
  for (const item of geo.features) {
    const numeric = String(item.id ?? "").padStart(3, "0");
    const label = typeof item.properties?.name === "string" ? item.properties.name : numeric;
    regionLabels.set(numeric, label);
    item.properties = { ...item.properties, name: numeric };
  }
  echarts.registerMap(MAP_NAME, geo as never);
  registered = true;
}
