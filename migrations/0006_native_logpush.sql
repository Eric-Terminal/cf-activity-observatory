-- 原始日志直接进入 R2；每个投递文件只索引一次，不按请求写 D1。
CREATE TABLE logpush_sources (
  zone_id TEXT NOT NULL REFERENCES zones(id),
  dataset TEXT NOT NULL CHECK(dataset IN ('http_requests', 'firewall_events')),
  activated_at INTEGER,
  last_received_at INTEGER,
  last_indexed_at INTEGER,
  PRIMARY KEY (zone_id, dataset)
) WITHOUT ROWID;

-- 每小时一个趋势对象。明细维度和计数保存在 R2，旧 D1 趋势保持可读。
CREATE TABLE metric_archives (
  zone_id TEXT NOT NULL REFERENCES zones(id),
  metric_kind TEXT NOT NULL CHECK(metric_kind IN ('http', 'security')),
  hour_start INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  etag TEXT NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (zone_id, metric_kind, hour_start)
) WITHOUT ROWID;
CREATE INDEX metric_archives_time_idx ON metric_archives(metric_kind, hour_start, zone_id);
