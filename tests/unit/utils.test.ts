import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, floorTo, parseCloudflareTime, stableId } from "@/worker/utils";

describe("采集基础工具", () => {
  it("为相同请求生成稳定且可区分的 ID", () => {
    expect(stableId("zone", 1, "ray")).toBe(stableId("zone", 1, "ray"));
    expect(stableId("zone", 1, "ray")).not.toBe(stableId("zone", 2, "ray"));
  });

  it("往返编码键集分页游标", () => {
    const cursor = { occurredAt: 1_717_171_717_000, id: "事件/一" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor("broken")).toBeNull();
  });

  it("按半开窗口边界取整并解析 Cloudflare 时间", () => {
    expect(floorTo(125_999, 60_000)).toBe(120_000);
    expect(parseCloudflareTime("2026-08-12T00:00:00Z")).toBe(1_786_492_800_000);
    expect(parseCloudflareTime("无效")).toBeNull();
  });
});
