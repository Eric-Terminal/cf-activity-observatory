import { afterEach, describe, expect, it, vi } from "vitest";
import { logpushTimestamp, parseLogpushKey, parseLogpushRecord } from "@/shared/logpush";
import { readNdjson } from "@/shared/ndjson";
import { queryArchivedRequests } from "@/client/archive";

const zone = "a".repeat(32);
const timestamp = Date.UTC(2026, 9, 10, 12);
const http = (ray: string, offset = 0) => ({ RayID: ray, EdgeStartTimestamp: new Date(timestamp + offset).toISOString(), ClientIP: "192.0.2.1", ClientRequestHost: "example.com", ClientRequestURI: "/search?q=test", EdgeResponseStatus: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("原生 Logpush 格式与流读取", () => {
  it("识别限定路径并拒绝其他对象", () => {
    expect(parseLogpushKey(`logpush/${zone}/http_requests/20261010/a.log.gz`)).toEqual({ zoneId: zone, dataset: "http_requests" });
    expect(parseLogpushKey(`archives/${zone}/httpRequestsAdaptive/2026/10/10/12.ndjson.gz`)).toBeNull();
    expect(parseLogpushKey(`logpush/${zone}/http_requests/ownership-challenge.txt`)).toBeNull();
    expect(parseLogpushKey(`logpush/${zone}/http_requests/00010101/test.txt.gz`)).toBeNull();
  });

  it("兼容三种时间格式，不把缺失时间伪装为当前时间", () => {
    expect(logpushTimestamp(new Date(timestamp).toISOString())).toBe(timestamp);
    expect(logpushTimestamp(timestamp / 1000)).toBe(timestamp);
    expect(logpushTimestamp(`${BigInt(timestamp) * 1_000_000n}`)).toBe(timestamp);
    expect(() => parseLogpushRecord("http_requests", zone, { RayID: "missing-time" })).toThrow("有效时间");
  });

  it("映射请求字段且明确来源，不推断为未采样全量", () => {
    expect(parseLogpushRecord("http_requests", zone, http("ray"))).toMatchObject({
      dataSource: "logpush", occurredAt: timestamp, rayId: "ray", path: "/search", query: "q=test", edgeStatus: 200, sampleInterval: null,
    });
    expect(() => parseLogpushRecord("http_requests", zone, { ...http("ray"), ZoneID: "b".repeat(32) })).toThrow("Zone");
  });

  it("同一请求触发多个规则时保留每个安全事件", () => {
    const event = { RayID: "same", Datetime: new Date(timestamp).toISOString(), Source: "firewallRules", Action: "block" };
    const a = parseLogpushRecord("firewall_events", zone, { ...event, RuleID: "one" });
    const b = parseLogpushRecord("firewall_events", zone, { ...event, RuleID: "two" });
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ source: "firewallRules", dataSource: "logpush" });
  });

  it("保留当前 Logpush 数据集的攻击评分和安全事件客户端信息", () => {
    expect(parseLogpushRecord("http_requests", zone, { ...http("scored"), WAFAttackScore: 17 }))
      .toMatchObject({ attackScore: 17 });
    expect(parseLogpushRecord("firewall_events", zone, {
      Datetime: new Date(timestamp).toISOString(), RayID: "firewall", ClientCountry: "CN",
      ClientRequestUserAgent: "Test browser", ClientRequestPath: "/search", ClientRequestQuery: "q=test",
    })).toMatchObject({ country: "CN", userAgent: "Test browser", path: "/search", query: "q=test" });
  });

  it("跨块 UTF-8、空行与末尾无换行均可读取", async () => {
    const bytes = new TextEncoder().encode('\n{"text":"中文"}\n{"last":true}');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const values = [];
    for await (const value of readNdjson(stream, false)) values.push(value);
    expect(values).toEqual([{ text: "中文" }, { last: true }]);
  });

  it("超过解压预算时终止，不能返回被截断的成功结果", async () => {
    const response = gzip([http("large")]);
    await expect(async () => { for await (const value of readNdjson(response.body!, true, 10)) void value; }).rejects.toThrow("安全上限");
  });
});

describe("原生批次的浏览器查询", () => {
  it("对重叠且乱序的文件全局排序、去重并正确翻页", async () => {
    const batches = [[http("a", 3000), http("b", 1000)], [http("c", 4000), http("a", 3000), http("d", 2000)]];
    const files = batches.map((records, index) => ({ id: `file-${index}`, zone_id: zone, dataset: "httpRequestsAdaptive", schema_version: 3,
      range_start: Math.min(...records.map((row) => Date.parse(row.EdgeStartTimestamp))), range_end: Math.max(...records.map((row) => Date.parse(row.EdgeStartTimestamp))) + 1, compressed_bytes: 100 }));
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/archives?")) return Promise.resolve(Response.json({ items: files }));
      return Promise.resolve(gzip(batches[url.includes("file-0") ? 0 : 1]));
    }));
    const params = new URLSearchParams({ from: new Date(timestamp).toISOString(), to: new Date(timestamp + 10_000).toISOString(), limit: "2" });
    const first = await queryArchivedRequests(params);
    expect(first.items.map((row) => row.rayId)).toEqual(["c", "a"]);
    params.set("cursor", first.nextCursor!);
    const second = await queryArchivedRequests(params);
    expect(second.items.map((row) => row.rayId)).toEqual(["d", "b"]);
    expect(second.nextCursor).toBeNull();
  });

  it("拒绝超大扫描并传递 AbortSignal", async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ items: [{ id: "large", zone_id: zone, schema_version: 3, range_start: timestamp, range_end: timestamp + 1, compressed_bytes: 65 * 1024 * 1024 }] })));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await expect(queryArchivedRequests(new URLSearchParams({ from: new Date(timestamp).toISOString(), to: new Date(timestamp + 1000).toISOString() }), signal)).rejects.toThrow("64 MiB");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }));
  });
});

function gzip(records: unknown[]): Response {
  return new Response(new Blob([records.map((row) => JSON.stringify(row)).join("\n")]).stream().pipeThrough(new CompressionStream("gzip")));
}
