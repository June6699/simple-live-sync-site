export const METRICS_SCHEMA_VERSION = 1;

export const METRICS_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS metrics_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS metrics_totals (
    event_type TEXT PRIMARY KEY,
    total INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS metrics_hourly (
    bucket_start INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (bucket_start, event_type)
  )`,
  `CREATE TABLE IF NOT EXISTS metrics_daily (
    bucket_start INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (bucket_start, event_type)
  )`,
  `CREATE TABLE IF NOT EXISTS metrics_geo_daily (
    bucket_start INTEGER NOT NULL,
    country_code TEXT NOT NULL,
    region_code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (bucket_start, country_code, region_code, event_type)
  )`,
  `CREATE TABLE IF NOT EXISTS metrics_visitors_daily (
    bucket_start INTEGER NOT NULL,
    visitor_hash TEXT NOT NULL,
    country_code TEXT NOT NULL,
    region_code TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    PRIMARY KEY (bucket_start, visitor_hash, country_code, region_code)
  )`,
  `CREATE TABLE IF NOT EXISTS availability_hourly (
    bucket_start INTEGER NOT NULL,
    target TEXT NOT NULL,
    status_rank INTEGER NOT NULL,
    checks INTEGER NOT NULL,
    http_latency_sum REAL NOT NULL,
    http_latency_samples INTEGER NOT NULL,
    websocket_latency_sum REAL NOT NULL,
    websocket_latency_samples INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (bucket_start, target)
  )`,
  `CREATE TABLE IF NOT EXISTS availability_daily (
    bucket_start INTEGER NOT NULL,
    target TEXT NOT NULL,
    up_hours INTEGER NOT NULL,
    total_hours INTEGER NOT NULL,
    http_latency_sum REAL NOT NULL,
    http_latency_samples INTEGER NOT NULL,
    websocket_latency_sum REAL NOT NULL,
    websocket_latency_samples INTEGER NOT NULL,
    PRIMARY KEY (bucket_start, target)
  )`,
  `CREATE INDEX IF NOT EXISTS metrics_hourly_range_idx
    ON metrics_hourly (bucket_start, event_type)`,
  `CREATE INDEX IF NOT EXISTS metrics_daily_range_idx
    ON metrics_daily (bucket_start, event_type)`,
  `CREATE INDEX IF NOT EXISTS metrics_geo_daily_range_idx
    ON metrics_geo_daily (bucket_start, country_code, region_code, event_type)`,
  `CREATE INDEX IF NOT EXISTS metrics_visitors_daily_range_idx
    ON metrics_visitors_daily (bucket_start, visitor_hash, country_code, region_code)`,
  `CREATE INDEX IF NOT EXISTS availability_hourly_range_idx
    ON availability_hourly (bucket_start, target)`,
  `CREATE INDEX IF NOT EXISTS availability_daily_range_idx
    ON availability_daily (bucket_start, target)`
] as const;
