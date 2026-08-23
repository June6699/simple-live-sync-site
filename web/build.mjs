import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const assetsDirectory = resolve(projectRoot, "public", "assets");

await mkdir(assetsDirectory, { recursive: true });
await build({
  absWorkingDir: projectRoot,
  entryPoints: ["web/stats.ts"],
  outfile: "public/assets/stats.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  charset: "utf8",
  logLevel: "info"
});
