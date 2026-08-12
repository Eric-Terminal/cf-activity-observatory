ALTER TABLE data_gaps ADD COLUMN acknowledged_at INTEGER;

-- 超出 GraphQL 保留窗口的区间已无法补采，应作为审计历史保留，而不是永久健康告警。
UPDATE data_gaps
SET acknowledged_at = detected_at
WHERE resolved_at IS NULL
  AND reason = '停机区间已超出 Cloudflare 当前数据集可回看窗口';

CREATE INDEX data_gaps_health_idx
ON data_gaps(acknowledged_at, resolved_at, range_start, range_end);
