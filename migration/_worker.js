/**
 * Hajj CAD Worker — D1-backed
 * Replaces previous _worker.js. Adds:
 *   /api/auth/login     POST   nid + last4_mobile -> session token
 *   /api/auth/whoami    GET    bearer token -> user
 *   /api/auth/logout    POST   invalidates session
 *   /api/health         GET    Worker + D1 health
 * Keeps:
 *   /api/v1/*           old read-only routes (data.json compat)
 *   /api/v1/pcr/proxy   GAS PCR proxy
 * All static assets pass through to Pages.
 *
 * Bindings (configured in wrangler.toml):
 *   env.DB              D1Database (hajj_cad)
 *
 * Build: 2026-05-09 v1.0 D1 Day 1
 */

const VERSION = "v12.0-d1";
const SESSION_TTL_SECS = 72 * 3600; // 72h

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data, opts = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  };
  if (opts.cache) {
    headers["Cache-Control"] = `public, max-age=${opts.cache}, s-maxage=${opts.cache}`;
  } else if (opts.cache !== false) {
    headers["Cache-Control"] = "no-store";
  }
  return new Response(JSON.stringify(data, null, opts.pretty ? 2 : 0), {
    status: opts.status || 200,
    headers,
  });
}

function err(message, status = 400, extra = {}) {
  return jsonResponse({ ok: false, error: message, ...extra }, { status });
}

// ----- crypto helpers -----

async function randomToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s) {
  const enc = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function getBearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function ipHashFromRequest(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  // Light obfuscation; not a security boundary, just for audit deduping.
  return ip; // we'll hash later if needed
}

// ----- auth core -----

async function authResolve(request, env) {
  const token = getBearer(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.nid, s.expires_at, a.name, a.role, a.cluster, a.station, a.unit_code, a.active
     FROM sessions s JOIN allowlist a ON a.nid = s.nid
     WHERE s.token = ?1 AND s.expires_at > ?2`
  ).bind(token, now()).first();
  if (!row) return null;
  if (!row.active) return null;
  return {
    token: row.token,
    nid: row.nid,
    name: row.name,
    role: row.role,
    cluster: row.cluster,
    station: row.station,
    unit_code: row.unit_code,
    expires_at: row.expires_at,
  };
}

async function rateLimitCheck(env, nid) {
  // 5 failed attempts in last 5 minutes blocks for 5 more minutes
  const since = now() - 300;
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE nid = ?1 AND ts > ?2 AND success = 0`
  ).bind(nid, since).first();
  return (r?.n || 0) < 5;
}

async function logLoginAttempt(env, nid, success, request, reason) {
  const ua = request.headers.get("User-Agent") || "";
  const ip = ipHashFromRequest(request);
  await env.DB.prepare(
    `INSERT INTO login_attempts (nid, success, ip_hash, ua, reason) VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(nid, success ? 1 : 0, await sha256Hex(ip), ua.slice(0, 200), reason || null).run();
}

// ----- AUTH endpoints -----

async function handleAuthLogin(request, env) {
  if (request.method !== "POST") return err("POST only", 405);
  let body;
  try { body = await request.json(); } catch { return err("invalid JSON"); }
  const nid = String(body?.nid || "").trim();
  const last4 = String(body?.last4_mobile || body?.last4 || body?.pin || "").trim();

  if (!/^\d{10}$/.test(nid)) return err("nid must be 10 digits");
  if (!/^\d{4}$/.test(last4)) return err("last4_mobile must be 4 digits");

  // Rate limit
  if (!(await rateLimitCheck(env, nid))) {
    await logLoginAttempt(env, nid, false, request, "rate_limited");
    return err("too many attempts, try again in 5 minutes", 429);
  }

  const user = await env.DB.prepare(
    `SELECT nid, name, role, cluster, station, unit_code, mobile_last4, active FROM allowlist WHERE nid = ?1`
  ).bind(nid).first();

  if (!user) {
    await logLoginAttempt(env, nid, false, request, "nid_not_found");
    return err("not authorized", 401);
  }
  if (!user.active) {
    await logLoginAttempt(env, nid, false, request, "inactive");
    return err("account inactive", 401);
  }
  if (String(user.mobile_last4).padStart(4, "0") !== last4) {
    await logLoginAttempt(env, nid, false, request, "wrong_pin");
    return err("not authorized", 401);
  }

  const token = await randomToken();
  const expires = now() + SESSION_TTL_SECS;
  const ua = (request.headers.get("User-Agent") || "").slice(0, 200);
  const ipHash = await sha256Hex(ipHashFromRequest(request));
  await env.DB.prepare(
    `INSERT INTO sessions (token, nid, expires_at, ua, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(token, nid, expires, ua, ipHash).run();
  await logLoginAttempt(env, nid, true, request, "ok");

  return jsonResponse({
    ok: true,
    token,
    expires_at: expires,
    user: {
      nid: user.nid,
      name: user.name,
      role: user.role,
      cluster: user.cluster,
      station: user.station,
      unit_code: user.unit_code,
    },
  });
}

async function handleAuthWhoami(request, env) {
  const u = await authResolve(request, env);
  if (!u) return err("unauthorized", 401);
  return jsonResponse({ ok: true, user: u });
}

async function handleAuthLogout(request, env) {
  const token = getBearer(request);
  if (!token) return err("no token", 401);
  await env.DB.prepare(`DELETE FROM sessions WHERE token = ?1`).bind(token).run();
  return jsonResponse({ ok: true });
}

// ----- HEALTH -----

async function handleHealth(request, env) {
  let dbOk = false;
  let userCount = 0;
  let sessionCount = 0;
  let dbErr = null;
  try {
    const r = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM allowlist WHERE active = 1) AS users,
         (SELECT COUNT(*) FROM sessions WHERE expires_at > ?1) AS active_sessions`
    ).bind(now()).first();
    dbOk = true;
    userCount = r.users;
    sessionCount = r.active_sessions;
  } catch (e) {
    dbErr = e.message;
  }
  return jsonResponse({
    ok: dbOk,
    version: VERSION,
    service: "hajj-cad",
    time: new Date().toISOString(),
    db: dbOk ? "ok" : "error",
    db_error: dbErr,
    users_active: userCount,
    sessions_active: sessionCount,
  });
}

// ----- LEGACY /api/v1/* (data.json read-only) -----

async function loadDataJson() {
  const url = "https://hajj.shuki.tech/data.json?t=" + Date.now();
  try {
    const r = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
    if (!r.ok) throw new Error("data.json " + r.status);
    return await r.json();
  } catch (e) {
    return { error: "data.json unavailable", detail: e.message };
  }
}

async function handleLegacyV1(request, _env, pathname) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const route = pathname.replace(/^\/api\/v1\/?/, "");

  if (route === "health") {
    return jsonResponse({ status: "ok", version: VERSION, build: "v12 d1", service: "hajj-ops", time: new Date().toISOString() }, { cache: 60 });
  }

  if (route === "pcr/proxy") {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target || !/^https:\/\/script\.google\.com\//.test(target)) {
      return err("url param required, must be https://script.google.com/...", 400);
    }
    const endpoint = url.searchParams.get("endpoint") || "summary";
    const targetUrl = new URL(target);
    targetUrl.searchParams.set("endpoint", endpoint);
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== "url" && k !== "endpoint") targetUrl.searchParams.set(k, v);
    }
    try {
      const r = await fetch(targetUrl.toString(), { headers: { Accept: "application/json" } });
      const txt = await r.text();
      return new Response(txt, {
        status: r.status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
      });
    } catch (e) {
      return err("proxy failed: " + e.message, 502);
    }
  }

  const data = await loadDataJson();
  if (data.error) return jsonResponse(data, { status: 503 });

  switch (route) {
    case "snapshot":     return jsonResponse(data, { pretty: true, cache: 60 });
    case "personnel":    return jsonResponse({ personnel: data.personnel, totals: data.totals, refreshed_at: data.refreshed_at }, { cache: 60 });
    case "units":        return jsonResponse({ units: data.units_detail || [], count: (data.units_detail || []).length, refreshed_at: data.refreshed_at }, { cache: 60 });
    case "stations":     return jsonResponse({ stations: data.stations_detail || [], count: (data.stations_detail || []).length, refreshed_at: data.refreshed_at }, { cache: 60 });
    case "movements":    return jsonResponse({ movements: data.movements || [], augmentations: data.augmentations || [], refreshed_at: data.refreshed_at }, { cache: 60 });
    case "ambulances":   return jsonResponse({ ambulances: data.ambulance_roster || [], by_station: data.amb_by_station || {}, count: (data.ambulance_roster || []).length, refreshed_at: data.refreshed_at }, { cache: 60 });
    case "calendar":     return jsonResponse({ calendar: data.calendar || [], timeline: data.timeline || [], refreshed_at: data.refreshed_at }, { cache: 60 });
    case "":
    case "/":
      return jsonResponse({
        api: "hajj-ops v1",
        version: VERSION,
        endpoints: ["/api/v1/health","/api/v1/personnel","/api/v1/units","/api/v1/stations","/api/v1/movements","/api/v1/ambulances","/api/v1/calendar","/api/v1/snapshot","/api/v1/pcr/proxy?url=…&endpoint=…"],
        docs: "https://hajj.shuki.tech/api-docs.html",
      }, { cache: 60 });
  }

  return err("endpoint not found", 404, { route });
}

// ----- ROUTER -----

async function handleApi(request, env, ctx, pathname) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Auth
  if (pathname === "/api/auth/login")   return handleAuthLogin(request, env);
  if (pathname === "/api/auth/whoami")  return handleAuthWhoami(request, env);
  if (pathname === "/api/auth/logout")  return handleAuthLogout(request, env);

  // Health
  if (pathname === "/api/health")       return handleHealth(request, env);

  // Legacy /api/v1/*
  if (pathname.startsWith("/api/v1/") || pathname === "/api/v1") {
    return handleLegacyV1(request, env, pathname);
  }

  return err("api route not found", 404, { path: pathname });
}

// ----- ENTRYPOINT -----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url.pathname);
      } catch (e) {
        return err("internal error: " + e.message, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
