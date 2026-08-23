export const METRICS_RETENTION_DAYS = 90;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const METRICS_RETENTION_MS = METRICS_RETENTION_DAYS * DAY_MS;

export const USAGE_METRIC_EVENT_TYPES = [
  "room_created",
  "room_joined",
  "send_favorite",
  "send_history",
  "send_shield_word",
  "send_bili_account"
] as const;

export type UsageMetricEventType = (typeof USAGE_METRIC_EVENT_TYPES)[number];
export type MetricsSource = "node" | "cloudflare";
export type MetricsGranularity = "hour" | "day";
export type AvailabilityStatus = "up" | "degraded" | "down" | "pending";

export interface ConnectionContext {
  source?: MetricsSource;
  visitorHash?: string;
  countryCode?: string;
  regionCode?: string;
  isProbe?: boolean;
}

export interface NormalizedConnectionContext {
  source: MetricsSource;
  visitorHash?: string;
  countryCode: string;
  regionCode: string;
  isProbe: boolean;
}

export interface UsageMetricEvent {
  type: UsageMetricEventType;
  count?: number;
}

export interface AvailabilityMetricEvent {
  type: "availability_check";
  target: string;
  httpOk: boolean;
  websocketOk: boolean;
  httpLatencyMs?: number;
  websocketLatencyMs?: number;
  errorCode?: string;
}

export type MetricsEvent = UsageMetricEvent | AvailabilityMetricEvent;

export interface NormalizedUsageMetricEvent extends UsageMetricEvent {
  count: number;
}

export interface NormalizedAvailabilityMetricEvent extends AvailabilityMetricEvent {
  target: string;
  httpLatencyMs?: number;
  websocketLatencyMs?: number;
  errorCode?: string;
}

export type NormalizedMetricsEvent =
  | NormalizedUsageMetricEvent
  | NormalizedAvailabilityMetricEvent;

export interface MetricRecord {
  event: NormalizedMetricsEvent;
  context: NormalizedConnectionContext;
  occurredAt: number;
}

export interface MetricsSink {
  record(
    event: MetricsEvent,
    context?: ConnectionContext,
    occurredAt?: number | Date
  ): void | Promise<void>;
}

export type MetricsErrorHandler = (error: unknown) => void;

export const noopMetricsSink: MetricsSink = {
  record() {
    // Intentionally empty.
  }
};

export function createFailOpenMetricsSink(
  sink: MetricsSink,
  onError: MetricsErrorHandler = () => undefined
): MetricsSink {
  return {
    record(event, context, occurredAt) {
      try {
        const result = sink.record(event, context, occurredAt);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch((error) => safelyReport(onError, error));
        }
      } catch (error) {
        safelyReport(onError, error);
      }
    }
  };
}

export function combineMetricsSinks(
  sinks: readonly MetricsSink[],
  onError: MetricsErrorHandler = () => undefined
): MetricsSink {
  const safeSinks = sinks.map((sink) => createFailOpenMetricsSink(sink, onError));
  return {
    record(event, context, occurredAt) {
      for (const sink of safeSinks) {
        sink.record(event, context, occurredAt);
      }
    }
  };
}

export function createMetricRecord(
  event: MetricsEvent,
  context: ConnectionContext = {},
  occurredAt: number | Date = Date.now()
): MetricRecord {
  return {
    event: normalizeMetricEvent(event),
    context: normalizeConnectionContext(context),
    occurredAt: normalizeTimestamp(occurredAt)
  };
}

export function normalizeConnectionContext(
  context: ConnectionContext = {}
): NormalizedConnectionContext {
  const countryCode = normalizeCountryCode(context.countryCode);
  return {
    source: context.source === "cloudflare" ? "cloudflare" : "node",
    visitorHash: normalizeOptionalDimension(context.visitorHash, 160),
    countryCode,
    regionCode: countryCode === "ZZ" ? "" : normalizeRegionCode(context.regionCode),
    isProbe: context.isProbe === true
  };
}

export function normalizeCountryCode(value: unknown): string {
  if (typeof value !== "string") {
    return "ZZ";
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || normalized === "XX") {
    return "ZZ";
  }
  return normalized;
}

export function normalizeRegionCode(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9-]{1,12}$/.test(normalized) ? normalized : "";
}

export function isUsageMetricEventType(value: unknown): value is UsageMetricEventType {
  return (
    typeof value === "string" &&
    (USAGE_METRIC_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export function isAvailabilityMetricEvent(
  event: MetricsEvent | NormalizedMetricsEvent
): event is NormalizedAvailabilityMetricEvent {
  return event.type === "availability_check";
}

export function availabilityStatus(httpOk: boolean, websocketOk: boolean): AvailabilityStatus {
  if (!httpOk) {
    return "down";
  }
  return websocketOk ? "up" : "degraded";
}

export function utcHourBucket(timestamp: number | Date): number {
  return floorBucket(normalizeTimestamp(timestamp), HOUR_MS);
}

export function utcDayBucket(timestamp: number | Date): number {
  return floorBucket(normalizeTimestamp(timestamp), DAY_MS);
}

export interface MetricsRange {
  from: number;
  to: number;
  granularity: MetricsGranularity;
  preset?: MetricsRangePreset;
}

export const METRICS_RANGE_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type MetricsRangePreset = (typeof METRICS_RANGE_PRESETS)[number];
export type MetricsTimelineRangePreset = MetricsRangePreset | "all";

export interface MetricsRangeInput {
  range?: string;
  from?: string | number | Date;
  to?: string | number | Date;
  granularity?: string;
}

export class MetricsRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsRangeError";
  }
}

export function parseMetricsRange(
  input: MetricsRangeInput | URLSearchParams | string | undefined,
  now: number | Date = Date.now()
): MetricsRange {
  const normalizedNow = normalizeTimestamp(now);
  const values = readRangeInput(input);
  const preset = normalizeRangePreset(values.range);
  const requestedTo = values.to === undefined
    ? normalizedNow
    : Math.min(parseRangeTimestamp(values.to, "to"), normalizedNow);
  const requestedFrom = values.from === undefined
    ? requestedTo - presetDuration(preset)
    : parseRangeTimestamp(values.from, "from");

  if (requestedFrom >= requestedTo) {
    throw new MetricsRangeError("metrics range must have from < to");
  }
  if (requestedTo - requestedFrom > METRICS_RETENTION_MS) {
    throw new MetricsRangeError(`metrics range cannot exceed ${METRICS_RETENTION_DAYS} days`);
  }

  const granularity = normalizeGranularity(values.granularity, requestedTo - requestedFrom);
  const unit = granularity === "hour" ? HOUR_MS : DAY_MS;
  const bucketTo = values.to === undefined ? Math.ceil(normalizedNow / unit) * unit : Math.ceil(requestedTo / unit) * unit;
  const bucketFrom = values.from === undefined ? bucketTo - presetDuration(preset) : floorBucket(requestedFrom, unit);
  return {
    from: bucketFrom,
    to: bucketTo,
    granularity,
    preset: values.from === undefined ? preset : undefined
  };
}

export function parseMetricsTimelineRange(
  input: MetricsRangeInput | URLSearchParams | string | undefined,
  earliestDayBucket: number | undefined,
  now: number | Date = Date.now()
): MetricsRange {
  const values = readRangeInput(input);
  if (values.range !== "all") {
    return parseMetricsRange(input, now);
  }
  if (values.from !== undefined || values.to !== undefined) {
    throw new MetricsRangeError('range="all" cannot be combined with from or to');
  }
  const normalizedNow = normalizeTimestamp(now);
  const to = Math.ceil(normalizedNow / DAY_MS) * DAY_MS;
  const from = earliestDayBucket === undefined ? utcDayBucket(normalizedNow) : utcDayBucket(earliestDayBucket);
  return { from, to, granularity: "day" };
}

export function enumerateUtcBuckets(range: MetricsRange): number[] {
  const unit = range.granularity === "hour" ? HOUR_MS : DAY_MS;
  const buckets: number[] = [];
  for (let bucket = floorBucket(range.from, unit); bucket < range.to; bucket += unit) {
    buckets.push(bucket);
  }
  return buckets;
}

function normalizeMetricEvent(event: MetricsEvent): NormalizedMetricsEvent {
  if (event.type === "availability_check") {
    return {
      type: event.type,
      target: normalizeRequiredDimension(event.target, 100, "availability target"),
      httpOk: event.httpOk === true,
      websocketOk: event.websocketOk === true,
      httpLatencyMs: normalizeLatency(event.httpLatencyMs),
      websocketLatencyMs: normalizeLatency(event.websocketLatencyMs),
      errorCode: normalizeOptionalDimension(event.errorCode, 80)
    };
  }
  if (!isUsageMetricEventType(event.type)) {
    throw new TypeError("unsupported metrics event type");
  }
  const count = event.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
    throw new RangeError("metrics event count must be an integer between 1 and 1000000");
  }
  return { type: event.type, count };
}

function normalizeLatency(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError("availability latency must be a non-negative finite number");
  }
  return Math.min(value, 3_600_000);
}

function normalizeOptionalDimension(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().slice(0, maxLength);
  return normalized || undefined;
}

function normalizeRequiredDimension(value: unknown, maxLength: number, label: string): string {
  const normalized = normalizeOptionalDimension(value, maxLength);
  if (!normalized) {
    throw new TypeError(`${label} is required`);
  }
  return normalized;
}

function normalizeTimestamp(value: number | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RangeError("metrics timestamp must be a non-negative finite epoch millisecond value");
  }
  return Math.floor(timestamp);
}

function floorBucket(timestamp: number, unit: number): number {
  return Math.floor(timestamp / unit) * unit;
}

function readRangeInput(
  input: MetricsRangeInput | URLSearchParams | string | undefined
): MetricsRangeInput {
  if (input === undefined) {
    return {};
  }
  if (typeof input === "string") {
    return { range: input };
  }
  if (input instanceof URLSearchParams) {
    return {
      range: input.get("range") ?? undefined,
      from: input.get("from") ?? undefined,
      to: input.get("to") ?? undefined,
      granularity: input.get("granularity") ?? undefined
    };
  }
  return input;
}

function normalizeRangePreset(value: string | undefined): MetricsRangePreset {
  const preset = value ?? "24h";
  if ((METRICS_RANGE_PRESETS as readonly string[]).includes(preset)) {
    return preset as MetricsRangePreset;
  }
  throw new MetricsRangeError(`unsupported metrics range: ${preset}`);
}

function presetDuration(preset: MetricsRangePreset): number {
  switch (preset) {
    case "24h":
      return DAY_MS;
    case "7d":
      return 7 * DAY_MS;
    case "30d":
      return 30 * DAY_MS;
    case "90d":
      return METRICS_RETENTION_MS;
  }
}

function parseRangeTimestamp(value: string | number | Date, label: string): number {
  const parsed =
    value instanceof Date || typeof value === "number"
      ? value instanceof Date
        ? value.getTime()
        : value
      : /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Date.parse(value.trim());
  try {
    return normalizeTimestamp(parsed);
  } catch {
    throw new MetricsRangeError(`invalid ${label} timestamp`);
  }
}

function normalizeGranularity(value: string | undefined, durationMs: number): MetricsGranularity {
  if (value === undefined || value === "") {
    return durationMs <= 48 * HOUR_MS ? "hour" : "day";
  }
  if (value === "hour" || value === "day") {
    return value;
  }
  throw new MetricsRangeError(`unsupported metrics granularity: ${value}`);
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as PromiseLike<void>).then === "function"
  );
}

function safelyReport(onError: MetricsErrorHandler, error: unknown): void {
  try {
    onError(error);
  } catch {
    // Metrics error reporting is also fail-open.
  }
}
