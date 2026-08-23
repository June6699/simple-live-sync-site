import { afterEach, describe, expect, it } from "vitest";

import { createMetricRecord } from "../src/metrics.js";
import { NodeSqliteAdapter } from "../src/metrics-node.js";
import { SqlMetricsStore } from "../src/metrics-store.js";
import { queryStatsApi } from "../src/stats-api.js";

const adapters: NodeSqliteAdapter[] = [];

afterEach(() => {
  for (const adapter of adapters.splice(0)) {
    adapter.close();
  }
});

describe("stats API payloads", () => {
  it("returns the public contract without visitor hashes", () => {
    const adapter = new NodeSqliteAdapter(":memory:");
    adapters.push(adapter);
    const store = new SqlMetricsStore(adapter);
    const now = Date.parse("2026-08-20T12:10:00Z");
    const target = "https://example.test";
    const visitorHash = "f".repeat(64);
    store.write([
      createMetricRecord(
        { type: "room_created" },
        { source: "node", visitorHash, countryCode: "DE", regionCode: "" },
        now - 1_000
      ),
      createMetricRecord(
        {
          type: "availability_check",
          target,
          httpOk: true,
          websocketOk: true,
          httpLatencyMs: 12,
          websocketLatencyMs: 18
        },
        { source: "node", isProbe: true },
        now - 5 * 60_000
      )
    ], { receivedAt: now });

    const summary = queryStatsApi(
      store,
      new URL("https://example.test/api/stats/summary"),
      target,
      now
    );
    expect(summary).toMatchObject({
      status: 200,
      payload: {
        totalCalls: 1,
        calls24h: 1,
        uniqueVisitors30d: 1,
        availability30d: null,
        generatedAt: "2026-08-20T12:10:00.000Z"
      }
    });

    const timeline = queryStatsApi(
      store,
      new URL("https://example.test/api/stats/timeline?range=24h"),
      target,
      now
    );
    expect(timeline.status).toBe(200);
    expect(JSON.stringify(timeline.payload)).not.toContain(visitorHash);

    const geo = queryStatsApi(
      store,
      new URL("https://example.test/api/stats/geo?range=30d"),
      target,
      now
    );
    expect(geo.payload).toEqual(
      expect.objectContaining({
        countries: [{ countryCode: "DE", calls: 1, uniqueVisitors: 1 }]
      })
    );
  });

  it("rejects unsupported ranges and query parameters", () => {
    const adapter = new NodeSqliteAdapter(":memory:");
    adapters.push(adapter);
    const store = new SqlMetricsStore(adapter);
    const target = "https://example.test";
    expect(
      queryStatsApi(
        store,
        new URL("https://example.test/api/stats/geo?range=all"),
        target
      ).status
    ).toBe(400);
    expect(
      queryStatsApi(
        store,
        new URL("https://example.test/api/stats/timeline?range=24h&from=0"),
        target
      ).status
    ).toBe(400);
  });
});
