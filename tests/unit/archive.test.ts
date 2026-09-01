import { describe, expect, it } from "vitest";
import { archiveCsvCell, decodeArchiveResponse } from "@/client/archive";
import { encodeArchiveCursor, matchesArchiveFilter } from "@/shared/archive-records";

describe("浏览器 R2 冷归档读取", () => {
  it("流式解压并兼容 schema v1 的 D1 原始行", async () => {
    const occurredAt = Date.UTC(2026, 8, 1, 10, 15);
    const response = gzipResponse([
      {
        type: "cf-activity-observatory/archive",
        schemaVersion: 1,
        zoneId: "zone-one",
        dataset: "httpRequestsAdaptive",
        rangeStart: "2026-09-01T10:00:00.000Z",
        rangeEnd: "2026-09-01T11:00:00.000Z",
        generatedAt: "2026-09-01T11:00:00.000Z",
      },
      {
        id: "request-one",
        zone_id: "zone-one",
        occurred_at: occurredAt,
        client_ip: "192.0.2.1",
        host: "API.Example.com",
        path: "/Audit/Event",
        query: "token=sample",
        edge_status: 403,
        bot_tags: "[\"verified\"]",
        extra: "{\"legacy\":true}",
      },
    ]);

    const items = await decodeArchiveResponse(response, "httpRequestsAdaptive");

    expect(items).toEqual([expect.objectContaining({
      id: "request-one",
      zoneId: "zone-one",
      occurredAt,
      clientIp: "192.0.2.1",
      edgeStatus: 403,
      botTags: ["verified"],
      extra: { legacy: true },
    })]);
    expect(matchesArchiveFilter(items[0], {
      zoneIds: ["zone-one"], from: occurredAt - 1, to: occurredAt + 1, limit: 100,
      host: "api.example", path: "/audit", query: "SAMPLE", status: 403,
    })).toBe(true);
  });

  it("读取 schema v2 并按键集游标排除上一页末项", async () => {
    const occurredAt = Date.UTC(2026, 8, 1, 12, 0);
    const response = gzipResponse([
      {
        type: "cf-activity-observatory/archive",
        schemaVersion: 2,
        zoneId: "zone-two",
        dataset: "firewallEventsAdaptive",
        rangeStart: "2026-09-01T12:00:00.000Z",
        rangeEnd: "2026-09-01T13:00:00.000Z",
        generatedAt: "2026-09-01T13:00:00.000Z",
      },
      {
        id: "event-two", zoneId: "zone-two", occurredAt, rayId: "ray-two", action: "block",
        source: "firewallRules", ruleId: "rule-two", ruleDescription: null, rulesetId: null, kind: null,
        clientIp: "198.51.100.2", country: "US", asn: 64500, host: "example.com", path: "/login",
        query: null, method: "POST", userAgent: "test", sampleInterval: 1, extra: {},
      },
    ]);

    const items = await decodeArchiveResponse(response, "firewallEventsAdaptive");
    const cursor = encodeArchiveCursor({ occurredAt, id: "event-two" });

    expect(items[0]).toMatchObject({ action: "block", ruleId: "rule-two", asn: 64500 });
    expect(matchesArchiveFilter(items[0], {
      zoneIds: [], from: occurredAt - 1, to: occurredAt + 1, limit: 100, cursor,
    })).toBe(false);
  });

  it("本地 CSV 导出阻止电子表格公式注入", () => {
    expect(archiveCsvCell("=WEBSERVICE(\"bad\")")).toBe("\"'=WEBSERVICE(\"\"bad\"\")\"");
  });
});

function gzipResponse(lines: unknown[]): Response {
  const content = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const stream = new Blob([content]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream, { headers: { "Content-Type": "application/gzip" } });
}
