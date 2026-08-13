-- 明细查询始终带时间范围，保留时间索引即可覆盖主要访问路径；其余索引会让每条样本重复消耗免费写入额度。
DROP INDEX IF EXISTS request_samples_ray_idx;
DROP INDEX IF EXISTS request_samples_ip_time_idx;
DROP INDEX IF EXISTS request_samples_host_time_idx;
DROP INDEX IF EXISTS request_samples_security_time_idx;
DROP INDEX IF EXISTS security_events_ray_idx;
DROP INDEX IF EXISTS security_events_rule_time_idx;

-- 这些死信来自旧采集器把主动背压当成失败；新状态机会重新续传对应游标。
UPDATE alert_state
SET status = 'recovered',
    recovered_at = unixepoch() * 1000,
    last_seen_at = unixepoch() * 1000
WHERE status = 'active'
  AND alert_key LIKE 'dlq:%'
  AND (
    details LIKE '%GraphQL 五分钟调用预算已用尽%'
    OR details LIKE '%Too many subrequests by single Worker invocation%'
    OR details LIKE '%D1 当日写入预算已达到 80%%'
  );

UPDATE sync_cursors
SET consecutive_failures = 0,
    last_error = NULL,
    in_flight_until = NULL,
    updated_at = unixepoch() * 1000
WHERE last_error = 'GraphQL 五分钟调用预算已用尽'
   OR last_error LIKE 'Too many subrequests by single Worker invocation%'
   OR last_error LIKE 'D1 当日写入预算已达到 80%%';
