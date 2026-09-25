const origin = String(process.argv[2] ?? "https://june6699.top").replace(/\/+$/, "");
const expectMetrics = process.argv.includes("--expect-metrics");
const timeoutMs = 8_000;

const home = await request("/");
assert(home.response.ok, `home returned ${home.response.status}`);
assert(
  home.response.headers.get("content-type")?.includes("text/html"),
  "home did not return HTML"
);

const health = await request("/health?format=json");
assert(health.response.ok, `health returned ${health.response.status}`);
const healthPayload = JSON.parse(health.body);
assert(healthPayload.status === true, "health status is not true");

if (expectMetrics) {
  const stats = await request("/api/stats/summary");
  assert(stats.response.ok, `stats returned ${stats.response.status}`);
  const statsPayload = JSON.parse(stats.body);
  assert(
    statsPayload !== null && typeof statsPayload === "object",
    "stats did not return a JSON object"
  );
}

console.log(`Public HTTP smoke passed at ${origin}`);

async function request(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { response, body: await response.text() };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
