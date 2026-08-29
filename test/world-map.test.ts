import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { geoStream, type GeoStream } from "d3-geo";
import { feature as topologyFeature } from "topojson-client";
import { describe, expect, it } from "vitest";

import { hasMappableGeoData, worldMapProjection } from "../web/world-map.js";

type WorldTopology = {
  objects: { countries: unknown };
  [key: string]: unknown;
};

describe("world map projection", () => {
  it("clips source geometry at the antimeridian instead of drawing across the map", () => {
    const topology = JSON.parse(readFileSync(
      resolve("public/assets/maps/world-countries-110m.json"),
      "utf8"
    )) as WorldTopology;
    const world = topologyFeature(
      topology as never,
      topology.objects.countries as never
    );
    const lines: Array<Array<[number, number]>> = [];
    let currentLine: Array<[number, number]> | null = null;
    const output: GeoStream = {
      point(x, y) {
        currentLine?.push([x, y]);
      },
      lineStart() {
        currentLine = [];
        lines.push(currentLine);
      },
      lineEnd() {
        currentLine = null;
      },
      polygonStart() {},
      polygonEnd() {},
      sphere() {}
    };

    geoStream(world as never, worldMapProjection.stream(output as Required<GeoStream>));

    const largestProjectedJump = Math.max(...lines.flatMap((line) => line.slice(1).map(
      (point, index) => Math.abs(point[0] - line[index][0])
    )));
    expect(largestProjectedJump).toBeLessThanOrEqual(Math.PI + Number.EPSILON);
  });

  it("round-trips ordinary coordinates", () => {
    const source = [116.4, 39.9];
    const restored = worldMapProjection.unproject(worldMapProjection.project(source));

    expect(restored[0]).toBeCloseTo(source[0], 8);
    expect(restored[1]).toBeCloseTo(source[1], 8);
  });
});

describe("mappable geo data", () => {
  it("does not treat unknown-only rows as drawable map data", () => {
    expect(hasMappableGeoData([
      { code: "ZZ", calls: 12, uniqueVisitors: 3 }
    ])).toBe(false);
    expect(hasMappableGeoData([
      { code: "ZZ", calls: 12, uniqueVisitors: 3 },
      { code: "CN", calls: 1, uniqueVisitors: 1 }
    ])).toBe(true);
  });
});
