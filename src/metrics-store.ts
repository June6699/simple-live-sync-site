import {
  availabilityStatus,
  createMetricRecord,
  DAY_MS,
  HOUR_MS,
  isAvailabilityMetricEvent,
  METRICS_RETENTION_MS,
  parseMetricsRange,
  parseMetricsTimelineRange,
  USAGE_METRIC_EVENT_TYPES,
  utcDayBucket,
  utcHourBucket,
  type AvailabilityStatus,
  type MetricRecord,
  type MetricsEvent,
  type MetricsGranularity,
  type MetricsRange,
  type MetricsRangeInput,
  type MetricsSource,
  type NormalizedConnectionContext,
  type NormalizedUsageMetricEvent,
  type UsageMetricEventType
} from "./metrics.js";
import { METRICS_SCHEMA_STATEMENTS, METRICS_SCHEMA_VERSION } from "./metrics-schema.js";

export type MetricsSqlValue = string | number | bigint | null;

export interface MetricsSqlRunResult {
  changes: number;
}

export interface MetricsSqlAdapter {
  execute(sql: string): void;
  run(sql: string, parameters?: readonly MetricsSqlValue[]): MetricsSqlRunResult;
  all<Row>(sql: string, parameters?: readonly MetricsSqlValue[]): Row[];
  transaction<T>(callback: () => T): T;
}

export interface MetricsStoreOptions {
  source?: MetricsSource;
  retentionMs?: number;
  cleanupIntervalMs?: number;
}

export interface MetricsWriteOptions {
  receivedAt?: number | Date;
}

export interface MetricsWriteResult {
  recordedUsage: number;
  recordedAvailability: number;
  ignoredProbes: number;
}

export interface MetricsTotalRow {
  eventType: UsageMetricEventType;
  total: number;
  updatedAt: number;
}

export interface MetricsSeriesRow {
  bucket: number;
  eventType: UsageMetricEventType;
  count: number;
}

export interface MetricsTimelineBucket {
  bucket: number;
  total: number;
  events: Record<UsageMetricEventType, number>;
}

export interface MetricsTimeline {
  range: MetricsRange;
  granularity: MetricsGranularity;
  buckets: MetricsTimelineBucket[];
}

export interface MetricsGeoCountry {
  countryCode: string;
  calls: number;
  uniqueVisitors: number;
}

export interface MetricsGeoRegion {
  countryCode: string;
  regionCode: string;
  calls: number;
  uniqueVisitors: number;
}

export interface MetricsGeoResult {
  range: MetricsRange;
  countries: MetricsGeoCountry[];
  regions: MetricsGeoRegion[];
}

export interface AvailabilityHourlyBucket {
  bucket: number;
  status: AvailabilityStatus;
  httpLatencyMs?: number;
  websocketLatencyMs?: number;
}

export interface AvailabilityDailyBucket {
  bucket: number;
  upHours: number;
  totalHours: number;
  ratio: number | null;
  httpLatencyMs?: number;
  websocketLatencyMs?: number;
}

export interface AvailabilityResult {
  range: MetricsRange;
  monitoringStartedAt?: number;
  buckets: Array<{
    time: number;
    status: AvailabilityStatus;
    httpLatencyMs?: number;
    websocketLatencyMs?: number;
  }>;
  hourly: AvailabilityHourlyBucket[];
  daily: AvailabilityDailyBucket[];
}

export interface MetricsSummary {
  totalCalls: number;
  calls24h: number;
  uniqueVisitors24h: number;
  uniqueVisitors30d: number;
  availability30d: number | null;
}

export interface MetricsMonitoringStart {
  usage?: number;
  availability?: number;
}

export interface MetricsSnapshot {
  generatedAt: number;
  source: MetricsSource;
  monitoringStartedAt: MetricsMonitoringStart;
  summary: MetricsSummary;
  timeline: MetricsTimeline;
  geo: MetricsGeoResult;
  availability: AvailabilityResult;
}

export interface MetricsCleanupResult {
  cutoff: number;
  deletedRows: number;
}

type UsageAggregate = {
  bucket?: number;
  countryCode?: string;
  regionCode?: string;
  eventType: UsageMetricEventType;
  count: number;
  updatedAt: number;
};

type VisitorAggregate = {
  bucket: number;
  visitorHash: string;
  countryCode: string;
  regionCode: string;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
};

const UPSERT_TOTAL = `INSERT INTO metrics_totals (event_type, total, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (event_type) DO UPDATE SET
    total = metrics_totals.total + excluded.total,
    updated_at = MAX(metrics_totals.updated_at, excluded.updated_at)`;

const UPSERT_HOURLY = `INSERT INTO metrics_hourly (bucket_start, event_type, count)
  VALUES (?, ?, ?)
  ON CONFLICT (bucket_start, event_type) DO UPDATE SET
    count = metrics_hourly.count + excluded.count`;

const UPSERT_DAILY = `INSERT INTO metrics_daily (bucket_start, event_type, count)
  VALUES (?, ?, ?)
  ON CONFLICT (bucket_start, event_type) DO UPDATE SET
    count = metrics_daily.count + excluded.count`;

const UPSERT_GEO_DAILY = `INSERT INTO metrics_geo_daily
  (bucket_start, country_code, region_code, event_type, count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (bucket_start, country_code, region_code, event_type) DO UPDATE SET
    count = metrics_geo_daily.count + excluded.count`;

const UPSERT_GEO_HOURLY = `INSERT INTO metrics_geo_hourly
  (bucket_start, country_code, region_code, event_type, count)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (bucket_start, country_code, region_code, event_type) DO UPDATE SET
    count = metrics_geo_hourly.count + excluded.count`;

const UPSERT_VISITOR_DAILY = `INSERT INTO metrics_visitors_daily
  (
    bucket_start, visitor_hash, country_code, region_code,
    first_seen_at, last_seen_at, event_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (bucket_start, visitor_hash, country_code, region_code) DO UPDATE SET
    first_seen_at = MIN(metrics_visitors_daily.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(metrics_visitors_daily.last_seen_at, excluded.last_seen_at),
    event_count = metrics_visitors_daily.event_count + excluded.event_count`;

const UPSERT_VISITOR_HOURLY = `INSERT INTO metrics_visitors_hourly
  (
    bucket_start, visitor_hash, country_code, region_code,
    first_seen_at, last_seen_at, event_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (bucket_start, visitor_hash, country_code, region_code) DO UPDATE SET
    first_seen_at = MIN(metrics_visitors_hourly.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(metrics_visitors_hourly.last_seen_at, excluded.last_seen_at),
    event_count = metrics_visitors_hourly.event_count + excluded.event_count`;

const HOURLY_DIMENSIONS_COVERAGE_KEY = "hourly_dimensions_coverage_started_at";

export class SqlMetricsStore {
  readonly source: MetricsSource;
  private readonly retentionMs: number;
  private readonly cleanupIntervalMs: number;
  private lastCleanupAt = 0;

  constructor(
    private readonly adapter: MetricsSqlAdapter,
    options: MetricsStoreOptions = {}
  ) {
    this.source = options.source ?? "node";
    this.retentionMs = options.retentionMs ?? METRICS_RETENTION_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DAY_MS;
    this.initialize();
  }

  initialize(): void {
    this.adapter.execute(METRICS_SCHEMA_STATEMENTS[0]);
    const storedVersion = this.readMetaNumber("schema_version");
    if (storedVersion !== undefined && storedVersion > METRICS_SCHEMA_VERSION) {
      throw new Error(
        `metrics schema version ${storedVersion} is newer than supported version ${METRICS_SCHEMA_VERSION}`
      );
    }
    for (const statement of METRICS_SCHEMA_STATEMENTS.slice(1)) {
      this.adapter.execute(statement);
    }
    this.initializeHourlyDimensionsCoverage();
    if (storedVersion !== METRICS_SCHEMA_VERSION) {
      this.writeMeta("schema_version", METRICS_SCHEMA_VERSION);
    }
    this.writeMeta("source", this.source);
    this.lastCleanupAt = this.readMetaNumber("last_cleanup_at") ?? 0;
  }

  record(event: MetricsEvent, context?: NormalizedConnectionContext, occurredAt?: number | Date): void {
    const record = createMetricRecord(event, context, occurredAt);
    this.write([record]);
  }

  write(
    records: readonly MetricRecord[],
    options: MetricsWriteOptions | number | Date = {}
  ): MetricsWriteResult {
    const receivedAt = normalizeTimestamp(
      typeof options === "number" || options instanceof Date
        ? options
        : options.receivedAt ?? Date.now()
    );
    const normalized = records.map((record) =>
      createMetricRecord(record.event, record.context, record.occurredAt)
    );
    let recordedUsage = 0;
    let recordedAvailability = 0;
    let ignoredProbes = 0;

    this.adapter.transaction(() => {
      const totals = new Map<string, UsageAggregate>();
      const hourly = new Map<string, UsageAggregate>();
      const daily = new Map<string, UsageAggregate>();
      const geoHourly = new Map<string, UsageAggregate>();
      const geoDaily = new Map<string, UsageAggregate>();
      const visitorsHourly = new Map<string, VisitorAggregate>();
      const visitorsDaily = new Map<string, VisitorAggregate>();
      const availabilityTargets = new Set<string>();

      for (const record of normalized) {
        if (isAvailabilityMetricEvent(record.event)) {
          this.upsertAvailability(record);
          availabilityTargets.add(record.event.target);
          recordedAvailability += 1;
          continue;
        }
        if (record.context.isProbe) {
          ignoredProbes += record.event.count;
          continue;
        }
        recordedUsage += record.event.count;
        this.updateEarliestMeta("usage_monitoring_started_at", record.occurredAt);
        this.aggregateUsage(
          { ...record, event: record.event as NormalizedUsageMetricEvent },
          totals,
          hourly,
          daily,
          geoHourly,
          geoDaily,
          visitorsHourly,
          visitorsDaily
        );
      }

      this.persistUsage(
        totals,
        hourly,
        daily,
        geoHourly,
        geoDaily,
        visitorsHourly,
        visitorsDaily
      );
      for (const target of availabilityTargets) {
        this.settleAvailabilityTarget(target, receivedAt);
      }
    });

    if (receivedAt - this.lastCleanupAt >= this.cleanupIntervalMs) {
      this.cleanup(receivedAt);
    }
    return { recordedUsage, recordedAvailability, ignoredProbes };
  }

  queryTotals(): MetricsTotalRow[] {
    return this.adapter
      .all<RawTotalRow>(
        `SELECT event_type, total, updated_at
         FROM metrics_totals ORDER BY event_type`
      )
      .map((row) => ({
        eventType: storedEventType(row.event_type),
        total: toNumber(row.total),
        updatedAt: toNumber(row.updated_at)
      }));
  }

  queryHourly(range: MetricsRange): MetricsSeriesRow[] {
    const normalized = normalizeRange(range, "hour");
    return this.querySeries("metrics_hourly", normalized);
  }

  queryDaily(range: MetricsRange): MetricsSeriesRow[] {
    const normalized = normalizeRange(range, "day");
    return this.querySeries("metrics_daily", normalized);
  }

  getEarliestDailyBucket(): number | undefined {
    const row = this.adapter.all<{ bucket: MetricsSqlValue }>(
      "SELECT MIN(bucket_start) AS bucket FROM metrics_daily"
    )[0];
    return nullableNumber(row?.bucket);
  }

  queryTimeline(
    input: MetricsRangeInput | URLSearchParams | string | undefined,
    now: number | Date = Date.now()
  ): MetricsTimeline {
    const range = parseMetricsTimelineRange(input, this.getEarliestDailyBucket(), now);
    const rows =
      range.granularity === "hour" ? this.queryHourly(range) : this.queryDaily(range);
    const buckets = new Map<number, MetricsTimelineBucket>();
    const unit = range.granularity === "hour" ? HOUR_MS : DAY_MS;
    for (let bucket = range.from; bucket < range.to; bucket += unit) {
      buckets.set(bucket, { bucket, total: 0, events: emptyEventCounts() });
    }
    for (const row of rows) {
      const bucket = buckets.get(row.bucket);
      if (!bucket) {
        continue;
      }
      bucket.events[row.eventType] += row.count;
      bucket.total += row.count;
    }
    return { range, granularity: range.granularity, buckets: [...buckets.values()] };
  }

  queryUniqueVisitors(range: MetricsRange): number {
    const granularity = range.granularity === "hour" ? "hour" : "day";
    const normalized = normalizeRange(range, granularity);

    if (granularity === "hour" && this.hasHourlyDimensionsCoverage(normalized)) {
      const row = this.adapter.all<{ visitors: MetricsSqlValue }>(
        `SELECT COUNT(DISTINCT visitor_hash) AS visitors
         FROM metrics_visitors_hourly
         WHERE bucket_start >= ? AND bucket_start < ?`,
        [normalized.from, normalized.to]
      )[0];
      return toNumber(row?.visitors ?? 0);
    }

    const dailyRange = granularity === "hour"
      ? overlappingDayRange(normalized)
      : normalized;
    const row = this.adapter.all<{ visitors: MetricsSqlValue }>(
      `SELECT COUNT(DISTINCT visitor_hash) AS visitors
       FROM metrics_visitors_daily
       WHERE bucket_start >= ? AND bucket_start < ?`,
      [dailyRange.from, dailyRange.to]
    )[0];
    return toNumber(row?.visitors ?? 0);
  }

  queryGeo(range: MetricsRange): MetricsGeoResult {
    const granularity = range.granularity === "hour" ? "hour" : "day";
    const normalized = normalizeRange(range, granularity);

    let callsByCountry: RawGeoCountryRow[];
    let visitorsByCountry: RawGeoCountryVisitorsRow[];
    let callsByRegion: RawGeoRegionRow[];
    let visitorsByRegion: RawGeoRegionVisitorsRow[];

    if (granularity === "hour" && this.hasHourlyDimensionsCoverage(normalized)) {
      callsByCountry = this.adapter.all<RawGeoCountryRow>(
        `SELECT country_code, SUM(count) AS calls
         FROM metrics_geo_hourly
         WHERE bucket_start >= ? AND bucket_start < ?
         GROUP BY country_code`,
        [normalized.from, normalized.to]
      );
      visitorsByCountry = this.adapter.all<RawGeoCountryVisitorsRow>(
        `SELECT country_code, COUNT(DISTINCT visitor_hash) AS visitors
         FROM metrics_visitors_hourly
         WHERE bucket_start >= ? AND bucket_start < ?
         GROUP BY country_code`,
        [normalized.from, normalized.to]
      );
      callsByRegion = this.adapter.all<RawGeoRegionRow>(
        `SELECT country_code, region_code, SUM(count) AS calls
         FROM metrics_geo_hourly
         WHERE bucket_start >= ? AND bucket_start < ? AND region_code <> ''
         GROUP BY country_code, region_code`,
        [normalized.from, normalized.to]
      );
      visitorsByRegion = this.adapter.all<RawGeoRegionVisitorsRow>(
        `SELECT country_code, region_code, COUNT(DISTINCT visitor_hash) AS visitors
         FROM metrics_visitors_hourly
         WHERE bucket_start >= ? AND bucket_start < ? AND region_code <> ''
         GROUP BY country_code, region_code`,
        [normalized.from, normalized.to]
      );
    } else {
      const dailyRange = granularity === "hour"
        ? overlappingDayRange(normalized)
        : normalized;
      callsByCountry = this.adapter.all<RawGeoCountryRow>(
        `SELECT country_code, SUM(count) AS calls
         FROM metrics_geo_daily
         WHERE bucket_start >= ? AND bucket_start < ?
         GROUP BY country_code`,
        [dailyRange.from, dailyRange.to]
      );
      visitorsByCountry = this.adapter.all<RawGeoCountryVisitorsRow>(
        `SELECT country_code, COUNT(DISTINCT visitor_hash) AS visitors
         FROM metrics_visitors_daily
         WHERE bucket_start >= ? AND bucket_start < ?
         GROUP BY country_code`,
        [dailyRange.from, dailyRange.to]
      );
      callsByRegion = this.adapter.all<RawGeoRegionRow>(
        `SELECT country_code, region_code, SUM(count) AS calls
         FROM metrics_geo_daily
         WHERE bucket_start >= ? AND bucket_start < ? AND region_code <> ''
         GROUP BY country_code, region_code`,
        [dailyRange.from, dailyRange.to]
      );
      visitorsByRegion = this.adapter.all<RawGeoRegionVisitorsRow>(
        `SELECT country_code, region_code, COUNT(DISTINCT visitor_hash) AS visitors
         FROM metrics_visitors_daily
         WHERE bucket_start >= ? AND bucket_start < ? AND region_code <> ''
         GROUP BY country_code, region_code`,
        [dailyRange.from, dailyRange.to]
      );
    }

    const countries = new Map<string, MetricsGeoCountry>();
    for (const row of callsByCountry) {
      getCountry(countries, String(row.country_code)).calls = toNumber(row.calls);
    }
    for (const row of visitorsByCountry) {
      getCountry(countries, String(row.country_code)).uniqueVisitors = toNumber(row.visitors);
    }
    const regions = new Map<string, MetricsGeoRegion>();
    for (const row of callsByRegion) {
      const value = getRegion(regions, String(row.country_code), String(row.region_code));
      value.calls = toNumber(row.calls);
    }
    for (const row of visitorsByRegion) {
      const value = getRegion(regions, String(row.country_code), String(row.region_code));
      value.uniqueVisitors = toNumber(row.visitors);
    }
    return {
      range: normalized,
      countries: [...countries.values()].sort((a, b) => b.calls - a.calls),
      regions: [...regions.values()].sort((a, b) => b.calls - a.calls)
    };
  }

  queryAvailability(
    range: MetricsRange,
    target: string,
    now: number | Date = Date.now()
  ): AvailabilityResult {
    const generatedAt = normalizeTimestamp(now);
    const monitoringStartedAt = this.getAvailabilityMonitoringStart(target);
    const hourlyRange = normalizeRange(range, "hour");
    const rows = this.adapter.all<RawAvailabilityHourlyRow>(
      `SELECT bucket_start, status_rank, checks,
              http_latency_sum, http_latency_samples,
              websocket_latency_sum, websocket_latency_samples
       FROM availability_hourly
       WHERE target = ? AND bucket_start >= ? AND bucket_start < ?
       ORDER BY bucket_start`,
      [target, hourlyRange.from, hourlyRange.to]
    );
    const rowMap = new Map(rows.map((row) => [toNumber(row.bucket_start), row]));
    const currentHour = utcHourBucket(generatedAt);
    const minute = new Date(generatedAt).getUTCMinutes();
    const start = Math.max(hourlyRange.from, monitoringStartedAt ?? hourlyRange.to);
    const hourly: AvailabilityHourlyBucket[] = [];
    for (let bucket = start; bucket < hourlyRange.to; bucket += HOUR_MS) {
      const row = rowMap.get(bucket);
      if (bucket > currentHour) {
        break;
      }
      if (bucket === currentHour && minute < 15) {
        hourly.push({ bucket, status: "pending" });
        continue;
      }
      hourly.push(row ? mapAvailabilityHour(row) : { bucket, status: "down" });
    }

    const dayRange = normalizeRange(range, "day");
    const daily = this.adapter
      .all<RawAvailabilityDailyRow>(
        `SELECT bucket_start, up_hours, total_hours,
                http_latency_sum, http_latency_samples,
                websocket_latency_sum, websocket_latency_samples
         FROM availability_daily
         WHERE target = ? AND bucket_start >= ? AND bucket_start < ?
         ORDER BY bucket_start`,
        [target, dayRange.from, dayRange.to]
      )
      .map(mapAvailabilityDay);
    return {
      range,
      monitoringStartedAt,
      buckets: hourly.map((bucket) => ({
        time: bucket.bucket,
        status: bucket.status,
        ...(bucket.httpLatencyMs === undefined
          ? {}
          : { httpLatencyMs: bucket.httpLatencyMs }),
        ...(bucket.websocketLatencyMs === undefined
          ? {}
          : { websocketLatencyMs: bucket.websocketLatencyMs })
      })),
      hourly,
      daily
    };
  }

  settleAvailability(target: string, now: number | Date = Date.now()): void {
    const current = normalizeTimestamp(now);
    this.adapter.transaction(() => this.settleAvailabilityTarget(target, current));
  }

  queryAvailabilityDaily(range: MetricsRange, target: string): AvailabilityDailyBucket[] {
    const normalized = normalizeRange(range, "day");
    return this.adapter
      .all<RawAvailabilityDailyRow>(
        `SELECT bucket_start, up_hours, total_hours,
                http_latency_sum, http_latency_samples,
                websocket_latency_sum, websocket_latency_samples
         FROM availability_daily
         WHERE target = ? AND bucket_start >= ? AND bucket_start < ?
         ORDER BY bucket_start`,
        [target, normalized.from, normalized.to]
      )
      .map(mapAvailabilityDay);
  }

  querySummary(target: string, now: number | Date = Date.now()): MetricsSummary {
    const generatedAt = normalizeTimestamp(now);
    const range24h = parseMetricsRange("24h", generatedAt);
    const range30d = parseMetricsRange("30d", generatedAt);
    const availability = this.queryAvailability(range30d, target, generatedAt);
    const settled = availability.hourly.filter((bucket) => bucket.status !== "pending");
    const up = settled.filter((bucket) => bucket.status === "up").length;
    return {
      totalCalls: sum(this.queryTotals().map((row) => row.total)),
      calls24h: sum(this.queryHourly(range24h).map((row) => row.count)),
      uniqueVisitors24h: this.queryUniqueVisitors(range24h),
      uniqueVisitors30d: this.queryUniqueVisitors(range30d),
      availability30d: settled.length > 0 ? (up / settled.length) * 100 : null
    };
  }

  querySnapshot(
    options: {
      timeline?: MetricsRangeInput | URLSearchParams | string;
      geo?: MetricsRangeInput | URLSearchParams | string;
      availability?: MetricsRangeInput | URLSearchParams | string;
      availabilityTarget: string;
      now?: number | Date;
    }
  ): MetricsSnapshot {
    const generatedAt = normalizeTimestamp(options.now ?? Date.now());
    const geoRange = parseMetricsRange(options.geo ?? "30d", generatedAt);
    const availabilityRange = parseMetricsRange(options.availability ?? "30d", generatedAt);
    return {
      generatedAt,
      source: this.source,
      monitoringStartedAt: {
        usage: this.getUsageMonitoringStart(),
        availability: this.getAvailabilityMonitoringStart(options.availabilityTarget)
      },
      summary: this.querySummary(options.availabilityTarget, generatedAt),
      timeline: this.queryTimeline(options.timeline ?? "24h", generatedAt),
      geo: this.queryGeo(geoRange),
      availability: this.queryAvailability(
        availabilityRange,
        options.availabilityTarget,
        generatedAt
      )
    };
  }

  getUsageMonitoringStart(): number | undefined {
    return this.readMetaNumber("usage_monitoring_started_at");
  }

  getAvailabilityMonitoringStart(target: string): number | undefined {
    return this.readMetaNumber(availabilityStartKey(target));
  }

  cleanup(now: number | Date = Date.now()): MetricsCleanupResult {
    const current = normalizeTimestamp(now);
    const cutoff = current - this.retentionMs;
    const hourCutoff = utcHourBucket(cutoff);
    const dayCutoff = utcDayBucket(cutoff);
    const deletedRows = this.adapter.transaction(() => {
      let deleted = 0;
      deleted += this.adapter.run("DELETE FROM metrics_hourly WHERE bucket_start < ?", [
        hourCutoff
      ]).changes;
      deleted += this.adapter.run("DELETE FROM metrics_geo_hourly WHERE bucket_start < ?", [
        hourCutoff
      ]).changes;
      deleted += this.adapter.run("DELETE FROM metrics_visitors_hourly WHERE bucket_start < ?", [
        hourCutoff
      ]).changes;
      deleted += this.adapter.run(
        "DELETE FROM metrics_visitors_daily WHERE bucket_start < ?",
        [dayCutoff]
      ).changes;
      deleted += this.adapter.run(
        "DELETE FROM availability_hourly WHERE bucket_start < ?",
        [hourCutoff]
      ).changes;
      this.writeMeta("last_cleanup_at", current);
      return deleted;
    });
    this.lastCleanupAt = current;
    return { cutoff, deletedRows };
  }

  private aggregateUsage(
    record: MetricRecord & { event: NormalizedUsageMetricEvent },
    totals: Map<string, UsageAggregate>,
    hourly: Map<string, UsageAggregate>,
    daily: Map<string, UsageAggregate>,
    geoHourly: Map<string, UsageAggregate>,
    geoDaily: Map<string, UsageAggregate>,
    visitorsHourly: Map<string, VisitorAggregate>,
    visitorsDaily: Map<string, VisitorAggregate>
  ): void {
    const hour = utcHourBucket(record.occurredAt);
    const day = utcDayBucket(record.occurredAt);
    const base: UsageAggregate = {
      eventType: record.event.type,
      count: record.event.count,
      updatedAt: record.occurredAt
    };
    addUsage(totals, [base.eventType], base);
    addUsage(hourly, [hour, base.eventType], { ...base, bucket: hour });
    addUsage(daily, [day, base.eventType], { ...base, bucket: day });
    addUsage(
      geoHourly,
      [hour, record.context.countryCode, record.context.regionCode, base.eventType],
      {
        ...base,
        bucket: hour,
        countryCode: record.context.countryCode,
        regionCode: record.context.regionCode
      }
    );
    addUsage(
      geoDaily,
      [day, record.context.countryCode, record.context.regionCode, base.eventType],
      {
        ...base,
        bucket: day,
        countryCode: record.context.countryCode,
        regionCode: record.context.regionCode
      }
    );
    if (record.context.visitorHash) {
      addVisitor(
        visitorsHourly,
        [hour, record.context.visitorHash, record.context.countryCode, record.context.regionCode],
        {
          bucket: hour,
          visitorHash: record.context.visitorHash,
          countryCode: record.context.countryCode,
          regionCode: record.context.regionCode,
          firstSeenAt: record.occurredAt,
          lastSeenAt: record.occurredAt,
          eventCount: record.event.count
        }
      );
      addVisitor(
        visitorsDaily,
        [day, record.context.visitorHash, record.context.countryCode, record.context.regionCode],
        {
          bucket: day,
          visitorHash: record.context.visitorHash,
          countryCode: record.context.countryCode,
          regionCode: record.context.regionCode,
          firstSeenAt: record.occurredAt,
          lastSeenAt: record.occurredAt,
          eventCount: record.event.count
        }
      );
    }
  }

  private persistUsage(
    totals: Map<string, UsageAggregate>,
    hourly: Map<string, UsageAggregate>,
    daily: Map<string, UsageAggregate>,
    geoHourly: Map<string, UsageAggregate>,
    geoDaily: Map<string, UsageAggregate>,
    visitorsHourly: Map<string, VisitorAggregate>,
    visitorsDaily: Map<string, VisitorAggregate>
  ): void {
    for (const value of totals.values()) {
      this.adapter.run(UPSERT_TOTAL, [value.eventType, value.count, value.updatedAt]);
    }
    for (const value of hourly.values()) {
      this.adapter.run(UPSERT_HOURLY, [value.bucket!, value.eventType, value.count]);
    }
    for (const value of daily.values()) {
      this.adapter.run(UPSERT_DAILY, [value.bucket!, value.eventType, value.count]);
    }
    for (const value of geoHourly.values()) {
      this.adapter.run(UPSERT_GEO_HOURLY, [
        value.bucket!,
        value.countryCode!,
        value.regionCode!,
        value.eventType,
        value.count
      ]);
    }
    for (const value of geoDaily.values()) {
      this.adapter.run(UPSERT_GEO_DAILY, [
        value.bucket!,
        value.countryCode!,
        value.regionCode!,
        value.eventType,
        value.count
      ]);
    }
    for (const value of visitorsHourly.values()) {
      this.adapter.run(UPSERT_VISITOR_HOURLY, [
        value.bucket,
        value.visitorHash,
        value.countryCode,
        value.regionCode,
        value.firstSeenAt,
        value.lastSeenAt,
        value.eventCount
      ]);
    }
    for (const value of visitorsDaily.values()) {
      this.adapter.run(UPSERT_VISITOR_DAILY, [
        value.bucket,
        value.visitorHash,
        value.countryCode,
        value.regionCode,
        value.firstSeenAt,
        value.lastSeenAt,
        value.eventCount
      ]);
    }
  }

  private upsertAvailability(record: MetricRecord): void {
    if (!isAvailabilityMetricEvent(record.event)) {
      return;
    }
    const event = record.event;
    const bucket = utcHourBucket(record.occurredAt);
    const rank = statusRank(availabilityStatus(event.httpOk, event.websocketOk));
    const previous = this.adapter.all<{ status_rank: MetricsSqlValue }>(
      "SELECT status_rank FROM availability_hourly WHERE bucket_start = ? AND target = ?",
      [bucket, event.target]
    )[0];
    const previousRank = previous ? toNumber(previous.status_rank) : undefined;
    const httpLatency = event.httpLatencyMs ?? 0;
    const websocketLatency = event.websocketLatencyMs ?? 0;
    this.adapter.run(
      `INSERT INTO availability_hourly
       (
         bucket_start, target, status_rank, checks,
         http_latency_sum, http_latency_samples,
         websocket_latency_sum, websocket_latency_samples, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT (bucket_start, target) DO UPDATE SET
         status_rank = MAX(availability_hourly.status_rank, excluded.status_rank),
         checks = availability_hourly.checks + 1,
         http_latency_sum = availability_hourly.http_latency_sum + excluded.http_latency_sum,
         http_latency_samples = availability_hourly.http_latency_samples + excluded.http_latency_samples,
         websocket_latency_sum = availability_hourly.websocket_latency_sum + excluded.websocket_latency_sum,
         websocket_latency_samples = availability_hourly.websocket_latency_samples + excluded.websocket_latency_samples,
         updated_at = MAX(availability_hourly.updated_at, excluded.updated_at)`,
      [
        bucket,
        event.target,
        rank,
        httpLatency,
        event.httpLatencyMs === undefined ? 0 : 1,
        websocketLatency,
        event.websocketLatencyMs === undefined ? 0 : 1,
        record.occurredAt
      ]
    );
    this.updateEarliestMeta(availabilityStartKey(event.target), bucket);
    this.updateEarliestMeta("availability_monitoring_started_at", bucket);

    const settledUntil = this.readMetaNumber(availabilitySettledKey(event.target));
    if (settledUntil !== undefined && bucket < settledUntil) {
      const upDelta = (previousRank ?? 0) < 2 && rank === 2 ? 1 : 0;
      this.upsertAvailabilityDay(
        utcDayBucket(bucket),
        event.target,
        upDelta,
        0,
        httpLatency,
        event.httpLatencyMs === undefined ? 0 : 1,
        websocketLatency,
        event.websocketLatencyMs === undefined ? 0 : 1
      );
    }
  }

  private settleAvailabilityTarget(target: string, now: number): void {
    const start = this.getAvailabilityMonitoringStart(target);
    if (start === undefined) {
      return;
    }
    const currentHour = utcHourBucket(now);
    const storedCursor = this.readMetaNumber(availabilitySettledKey(target));
    let cursor = storedCursor ?? start;
    cursor = Math.max(cursor, start);
    for (; cursor < currentHour; cursor += HOUR_MS) {
      const row = this.adapter.all<RawAvailabilityHourlyRow>(
        `SELECT bucket_start, status_rank, checks,
                http_latency_sum, http_latency_samples,
                websocket_latency_sum, websocket_latency_samples
         FROM availability_hourly WHERE bucket_start = ? AND target = ?`,
        [cursor, target]
      )[0];
      const rank = row ? toNumber(row.status_rank) : 0;
      this.upsertAvailabilityDay(
        utcDayBucket(cursor),
        target,
        rank === 2 ? 1 : 0,
        1,
        row ? toNumber(row.http_latency_sum) : 0,
        row ? toNumber(row.http_latency_samples) : 0,
        row ? toNumber(row.websocket_latency_sum) : 0,
        row ? toNumber(row.websocket_latency_samples) : 0
      );
    }
    if (cursor !== storedCursor) {
      this.writeMeta(availabilitySettledKey(target), cursor);
    }
  }

  private upsertAvailabilityDay(
    day: number,
    target: string,
    upHours: number,
    totalHours: number,
    httpLatencySum: number,
    httpLatencySamples: number,
    websocketLatencySum: number,
    websocketLatencySamples: number
  ): void {
    this.adapter.run(
      `INSERT INTO availability_daily
       (
         bucket_start, target, up_hours, total_hours,
         http_latency_sum, http_latency_samples,
         websocket_latency_sum, websocket_latency_samples
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bucket_start, target) DO UPDATE SET
         up_hours = availability_daily.up_hours + excluded.up_hours,
         total_hours = availability_daily.total_hours + excluded.total_hours,
         http_latency_sum = availability_daily.http_latency_sum + excluded.http_latency_sum,
         http_latency_samples = availability_daily.http_latency_samples + excluded.http_latency_samples,
         websocket_latency_sum = availability_daily.websocket_latency_sum + excluded.websocket_latency_sum,
         websocket_latency_samples = availability_daily.websocket_latency_samples + excluded.websocket_latency_samples`,
      [
        day,
        target,
        upHours,
        totalHours,
        httpLatencySum,
        httpLatencySamples,
        websocketLatencySum,
        websocketLatencySamples
      ]
    );
  }

  private querySeries(
    table: "metrics_hourly" | "metrics_daily",
    range: MetricsRange
  ): MetricsSeriesRow[] {
    return this.adapter
      .all<RawSeriesRow>(
        `SELECT bucket_start, event_type, count FROM ${table}
         WHERE bucket_start >= ? AND bucket_start < ?
         ORDER BY bucket_start, event_type`,
        [range.from, range.to]
      )
      .map((row) => ({
        bucket: toNumber(row.bucket_start),
        eventType: storedEventType(row.event_type),
        count: toNumber(row.count)
      }));
  }

  private updateEarliestMeta(key: string, timestamp: number): void {
    this.adapter.run(
      `INSERT INTO metrics_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = CASE
         WHEN CAST(metrics_meta.value AS INTEGER) > CAST(excluded.value AS INTEGER)
         THEN excluded.value ELSE metrics_meta.value END`,
      [key, String(timestamp)]
    );
  }

  private initializeHourlyDimensionsCoverage(): void {
    if (this.readMetaNumber(HOURLY_DIMENSIONS_COVERAGE_KEY) !== undefined) {
      return;
    }
    const earliestHourly = nullableNumber(
      this.adapter.all<{ bucket: MetricsSqlValue }>(
        "SELECT MIN(bucket_start) AS bucket FROM metrics_geo_hourly"
      )[0]?.bucket
    );
    if (earliestHourly !== undefined) {
      // The first V2 bucket may contain only the post-upgrade part of an hour.
      this.writeMeta(HOURLY_DIMENSIONS_COVERAGE_KEY, earliestHourly + HOUR_MS);
      return;
    }
    const hasLegacyDailyData = this.adapter.all<{ present: MetricsSqlValue }>(
      "SELECT 1 AS present FROM metrics_geo_daily LIMIT 1"
    ).length > 0;
    this.writeMeta(
      HOURLY_DIMENSIONS_COVERAGE_KEY,
      hasLegacyDailyData ? utcHourBucket(Date.now()) + HOUR_MS : 0
    );
  }

  private hasHourlyDimensionsCoverage(range: MetricsRange): boolean {
    const coverageStartedAt = this.readMetaNumber(HOURLY_DIMENSIONS_COVERAGE_KEY);
    return coverageStartedAt !== undefined && range.from >= coverageStartedAt;
  }

  private readMetaNumber(key: string): number | undefined {
    const row = this.adapter.all<{ value: MetricsSqlValue }>(
      "SELECT value FROM metrics_meta WHERE key = ?",
      [key]
    )[0];
    return row ? nullableNumber(row.value) : undefined;
  }

  private writeMeta(key: string, value: string | number): void {
    this.adapter.run(
      `INSERT INTO metrics_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, String(value)]
    );
  }
}

type RawTotalRow = {
  event_type: MetricsSqlValue;
  total: MetricsSqlValue;
  updated_at: MetricsSqlValue;
};

type RawSeriesRow = {
  bucket_start: MetricsSqlValue;
  event_type: MetricsSqlValue;
  count: MetricsSqlValue;
};

type RawGeoCountryRow = { country_code: MetricsSqlValue; calls: MetricsSqlValue };
type RawGeoCountryVisitorsRow = {
  country_code: MetricsSqlValue;
  visitors: MetricsSqlValue;
};
type RawGeoRegionRow = {
  country_code: MetricsSqlValue;
  region_code: MetricsSqlValue;
  calls: MetricsSqlValue;
};
type RawGeoRegionVisitorsRow = {
  country_code: MetricsSqlValue;
  region_code: MetricsSqlValue;
  visitors: MetricsSqlValue;
};

type RawAvailabilityHourlyRow = {
  bucket_start: MetricsSqlValue;
  status_rank: MetricsSqlValue;
  checks: MetricsSqlValue;
  http_latency_sum: MetricsSqlValue;
  http_latency_samples: MetricsSqlValue;
  websocket_latency_sum: MetricsSqlValue;
  websocket_latency_samples: MetricsSqlValue;
};

type RawAvailabilityDailyRow = {
  bucket_start: MetricsSqlValue;
  up_hours: MetricsSqlValue;
  total_hours: MetricsSqlValue;
  http_latency_sum: MetricsSqlValue;
  http_latency_samples: MetricsSqlValue;
  websocket_latency_sum: MetricsSqlValue;
  websocket_latency_samples: MetricsSqlValue;
};

function addUsage(
  map: Map<string, UsageAggregate>,
  dimensions: readonly MetricsSqlValue[],
  value: UsageAggregate
): void {
  const key = JSON.stringify(dimensions);
  const existing = map.get(key);
  if (existing) {
    existing.count += value.count;
    existing.updatedAt = Math.max(existing.updatedAt, value.updatedAt);
  } else {
    map.set(key, { ...value });
  }
}

function addVisitor(
  map: Map<string, VisitorAggregate>,
  dimensions: readonly MetricsSqlValue[],
  value: VisitorAggregate
): void {
  const key = JSON.stringify(dimensions);
  const existing = map.get(key);
  if (existing) {
    existing.firstSeenAt = Math.min(existing.firstSeenAt, value.firstSeenAt);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, value.lastSeenAt);
    existing.eventCount += value.eventCount;
  } else {
    map.set(key, { ...value });
  }
}

function emptyEventCounts(): Record<UsageMetricEventType, number> {
  return {
    room_created: 0,
    room_joined: 0,
    send_favorite: 0,
    send_history: 0,
    send_shield_word: 0,
    send_bili_account: 0
  };
}

function getCountry(
  map: Map<string, MetricsGeoCountry>,
  countryCode: string
): MetricsGeoCountry {
  const existing = map.get(countryCode);
  if (existing) {
    return existing;
  }
  const created = { countryCode, calls: 0, uniqueVisitors: 0 };
  map.set(countryCode, created);
  return created;
}

function getRegion(
  map: Map<string, MetricsGeoRegion>,
  countryCode: string,
  regionCode: string
): MetricsGeoRegion {
  const key = `${countryCode}:${regionCode}`;
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = { countryCode, regionCode, calls: 0, uniqueVisitors: 0 };
  map.set(key, created);
  return created;
}

function mapAvailabilityHour(row: RawAvailabilityHourlyRow): AvailabilityHourlyBucket {
  const httpSamples = toNumber(row.http_latency_samples);
  const websocketSamples = toNumber(row.websocket_latency_samples);
  return {
    bucket: toNumber(row.bucket_start),
    status: rankStatus(toNumber(row.status_rank)),
    httpLatencyMs:
      httpSamples > 0 ? toNumber(row.http_latency_sum) / httpSamples : undefined,
    websocketLatencyMs:
      websocketSamples > 0
        ? toNumber(row.websocket_latency_sum) / websocketSamples
        : undefined
  };
}

function mapAvailabilityDay(row: RawAvailabilityDailyRow): AvailabilityDailyBucket {
  const upHours = toNumber(row.up_hours);
  const totalHours = toNumber(row.total_hours);
  const httpSamples = toNumber(row.http_latency_samples);
  const websocketSamples = toNumber(row.websocket_latency_samples);
  return {
    bucket: toNumber(row.bucket_start),
    upHours,
    totalHours,
    ratio: totalHours > 0 ? upHours / totalHours : null,
    httpLatencyMs:
      httpSamples > 0 ? toNumber(row.http_latency_sum) / httpSamples : undefined,
    websocketLatencyMs:
      websocketSamples > 0
        ? toNumber(row.websocket_latency_sum) / websocketSamples
        : undefined
  };
}

function statusRank(status: AvailabilityStatus): number {
  if (status === "up") {
    return 2;
  }
  if (status === "degraded") {
    return 1;
  }
  return 0;
}

function rankStatus(rank: number): AvailabilityStatus {
  if (rank >= 2) {
    return "up";
  }
  return rank === 1 ? "degraded" : "down";
}

function availabilityStartKey(target: string): string {
  return `availability_monitoring_started_at:${target}`;
}

function availabilitySettledKey(target: string): string {
  return `availability_settled_until:${target}`;
}

function normalizeRange(range: MetricsRange, granularity: MetricsGranularity): MetricsRange {
  const unit = granularity === "hour" ? HOUR_MS : DAY_MS;
  return {
    from: Math.floor(range.from / unit) * unit,
    to: Math.ceil(range.to / unit) * unit,
    granularity,
    preset: range.preset
  };
}

function overlappingDayRange(range: MetricsRange): MetricsRange {
  return {
    from: utcDayBucket(range.from),
    to: utcDayBucket(range.to - 1) + DAY_MS,
    granularity: "day",
    preset: range.preset
  };
}

function normalizeTimestamp(value: number | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError("metrics store timestamp must be non-negative and finite");
  }
  return Math.floor(timestamp);
}

function storedEventType(value: MetricsSqlValue): UsageMetricEventType {
  if ((USAGE_METRIC_EVENT_TYPES as readonly unknown[]).includes(value)) {
    return value as UsageMetricEventType;
  }
  throw new TypeError(`stored metrics event type is invalid: ${String(value)}`);
}

function nullableNumber(value: MetricsSqlValue | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return toNumber(value);
}

function toNumber(value: MetricsSqlValue): number {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new TypeError(`stored metrics value is not numeric: ${String(value)}`);
  }
  return result;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
