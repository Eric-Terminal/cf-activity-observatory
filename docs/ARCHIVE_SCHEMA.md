# R2 归档格式 / R2 Archive Schema

当前 schema version：`1`。

归档对象使用 gzip 压缩的 NDJSON：

```text
archives/{zone_id}/{dataset}/YYYY/MM/DD/HH.ndjson.gz
```

第一行是元数据：

```json
{
  "type": "cf-activity-observatory/archive",
  "schemaVersion": 1,
  "zoneId": "zone-id",
  "dataset": "httpRequestsAdaptive",
  "rangeStart": "2026-08-12T00:00:00.000Z",
  "rangeEnd": "2026-08-12T01:00:00.000Z",
  "generatedAt": "2026-08-12T02:00:00.000Z"
}
```

后续每行是该小时内一条已经去重的 D1 原始行。对象 R2 custom metadata 同时保存 `schemaVersion`、`zoneId`、`dataset`、SHA-256（Base64URL）和记录数。D1 `archive_manifests` 保存对象 key、压缩字节数、ETag、校验和、状态与在线清理时间。

最近 48 小时使用确定性 key 重写，以纳入迟到数据。只有 manifest 为 `verified` 的小时才允许从 D1 删除。

解压与检查：

```bash
gzip -dc 00.ndjson.gz | head
gzip -dc 00.ndjson.gz | tail -n +2 | jq -c . >/dev/null
```

恢复时先验证对象字节的 SHA-256 与 manifest 一致，再跳过第一行，将后续行按 `id` 使用 `INSERT OR IGNORE` 导入相应表。不要把归档直接暴露为公共 R2 URL，因为行中可能包含 IP、query 和 User-Agent。

---

The current schema version is `1`. Each object is gzip-compressed NDJSON at the deterministic key shown above. The first line is archive metadata; every subsequent line is one deduplicated raw D1 row in the UTC hour. R2 custom metadata and `archive_manifests` record the schema version, zone, dataset, SHA-256 Base64URL checksum, record count, compressed bytes, ETag, verification state, and pruning time.

The most recent 48 hours may be rewritten to include late data. D1 rows are pruned only after the corresponding manifest is `verified`. Keep archives private because rows may contain IP addresses, full query strings, and User-Agent values.
