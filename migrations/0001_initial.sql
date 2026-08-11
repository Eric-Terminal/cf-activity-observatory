PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT INTO schema_meta (version, applied_at) VALUES (1, unixepoch() * 1000);

CREATE TABLE zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  poll_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_minutes BETWEEN 1 AND 1440),
  detail_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (detail_retention_days BETWEEN 7 AND 3650),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_scheduled_at INTEGER
);

CREATE TABLE dataset_capabilities (
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  available_fields TEXT NOT NULL DEFAULT '[]',
  max_page_size INTEGER,
  max_number_of_fields INTEGER,
  not_older_than INTEGER,
  max_duration INTEGER,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (zone_id, dataset)
);

CREATE TABLE sync_cursors (
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL,
  cursor_at INTEGER NOT NULL,
  last_success_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  in_flight_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (zone_id, dataset)
);

CREATE TABLE request_samples (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  ray_id TEXT,
  client_ip TEXT,
  country TEXT,
  asn INTEGER,
  asn_description TEXT,
  user_agent TEXT,
  referer TEXT,
  device_type TEXT,
  host TEXT,
  path TEXT,
  query TEXT,
  method TEXT,
  protocol TEXT,
  request_source TEXT,
  colo TEXT,
  cache_status TEXT,
  origin_status INTEGER,
  edge_status INTEGER,
  security_action TEXT,
  security_source TEXT,
  security_rule_id TEXT,
  bot_score INTEGER,
  bot_score_source TEXT,
  bot_tags TEXT,
  verified_bot_category TEXT,
  attack_score INTEGER,
  content_scan_result TEXT,
  leaked_credential_result TEXT,
  sample_interval REAL,
  collected_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX request_samples_zone_time_idx ON request_samples(zone_id, occurred_at DESC, id DESC);
CREATE INDEX request_samples_ray_idx ON request_samples(zone_id, ray_id);
CREATE INDEX request_samples_ip_time_idx ON request_samples(zone_id, client_ip, occurred_at DESC);
CREATE INDEX request_samples_host_time_idx ON request_samples(zone_id, host, occurred_at DESC);
CREATE INDEX request_samples_security_time_idx ON request_samples(zone_id, security_source, security_action, occurred_at DESC);

CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  ray_id TEXT,
  action TEXT,
  source TEXT,
  rule_id TEXT,
  rule_description TEXT,
  ruleset_id TEXT,
  kind TEXT,
  client_ip TEXT,
  country TEXT,
  asn INTEGER,
  host TEXT,
  path TEXT,
  query TEXT,
  method TEXT,
  user_agent TEXT,
  sample_interval REAL,
  collected_at INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX security_events_zone_time_idx ON security_events(zone_id, occurred_at DESC, id DESC);
CREATE INDEX security_events_ray_idx ON security_events(zone_id, ray_id);
CREATE INDEX security_events_rule_time_idx ON security_events(zone_id, source, rule_id, occurred_at DESC);

CREATE TABLE metric_buckets (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  bucket_seconds INTEGER NOT NULL,
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
  UNIQUE (zone_id, bucket_start, bucket_seconds, metric_kind, dimension_signature)
);

CREATE INDEX metric_buckets_zone_time_idx ON metric_buckets(zone_id, bucket_seconds, bucket_start);
CREATE INDEX metric_buckets_dimension_idx ON metric_buckets(zone_id, dimension_type, dimension_value, bucket_start);

CREATE TABLE collector_runs (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  zone_id TEXT,
  dataset TEXT,
  job_type TEXT NOT NULL,
  range_start INTEGER,
  range_end INTEGER,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  graphql_queries INTEGER NOT NULL DEFAULT 0,
  returned_rows INTEGER NOT NULL DEFAULT 0,
  inserted_rows INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX collector_runs_time_idx ON collector_runs(started_at DESC);
CREATE INDEX collector_runs_zone_idx ON collector_runs(zone_id, dataset, started_at DESC);

CREATE TABLE data_gaps (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE archive_manifests (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  record_count INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  etag TEXT,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  verified_at INTEGER,
  pruned_at INTEGER
);

CREATE INDEX archive_manifests_zone_time_idx ON archive_manifests(zone_id, dataset, range_start DESC);

CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  worker_invocations INTEGER NOT NULL DEFAULT 0,
  queue_messages INTEGER NOT NULL DEFAULT 0,
  graphql_queries INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  d1_size_after INTEGER NOT NULL DEFAULT 0,
  r2_class_a INTEGER NOT NULL DEFAULT 0,
  r2_class_b INTEGER NOT NULL DEFAULT 0,
  r2_bytes_written INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  page TEXT NOT NULL,
  filters TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX saved_views_owner_idx ON saved_views(owner_email, page, updated_at DESC);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE smtp_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port IN (465, 587)),
  tls_mode TEXT NOT NULL CHECK (tls_mode IN ('implicit', 'starttls')),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('plain', 'login')),
  username TEXT NOT NULL,
  encrypted_password TEXT,
  password_iv TEXT,
  encryption_version INTEGER,
  sender_name TEXT,
  sender_address TEXT NOT NULL,
  recipients TEXT NOT NULL,
  subject_prefix TEXT NOT NULL DEFAULT '[CF Activity Observatory]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE alert_state (
  alert_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  recovered_at INTEGER,
  details TEXT NOT NULL DEFAULT '{}'
);
