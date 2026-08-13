-- 趋势数据在任一序列、时间段只保留一种粒度；旧采集器已删除的五分钟排名必须由小时层接续。
CREATE TABLE metric_buckets_next (
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  bucket_seconds INTEGER NOT NULL CHECK (bucket_seconds IN (300, 3600, 86400)),
  metric_kind TEXT NOT NULL,
  dimension_signature TEXT NOT NULL,
  host TEXT,
  country TEXT,
  asn INTEGER,
  method TEXT,
  protocol TEXT,
  edge_status INTEGER,
  origin_status INTEGER,
  status_class INTEGER,
  cache_status TEXT,
  security_action TEXT,
  security_source TEXT,
  request_source TEXT,
  dimension_type TEXT,
  dimension_value TEXT,
  estimated_count REAL NOT NULL DEFAULT 0,
  sample_interval REAL,
  confidence_estimate REAL,
  confidence_lower REAL,
  confidence_upper REAL,
  confidence_sample_size INTEGER,
  edge_response_bytes REAL,
  visits REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature)
) WITHOUT ROWID;

WITH normalized AS (
  SELECT
    zone_id,
    bucket_start,
    bucket_seconds,
    metric_kind,
    json_object(
      'asn', asn,
      'cacheStatus', cache_status,
      'country', country,
      'dimensionType', dimension_type,
      'dimensionValue', dimension_value,
      'edgeStatus', edge_status,
      'host', host,
      'method', method,
      'originStatus', origin_status,
      'protocol', protocol,
      'requestSource', request_source,
      'securityAction', security_action,
      'securitySource', security_source,
      'statusClass', status_class
    ) AS normalized_signature,
    host,
    country,
    asn,
    method,
    protocol,
    edge_status,
    origin_status,
    status_class,
    cache_status,
    security_action,
    security_source,
    request_source,
    dimension_type,
    dimension_value,
    estimated_count,
    sample_interval,
    confidence_estimate,
    confidence_lower,
    confidence_upper,
    confidence_sample_size,
    edge_response_bytes,
    visits,
    updated_at
  FROM metric_buckets
  WHERE (bucket_seconds = 300 AND bucket_start >= (unixepoch() * 1000 - 90 * 86400000))
     OR (bucket_seconds = 3600
         AND dimension_type IS NOT NULL
         AND bucket_start >= (unixepoch() * 1000 - 90 * 86400000))
     OR (bucket_seconds = 3600
         AND bucket_start < (unixepoch() * 1000 - 90 * 86400000)
         AND bucket_start >= (unixepoch() * 1000 - 730 * 86400000))
     OR (bucket_seconds = 86400 AND bucket_start < (unixepoch() * 1000 - 730 * 86400000))
)
INSERT INTO metric_buckets_next (
  zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature, host, country, asn,
  method, protocol, edge_status, origin_status, status_class, cache_status, security_action, security_source,
  request_source, dimension_type, dimension_value, estimated_count, sample_interval, confidence_estimate,
  confidence_lower, confidence_upper, confidence_sample_size, edge_response_bytes, visits, updated_at
)
SELECT
  zone_id, bucket_start, bucket_seconds, metric_kind, normalized_signature,
  MAX(host), MAX(country), MAX(asn), MAX(method), MAX(protocol), MAX(edge_status), MAX(origin_status),
  MAX(status_class), MAX(cache_status), MAX(security_action), MAX(security_source), MAX(request_source),
  MAX(dimension_type), MAX(dimension_value), SUM(estimated_count), AVG(sample_interval),
  SUM(confidence_estimate), SUM(confidence_lower), SUM(confidence_upper), SUM(confidence_sample_size),
  SUM(edge_response_bytes), SUM(visits), MAX(updated_at)
FROM normalized
GROUP BY zone_id, bucket_start, bucket_seconds, metric_kind, normalized_signature;

DROP TABLE metric_buckets;
ALTER TABLE metric_buckets_next RENAME TO metric_buckets;

-- 全 Zone 趋势查询走这一棵索引；复合主键自身覆盖按 Zone 的时间查询，避免为每个点维护多份索引。
CREATE INDEX metric_buckets_query_idx
ON metric_buckets(metric_kind, dimension_type, bucket_start, bucket_seconds, zone_id, dimension_value);

DELETE FROM app_settings WHERE key = 'metric_rollup_watermark';
