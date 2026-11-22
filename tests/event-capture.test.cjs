const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/event-capture.js");
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
afterEach(() => { global.fetch = originalFetch; process.env = { ...originalEnv }; });
function configure() {
  process.env.EVENT_CAPTURE_GITHUB_TOKEN = "server-only-token";
  process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "server-redis-secret";
  delete process.env.EVENT_CAPTURE_ADMIN_KEY;
}
async function request(method, input = { event_id: "sc", cycle: 2026 }, headers = {}) {
  const req = { method, body: method === "POST" ? input : undefined, query: input, headers, socket: { remoteAddress: "192.0.2.1" } };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; }, end() { return this; } };
  await handler(req, res);
  return res;
}
function mockServices({ runs = [], material = null, reserve, redisDown = false, dispatchFails = false } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (url === process.env.UPSTASH_REDIS_REST_URL) {
      if (redisDown) throw new Error("redis unavailable");
      const cmd = JSON.parse(options.body);
      const result = cmd[0] === "EVAL" ? (cmd[2] === 4 ? reserve || [1, cmd.at(-1)] : 1) : null;
      return { ok: true, json: async () => ({ result }) };
    }
    if (url.includes("/contents/")) return { ok: Boolean(material), status: material ? 200 : 404, json: async () => material };
    if (url.includes("/dispatches")) {
      if (dispatchFails) throw new Error("timed out");
      return { ok: true };
    }
    return { ok: true, json: async () => ({ workflow_runs: runs }) };
  };
  return calls;
}
test("public dispatch needs no login or admin key; credentials only go to server services", async () => {
  configure();
  const calls = mockServices();
  const response = await request("POST");
  assert.equal(response.code, 202);
  const dispatch = calls.find(c => c.url.endsWith("/dispatches"));
  assert.deepEqual(JSON.parse(dispatch.body).inputs, { event_id: "sc", cycle: "2026" });
  assert.equal(dispatch.headers.Authorization, "Bearer server-only-token");
  assert.ok(!JSON.stringify(response.body).includes("secret"));
  const admission = calls.map(c => c.body && JSON.parse(c.body)).find(c => c?.[0] === "EVAL");
  assert.equal(admission[2], 4);
  assert.ok(!JSON.stringify(admission).includes("192.0.2.1"));
});
test("missing shared limiter, unknown events and invalid bodies fail without dispatch", async () => {
  configure();
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  global.fetch = () => { throw new Error("unexpected request"); };
  assert.equal((await request("POST")).code, 503);
  assert.equal((await request("POST", { event_id: "../../evil", cycle: 2026 })).code, 400);
  assert.equal((await request("POST", "null")).code, 400);
});
test("fresh materials are reused without reserving quota or dispatching", async () => {
  configure();
  const calls = mockServices({ material: { status: "ok", pages: [{}], generated_at: new Date().toISOString() } });
  const response = await request("POST");
  assert.equal(response.code, 200);
  assert.equal(response.body.cached, true);
  assert.ok(!calls.some(c => c.url.endsWith("/dispatches") || c.body && JSON.parse(c.body)[0] === "EVAL"));
});
test("active shared task and atomically reserved task both avoid duplicate dispatch", async () => {
  configure();
  const run = { id: 7, display_title: "event-capture:sc:2026", status: "in_progress", conclusion: null,
    html_url: "https://github.com/example/run/7", created_at: new Date().toISOString(), private_field: "hidden" };
  let calls = mockServices({ runs: [run] });
  let response = await request("POST");
  assert.equal(response.body.existing, true);
  assert.ok(!JSON.stringify(response.body).includes("private_field"));
  assert.ok(!calls.some(c => c.url.endsWith("/dispatches")));
  const at = new Date().toISOString();
  calls = mockServices({ reserve: [0, JSON.stringify({ id: "other-request", at })] });
  response = await request("POST");
  assert.equal(response.code, 202);
  assert.equal(response.body.pending_since, at);
  assert.equal(response.body.existing, true);
  assert.ok(!calls.some(c => c.url.endsWith("/dispatches")));
});
test("IP, daily and global spacing rejections expose retry time without dispatch", async () => {
  configure();
  for (const code of [-1, -2, -3]) {
    const calls = mockServices({ reserve: [code, 120] });
    const response = await request("POST");
    assert.equal(response.code, 429);
    assert.equal(response.headers["Retry-After"], "120");
    assert.equal(response.body.error, code === -2 ? "daily_limit_reached" : "try_again_later");
    assert.ok(!calls.some(c => c.url.endsWith("/dispatches")));
  }
});
test("shared limiter failure fails closed, dispatch timeout retains the reservation", async () => {
  configure();
  let calls = mockServices({ redisDown: true });
  assert.equal((await request("POST")).code, 503);
  assert.ok(!calls.some(c => c.url.includes("github.com")));
  calls = mockServices({ dispatchFails: true });
  assert.equal((await request("POST")).body.error, "dispatch_status_unknown");
  assert.equal(calls.filter(c => c.body && JSON.parse(c.body)[0] === "EVAL").length, 1);
});
test("GitHub Pages origin can preflight but unrelated origins cannot call endpoint", async () => {
  configure();
  const allowed = await request("OPTIONS", {}, { origin: "https://shengjiangbanxia.github.io" });
  assert.equal(allowed.code, 204);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "https://shengjiangbanxia.github.io");
  assert.equal((await request("POST", undefined, { origin: "https://unrelated.example" })).code, 403);
});
