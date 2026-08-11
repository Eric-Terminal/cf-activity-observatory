import { describe, expect, it } from "vitest";
import type { DatasetCapability } from "@/shared/contracts";
import { buildDatasetQuery, selectedFields } from "@/worker/cloudflare";

describe("Cloudflare GraphQL 查询构建", () => {
  it("只保留能力发现允许的字段并遵守字段数上限", () => {
    const capability: DatasetCapability = {
      zoneId: "zone",
      dataset: "httpRequestsAdaptive",
      enabled: true,
      availableFields: ["datetime", "clientIP", "rayName"],
      maxPageSize: 1000,
      maxNumberOfFields: 2,
      notOlderThan: 604800,
      maxDuration: 86400,
      checkedAt: 0,
    };
    expect(selectedFields(capability)).toEqual(["datetime", "rayName"]);
  });

  it("构建明细查询时使用半开时间筛选", () => {
    const query = buildDatasetQuery("firewallEventsAdaptive", ["datetime", "action"], 250);
    expect(query).toContain("datetime_geq: $start");
    expect(query).toContain("datetime_lt: $end");
    expect(query).toContain("limit: 250");
  });

  it("把 Groups 能力字段还原为嵌套选择集", () => {
    const query = buildDatasetQuery("httpRequestsAdaptiveGroups", ["dimensions_datetimeFiveMinutes", "count", "avg_sampleInterval", "confidence_count_lower"], 250);
    expect(query).toContain("dimensions { datetimeFiveMinutes }");
    expect(query).toContain("count");
    expect(query).toContain("avg { sampleInterval }");
    expect(query).toContain("confidence(level: 0.95) { count { lower } }");
    expect(query).toContain("orderBy: [datetimeFiveMinutes_DESC]");
  });
});
