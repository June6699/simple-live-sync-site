import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFailOpenMetricsSink,
  createMetricRecord,
  parseMetricsRange,
  type ConnectionContext,
  type MetricsEvent
} from "../src/metrics.js";
import { NodeMetricsService, NodeSqliteAdapter } from "../src/metrics-node.js";
import { SqlMetricsStore } from "../src/metrics-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("metrics storage", () => {
  it("counts only the six successful call events and deduplicates visitors", () => {
    const adapter = new NodeSqliteAdapter(":memory:");
    const store = new SqlMetricsStore(adapter);
    const now = Date.parse("2026-08-20T12:05:00Z");
    const context = {
      source: "node" as const,
      visitorHash: "a".repeat(64),
      countryCode: "CN",
      regionCode: "BJ"
    };
    const events: MetricsEvent[] = [
      { type: "room_created" },
      { type: "room_joined" },
      { type: "send_favorite" },
      { type: "send_history" },
      { type: "send_shield_word" },
      { type: "send_bili_account" }
    ];
    store.write(events.map((event) => metric(event, context, now)));
    store.write([
      metric({ type: "room_created" }, { ...context, isProbe: true }, now)
    ]);

    const summary = store.querySummary("https://example.test", now + 1_000);
    expect(summary).toMatchObject({
      totalCalls: 6,
      calls24h: 6,
      uniqueVisitors24h: 1,
      uniqueVisitors30d: 1
    });
    expect(store.queryTotals()).toHaveLength(6);
    expect(store.queryGeo(parseMetricsRange("24h", now + 1_000))).toEqual(
      expect.objectContaining({
        countries: [
          { countryCode: "CN", calls: 6, uniqueVisitors: 1 }
        ],
        regions: [
          { countryCode: "CN", regionCode: "BJ", calls: 6, uniqueVisitors: 1 }
        ]
      })
    );
    adapter.close();
  });

  it("deduplicates country visitors independently from province visitors", () => {
    const adapter = new NodeSqliteAdapter(":memory:");
    const store = new SqlMetricsStore(adapter);
    const now = Date.parse("2026-08-20T12:05:00Z");
    const visitorHash = "b".repeat(64);
    store.write([
      metric(
        { type: "room_created" },
        { source: "node", visitorHash, countryCode: "CN", regionCode: "BJ" },
        now
      ),
      metric(
        { type: "room_joined" },
        { source: "node", visitorHash, countryCode: "CN", regionCode: "SH" },
        now
      ),
      metric(
        { type: "send_history" },
        {
          source: "node",
          visitorHash: "c".repeat(64),
          countryCode: "US",
          regionCode: ""
        },
        now
      )
    ]);

    const geo = store.queryGeo(parseMetricsRange("24h", now + 1_000));
    expect(geo.countries).toEqual(
      expect.arrayContaining([
        { countryCode: "CN", calls: 2, uniqueVisitors: 1 },
        { countryCode: "US", calls: 1, uniqueVisitors: 1 }
      ])
    );
    expect(geo.regions).toEqual(
      expect.arrayContaining([
        { countryCode: "CN", regionCode: "BJ", calls: 1, uniqueVisitors: 1 },
        { countryCode: "CN", regionCode: "SH", calls: 1, uniqueVisitors: 1 }
      ])
    );
    adapter.close();
  });

  it("synthesizes pending and missing availability hours", () => {
    const adapter = new NodeSqliteAdapter(":memory:");
    const store = new SqlMetricsStore(adapter);
    const target = "https://example.test";
    store.write([
      metric(
        {
          type: "availability_check",
          target,
          httpOk: true,
          websocketOk: true,
          httpLatencyMs: 20,
          websocketLatencyMs: 30
        },
        { source: "node", isProbe: true },
        Date.parse("2026-08-20T00:05:00Z")
      ),
      metric(
        {
          type: "availability_check",
          target,
          httpOk: true,
          websocketOk: false,
          httpLatencyMs: 25
        },
        { source: "node", isProbe: true },
        Date.parse("2026-08-20T01:05:00Z")
      ),
      metric(
        {
          type: "availability_check",
          target,
          httpOk: false,
          websocketOk: true
        },
        { source: "node", isProbe: true },
        Date.parse("2026-08-20T02:05:00Z")
      )
    ], { receivedAt: Date.parse("2026-08-20T03:10:00Z") });

    const pendingNow = Date.parse("2026-08-20T03:10:00Z");
    const pending = store.queryAvailability(parseMetricsRange("24h", pendingNow), target, pendingNow);
    expect(pending.hourly.slice(-4).map((bucket) => bucket.status)).toEqual([
      "up",
      "degraded",
      "down",
      "pending"
    ]);

    const settledNow = Date.parse("2026-08-20T03:16:00Z");
    const settled = store.queryAvailability(parseMetricsRange("24h", settledNow), target, settledNow);
    expect(settled.hourly.at(-1)).toMatchObject({ status: "down" });
    expect(store.querySummary(target, settledNow).availability30d).toBeCloseTo(25);
    adapter.close();
  });

  it("retains daily totals while removing 90-day detail", () => {
    const adapter = new NodeSqliteAdapter(":memory:");
    const store = new SqlMetricsStore(adapter, { cleanupIntervalMs: Number.MAX_SAFE_INTEGER });
    const old = Date.parse("2025-01-01T12:00:00Z");
    store.write([
      metric(
        { type: "room_created" },
        {
          source: "node",
          visitorHash: "d".repeat(64),
          countryCode: "JP",
          regionCode: ""
        },
        old
      )
    ], { receivedAt: old });
    store.cleanup(Date.parse("2026-08-20T12:00:00Z"));

    expect(store.queryTotals()[0]?.total).toBe(1);
    expect(store.queryDaily({
      from: Date.parse("2025-01-01T00:00:00Z"),
      to: Date.parse("2025-01-02T00:00:00Z"),
      granularity: "day"
    })).toHaveLength(1);
    expect(store.queryHourly({
      from: Date.parse("2025-01-01T00:00:00Z"),
      to: Date.parse("2025-01-02T00:00:00Z"),
      granularity: "hour"
    })).toHaveLength(0);
    adapter.close();
  });
});

describe("Node metrics queue", () => {
  it("flushes at 100 records and persists across restart without raw IP", () => {
    const directory = mkdtempSync(join(tmpdir(), "simple-live-sync-metrics-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "metrics.sqlite");
    const service = new NodeMetricsService({ path, maxBatchSize: 100 });
    for (let index = 0; index < 100; index += 1) {
      service.record(
        { type: "room_created" },
        {
          source: "node",
          visitorHash: "e".repeat(64),
          countryCode: "ZZ",
          regionCode: ""
        }
      );
    }
    expect(service.queuedRecords).toBe(0);
    service.close();

    const reopened = new NodeMetricsService({ path });
    expect(reopened.store.queryTotals()[0]?.total).toBe(100);
    reopened.close();
    expect(readFileSync(path).includes(Buffer.from("203.0.113.9", "utf8"))).toBe(false);
  });

  it("keeps sync behavior fail-open when a sink throws", () => {
    const errors: unknown[] = [];
    const sink = createFailOpenMetricsSink(
      {
        record() {
          throw new Error("database unavailable");
        }
      },
      (error) => errors.push(error)
    );
    expect(() => sink.record({ type: "room_created" })).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

function metric(event: MetricsEvent, context: ConnectionContext, occurredAt: number) {
  return createMetricRecord(event, context, occurredAt);
}
