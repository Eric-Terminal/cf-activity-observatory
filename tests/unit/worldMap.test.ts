import { describe, expect, it } from "vitest";
import { countryFromAlpha2, countryMapOption, worldProjection } from "@/client/worldMap";

describe("世界地图数据关联与投影", () => {
  it("把 Cloudflare 两位国家代码映射为地图使用的数字地区 ID", () => {
    expect(countryFromAlpha2("GB")).toMatchObject({ alpha2: "GB", numeric: "826" });
    expect(countryFromAlpha2("us")).toMatchObject({ alpha2: "US", numeric: "840" });
  });

  it("为地图提供具备日界线裁剪能力的投影流", () => {
    expect(typeof worldProjection.stream).toBe("function");
    expect(worldProjection.project([0, 0])).toHaveLength(2);
  });

  it("国家统计使用数字地区 ID 并保留本地化名称", () => {
    const option = countryMapOption({
      bucketSeconds: 300,
      series: [{ name: "GB", points: [{ bucket_start: 1, dimension: "GB", estimated_count: 12, sample_interval: 1, confidence_lower: null, confidence_upper: null, edge_response_bytes: null, visits: null }] }],
    }, "zh-CN") as { series: Array<{ data: Array<{ name: string; displayName: string; value: number }> }> };
    expect(option.series[0]?.data[0]).toMatchObject({ name: "826", displayName: "英国", value: 12 });
  });
});
