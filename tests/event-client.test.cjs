const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function client(postResult, { materialDate = new Date().toISOString(), postStatus = 200 } = {}) {
  class Element {
    constructor() { this.hidden = false; this.children = []; this.listeners = {}; this.textContent = ""; }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.append(node); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
    addEventListener(name, callback) { this.listeners[name] = callback; }
    click() { return this.listeners.click?.(); }
  }
  const html = fs.readFileSync("event.html", "utf8");
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const calls = [];
  const context = {
    document: { getElementById: id => elements[id], createElement: () => new Element() },
    window: { addEventListener() {} }, location: new URL("https://shengjiangbanxia.github.io/ai-industry-news/event.html?id=sc&cycle=2026"),
    URL, URLSearchParams, Date, setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      let payload, status = 200;
      if (url.includes("config/event-capture")) payload = { api_url: "https://capture.example/api/event-capture" };
      else if (url.includes("industry-events")) payload = { events: [{ id: "sc", cycle: 2026, name: "SC26", source_url: "https://official.example/" }] };
      else if (url.includes("event-materials")) payload = { generated_at: materialDate, status: "ok", pages: [{ title: "Official", url: "https://official.example/", excerpts: [] }] };
      else if (options.method === "POST") { payload = postResult; status = postStatus; }
      else payload = { run: null };
      return { ok: status < 400, status, json: async () => payload };
    },
  };
  vm.runInNewContext(fs.readFileSync("assets/event.js", "utf8"), context);
  await new Promise(setImmediate);
  await elements.captureForm.listeners.submit({ preventDefault() {} });
  return { elements, calls };
}

test("visitor submits to configured public endpoint with no credential or password field", async () => {
  const { elements, calls } = await client({ accepted: true, run: null, pending_since: new Date().toISOString() }, { postStatus: 202 });
  assert.equal(elements.adminKey, undefined);
  const post = calls.find(call => call.method === "POST");
  assert.equal(post.url, "https://capture.example/api/event-capture");
  assert.equal(post.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(post.body), { event_id: "sc", cycle: 2026 });
  assert.match(elements.captureStatus.textContent, /已提交/);
});
test("cached result is reused, and stale display data is not reported as synchronized", async () => {
  const now = new Date().toISOString();
  let result = await client({ cached: true, generated_at: now });
  assert.match(result.elements.captureStatus.textContent, /已复用/);
  result = await client({ cached: true, generated_at: now }, { materialDate: "2020-01-01T00:00:00Z" });
  assert.match(result.elements.captureStatus.textContent, /正在同步/);
});
test("daily quota and missing backend have distinct reader-facing messages", async () => {
  let result = await client({ error: "daily_limit_reached", retry_after: 3600 }, { postStatus: 429 });
  assert.match(result.elements.captureStatus.textContent, /今日/);
  result = await client({ error: "capture_not_configured" }, { postStatus: 503 });
  assert.match(result.elements.captureStatus.textContent, /尚未配置/);
  assert.equal(result.elements.captureForm.hidden, true);
});
