# R2 归档格式 / R2 Archive Schema

GraphQL 归档 schema version：`2`，继续兼容 `1`。原生 Logpush 清单版本 `3` 与趋势对象格式见本页末尾。GraphQL 对象使用 gzip 压缩的 NDJSON，并按 UTC 小时使用确定性 key：

```text
archives/{zone_id}/{dataset}/YYYY/MM/DD/HH.ndjson.gz
```

第一行是元数据：

```json
{
  "type": "cf-activity-observatory/archive",
  "schemaVersion": 2,
  "zoneId": "zone-id",
  "dataset": "httpRequestsAdaptive",
  "rangeStart": "2026-09-01T00:00:00.000Z",
  "rangeEnd": "2026-09-01T01:00:00.000Z",
  "generatedAt": "2026-09-01T01:05:00.000Z"
}
```

后续每行是一条已经按 `id` 去重的 `SampledRequest` 或 `SecurityEvent`，字段名与 `/shared/contracts.ts` 中的 API camelCase 契约一致。重复或修复采集会读取同一小时对象、合并记录并原位重写；缺失的 ASN 可以由后续回采补齐。Queue 消费并发固定为 1，避免同一小时发生并发读改写覆盖。

R2 custom metadata 保存 `schemaVersion`、`zoneId`、`dataset`、SHA-256（Base64URL）和记录数。D1 `archive_manifests` 只保存对象 key、时间范围、压缩字节数、ETag、校验和与验证状态，不保存逐条明细。

网页先按数据集、Zone 和时间范围读取 manifest，再通过受 Cloudflare Access 保护的下载端点获取原始 gzip 字节。解压、v1/v2 转换、组合筛选、排序、分页和导出都在当前浏览器中完成。R2 bucket 不应公开，因为归档可能含 IP、完整 query 和 User-Agent。

schema v1 对象仍受支持。v1 的后续行是 snake_case D1 原始行，网页读取时会映射为当前 API 契约；已有对象不需要批量重写。新采集一旦合并到旧小时，该对象会自然升级为 v2。

本地检查：

```bash
gzip -dc 00.ndjson.gz | head
gzip -dc 00.ndjson.gz | tail -n +2 | jq -c . >/dev/null
```

---

The current schema version is `2`. Objects are gzip-compressed NDJSON at deterministic UTC-hour keys. The first line is archive metadata; every subsequent line is a deduplicated camelCase `SampledRequest` or `SecurityEvent`. Repair collection merges into the same object and may fill previously missing ASN data.

R2 custom metadata and the D1 `archive_manifests` row record the schema version, zone, dataset, SHA-256 Base64URL checksum, record count, compressed bytes, ETag, and verification state. Individual detail records are not stored in D1.

The Access-protected API streams raw gzip bytes. Decompression, schema conversion, filtering, ordering, keyset pagination, and export happen locally in the browser. Keep the bucket private because records may contain IP addresses, full query strings, and User-Agent values.

Schema v1 remains readable. Its snake_case D1 rows are converted to the current API contract in the browser, so existing objects require no bulk migration. A later repair merge naturally rewrites that hour as v2.

## 原生 Logpush 与趋势

`logpush/{zone_id}/{http_requests|firewall_events}/{DATE}/...gz` 为 Cloudflare 原样投递的 gzip NDJSON，**没有应用元数据行**。清单 `schema_version=3`、`status=indexed`，以对象 ETag 保证下载时清单仍对应当前对象；`sha256` 为空，不声称做过 SHA-256 校验。索引过程验证时间、RayID 和每行 JSON，记录真实最小时间、最大时间加一毫秒、条数与压缩大小。浏览器适配 PascalCase 字段并标记 `dataSource=logpush`。同一 RayID 的不同规则安全事件分别保留。

`metrics/{zone_id}/{http|security}/{hour_start_epoch_ms}.json.gz` 是 gzip JSON，包含 `version: 1`、`zoneId`、`kind`、`hourStart` 和 `rows`。行保留旧 `metric_buckets` 的 snake_case 字段，以 `(bucket_start,bucket_seconds,dimension_signature)` 合并；首次接管小时包含该小时旧 D1 全部维度。只有 R2 写入成功后才更新 `metric_archives`，读侧按小时排除对应旧 D1 行，防止重复统计。

`migration-backups/metrics/{zone_id}/{kind}/{hour}.json.gz` 保存该小时第一次迁移时的原始 D1 行数组。迁移先回读验证每一条待删除记录，原始备份不随后续小批回收覆盖。该前缀不得配置自动清理，直到运维明确不再需要回滚。

Native Logpush manifests use version 3 and `indexed` status. Files have no application header or application SHA-256 checksum. Trend documents use a separate version-1 gzip JSON format; original D1 migration backups are retained independently for rollback. See [setup and migration](./LOGPUSH.md).
