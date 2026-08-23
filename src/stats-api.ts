import { MetricsRangeError, parseMetricsRange } from "./metrics.js";
import { SqlMetricsStore } from "./metrics-store.js";

const DETAIL_RANGES = ["24h", "7d", "30d", "90d"] as const;
const TIMELINE_RANGES = [...DETAIL_RANGES, "all"] as const;

export const STATS_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

export type StatsApiResult = {
  status: number;
  payload: unknown;
};

export function queryStatsApi(
  store: SqlMetricsStore,
  url: URL,
  availabilityTarget: string,
  now: number | Date = Date.now()
): StatsApiResult {
  const generatedAt = timestamp(now);
  try {
    switch (url.pathname) {
      case "/api/stats/summary": {
        rejectUnexpectedParameters(url.searchParams, []);
        const summary = store.querySummary(availabilityTarget, generatedAt);
        return ok({
          totalCalls: summary.totalCalls,
          calls24h: summary.calls24h,
          uniqueVisitors30d: summary.uniqueVisitors30d,
          availability30d: summary.availability30d,
          monitoringStartedAt: isoOrNull(
            store.getAvailabilityMonitoringStart(availabilityTarget)
          ),
          generatedAt: new Date(generatedAt).toISOString()
        });
      }
      case "/api/stats/timeline": {
        const range = readRange(url.searchParams, TIMELINE_RANGES, "24h");
        const result = store.queryTimeline(range, generatedAt);
        return ok({
          range,
          granularity: result.granularity,
          buckets: result.buckets.map((bucket) => ({
            time: new Date(bucket.bucket).toISOString(),
            total: bucket.total,
            events: bucket.events
          }))
        });
      }
      case "/api/stats/geo": {
        const range = readRange(url.searchParams, DETAIL_RANGES, "30d");
        const result = store.queryGeo(parseMetricsRange(range, generatedAt));
        return ok({
          range,
          countries: result.countries,
          regions: result.regions.filter((row) => row.countryCode === "CN")
        });
      }
      case "/api/stats/availability": {
        const range = readRange(url.searchParams, DETAIL_RANGES, "30d");
        const result = store.queryAvailability(
          parseMetricsRange(range, generatedAt),
          availabilityTarget,
          generatedAt
        );
        return ok({
          range,
          monitoringStartedAt: isoOrNull(result.monitoringStartedAt),
          buckets: result.hourly.map((bucket) => ({
            time: new Date(bucket.bucket).toISOString(),
            status: bucket.status,
            ...(bucket.httpLatencyMs === undefined
              ? {}
              : { httpLatencyMs: roundLatency(bucket.httpLatencyMs) }),
            ...(bucket.websocketLatencyMs === undefined
              ? {}
              : { websocketLatencyMs: roundLatency(bucket.websocketLatencyMs) })
          }))
        });
      }
      default:
        return { status: 404, payload: { status: false, message: "not found" } };
    }
  } catch (error) {
    if (error instanceof MetricsRangeError || error instanceof TypeError) {
      return {
        status: 400,
        payload: { status: false, message: error.message }
      };
    }
    throw error;
  }
}

export function isStatsApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/stats/");
}

function ok(payload: unknown): StatsApiResult {
  return { status: 200, payload };
}

function readRange<const Values extends readonly string[]>(
  parameters: URLSearchParams,
  allowed: Values,
  fallback: Values[number]
): Values[number] {
  rejectUnexpectedParameters(parameters, ["range"]);
  const value = parameters.get("range") ?? fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new MetricsRangeError(`unsupported metrics range: ${value}`);
  }
  return value as Values[number];
}

function rejectUnexpectedParameters(
  parameters: URLSearchParams,
  allowed: readonly string[]
): void {
  for (const key of parameters.keys()) {
    if (!allowed.includes(key)) {
      throw new MetricsRangeError(`unsupported query parameter: ${key}`);
    }
  }
}

function isoOrNull(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

function timestamp(value: number | Date): number {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result)) {
    throw new RangeError("invalid stats API timestamp");
  }
  return result;
}

function roundLatency(value: number): number {
  return Math.round(value * 10) / 10;
}
