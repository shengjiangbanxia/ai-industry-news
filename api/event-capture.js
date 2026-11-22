const { createHmac, randomUUID } = require("node:crypto");
const calendar = require("../config/industry-events.json");

// A shared atomic reservation prevents concurrent serverless instances from
// dispatching duplicate jobs or exceeding the public quotas.
const RESERVE = `
local pending = redis.call('GET', KEYS[1])
if pending then return {0, pending} end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= 3 then return {-1, redis.call('TTL', KEYS[2])} end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= 12 then return {-2, redis.call('TTL', KEYS[3])} end
if redis.call('EXISTS', KEYS[4]) == 1 then return {-3, redis.call('TTL', KEYS[4])} end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 900)
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 3600) end
if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], 86400) end
redis.call('SET', KEYS[4], '1', 'EX', 60)
return {1, ARGV[1]}`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
  const send = (status, body) => res.status(status).json(body);
  const origins = (process.env.EVENT_CAPTURE_ALLOWED_ORIGINS || "https://shengjiangbanxia.github.io")
    .split(",").map((value) => value.trim()).filter(Boolean);
  for (const domain of [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (domain) origins.push(`https://${domain}`);
  }
  const origin = req.headers.origin;
  if (origin && !origins.includes(origin)) return send(403, { error: "origin_not_allowed" });
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.status(204).end();
  }
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return send(405, { error: "method_not_allowed" });
  }
  let body = req.body === undefined ? {} : req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return send(400, { error: "invalid_json" }); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "invalid_json" });
  const input = req.method === "POST" ? body : req.query || {};
  const event = calendar.events.find((row) => row.id === input.event_id && String(row.cycle) === String(input.cycle));
  if (!event) return send(400, { error: "unknown_event" });
  const token = process.env.EVENT_CAPTURE_GITHUB_TOKEN;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  // Fail closed instead of falling back to unreliable process-local limits.
  if (!token || !redisUrl || !redisToken) return send(503, { error: "capture_not_configured" });
  const repo = process.env.EVENT_CAPTURE_REPOSITORY || "shengjiangbanxia/ai-industry-news";
  const branch = process.env.EVENT_CAPTURE_BRANCH || "master";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^https:\/\/[\w.-]+(?::443)?\/?$/.test(redisUrl)) {
    return send(503, { error: "invalid_server_config" });
  }
  const base = `https://api.github.com/repos/${repo}`;
  const workflow = `${base}/actions/workflows/collect-event-materials.yml`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const prefix = `event-capture:${repo}:${branch}:`;
  const eventKey = `${prefix}${event.id}:${event.cycle}`;
  const pendingKey = `${eventKey}:pending`;
  async function redis(...command) {
    const response = await fetch(redisUrl, {
      method: "POST", headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(command), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("limiter_unavailable");
    const result = await response.json();
    if (result.error) throw new Error("limiter_unavailable");
    return result.result;
  }
  async function snapshot() {
    const cached = await redis("GET", `${eventKey}:snapshot`);
    if (cached) return JSON.parse(cached);
    const response = await fetch(`${workflow}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=100`, {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("workflow_unavailable");
    const runs = (await response.json()).workflow_runs || [];
    const title = `event-capture:${event.id}:${event.cycle}`;
    const matching = runs.filter((run) => run.display_title === title);
    const latest = matching.find((run) => run.status !== "completed") || matching[0];
    const run = latest ? { id: latest.id, status: latest.status, conclusion: latest.conclusion,
      url: latest.html_url, created_at: latest.created_at } : null;
    const material = await fetch(`${base}/contents/data/event-materials/${event.id}-${event.cycle}.json?ref=${encodeURIComponent(branch)}`, {
      headers: { ...headers, Accept: "application/vnd.github.raw+json" }, signal: AbortSignal.timeout(10000),
    });
    if (!material.ok && material.status !== 404) throw new Error("materials_unavailable");
    const payload = material.ok ? await material.json() : null;
    const generatedAt = payload && ["ok", "partial"].includes(payload.status) && payload.pages?.length ? payload.generated_at : null;
    const value = { run, generated_at: generatedAt };
    await redis("SET", `${eventKey}:snapshot`, JSON.stringify(value), "EX", 15);
    return value;
  }
  try {
    const state = await snapshot();
    const age = state.generated_at ? Date.now() - Date.parse(state.generated_at) : Infinity;
    const fresh = age >= 0 && age < 6 * 3600000;
    const data = { configured: true, ...state, cached: fresh, cache_hours: 6 };
    if (req.method === "GET") {
      const pending = await redis("GET", pendingKey);
      if (pending) {
        const reservation = JSON.parse(pending);
        if (!data.run || Date.parse(data.run.created_at) < Date.parse(reservation.at) - 5000) {
          data.run = null;
          data.pending_since = reservation.at;
        }
      }
      return send(200, data);
    }
    if (state.run && state.run.status !== "completed") return send(200, { ...data, accepted: true, existing: true });
    if (fresh) return send(200, { ...data, accepted: true });
    // Vercel overwrites x-forwarded-for. Other hosts need a trusted proxy.
    // Only a salted hash, not the visitor's IP, is stored in Redis.
    const ip = process.env.VERCEL ? String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim()
      : req.socket?.remoteAddress || "unknown";
    const identity = createHmac("sha256", redisToken).update(ip).digest("hex");
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const reservation = JSON.stringify({ id: randomUUID(), at: new Date().toISOString() });
    const result = await redis("EVAL", RESERVE, 4, pendingKey, `${prefix}ip:${identity}`, `${prefix}daily:${day}`, `${prefix}gap`, reservation);
    if (Number(result[0]) === 0) {
      const pending = JSON.parse(result[1]);
      return send(202, { ...data, accepted: true, existing: true, run: null, pending_since: pending.at });
    }
    if (Number(result[0]) < 0) {
      const retry = Math.max(1, Number(result[1]) || 60);
      res.setHeader("Retry-After", String(retry));
      return send(429, { error: Number(result[0]) === -2 ? "daily_limit_reached" : "try_again_later", retry_after: retry });
    }
    try {
      const dispatch = await fetch(`${workflow}/dispatches`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: branch, inputs: { event_id: event.id, cycle: String(event.cycle) } }),
        signal: AbortSignal.timeout(10000),
      });
      // On timeout the outcome is unknown, so retain the lock against duplicates.
      if (!dispatch.ok) {
        await redis("EVAL", RELEASE, 1, pendingKey, reservation);
        return send(502, { error: "dispatch_failed" });
      }
      return send(202, { accepted: true, run: null, pending_since: JSON.parse(reservation).at });
    } catch {
      return send(502, { error: "dispatch_status_unknown" });
    }
  } catch {
    return send(503, { error: "capture_service_unavailable" });
  }
};
