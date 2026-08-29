import * as echarts from "echarts/core";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { BarChart, LineChart, MapChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapContinuousComponent
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { feature as topologyFeature } from "topojson-client";
import "./stats.css";
import { hasMappableGeoData, worldMapProjection } from "./world-map.js";

echarts.use([
  AriaComponent,
  BarChart,
  CanvasRenderer,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  MapChart,
  TooltipComponent,
  VisualMapContinuousComponent
]);

type RangeKey = "24h" | "7d" | "30d" | "90d" | "all";
type MapMetric = "uniqueVisitors" | "calls";
type MapLevel = "world" | "china";
type AvailabilityStatus = "up" | "degraded" | "down" | "pending";
type SortKey = "name" | "uniqueVisitors" | "calls";
type SortDirection = "ascending" | "descending";

type JsonRecord = Record<string, unknown>;

type TimelineBucket = {
  time: string;
  total: number;
  events: Record<EventKey, number>;
};

type GeoRow = {
  code: string;
  countryCode: string;
  regionCode: string;
  name: string;
  calls: number;
  uniqueVisitors: number;
};

type AvailabilityBucket = {
  time: string;
  status: AvailabilityStatus;
  httpLatencyMs: number | null;
  wsLatencyMs: number | null;
};

type GeoJsonFeature = {
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: unknown;
  type: "Feature";
};

type GeoJsonCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

type WorldTopology = {
  objects: { countries: unknown };
  [key: string]: unknown;
};

const EVENT_KEYS = [
  "room_created",
  "room_joined",
  "send_favorite",
  "send_history",
  "send_shield_word",
  "send_bili_account"
] as const;

type EventKey = (typeof EVENT_KEYS)[number];

const EVENT_META: Record<EventKey, { label: string; color: string; aliases: string[] }> = {
  room_created: {
    label: "建立房间",
    color: "#127c5b",
    aliases: ["room_created", "roomCreated", "createRoom"]
  },
  room_joined: {
    label: "加入房间",
    color: "#325a9f",
    aliases: ["room_joined", "roomJoined", "joinRoom"]
  },
  send_favorite: {
    label: "同步关注",
    color: "#d7832f",
    aliases: ["send_favorite", "sync_favorite", "sendFavorite"]
  },
  send_history: {
    label: "同步历史",
    color: "#8b63b9",
    aliases: ["send_history", "sync_history", "sendHistory"]
  },
  send_shield_word: {
    label: "同步屏蔽词",
    color: "#b54f6b",
    aliases: ["send_shield_word", "sync_shield_word", "sendShieldWord"]
  },
  send_bili_account: {
    label: "同步哔哩账号",
    color: "#2c8795",
    aliases: ["send_bili_account", "sync_bili_account", "sendBiliAccount"]
  }
};

const RANGE_LABELS: Record<RangeKey, string> = {
  "24h": "近 24 小时",
  "7d": "近 7 天",
  "30d": "近 30 天",
  "90d": "近 90 天",
  all: "全部历史"
};

const STATUS_LABELS: Record<AvailabilityStatus, string> = {
  up: "正常",
  degraded: "部分可用",
  down: "故障",
  pending: "待结算"
};

const NUMERIC_TO_ALPHA2: Record<string, string> = {
  "004": "AF", "008": "AL", "012": "DZ", "024": "AO", "010": "AQ", "032": "AR",
  "051": "AM", "036": "AU", "040": "AT", "031": "AZ", "044": "BS", "050": "BD",
  "112": "BY", "056": "BE", "084": "BZ", "204": "BJ", "064": "BT", "068": "BO",
  "070": "BA", "072": "BW", "076": "BR", "096": "BN", "100": "BG", "854": "BF",
  "108": "BI", "116": "KH", "120": "CM", "124": "CA", "140": "CF", "148": "TD",
  "152": "CL", "156": "CN", "170": "CO", "178": "CG", "180": "CD", "188": "CR",
  "384": "CI", "191": "HR", "192": "CU", "196": "CY", "203": "CZ", "208": "DK",
  "262": "DJ", "214": "DO", "218": "EC", "818": "EG", "222": "SV", "226": "GQ",
  "232": "ER", "233": "EE", "748": "SZ", "231": "ET", "238": "FK", "242": "FJ",
  "246": "FI", "250": "FR", "260": "TF", "266": "GA", "270": "GM", "268": "GE",
  "276": "DE", "288": "GH", "300": "GR", "304": "GL", "320": "GT", "324": "GN",
  "624": "GW", "328": "GY", "332": "HT", "340": "HN", "348": "HU", "352": "IS",
  "356": "IN", "360": "ID", "364": "IR", "368": "IQ", "372": "IE", "376": "IL",
  "380": "IT", "388": "JM", "392": "JP", "400": "JO", "398": "KZ", "404": "KE",
  "408": "KP", "410": "KR", "414": "KW", "417": "KG", "418": "LA", "428": "LV",
  "422": "LB", "426": "LS", "430": "LR", "434": "LY", "440": "LT", "442": "LU",
  "450": "MG", "454": "MW", "458": "MY", "466": "ML", "478": "MR", "484": "MX",
  "498": "MD", "496": "MN", "499": "ME", "504": "MA", "508": "MZ", "104": "MM",
  "516": "NA", "524": "NP", "528": "NL", "540": "NC", "554": "NZ", "558": "NI",
  "562": "NE", "566": "NG", "807": "MK", "578": "NO", "512": "OM", "586": "PK",
  "275": "PS", "591": "PA", "598": "PG", "600": "PY", "604": "PE", "608": "PH",
  "616": "PL", "620": "PT", "630": "PR", "634": "QA", "642": "RO", "643": "RU",
  "646": "RW", "682": "SA", "686": "SN", "688": "RS", "694": "SL", "703": "SK",
  "705": "SI", "090": "SB", "706": "SO", "710": "ZA", "728": "SS", "724": "ES",
  "144": "LK", "729": "SD", "740": "SR", "752": "SE", "756": "CH", "760": "SY",
  "158": "TW", "762": "TJ", "834": "TZ", "764": "TH", "626": "TL", "768": "TG",
  "780": "TT", "788": "TN", "792": "TR", "795": "TM", "800": "UG", "804": "UA",
  "784": "AE", "826": "GB", "840": "US", "858": "UY", "860": "UZ", "548": "VU",
  "862": "VE", "704": "VN", "732": "EH", "887": "YE", "894": "ZM", "716": "ZW"
};

const WORLD_CODE_BY_SOURCE_NAME: Readonly<Record<string, string>> = {
  Kosovo: "XK",
  "N. Cyprus": "CY",
  Somaliland: "SO"
};

const CHINA_PROVINCES = [
  ["BJ", "北京市", "Beijing Municipality"],
  ["TJ", "天津市", "Tianjin Municipality"],
  ["HE", "河北省", "Hebei Province"],
  ["SX", "山西省", "Shanxi Province"],
  ["NM", "内蒙古自治区", "Inner Mongolia Autonomous Region"],
  ["LN", "辽宁省", "Liaoning Province"],
  ["JL", "吉林省", "Jilin Province"],
  ["HL", "黑龙江省", "Heilongjiang Province"],
  ["SH", "上海市", "Shanghai Municipality"],
  ["JS", "江苏省", "Jiangsu Province"],
  ["ZJ", "浙江省", "Zhejiang Province"],
  ["AH", "安徽省", "Anhui Province"],
  ["FJ", "福建省", "Fujian Province"],
  ["JX", "江西省", "Jiangxi Province"],
  ["SD", "山东省", "Shandong Province"],
  ["HA", "河南省", "Henan Province"],
  ["HB", "湖北省", "Hubei Province"],
  ["HN", "湖南省", "Hunan Province"],
  ["GD", "广东省", "Guangzhou Province"],
  ["GX", "广西壮族自治区", "Guangxi Zhuang Autonomous Region"],
  ["HI", "海南省", "Hainan Province"],
  ["CQ", "重庆市", "Chongqing Municipality"],
  ["SC", "四川省", "Sichuan Province"],
  ["GZ", "贵州省", "Guizhou Province"],
  ["YN", "云南省", "Yunnan Province"],
  ["XZ", "西藏自治区", "Tibet Autonomous Region"],
  ["SN", "陕西省", "Shaanxi Province"],
  ["GS", "甘肃省", "Gansu Province"],
  ["QH", "青海省", "Qinghai Province"],
  ["NX", "宁夏回族自治区", "Ningxia Ningxia Hui Autonomous Region"],
  ["XJ", "新疆维吾尔自治区", "Xinjiang Uyghur Autonomous Region"],
  ["TW", "台湾省", "Taiwan Province"],
  ["HK", "香港特别行政区", "Hong Kong Special Administrative Region"],
  ["MO", "澳门特别行政区", "Macau Special Administrative Region"]
] as const;

const CHINA_NUMERIC_TO_CODE: Record<string, string> = {
  "11": "BJ", "12": "TJ", "13": "HE", "14": "SX", "15": "NM", "21": "LN", "22": "JL",
  "23": "HL", "31": "SH", "32": "JS", "33": "ZJ", "34": "AH", "35": "FJ", "36": "JX",
  "37": "SD", "41": "HA", "42": "HB", "43": "HN", "44": "GD", "45": "GX", "46": "HI",
  "50": "CQ", "51": "SC", "52": "GZ", "53": "YN", "54": "XZ", "61": "SN", "62": "GS",
  "63": "QH", "64": "NX", "65": "XJ", "71": "TW", "81": "HK", "82": "MO"
};

const CHINA_NAME_BY_CODE: ReadonlyMap<string, string> = new Map(CHINA_PROVINCES.map(([code, name]) => [code, name]));
const CHINA_CODE_BY_SHAPE: ReadonlyMap<string, string> = new Map(CHINA_PROVINCES.map(([code, , shape]) => [shape, code]));
const countryDisplayNames = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
  : null;
const integerFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const percentFormatter = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utcHourFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
const localDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short"
});
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

const state = {
  range: "24h" as RangeKey,
  mapMetric: "uniqueVisitors" as MapMetric,
  mapLevel: "world" as MapLevel,
  timeline: [] as TimelineBucket[],
  countries: [] as GeoRow[],
  regions: [] as GeoRow[],
  availability: [] as AvailabilityBucket[],
  geoSort: { key: "uniqueVisitors" as SortKey, direction: "descending" as SortDirection },
  selectedAvailabilityIndex: -1,
  requestId: 0
};

const charts = {
  timeline: null as ECharts | null,
  events: null as ECharts | null,
  geo: null as ECharts | null,
  latency: null as ECharts | null
};

let rangeAbortController: AbortController | null = null;
let mapsReady: Promise<void> | null = null;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element #${id}`);
  }
  return element as T;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstDefined(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function toNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function normalizeCountryCode(value: unknown): string {
  const code = toText(value).trim().toUpperCase();
  if (!code || code === "UNKNOWN" || code === "XX" || code === "--") {
    return "ZZ";
  }
  if (code === "UK") {
    return "GB";
  }
  return code.slice(0, 2);
}

function normalizeRegionCode(value: unknown): string {
  let code = toText(value).trim().toUpperCase().replace(/^CN[-_]/, "");
  if (!code || code === "UNKNOWN" || code === "--") {
    return "ZZ";
  }
  if (/^\d{6}$/.test(code)) {
    code = code.slice(0, 2);
  }
  return CHINA_NUMERIC_TO_CODE[code] ?? code;
}

function formatInteger(value: number): string {
  return integerFormatter.format(Math.round(value));
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${percentFormatter.format(value)}%`;
}

function normalizePercentage(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.min(100, number <= 1 ? number * 100 : number);
}

function countryName(code: string): string {
  if (code === "ZZ") {
    return "未知地区";
  }
  if (code === "XK") {
    return "科索沃";
  }
  try {
    return countryDisplayNames?.of(code) || code;
  } catch {
    return code;
  }
}

function regionName(code: string): string {
  return code === "ZZ" ? "中国（省份未知）" : CHINA_NAME_BY_CODE.get(code) ?? code;
}

function parseDate(value: string): Date | null {
  const numeric = /^\d{10,}$/.test(value) ? Number(value) : Number.NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatUtcTime(value: string): string {
  const date = parseDate(value);
  return date ? `${utcHourFormatter.format(date)} UTC` : value;
}

function formatAxisTime(value: string, range: RangeKey): string {
  const date = parseDate(value);
  if (!date) {
    return value;
  }
  if (range === "24h") {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "2-digit", day: "2-digit" }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readCssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartPalette() {
  return {
    text: readCssColor("--text"),
    muted: readCssColor("--muted"),
    line: readCssColor("--line"),
    panel: readCssColor("--panel"),
    panelSoft: readCssColor("--panel-soft"),
    brand: readCssColor("--brand"),
    brandDark: readCssColor("--brand-dark"),
    accent: readCssColor("--accent"),
    blue: readCssColor("--blue")
  };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function eventCountsFrom(record: JsonRecord): Record<EventKey, number> {
  const nested = asRecord(firstDefined(record, ["events", "counts", "eventCounts", "byEvent"]));
  const result = {} as Record<EventKey, number>;
  for (const eventKey of EVENT_KEYS) {
    const aliases = EVENT_META[eventKey].aliases;
    let value: unknown;
    for (const alias of aliases) {
      value = nested[alias] ?? record[alias];
      if (value !== undefined) {
        break;
      }
    }
    result[eventKey] = toNumber(value);
  }
  return result;
}

function normalizeTimeline(payload: unknown): TimelineBucket[] {
  const root = asRecord(payload);
  const rows = asArray(firstDefined(root, ["buckets", "timeline", "data", "items", "rows"]));
  return rows
    .map((item): TimelineBucket | null => {
      const record = asRecord(item);
      const time = toText(firstDefined(record, ["time", "bucket", "timestamp", "hour", "day", "period"]));
      if (!time) {
        return null;
      }
      const events = eventCountsFrom(record);
      const derivedTotal = EVENT_KEYS.reduce((sum, key) => sum + events[key], 0);
      const totalValue = firstDefined(record, ["total", "totalCalls", "calls", "count"]);
      return { time, events, total: totalValue === undefined ? derivedTotal : toNumber(totalValue) };
    })
    .filter((bucket): bucket is TimelineBucket => bucket !== null)
    .sort((left, right) => left.time.localeCompare(right.time));
}

function normalizeGeoRows(payload: unknown): { countries: GeoRow[]; regions: GeoRow[] } {
  const root = asRecord(payload);
  const countryRows = asArray(firstDefined(root, ["countries", "country", "countryRows"]));
  const regionRows = asArray(firstDefined(root, ["regions", "provinces", "subdivisions", "regionRows"]));
  const genericRows = asArray(firstDefined(root, ["data", "items", "rows", "geo"]));
  const allCountryRows = countryRows.length > 0 ? countryRows : genericRows.filter((item) => {
    const record = asRecord(item);
    return !toText(firstDefined(record, ["regionCode", "region_code", "region", "provinceCode"]));
  });
  const allRegionRows = regionRows.length > 0 ? regionRows : genericRows.filter((item) => {
    const record = asRecord(item);
    return Boolean(toText(firstDefined(record, ["regionCode", "region_code", "region", "provinceCode"])));
  });

  const countries = aggregateGeoRows(allCountryRows, "country");
  const regions = aggregateGeoRows(allRegionRows, "region").filter((row) => row.countryCode === "CN" || row.countryCode === "ZZ");
  return { countries, regions };
}

function aggregateGeoRows(rows: unknown[], level: "country" | "region"): GeoRow[] {
  const aggregate = new Map<string, GeoRow>();
  for (const item of rows) {
    const record = asRecord(item);
    const countryCode = normalizeCountryCode(firstDefined(record, ["countryCode", "country_code", "country", "code"]));
    const rawRegion = firstDefined(record, ["regionCode", "region_code", "region", "provinceCode", "subdivisionCode"]);
    const regionCode = level === "region" ? normalizeRegionCode(rawRegion) : "";
    const code = level === "country" ? countryCode : regionCode;
    if (!code) {
      continue;
    }
    const key = `${countryCode}:${regionCode}`;
    const calls = toNumber(firstDefined(record, ["calls", "totalCalls", "count", "events", "eventCount"]));
    const uniqueVisitors = toNumber(firstDefined(record, ["uniqueVisitors", "uniqueIps", "uniqueIPs", "visitors", "ips", "visitorCount"]));
    const existing = aggregate.get(key) ?? {
      code,
      countryCode,
      regionCode,
      name: level === "country" ? countryName(countryCode) : regionName(regionCode),
      calls: 0,
      uniqueVisitors: 0
    };
    existing.calls += calls;
    existing.uniqueVisitors = Math.max(existing.uniqueVisitors, uniqueVisitors);
    aggregate.set(key, existing);
  }
  return [...aggregate.values()];
}

function normalizeAvailability(payload: unknown): { buckets: AvailabilityBucket[]; monitoringStartedAt: string } {
  const root = asRecord(payload);
  const rows = asArray(firstDefined(root, ["buckets", "hourly", "availability", "hours", "data", "items", "rows"]));
  const buckets = rows
    .map((item): AvailabilityBucket | null => {
      const record = asRecord(item);
      const time = toText(firstDefined(record, ["time", "bucket", "timestamp", "hour", "period"]));
      if (!time) {
        return null;
      }
      const rawStatus = toText(firstDefined(record, ["status", "state"])).toLowerCase();
      const status: AvailabilityStatus = rawStatus === "up" || rawStatus === "degraded" || rawStatus === "pending"
        ? rawStatus
        : "down";
      const http = asRecord(record.http);
      const websocket = asRecord(firstDefined(record, ["websocket", "ws"]));
      return {
        time,
        status,
        httpLatencyMs: toNullableNumber(firstDefined(record, ["httpLatencyMs", "http_latency_ms", "httpMs"]) ?? firstDefined(http, ["latencyMs", "latency"])),
        wsLatencyMs: toNullableNumber(firstDefined(record, ["wsLatencyMs", "websocketLatencyMs", "ws_latency_ms", "wsMs"]) ?? firstDefined(websocket, ["latencyMs", "latency"]))
      };
    })
    .filter((bucket): bucket is AvailabilityBucket => bucket !== null)
    .sort((left, right) => left.time.localeCompare(right.time));
  return {
    buckets,
    monitoringStartedAt: toText(firstDefined(root, ["monitoringStartedAt", "monitoring_started_at", "startedAt"]))
  };
}

function normalizeSummary(payload: unknown) {
  const root = asRecord(payload);
  const summary = Object.keys(asRecord(root.summary)).length > 0 ? asRecord(root.summary) : root;
  const totals = asRecord(firstDefined(summary, ["totals", "total"]));
  const availability = asRecord(firstDefined(summary, ["availability", "availability30d"]));
  const rawMonitoringStart = firstDefined(summary, ["monitoringStartedAt", "monitoring_started_at"])
    ?? firstDefined(root, ["monitoringStartedAt", "monitoring_started_at"]);
  const monitoringStarts = asRecord(rawMonitoringStart);
  const totalCalls = toNumber(firstDefined(summary, ["totalCalls", "total_calls", "callsTotal"]) ?? firstDefined(totals, ["totalCalls", "calls", "total"]));
  const calls24h = toNumber(firstDefined(summary, ["calls24h", "calls_24h", "last24Hours", "recentCalls"]));
  const uniqueVisitors30d = toNumber(firstDefined(summary, ["uniqueVisitors30d", "uniqueIps30d", "uniqueIPs30d", "visitors30d"]));
  const availability30d = normalizePercentage(firstDefined(summary, ["availability30d", "availabilityPercent30d", "availabilityRate30d", "uptime30d"])
    ?? firstDefined(availability, ["percentage", "percent", "rate", "uptime"]));
  return {
    totalCalls,
    calls24h,
    uniqueVisitors30d,
    availability30d,
    monitoringStartedAt: toText(firstDefined(monitoringStarts, ["availability", "usage"])
      ?? rawMonitoringStart),
    generatedAt: toText(firstDefined(summary, ["generatedAt", "generated_at", "updatedAt"])
      ?? firstDefined(root, ["generatedAt", "generated_at", "updatedAt"]))
  };
}

function initCharts(): void {
  charts.timeline = echarts.init(byId("timeline-chart"), undefined, { renderer: "canvas" });
  charts.events = echarts.init(byId("events-chart"), undefined, { renderer: "canvas" });
  charts.geo = echarts.init(byId("geo-chart"), undefined, { renderer: "canvas" });
  charts.latency = echarts.init(byId("latency-chart"), undefined, { renderer: "canvas" });

  charts.geo.on("click", (params: unknown) => {
    const record = asRecord(params);
    const code = toText(record.name);
    if (!code) {
      return;
    }
    handleMapLocation(code);
  });

  let resizeFrame = 0;
  const resizeCharts = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => Object.values(charts).forEach((chart) => chart?.resize()));
  };
  const observer = new ResizeObserver(resizeCharts);
  observer.observe(document.documentElement);
  window.addEventListener("resize", resizeCharts, { passive: true });
}

function setChartState(shellId: string, status: "loading" | "ready" | "empty" | "error", message: string): void {
  const shell = byId(shellId);
  shell.dataset.state = status;
  shell.setAttribute("aria-busy", status === "loading" ? "true" : "false");
  const messageNode = shell.querySelector<HTMLElement>(".panel-state-message");
  if (messageNode) {
    messageNode.textContent = message;
  }
}

function setMetric(id: string, value: string, label: string): void {
  const element = byId(id);
  element.textContent = value;
  element.classList.remove("skeleton-line");
  element.setAttribute("aria-label", label);
}

async function loadSummary(): Promise<void> {
  byId("summary").dataset.state = "loading";
  try {
    const payload = await fetchJson("/api/stats/summary");
    const summary = normalizeSummary(payload);
    setMetric("metric-total", formatInteger(summary.totalCalls), `永久总调用 ${formatInteger(summary.totalCalls)} 次`);
    setMetric("metric-24h", formatInteger(summary.calls24h), `近 24 小时调用 ${formatInteger(summary.calls24h)} 次`);
    setMetric("metric-visitors", formatInteger(summary.uniqueVisitors30d), `近 30 天独立 IP ${formatInteger(summary.uniqueVisitors30d)} 个`);
    setMetric("metric-availability", formatPercent(summary.availability30d), `近 30 天可用率 ${formatPercent(summary.availability30d)}`);
    if (summary.monitoringStartedAt) {
      byId("metric-availability-note").textContent = `自 ${formatUtcTime(summary.monitoringStartedAt)} 起监控`;
    }
    byId("summary").dataset.state = "ready";
    const generated = parseDate(summary.generatedAt);
    byId("freshness-text").textContent = generated
      ? `数据生成于 ${localDateTimeFormatter.format(generated)}`
      : `数据更新于 ${localDateTimeFormatter.format(new Date())}`;
    byId("fatal-error").hidden = true;
  } catch (error) {
    byId("summary").dataset.state = "error";
    byId("fatal-error").hidden = false;
    byId("fatal-error-message").textContent = `核心指标读取失败（${errorMessage(error)}）。同步服务本身不受统计故障影响。`;
    byId("freshness-text").textContent = "统计数据暂时不可用";
    throw error;
  }
}

async function loadRangeData(): Promise<void> {
  rangeAbortController?.abort();
  rangeAbortController = new AbortController();
  const signal = rangeAbortController.signal;
  const requestId = ++state.requestId;
  const range = state.range;
  const boundedRange = range === "all" ? "90d" : range;
  setChartState("timeline-shell", "loading", "正在加载调用趋势…");
  setChartState("events-shell", "loading", "正在加载事件分布…");
  setChartState("map-shell", "loading", "正在加载本地地图与地理统计…");
  setChartState("latency-shell", "loading", "正在加载可用性与延迟…");
  byId("availability-strip-shell").dataset.state = "loading";
  byId("availability-selection").textContent = "正在加载小时状态…";
  byId("geo-table-body").innerHTML = '<tr><td colspan="3" class="table-empty">正在加载地理数据…</td></tr>';

  const [timelineResult, geoResult, availabilityResult] = await Promise.allSettled([
    fetchJson(`/api/stats/timeline?range=${encodeURIComponent(range)}`, signal),
    fetchJson(`/api/stats/geo?range=${encodeURIComponent(boundedRange)}`, signal),
    fetchJson(`/api/stats/availability?range=${encodeURIComponent(boundedRange)}`, signal)
  ]);

  if (requestId !== state.requestId || signal.aborted) {
    return;
  }

  if (timelineResult.status === "fulfilled") {
    state.timeline = normalizeTimeline(timelineResult.value);
    renderTimeline();
    renderEvents();
  } else {
    state.timeline = [];
    const message = `调用数据读取失败：${errorMessage(timelineResult.reason)}`;
    setChartState("timeline-shell", "error", message);
    setChartState("events-shell", "error", message);
    byId("events-text-list").replaceChildren();
  }

  if (geoResult.status === "fulfilled") {
    const geo = normalizeGeoRows(geoResult.value);
    state.countries = geo.countries;
    state.regions = geo.regions;
    try {
      await ensureMapsReady();
      if (requestId === state.requestId) {
        renderMap();
      }
    } catch (error) {
      setChartState("map-shell", "error", `本地地图资源读取失败：${errorMessage(error)}`);
    }
    renderGeoTable();
  } else {
    state.countries = [];
    state.regions = [];
    setChartState("map-shell", "error", `地理数据读取失败：${errorMessage(geoResult.reason)}`);
    renderGeoTable("地理数据读取失败，请重试。");
  }

  if (availabilityResult.status === "fulfilled") {
    const availability = normalizeAvailability(availabilityResult.value);
    state.availability = availability.buckets;
    renderAvailability();
  } else {
    state.availability = [];
    setChartState("latency-shell", "error", `可用性数据读取失败：${errorMessage(availabilityResult.reason)}`);
    byId("availability-strip-shell").dataset.state = "error";
    byId("availability-strip").replaceChildren();
    byId("availability-selection").textContent = "可用性数据读取失败，请重试。";
  }
}

function renderTimeline(): void {
  const chart = charts.timeline;
  if (!chart) {
    return;
  }
  if (state.timeline.length === 0 || state.timeline.every((bucket) => bucket.total === 0)) {
    chart.clear();
    setChartState("timeline-shell", "empty", `${RANGE_LABELS[state.range]}暂无成功调用。`);
    byId("timeline-summary").textContent = `${RANGE_LABELS[state.range]}暂无成功调用。`;
    return;
  }
  const palette = chartPalette();
  const labels = state.timeline.map((bucket) => formatAxisTime(bucket.time, state.range));
  const totals = state.timeline.map((bucket) => bucket.total);
  const total = totals.reduce((sum, value) => sum + value, 0);
  const peak = Math.max(...totals);
  const peakIndex = totals.indexOf(peak);
  const granularity = state.range === "24h" ? "小时" : state.range === "all" ? "日" : "小时 / 日";
  byId("timeline-granularity").textContent = `${RANGE_LABELS[state.range]} · UTC ${granularity}桶`;
  byId("timeline-summary").textContent = `${RANGE_LABELS[state.range]}共有 ${formatInteger(total)} 次成功调用，峰值为 ${formatInteger(peak)} 次，出现在 ${formatUtcTime(state.timeline[peakIndex]?.time ?? "")}。`;
  chart.setOption({
    animation: !reducedMotion.matches,
    aria: {
      enabled: true,
      decal: { show: true },
      description: byId("timeline-summary").textContent
    },
    color: [palette.brand],
    grid: { left: 48, right: 18, top: 24, bottom: state.timeline.length > 100 ? 56 : 40 },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: palette.panel,
      borderColor: palette.line,
      textStyle: { color: palette.text },
      formatter: (params: unknown) => {
        const items = asArray(params);
        const first = asRecord(items[0]);
        const index = Number(first.dataIndex ?? 0);
        const bucket = state.timeline[index];
        if (!bucket) return "";
        return `<strong>${escapeHtml(formatUtcTime(bucket.time))}</strong><br/>成功调用：${formatInteger(bucket.total)}`;
      }
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: palette.line } },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, hideOverlap: true, fontSize: 11 }
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      name: "调用次数",
      nameTextStyle: { color: palette.muted, padding: [0, 0, 4, 0] },
      axisLabel: { color: palette.muted },
      splitLine: { lineStyle: { color: palette.line, type: "dashed" } }
    },
    dataZoom: state.timeline.length > 120 ? [{ type: "inside", start: 75, end: 100 }, { type: "slider", height: 18, bottom: 4 }] : [],
    series: [{
      name: "成功调用",
      type: "line",
      data: totals,
      smooth: state.timeline.length < 100 ? 0.2 : false,
      showSymbol: state.timeline.length <= 48,
      symbolSize: 7,
      lineStyle: { width: 3 },
      areaStyle: { color: palette.brand, opacity: darkMode.matches ? 0.13 : 0.1 },
      emphasis: { focus: "series" }
    }]
  } as EChartsCoreOption, true);
  setChartState("timeline-shell", "ready", "");
}

function renderEvents(): void {
  const chart = charts.events;
  if (!chart) {
    return;
  }
  const totals = EVENT_KEYS.map((eventKey) => ({
    key: eventKey,
    label: EVENT_META[eventKey].label,
    color: EVENT_META[eventKey].color,
    value: state.timeline.reduce((sum, bucket) => sum + bucket.events[eventKey], 0)
  }));
  const overall = totals.reduce((sum, item) => sum + item.value, 0);
  const textList = byId<HTMLUListElement>("events-text-list");
  textList.replaceChildren(...totals.map((item) => {
    const entry = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = item.label;
    const value = document.createElement("strong");
    value.textContent = formatInteger(item.value);
    entry.append(label, value);
    return entry;
  }));
  if (overall === 0) {
    chart.clear();
    setChartState("events-shell", "empty", `${RANGE_LABELS[state.range]}暂无事件分项。`);
    return;
  }
  const palette = chartPalette();
  chart.setOption({
    animation: !reducedMotion.matches,
    aria: { enabled: true, decal: { show: true } },
    grid: { left: 84, right: 28, top: 12, bottom: 18 },
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: palette.panel,
      borderColor: palette.line,
      textStyle: { color: palette.text },
      formatter: (params: unknown) => {
        const record = asRecord(params);
        return `${escapeHtml(toText(record.name))}：${formatInteger(toNumber(record.value))}`;
      }
    },
    xAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: palette.muted },
      splitLine: { lineStyle: { color: palette.line, type: "dashed" } }
    },
    yAxis: {
      type: "category",
      data: totals.map((item) => item.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11 }
    },
    series: [{
      type: "bar",
      data: totals.map((item) => ({ value: item.value, itemStyle: { color: item.color, borderRadius: [0, 4, 4, 0] } })),
      barMaxWidth: 22,
      label: { show: true, position: "right", color: palette.text, formatter: "{c}" }
    }]
  } as EChartsCoreOption, true);
  setChartState("events-shell", "ready", "");
}

async function ensureMapsReady(): Promise<void> {
  if (mapsReady) {
    return mapsReady;
  }
  mapsReady = (async () => {
    const [worldPayload, chinaPayload] = await Promise.all([
      fetchJson("/assets/maps/world-countries-110m.json"),
      fetchJson("/assets/maps/china-adm1.geojson")
    ]);
    const topology = worldPayload as WorldTopology;
    if (!topology.objects?.countries) {
      throw new Error("世界地图数据格式无效");
    }
    const worldGeo = topologyFeature(topology as never, topology.objects.countries as never) as unknown as GeoJsonCollection;
    if (worldGeo.type !== "FeatureCollection" || !Array.isArray(worldGeo.features)) {
      throw new Error("世界地图转换失败");
    }
    worldGeo.features.forEach((mapFeature, index) => {
      const numeric = String(mapFeature.id ?? "").padStart(3, "0");
      const sourceName = toText(mapFeature.properties?.name);
      const code = NUMERIC_TO_ALPHA2[numeric] ?? WORLD_CODE_BY_SOURCE_NAME[sourceName] ?? `MAP-${index}`;
      mapFeature.properties = { ...mapFeature.properties, name: code, sourceName };
    });

    const chinaGeo = chinaPayload as GeoJsonCollection;
    if (chinaGeo.type !== "FeatureCollection" || !Array.isArray(chinaGeo.features) || chinaGeo.features.length !== 34) {
      throw new Error("中国省级地图数据格式无效");
    }
    chinaGeo.features.forEach((mapFeature, index) => {
      const shapeName = toText(mapFeature.properties?.shapeName);
      const code = CHINA_CODE_BY_SHAPE.get(shapeName) ?? `CN-${index}`;
      mapFeature.properties = { ...mapFeature.properties, name: code, sourceName: shapeName };
    });
    echarts.registerMap("simple-live-world", worldGeo as never);
    echarts.registerMap("simple-live-china", chinaGeo as never);
  })().catch((error: unknown) => {
    mapsReady = null;
    throw error;
  });
  return mapsReady;
}

function completeChinaRows(): GeoRow[] {
  const byCode = new Map(state.regions.map((row) => [row.code, row]));
  const rows: GeoRow[] = CHINA_PROVINCES.map(([code, name]) => byCode.get(code) ?? {
    code,
    countryCode: "CN",
    regionCode: code,
    name,
    calls: 0,
    uniqueVisitors: 0
  });
  for (const row of state.regions) {
    if (!CHINA_NAME_BY_CODE.has(row.code)) {
      rows.push(row);
    }
  }
  return rows;
}

function currentGeoRows(): GeoRow[] {
  return state.mapLevel === "world" ? state.countries : completeChinaRows();
}

function renderMap(): void {
  const chart = charts.geo;
  if (!chart) {
    return;
  }
  const rows = currentGeoRows();
  const mapRows = rows.filter((row) => row.code !== "ZZ");
  const hasData = hasMappableGeoData(rows);
  const metricLabel = state.mapMetric === "uniqueVisitors" ? "独立 IP" : "调用次数";
  const maximum = Math.max(1, ...mapRows.map((row) => row[state.mapMetric]));
  const palette = chartPalette();
  const mapName = state.mapLevel === "world" ? "simple-live-world" : "simple-live-china";
  const visibleName = state.mapLevel === "world" ? countryName : regionName;
  byId("map-hint").textContent = `颜色越深表示“${metricLabel}”越多。点击国家查看详情；点击中国可下钻到 34 个省级区域。`;
  byId("geo-chart").setAttribute("aria-label", `${state.mapLevel === "world" ? "世界" : "中国省级"}${metricLabel}来源分布地图`);
  chart.setOption({
    animation: !reducedMotion.matches,
    aria: {
      enabled: true,
      decal: { show: false },
      description: `${RANGE_LABELS[state.range === "all" ? "90d" : state.range]}${state.mapLevel === "world" ? "世界国家" : "中国省级"}${metricLabel}分布。地图下方提供完整数据表。`
    },
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: palette.panel,
      borderColor: palette.line,
      textStyle: { color: palette.text },
      formatter: (params: unknown) => {
        const record = asRecord(params);
        const code = toText(record.name);
        const data = asRecord(record.data);
        const row = rows.find((item) => item.code === code);
        const name = row?.name ?? visibleName(code);
        return `<strong>${escapeHtml(name)}</strong><br/>独立 IP：${formatInteger(row?.uniqueVisitors ?? toNumber(data.uniqueVisitors))}<br/>调用次数：${formatInteger(row?.calls ?? toNumber(data.calls))}`;
      }
    },
    visualMap: {
      min: 0,
      max: maximum,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 10,
      text: ["多", "少"],
      textStyle: { color: palette.muted },
      inRange: { color: darkMode.matches ? ["#24342d", "#3a8f70", "#83ddb9"] : ["#dce9e2", "#55a986", "#0d5f48"] }
    },
    series: [{
      name: metricLabel,
      type: "map",
      map: mapName,
      ...(state.mapLevel === "world" ? { projection: worldMapProjection } : {}),
      roam: false,
      selectedMode: "single",
      data: mapRows.map((row) => ({
        name: row.code,
        value: row[state.mapMetric],
        calls: row.calls,
        uniqueVisitors: row.uniqueVisitors
      })),
      itemStyle: {
        areaColor: palette.panel,
        borderColor: palette.line,
        borderWidth: 0.8
      },
      emphasis: {
        label: { show: false },
        itemStyle: { areaColor: palette.accent, borderColor: palette.text, borderWidth: 1 }
      },
      select: {
        label: { show: false },
        itemStyle: { areaColor: palette.accent, borderColor: palette.text, borderWidth: 1.5 }
      }
    }]
  } as EChartsCoreOption, true);
  setChartState("map-shell", hasData ? "ready" : "empty", hasData ? "" : `${RANGE_LABELS[state.range === "all" ? "90d" : state.range]}暂无可定位的 IP 来源。`);
}

function handleMapLocation(code: string): void {
  if (state.mapLevel === "world" && code === "CN") {
    setMapLevel("china");
    return;
  }
  const row = currentGeoRows().find((item) => item.code === code) ?? {
    code,
    countryCode: state.mapLevel === "world" ? code : "CN",
    regionCode: state.mapLevel === "china" ? code : "",
    name: state.mapLevel === "world" ? countryName(code) : regionName(code),
    calls: 0,
    uniqueVisitors: 0
  };
  showMapSelection(row);
}

function showMapSelection(row: GeoRow): void {
  byId("map-selection-name").textContent = row.name;
  byId("map-selection-visitors").textContent = formatInteger(row.uniqueVisitors);
  byId("map-selection-calls").textContent = formatInteger(row.calls);
}

function setMapLevel(level: MapLevel): void {
  state.mapLevel = level;
  const worldCrumb = byId<HTMLButtonElement>("world-crumb");
  const chinaCrumb = byId<HTMLButtonElement>("china-crumb");
  const isWorld = level === "world";
  worldCrumb.toggleAttribute("aria-current", isWorld);
  if (isWorld) {
    worldCrumb.setAttribute("aria-current", "page");
  } else {
    worldCrumb.removeAttribute("aria-current");
  }
  chinaCrumb.hidden = isWorld;
  if (!isWorld) {
    chinaCrumb.setAttribute("aria-current", "page");
  }
  byId("geo-table-title").textContent = isWorld ? "有数据的国家和地区" : "中国 34 个省级区域";
  byId("map-selection-name").textContent = isWorld ? "尚未选择地区" : "中国省级分布";
  byId("map-selection-visitors").textContent = "—";
  byId("map-selection-calls").textContent = "—";
  renderMap();
  renderGeoTable();
}

function renderGeoTable(errorText?: string): void {
  const body = byId<HTMLTableSectionElement>("geo-table-body");
  if (errorText) {
    body.innerHTML = `<tr><td colspan="3" class="table-empty">${escapeHtml(errorText)}</td></tr>`;
    return;
  }
  const rows = [...currentGeoRows()];
  const { key, direction } = state.geoSort;
  const factor = direction === "ascending" ? 1 : -1;
  rows.sort((left, right) => {
    if (key === "name") {
      return left.name.localeCompare(right.name, "zh-CN") * factor;
    }
    const difference = (left[key] - right[key]) * factor;
    return difference || left.name.localeCompare(right.name, "zh-CN");
  });
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="3" class="table-empty">当前范围暂无地理数据。</td></tr>';
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    const nameCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "location-button";
    button.textContent = row.name;
    button.setAttribute("aria-label", `${row.name}，独立 IP ${formatInteger(row.uniqueVisitors)}，调用 ${formatInteger(row.calls)}`);
    button.addEventListener("click", () => handleMapLocation(row.code));
    nameCell.append(button);
    const visitorsCell = document.createElement("td");
    visitorsCell.textContent = formatInteger(row.uniqueVisitors);
    const callsCell = document.createElement("td");
    callsCell.textContent = formatInteger(row.calls);
    tableRow.append(nameCell, visitorsCell, callsCell);
    fragment.append(tableRow);
  }
  body.replaceChildren(fragment);
}

function renderAvailability(): void {
  renderAvailabilityStrip();
  const chart = charts.latency;
  if (!chart) {
    return;
  }
  if (state.availability.length === 0) {
    chart.clear();
    setChartState("latency-shell", "empty", `${RANGE_LABELS[state.range === "all" ? "90d" : state.range]}暂无可用性记录。`);
    byId("availability-summary").textContent = "暂无可用性记录。";
    return;
  }
  const palette = chartPalette();
  const labels = state.availability.map((bucket) => formatAxisTime(bucket.time, state.range === "all" ? "90d" : state.range));
  const upCount = state.availability.filter((bucket) => bucket.status === "up").length;
  const degradedCount = state.availability.filter((bucket) => bucket.status === "degraded").length;
  const downCount = state.availability.filter((bucket) => bucket.status === "down").length;
  const pendingCount = state.availability.filter((bucket) => bucket.status === "pending").length;
  byId("availability-summary").textContent = `可用性记录共 ${state.availability.length} 个小时：正常 ${upCount} 小时，部分可用 ${degradedCount} 小时，故障 ${downCount} 小时，待结算 ${pendingCount} 小时。`;
  chart.setOption({
    animation: !reducedMotion.matches,
    aria: {
      enabled: true,
      decal: { show: true },
      description: byId("availability-summary").textContent
    },
    color: [palette.brand, palette.blue],
    legend: {
      top: 4,
      right: 8,
      textStyle: { color: palette.muted },
      data: ["HTTP", "WebSocket"]
    },
    grid: { left: 54, right: 18, top: 48, bottom: state.availability.length > 120 ? 58 : 38 },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: palette.panel,
      borderColor: palette.line,
      textStyle: { color: palette.text },
      formatter: (params: unknown) => {
        const items = asArray(params);
        const first = asRecord(items[0]);
        const index = Number(first.dataIndex ?? 0);
        const bucket = state.availability[index];
        if (!bucket) return "";
        return `<strong>${escapeHtml(formatUtcTime(bucket.time))}</strong><br/>状态：${STATUS_LABELS[bucket.status]}<br/>HTTP：${latencyText(bucket.httpLatencyMs)}<br/>WebSocket：${latencyText(bucket.wsLatencyMs)}`;
      }
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: palette.line } },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, hideOverlap: true, fontSize: 11 }
    },
    yAxis: {
      type: "value",
      min: 0,
      name: "延迟（ms）",
      nameTextStyle: { color: palette.muted },
      axisLabel: { color: palette.muted },
      splitLine: { lineStyle: { color: palette.line, type: "dashed" } }
    },
    dataZoom: state.availability.length > 168 ? [{ type: "inside", start: 85, end: 100 }, { type: "slider", height: 18, bottom: 4 }] : [],
    series: [
      {
        name: "HTTP",
        type: "line",
        data: state.availability.map((bucket) => bucket.httpLatencyMs),
        connectNulls: false,
        showSymbol: state.availability.length <= 48,
        symbolSize: 6,
        lineStyle: { width: 2 },
        emphasis: { focus: "series" }
      },
      {
        name: "WebSocket",
        type: "line",
        data: state.availability.map((bucket) => bucket.wsLatencyMs),
        connectNulls: false,
        showSymbol: state.availability.length <= 48,
        symbolSize: 6,
        lineStyle: { width: 2 },
        emphasis: { focus: "series" }
      }
    ]
  } as EChartsCoreOption, true);
  setChartState("latency-shell", "ready", "");
}

function renderAvailabilityStrip(): void {
  const strip = byId("availability-strip");
  strip.replaceChildren();
  if (state.availability.length === 0) {
    byId("availability-strip-shell").dataset.state = "empty";
    byId("availability-selection").textContent = "当前范围暂无逐小时可用性记录。";
    return;
  }
  const fragment = document.createDocumentFragment();
  state.selectedAvailabilityIndex = state.availability.length - 1;
  state.availability.forEach((bucket, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "availability-cell";
    cell.dataset.status = bucket.status;
    cell.dataset.index = String(index);
    cell.setAttribute("role", "option");
    cell.setAttribute("aria-selected", index === state.selectedAvailabilityIndex ? "true" : "false");
    cell.tabIndex = index === state.selectedAvailabilityIndex ? 0 : -1;
    cell.setAttribute("aria-label", availabilityLabel(bucket));
    cell.title = availabilityLabel(bucket);
    cell.addEventListener("click", () => selectAvailability(index, false));
    cell.addEventListener("focus", () => selectAvailability(index, false));
    cell.addEventListener("keydown", handleAvailabilityKeydown);
    fragment.append(cell);
  });
  strip.append(fragment);
  byId("availability-strip-shell").dataset.state = "ready";
  updateAvailabilitySelection();
  requestAnimationFrame(() => {
    strip.scrollLeft = strip.scrollWidth;
  });
}

function handleAvailabilityKeydown(event: KeyboardEvent): void {
  let next = state.selectedAvailabilityIndex;
  if (event.key === "ArrowLeft") next -= 1;
  else if (event.key === "ArrowRight") next += 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = state.availability.length - 1;
  else return;
  event.preventDefault();
  selectAvailability(Math.max(0, Math.min(state.availability.length - 1, next)), true);
}

function selectAvailability(index: number, focus: boolean): void {
  const cells = [...byId("availability-strip").querySelectorAll<HTMLButtonElement>(".availability-cell")];
  const previous = cells[state.selectedAvailabilityIndex];
  previous?.setAttribute("aria-selected", "false");
  if (previous) previous.tabIndex = -1;
  state.selectedAvailabilityIndex = index;
  const current = cells[index];
  current?.setAttribute("aria-selected", "true");
  if (current) current.tabIndex = 0;
  if (focus) current?.focus({ preventScroll: true });
  current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
  updateAvailabilitySelection();
}

function updateAvailabilitySelection(): void {
  const bucket = state.availability[state.selectedAvailabilityIndex];
  byId("availability-selection").textContent = bucket ? availabilityLabel(bucket) : "暂无状态";
}

function latencyText(value: number | null): string {
  return value === null ? "无记录" : `${formatInteger(value)} ms`;
}

function availabilityLabel(bucket: AvailabilityBucket): string {
  return `${formatUtcTime(bucket.time)}：${STATUS_LABELS[bucket.status]}；HTTP ${latencyText(bucket.httpLatencyMs)}；WebSocket ${latencyText(bucket.wsLatencyMs)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "请求已取消";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "未知错误";
}

async function refreshAll(): Promise<void> {
  const button = byId<HTMLButtonElement>("refresh-data");
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    await Promise.allSettled([loadSummary(), loadRangeData()]);
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextRange = button.dataset.range as RangeKey;
      if (!Object.prototype.hasOwnProperty.call(RANGE_LABELS, nextRange) || nextRange === state.range) {
        return;
      }
      state.range = nextRange;
      document.querySelectorAll<HTMLButtonElement>("[data-range]").forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
      byId("range-cap-note").hidden = nextRange !== "all";
      void loadRangeData();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-map-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      const metric = button.dataset.mapMetric as MapMetric;
      if (metric !== "calls" && metric !== "uniqueVisitors") {
        return;
      }
      state.mapMetric = metric;
      document.querySelectorAll<HTMLButtonElement>("[data-map-metric]").forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
      renderMap();
    });
  });

  byId("world-crumb").addEventListener("click", () => setMapLevel("world"));
  byId("refresh-data").addEventListener("click", () => void refreshAll());
  byId("fatal-retry").addEventListener("click", () => void refreshAll());
  document.querySelectorAll<HTMLButtonElement>(".panel-retry").forEach((button) => button.addEventListener("click", () => void loadRangeData()));

  document.querySelectorAll<HTMLTableCellElement>("#geo-table th[data-sort-key]").forEach((header) => {
    header.querySelector("button")?.addEventListener("click", () => {
      const key = header.dataset.sortKey as SortKey;
      if (state.geoSort.key === key) {
        state.geoSort.direction = state.geoSort.direction === "ascending" ? "descending" : "ascending";
      } else {
        state.geoSort.key = key;
        state.geoSort.direction = key === "name" ? "ascending" : "descending";
      }
      document.querySelectorAll<HTMLTableCellElement>("#geo-table th[data-sort-key]").forEach((item) => {
        item.setAttribute("aria-sort", item === header ? state.geoSort.direction : "none");
      });
      renderGeoTable();
    });
  });

  const rerenderForTheme = () => {
    if (state.timeline.length > 0) {
      renderTimeline();
      renderEvents();
    }
    if (state.countries.length > 0 || state.regions.length > 0) {
      renderMap();
    }
    if (state.availability.length > 0) {
      renderAvailability();
    }
  };
  darkMode.addEventListener("change", rerenderForTheme);
  reducedMotion.addEventListener("change", rerenderForTheme);
}

async function main(): Promise<void> {
  try {
    initCharts();
    bindControls();
    await refreshAll();
  } catch (error) {
    byId("fatal-error").hidden = false;
    byId("fatal-error-message").textContent = `页面初始化失败（${errorMessage(error)}）。请重新加载页面。`;
  }
}

void main();
