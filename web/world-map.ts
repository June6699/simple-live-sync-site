import { geoEquirectangular, type GeoStream } from "d3-geo";

type MapProjectionStream = Required<GeoStream>;

export type WorldMapProjection = {
  project(point: number[]): number[];
  unproject(point: number[]): number[];
  stream(outStream: MapProjectionStream): MapProjectionStream;
};

const projection = geoEquirectangular()
  .scale(1)
  .translate([0, 0]);

export const worldMapProjection: WorldMapProjection = {
  project(point) {
    return projection([point[0], point[1]]) as [number, number];
  },
  unproject(point) {
    return projection.invert?.([point[0], point[1]]) as [number, number];
  },
  stream(outStream) {
    return projection.stream(outStream) as MapProjectionStream;
  }
};

export function hasMappableGeoData(
  rows: ReadonlyArray<{ code: string; calls: number; uniqueVisitors: number }>
): boolean {
  return rows.some((row) => row.code !== "ZZ" && (row.calls > 0 || row.uniqueVisitors > 0));
}
