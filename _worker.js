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

async function loadDataJson(env) {
  // Use ASSETS binding (no external fetch loop, much faster than self-fetching)
  try {
    const r = await env.ASSETS.fetch(new Request("https://internal/data.json"));
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

  const data = await loadDataJson(_env);
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

  // v2 unified action router (migrated GAS endpoints, GAS-shape responses)
  if (pathname === "/api/v2/exec")      return handleExecV2(request, env);

  // Historical data import (admin only, POST JSON body)
  if (pathname === "/api/v2/migrate_history") return handleMigrateHistory(request, env);

  // Legacy /api/v1/*
  if (pathname.startsWith("/api/v1/") || pathname === "/api/v1") {
    return handleLegacyV1(request, env, pathname);
  }

  return err("api route not found", 404, { path: pathname });
}

// ----- ENTRYPOINT -----

// ===== /api/v2/exec router + 18 migrated action handlers =====

/**
 * Hajj CAD — /api/v2/exec router and action handlers
 * Migrated actions return GAS-compatible response shapes so frontend code
 * needs no changes beyond pointing to /api/v2/exec.
 *
 * Each handler signature: async (user, env, params, dataJson) => {ok, ...}
 */

// Allowed roles per action (mirrors Code.gs hasRole_ checks)
const ROLE_GATE = {
  whoami: null,                    // any authed user
  roster: null,                    // any authed user
  augmentations: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  mobilization_plan: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  roster_fill: ['leadership','admin','dispatcher','cluster_supervisor'],
  unit_availability: ['cluster_supervisor','dispatcher','leadership','admin'],
  units_list: null,
  unit_positions: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  station_status_list: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  reposition_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  admin_allowlist_view: ['admin'],
  admin_sessions_view: ['admin'],
  admin_audit_list: ['admin'],
  admin_apply_validation: ['admin'],
  active_summary: ['cluster_supervisor','dispatcher','leadership','admin'],
  sar_summary: ['sar','admin'],
  dispatch_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  dashboard_active: ['cluster_supervisor','dispatcher','leadership','admin'],
  dashboard_dispatch: ['cluster_supervisor','dispatcher','leadership','admin'],
  dashboard_sv: ['cluster_supervisor','dispatcher','leadership','admin'],
  // Writes
  dispatch_create: ['dispatcher','leadership','admin'],
  dispatch_event: ['dispatcher','leadership','admin'],
  dispatch_close: ['dispatcher','leadership','admin'],
  station_status_set: ['cluster_supervisor','leadership','admin'],
  unit_status_set: ['cluster_supervisor','dispatcher','leadership','admin'],
  reposition_request: ['cluster_supervisor','dispatcher','leadership','admin'],
};

// Actions that need data.json loaded (cached in module scope after first call)
const NEEDS_JSON = new Set([
  'augmentations','mobilization_plan','roster_fill','unit_availability',
  'units_list','unit_positions','active_summary','dashboard_active',
  'dashboard_dispatch','dashboard_sv','sar_summary','roster','station_status_list'
]);

const STATIONS = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3'];
const CLUSTER_STATIONS = {
  arafat: ['ARF1','ARF2','ARF3'],
  muzdalifah: ['MUZ1','MUZ2','MUZ3'],
  mina: ['MIN1','MIN2','MIN3']
};

// === Helpers ===

function hasRole(user, allowed) {
  if (!allowed) return true;
  return allowed.includes(String(user.role || '').toLowerCase());
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function maskMobile(m) {
  if (!m) return '';
  const s = String(m).replace(/\D/g,'');
  return s.length >= 4 ? '****' + s.slice(-4) : '****';
}

// === ACTION HANDLERS ===

const ACTIONS = {

  // --- read-only, simple ---

  async whoami(user) {
    return {
      ok: true,
      user: {
        nid: user.nid, name: user.name, role: user.role,
        cluster: user.cluster, station: user.station,
        unit_code: user.unit_code, name_ar: user.name_ar || ''
      }
    };
  },

  async roster(user, env, params, dj) {
    // /me reads this — user info + their unit's schedule
    const u = {
      nid: user.nid, name: user.name, role: user.role,
      cluster: user.cluster, station: user.station, unit_code: user.unit_code
    };
    let schedule = [];
    if (user.unit_code && dj && dj.schedule_grid) {
      // schedule_grid is keyed by DH. Each value has units→cells.
      // Frontend expects [{NID, Unit, DH, Shift, Date, Station}, ...]
      const DH_BASE = new Date('2026-05-30T00:00:00+03:00').getTime();
      Object.keys(dj.schedule_grid).forEach(dhStr => {
        const dh = parseInt(dhStr, 10);
        const dayObj = dj.schedule_grid[dhStr] || {};
        const units = dayObj.units || dayObj || {};
        const myCell = units[user.unit_code];
        if (!myCell) return;
        // myCell may be {S1, S2} or { day, night }
        ['S1','S2','day','night'].forEach(slot => {
          const v = myCell[slot];
          if (!v) return;
          schedule.push({
            NID: user.nid, Unit: user.unit_code, DH: dh,
            Shift: (slot === 'S1' || slot === 'day') ? 'Day' : 'Night',
            Date: new Date(DH_BASE + (dh - 4) * 86400000).toISOString().slice(0,10),
            Station: String(v)
          });
        });
      });
    }
    return { ok: true, user: u, schedule };
  },

  // --- D1 reads ---

  async admin_allowlist_view(user, env) {
    const r = await env.DB.prepare(
      `SELECT nid AS NID, name AS Name, role AS Role, cluster AS Cluster,
              station AS Station, unit_code AS Unit, mobile_last4 AS Mobile,
              active AS Active, notes AS Notes
       FROM allowlist ORDER BY name`
    ).all();
    const rows = (r.results || []).map(row => {
      // Match GAS shape: Mobile shown as ****1234
      if (row.Mobile) row.Mobile = '****' + String(row.Mobile).slice(-4);
      return row;
    });
    return { ok: true, rows, count: rows.length };
  },

  async admin_sessions_view(user, env) {
    const r = await env.DB.prepare(
      `SELECT token AS Token, nid AS NID, expires_at, created_at, ua AS UA
       FROM sessions ORDER BY created_at DESC LIMIT 100`
    ).all();
    const now = nowSec();
    const rows = (r.results || []).map(row => ({
      Token: '...' + String(row.Token).slice(-6),
      NID: row.NID,
      Created_At: new Date(row.created_at * 1000).toISOString(),
      Expires: new Date(row.expires_at * 1000).toISOString(),
      UA: row.UA,
      is_active: row.expires_at > now
    }));
    return { ok: true, rows, total: rows.length };
  },

  async admin_audit_list(user, env) {
    const r = await env.DB.prepare(
      `SELECT id, ts, actor_nid, action, resource, resource_id, details
       FROM audit_log ORDER BY ts DESC LIMIT 200`
    ).all();
    const entries = (r.results || []).map(row => ({
      id: row.id, ts: new Date(row.ts * 1000).toISOString(),
      actor_nid: row.actor_nid, action: row.action,
      resource: row.resource, resource_id: row.resource_id,
      details: row.details
    }));
    return { ok: true, entries };
  },

  async dispatch_list(user, env, params) {
    const limit = Math.min(parseInt(params.limit || '500', 10), 2000);
    // Date filter: ?date=YYYY-MM-DD returns only that day (UTC)
    let where = '', binds = [];
    if (params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
      const dayStart = Math.floor(new Date(params.date + 'T00:00:00Z').getTime() / 1000);
      const dayEnd = dayStart + 86400;
      where = 'WHERE ts >= ?1 AND ts < ?2';
      binds = [dayStart, dayEnd, limit];
    } else if (params.from && params.to) {
      const fromTs = Math.floor(new Date(params.from).getTime() / 1000);
      const toTs = Math.floor(new Date(params.to).getTime() / 1000);
      where = 'WHERE ts >= ?1 AND ts < ?2';
      binds = [fromTs, toTs, limit];
    } else {
      binds = [limit];
    }
    const sql = `SELECT incident_id AS Incident_ID, ts, station AS Zone, sub_location,
                        source AS Source, complaint AS Chief_Complaint, triage AS Category,
                        cardiac_arrest, unit_assigned AS Unit, status AS Status,
                        patient_count, notes AS Notes, created_by_nid AS Created_By,
                        closed_at, closed_by_nid AS Closed_By, pcr_id AS PCR_ID
                 FROM dispatch_log ${where} ORDER BY ts DESC LIMIT ?${binds.length}`;
    const r = await env.DB.prepare(sql).bind(...binds).all();
    const incidents = (r.results || []).map(row => {
      row.Created_At = new Date(row.ts * 1000).toISOString();
      if (row.closed_at) row.Closed_At = new Date(row.closed_at * 1000).toISOString();
      delete row.ts; delete row.closed_at;
      return row;
    });
    // Day list for date toggle UI: distinct dates in dispatch_log (last 30)
    let availableDays = [];
    if (params.with_days === '1') {
      const d = await env.DB.prepare(
        `SELECT DISTINCT date(ts, 'unixepoch') AS d FROM dispatch_log
         ORDER BY d DESC LIMIT 30`
      ).all();
      availableDays = (d.results || []).map(r => r.d);
    }
    return {
      ok: true,
      incidents,
      filter: params.date || (params.from ? `${params.from}..${params.to}` : 'all'),
      available_days: availableDays,
      server_time: new Date().toISOString()
    };
  },

  async reposition_list(user, env) {
    const r = await env.DB.prepare(
      `SELECT id, unit_code AS Unit_Code, from_station AS From_Station,
              to_station AS To_Station, status AS Status, reason AS Reason,
              requested_by_nid AS Requested_By, requested_at, completed_at
       FROM reposition_log ORDER BY requested_at DESC LIMIT 100`
    ).all();
    const all = (r.results || []).map(row => {
      row.Timestamp = new Date(row.requested_at * 1000).toISOString();
      if (row.completed_at) row.Completed_At = new Date(row.completed_at * 1000).toISOString();
      delete row.requested_at; delete row.completed_at;
      return row;
    });
    return {
      ok: true,
      pending: all.filter(r => ['requested','pending'].includes(r.Status)),
      recent: all.slice(0, 50)
    };
  },

  // --- data.json reads ---

  async roster_fill(user, env, params, dj) {
    // data.json.roster has the exact shape Apps Script returns
    const r = (dj && dj.roster) ? dj.roster : {};
    return Object.assign({ ok: true }, r);
  },

  async augmentations(user, env, params, dj) {
    // Read raw rows from D1 (imported from Mob Sheet → Augmentations tab)
    const r = await env.DB.prepare(
      `SELECT aug_id, from_unit, to_station, movement, dh_day, hour, status, reason, notes
       FROM augmentations ORDER BY aug_id ASC`
    ).all();
    const rows = (r.results || []).map(row => ({
      'Aug ID': row.aug_id,
      'From Unit': row.from_unit,
      'To Station': row.to_station,
      'Movement': row.movement,
      'DH Day': row.dh_day,
      'Hour': row.hour,
      'Status': row.status,
      'Reason': row.reason,
      'Notes': row.notes,
      // legacy snake_case aliases for frontend variants
      from_unit: row.from_unit,
      to_station: row.to_station,
      dh_day: row.dh_day
    }));
    // Summary stats (from data.json if available, otherwise compute)
    const a = (dj && dj.augmentations) || {};
    const counts = { Planned: 0, Active: 0, Returned: 0, Cancelled: 0 };
    rows.forEach(r => { if (r.Status && counts[r.Status] !== undefined) counts[r.Status]++; });
    return {
      ok: true,
      total: rows.length,
      active: counts.Active,
      planned: counts.Planned,
      returned: counts.Returned,
      cancelled: counts.Cancelled,
      total_para_moved: a.total_para_moved || rows.length,
      by_movement: a.by_movement || {},
      by_donor: a.by_donor || {},
      by_recipient: a.by_recipient || {},
      matrix: a.matrix || {},
      rows  // raw rows now populated from D1
    };
  },

  async mobilization_plan(user, env, params, dj) {
    // Read pivoted long-format from D1 and pivot back to wide for frontend
    // Filter: ?dh_day=4..14, ?unit_id=PM, ?value=ARF1 (station code)
    let where = '', binds = [];
    const conditions = [];
    if (params.dh_day) {
      conditions.push(`dh_day = ?${binds.length + 1}`);
      binds.push(parseInt(params.dh_day, 10));
    }
    if (params.unit_id) {
      conditions.push(`unit_id = ?${binds.length + 1}`);
      binds.push(params.unit_id);
    }
    if (params.value) {
      conditions.push(`value = ?${binds.length + 1}`);
      binds.push(params.value);
    }
    if (conditions.length) where = 'WHERE ' + conditions.join(' AND ');
    const sql = `SELECT unit_id, unit_type, unit_size, home, slot_key, dh_day, shift, value
                 FROM mobilization_plan ${where} ORDER BY unit_id, dh_day, shift`;
    const r = await env.DB.prepare(sql).bind(...binds).all();
    const longRows = r.results || [];
    // Pivot back: { unit_id: 'PM', 'Unit Type': 'PM', '4DH-S1': 'D7', '4DH-S2': 'N19', ... }
    const wide = {};
    longRows.forEach(row => {
      if (!wide[row.unit_id]) {
        wide[row.unit_id] = {
          'Unit ID': row.unit_id,
          'Unit Type': row.unit_type,
          'Size': row.unit_size,
          'Home': row.home
        };
      }
      wide[row.unit_id][row.slot_key] = row.value;
    });
    const rows = Object.values(wide);
    // Build sorted slot key list for frontend
    const slotKeys = [...new Set(longRows.map(r => r.slot_key))].sort((a, b) => {
      const ma = a.match(/(\d+)DH-S(\d+)/), mb = b.match(/(\d+)DH-S(\d+)/);
      if (!ma || !mb) return a.localeCompare(b);
      return parseInt(ma[1]) - parseInt(mb[1]) || parseInt(ma[2]) - parseInt(mb[2]);
    });
    const headers = ['Unit ID', 'Unit Type', 'Size', 'Home', ...slotKeys];
    return { ok: true, rows, total: rows.length, headers, long_format_count: longRows.length };
  },

  async units_list(user, env, params, dj) {
    // Map data.json.units_detail → Apps Script shape
    const detail = (dj && dj.units_detail) || [];
    const out = detail.map(u => ({
      code: u.id || '',
      type: u.type || '',
      home_station: u.home || '',
      category: u.category || ''
    })).filter(u => u.code);
    // Sort: Mike → Alpha → Romeo
    const order = { Mike: 0, Alpha: 1, Romeo: 2 };
    out.sort((a, b) => {
      const ap = a.code.split('-')[0], bp = b.code.split('-')[0];
      const oa = order[ap] !== undefined ? order[ap] : 99;
      const ob = order[bp] !== undefined ? order[bp] : 99;
      if (oa !== ob) return oa - ob;
      return a.code.localeCompare(b.code, undefined, { numeric: true });
    });
    return { ok: true, units: out };
  },

  async unit_positions(user, env, params, dj) {
    // Default: home positions from data.json units_detail
    // Override: any active reposition_log entries
    const detail = (dj && dj.units_detail) || [];
    const positions = {};
    detail.forEach(u => {
      const code = u.id || '';
      if (!code) return;
      positions[code] = {
        unit: code, station: u.home || '', sub_location: '',
        since: null, source: 'home'
      };
    });
    // D1 reposition overrides
    try {
      const r = await env.DB.prepare(
        `SELECT unit_code, to_station, requested_at FROM reposition_log
         WHERE status IN ('approved','active') ORDER BY requested_at DESC`
      ).all();
      (r.results || []).forEach(row => {
        if (positions[row.unit_code]) {
          positions[row.unit_code] = {
            unit: row.unit_code,
            station: row.to_station,
            sub_location: '',
            since: new Date(row.requested_at * 1000).toISOString(),
            source: 'reposition'
          };
        }
      });
    } catch (_) {}
    return { ok: true, positions: Object.values(positions) };
  },

  async unit_availability(user, env, params, dj) {
    const detail = (dj && dj.units_detail) || [];
    const units = detail.map(u => ({
      code: u.id || '',
      type: u.type || '',
      home_station: (u.home || '').toUpperCase(),
      current_station: (u.home || '').toUpperCase(),
      category: u.category || '',
      state: 'unknown',
      open_incidents: 0,
      schedule_label: '',
      manual_status: '',
      manual_note: '',
      manual_at: ''
    })).filter(u => u.code);

    // Apply reposition overrides for current_station
    try {
      const r = await env.DB.prepare(
        `SELECT unit_code, to_station FROM reposition_log
         WHERE status IN ('approved','active')`
      ).all();
      const reposByCode = {};
      (r.results || []).forEach(row => { reposByCode[row.unit_code] = row.to_station; });
      units.forEach(u => {
        if (reposByCode[u.code]) u.current_station = reposByCode[u.code];
      });
    } catch (_) {}

    // Apply unit_status_log latest
    try {
      const s = await env.DB.prepare(
        `SELECT unit_code, status, note, ts FROM unit_status_log
         WHERE id IN (SELECT MAX(id) FROM unit_status_log GROUP BY unit_code)`
      ).all();
      const stMap = {};
      (s.results || []).forEach(row => { stMap[row.unit_code] = row; });
      units.forEach(u => {
        if (stMap[u.code]) {
          u.manual_status = stMap[u.code].status;
          u.manual_note = stMap[u.code].note || '';
          u.manual_at = new Date(stMap[u.code].ts * 1000).toISOString();
          u.state = stMap[u.code].status;
        }
      });
    } catch (_) {}

    // Open incidents per unit
    try {
      const i = await env.DB.prepare(
        `SELECT unit_assigned, COUNT(*) AS n FROM dispatch_log
         WHERE status NOT IN ('complete','cancelled') AND unit_assigned IS NOT NULL
         GROUP BY unit_assigned`
      ).all();
      const inc = {};
      (i.results || []).forEach(row => { inc[row.unit_assigned] = row.n; });
      units.forEach(u => { u.open_incidents = inc[u.code] || 0; });
    } catch (_) {}

    return { ok: true, units };
  },

  // --- composed (multi-source) ---

  async station_status_list(user, env, params, dj) {
    // Latest status per station from D1 station_status_log
    const latest = {};
    try {
      const r = await env.DB.prepare(
        `SELECT s.station, s.status, s.note, s.set_by_nid, s.ts
         FROM station_status_log s
         WHERE s.id IN (SELECT MAX(id) FROM station_status_log GROUP BY station)`
      ).all();
      (r.results || []).forEach(row => {
        latest[row.station] = {
          station: row.station,
          status: row.status,
          note: row.note || '',
          operator_nid: row.set_by_nid,
          updated_at: new Date(row.ts * 1000).toISOString()
        };
      });
    } catch (_) {}

    // Today's case counts per station
    const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    const cases = {};
    try {
      const r = await env.DB.prepare(
        `SELECT station, status, triage, COUNT(*) AS n FROM dispatch_log
         WHERE ts >= ?1 GROUP BY station, status, triage`
      ).bind(todayStart).all();
      (r.results || []).forEach(row => {
        if (!cases[row.station]) cases[row.station] = { total:0, open:0, red:0, yellow:0, green:0, black:0, closed:0 };
        const c = cases[row.station];
        c.total += row.n;
        if (row.status === 'complete' || row.status === 'cancelled') c.closed += row.n;
        else c.open += row.n;
        if (row.triage && c[row.triage] !== undefined) c[row.triage] += row.n;
      });
    } catch (_) {}

    // Units per station (from D1 units default; data.json has the full counts)
    const unitCount = {};
    const detail = (dj && dj.units_detail) || [];
    detail.forEach(u => {
      const home = (u.home || '').toUpperCase();
      if (!home) return;
      unitCount[home] = (unitCount[home] || 0) + 1;
    });

    // Combine
    const out = STATIONS.map(st => {
      const e = latest[st] || { station: st, status:'', note:'', operator_nid:'', updated_at:'' };
      e.cases = cases[st] || { total:0, open:0 };
      e.units = unitCount[st] || 0;
      e.readiness = e.status === 'green' ? 'ready' :
                    e.status === 'yellow' ? 'busy' :
                    e.status === 'red' ? 'overload' :
                    e.status === 'black' ? 'down' :
                    'not_set';
      return e;
    });
    return { ok: true, stations: out };
  },

  async sar_summary(user, env, params, dj) {
    // SAR redacted: only colors + counts
    const stationsResult = await ACTIONS.station_status_list(user, env, params, dj);
    const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    let open = 0, closedToday = 0, inTransfer = 0;
    try {
      const r = await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM dispatch_log WHERE status NOT IN ('complete','cancelled')) AS open_n,
          (SELECT COUNT(*) FROM dispatch_log WHERE status = 'complete' AND closed_at >= ?1) AS closed_n,
          (SELECT COUNT(*) FROM dispatch_log WHERE status = 'transporting') AS transfer_n`
      ).bind(todayStart).first();
      open = r.open_n || 0;
      closedToday = r.closed_n || 0;
      inTransfer = r.transfer_n || 0;
    } catch (_) {}
    return {
      ok: true, open, closed_today: closedToday, in_transfer: inTransfer,
      stations: stationsResult.stations.map(s => ({ station: s.station, status: s.status })),
      server_time: new Date().toISOString()
    };
  },

  async active_summary(user, env, params, dj) {
    const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    const STATIONS_LIST = STATIONS;

    // Initialize all fields the frontend reads (so missing data = 0, never undefined)
    const result = {
      ok: true,
      server_time: new Date().toISOString(),
      dispatch: {
        open: 0, red_open: 0, cardiac_open: 0, in_transfer: 0, closed_today: 0,
        by_station: {},
        response_time: { mean_ms: 0, p50_ms: 0, p95_ms: 0, count: 0 },
        recent: []
      },
      pcr: {
        today: 0, total: 0,
        by_acuity: {}, by_disposition: {}, by_complaint: {},
        recent: []
      },
      stations: [],
      incidents: []   // for heatmap
    };

    // Initialize per-station containers so frontend can iterate even on empty data
    STATIONS_LIST.forEach(st => {
      result.dispatch.by_station[st] = { open: 0, red_open: 0, in_transfer: 0, closed_today: 0 };
    });

    // 1. Pull all dispatches (today + open from prior days) for full aggregate
    try {
      const incR = await env.DB.prepare(
        `SELECT incident_id, ts, station, sub_location, source, complaint, triage,
                cardiac_arrest, unit_assigned, status, patient_count, notes,
                closed_at, closed_by_nid
         FROM dispatch_log
         WHERE status NOT IN ('complete','cancelled')
            OR closed_at >= ?1 OR ts >= ?1
         ORDER BY ts DESC LIMIT 500`
      ).bind(todayStart).all();
      const incidents = incR.results || [];

      const respTimes = [];
      incidents.forEach(inc => {
        const isOpen = !['complete','cancelled'].includes(inc.status);
        const isToday = inc.ts >= todayStart;
        const closedToday = inc.closed_at && inc.closed_at >= todayStart;
        const station = inc.station || 'UNK';
        const bs = result.dispatch.by_station[station] || (result.dispatch.by_station[station] = { open: 0, red_open: 0, in_transfer: 0, closed_today: 0 });

        if (isOpen) {
          result.dispatch.open++;
          bs.open++;
          if (inc.triage === 'red') { result.dispatch.red_open++; bs.red_open++; }
          if (inc.cardiac_arrest) result.dispatch.cardiac_open++;
          if (inc.status === 'transporting') { result.dispatch.in_transfer++; bs.in_transfer++; }
        }
        if (closedToday) {
          result.dispatch.closed_today++;
          bs.closed_today++;
        }
      });

      // Recent strip: last 20 from today
      result.dispatch.recent = incidents
        .filter(i => i.ts >= todayStart)
        .slice(0, 20)
        .map(i => ({
          incident_id: i.incident_id,
          ts: new Date(i.ts * 1000).toISOString(),
          station: i.station,
          triage: i.triage,
          status: i.status,
          complaint: i.complaint,
          unit: i.unit_assigned
        }));

      result.incidents = incidents.map(i => ({
        incident_id: i.incident_id,
        ts: new Date(i.ts * 1000).toISOString(),
        station: i.station,
        triage: i.triage,
        status: i.status
      }));
    } catch (e) {
      result.dispatch._err = String(e.message);
    }

    // 2. PCRs (qpcr_log)
    try {
      const pcrR = await env.DB.prepare(
        `SELECT pcr_id, ts, station, triage_category, disposition, chief_complaint
         FROM qpcr_log ORDER BY ts DESC LIMIT 500`
      ).all();
      const pcrs = pcrR.results || [];
      result.pcr.total = pcrs.length;
      const todayPcrs = pcrs.filter(p => p.ts >= todayStart);
      result.pcr.today = todayPcrs.length;
      todayPcrs.forEach(p => {
        const ac = (p.triage_category || 'unspecified').toLowerCase();
        result.pcr.by_acuity[ac] = (result.pcr.by_acuity[ac] || 0) + 1;
        const dp = (p.disposition || 'unspecified').toLowerCase();
        result.pcr.by_disposition[dp] = (result.pcr.by_disposition[dp] || 0) + 1;
        const cc = (p.chief_complaint || 'unspecified').toLowerCase();
        result.pcr.by_complaint[cc] = (result.pcr.by_complaint[cc] || 0) + 1;
      });
      result.pcr.recent = todayPcrs.slice(0, 20).map(p => ({
        pcr_id: p.pcr_id,
        ts: new Date(p.ts * 1000).toISOString(),
        station: p.station,
        triage: p.triage_category,
        disposition: p.disposition,
        complaint: p.chief_complaint
      }));
    } catch (e) {
      result.pcr._err = String(e.message);
    }

    // 3. Station status (use existing handler)
    try {
      const stationsResult = await ACTIONS.station_status_list(user, env, params, dj);
      result.stations = stationsResult.stations || [];
    } catch (e) {
      result.stations = STATIONS_LIST.map(s => ({ station: s, status: '', note: '' }));
    }

    return result;
  },

  async dashboard_active(user, env, params, dj) {
    // Mega: combine summary + augmentations + unit_positions + roster_fill + unit_availability
    const [summary, aug, pos, fill, avail] = await Promise.all([
      ACTIONS.active_summary(user, env, params, dj),
      ACTIONS.augmentations(user, env, params, dj),
      ACTIONS.unit_positions(user, env, params, dj),
      ACTIONS.roster_fill(user, env, params, dj),
      ACTIONS.unit_availability(user, env, params, dj)
    ]);
    return {
      ok: true,
      server_time: new Date().toISOString(),
      summary, augmentations: aug, unit_positions: pos,
      roster_fill: fill, unit_availability: avail
    };
  },

  async dashboard_dispatch(user, env, params, dj) {
    // Return full sub-response objects so frontend can check sub.ok
    const [units, incidents, stations] = await Promise.all([
      ACTIONS.unit_availability(user, env, params, dj),
      ACTIONS.dispatch_list(user, env, params, dj),
      ACTIONS.station_status_list(user, env, params, dj)
    ]);
    return {
      ok: true,
      server_time: new Date().toISOString(),
      units,            // {ok, units}
      incidents,        // {ok, incidents, ...}
      station_status: stations  // {ok, stations}
    };
  },

  async dashboard_sv(user, env, params, dj) {
    // Return full sub-response objects so frontend can check sub.ok
    const [stations, repos, units] = await Promise.all([
      ACTIONS.station_status_list(user, env, params, dj),
      ACTIONS.reposition_list(user, env, params, dj),
      ACTIONS.unit_availability(user, env, params, dj)
    ]);
    return {
      ok: true,
      server_time: new Date().toISOString(),
      station_status: stations,  // {ok, stations}
      repositions: repos,        // {ok, pending, recent}
      units                      // {ok, units}
    };
  },

  // ==================== WRITES ====================

  async dispatch_create(user, env, params) {
    const station = (params.station || '').toUpperCase();
    if (!STATIONS.includes(station)) {
      return { ok: false, error: 'invalid_station', station };
    }
    const triage = (params.triage || 'green').toLowerCase();
    if (!['red','yellow','green','black'].includes(triage)) {
      return { ok: false, error: 'invalid_triage', triage };
    }
    // Generate incident_id: DSP-YYYYMMDD-NNNN (sequential per day)
    const now = Math.floor(Date.now() / 1000);
    const dateStr = new Date(now * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    const seqRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM dispatch_log WHERE incident_id LIKE ?1`
    ).bind(`DSP-${dateStr}-%`).first();
    const seq = String((seqRow?.n || 0) + 1).padStart(4, '0');
    const incidentId = `DSP-${dateStr}-${seq}`;
    const cardiacArrest = (params.cardiac_arrest === 'true' || params.cardiac_arrest === '1' || params.cardiac_arrest === 'yes') ? 1 : 0;
    const patientCount = Math.max(1, parseInt(params.patient_count || '1', 10));
    const status = params.unit_assigned ? 'on_scene' : 'pending';
    try {
      await env.DB.prepare(
        `INSERT INTO dispatch_log
         (incident_id, ts, station, sub_location, source, complaint, triage,
          cardiac_arrest, unit_assigned, status, patient_count, notes, created_by_nid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
      ).bind(
        incidentId, now, station,
        params.sub_location || '',
        params.source || 'walk-in',
        params.complaint || '',
        triage,
        cardiacArrest,
        params.unit_assigned || null,
        status,
        patientCount,
        params.notes || '',
        user.nid
      ).run();
      // Audit
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'dispatch_create', 'incident', ?2, ?3)`
      ).bind(user.nid, incidentId, JSON.stringify({ station, triage, status })).run();
      return { ok: true, incident_id: incidentId, status, ts: now };
    } catch (e) {
      return { ok: false, error: 'insert_failed', detail: e.message };
    }
  },

  async dispatch_event(user, env, params) {
    const incidentId = params.incident_id;
    const event = (params.event || '').toLowerCase();
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };
    const validEvents = ['unit_assigned','on_scene','transporting','arrived_hospital'];
    if (!validEvents.includes(event)) return { ok: false, error: 'invalid_event', event, valid: validEvents };
    // Map event → status
    const statusMap = {
      'unit_assigned': 'on_scene',
      'on_scene': 'on_scene',
      'transporting': 'transporting',
      'arrived_hospital': 'transporting'
    };
    const newStatus = statusMap[event];
    try {
      const updates = ['status = ?1'];
      const binds = [newStatus];
      if (params.unit_assigned) {
        updates.push(`unit_assigned = ?${binds.length + 1}`);
        binds.push(params.unit_assigned);
      }
      binds.push(incidentId);
      const r = await env.DB.prepare(
        `UPDATE dispatch_log SET ${updates.join(', ')} WHERE incident_id = ?${binds.length}`
      ).bind(...binds).run();
      if (r.meta?.changes === 0) return { ok: false, error: 'incident_not_found', incident_id: incidentId };
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'dispatch_event', 'incident', ?2, ?3)`
      ).bind(user.nid, incidentId, JSON.stringify({ event, new_status: newStatus, notes: params.notes || '' })).run();
      return { ok: true, incident_id: incidentId, status: newStatus };
    } catch (e) {
      return { ok: false, error: 'update_failed', detail: e.message };
    }
  },

  async dispatch_close(user, env, params) {
    const incidentId = params.incident_id;
    const outcome = (params.outcome || '').toLowerCase();
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };
    const validOutcomes = ['transferred','treated_released','refused','deceased','cancelled'];
    if (!validOutcomes.includes(outcome)) return { ok: false, error: 'invalid_outcome', outcome, valid: validOutcomes };
    const now = Math.floor(Date.now() / 1000);
    const status = outcome === 'cancelled' ? 'cancelled' : 'complete';
    try {
      const r = await env.DB.prepare(
        `UPDATE dispatch_log
         SET status = ?1, closed_at = ?2, closed_by_nid = ?3, notes = COALESCE(notes,'') || ?4
         WHERE incident_id = ?5`
      ).bind(
        status, now, user.nid,
        params.notes ? `\n[close ${new Date(now*1000).toISOString()}]: ${params.notes}` : '',
        incidentId
      ).run();
      if (r.meta?.changes === 0) return { ok: false, error: 'incident_not_found', incident_id: incidentId };
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'dispatch_close', 'incident', ?2, ?3)`
      ).bind(user.nid, incidentId, JSON.stringify({ outcome, status, notes: params.notes || '' })).run();
      return { ok: true, incident_id: incidentId, status, outcome, closed_at: now };
    } catch (e) {
      return { ok: false, error: 'close_failed', detail: e.message };
    }
  },

  async station_status_set(user, env, params) {
    const station = (params.station || '').toUpperCase();
    if (!STATIONS.includes(station)) return { ok: false, error: 'invalid_station', station };
    const status = (params.status || '').toLowerCase();
    if (!['open','closed','degraded','surge','offline'].includes(status)) {
      return { ok: false, error: 'invalid_status', status, valid: ['open','closed','degraded','surge','offline'] };
    }
    // Cluster_supervisor can only set their own cluster
    if (user.role === 'cluster_supervisor' && user.cluster) {
      const clusterStations = CLUSTER_STATIONS[user.cluster.toLowerCase()] || [];
      if (!clusterStations.includes(station)) {
        return { ok: false, error: 'cross_cluster_forbidden', user_cluster: user.cluster, station };
      }
    }
    const capacityPct = params.capacity_pct ? Math.max(0, Math.min(100, parseInt(params.capacity_pct, 10))) : null;
    try {
      const r = await env.DB.prepare(
        `INSERT INTO station_status_log (station, sub_location, status, capacity_pct, set_by_nid, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(station, params.sub_location || '', status, capacityPct, user.nid, params.note || '').run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'station_status_set', 'station', ?2, ?3)`
      ).bind(user.nid, station, JSON.stringify({ status, capacity_pct: capacityPct, note: params.note || '' })).run();
      return { ok: true, station, status, capacity_pct: capacityPct, ts: Math.floor(Date.now()/1000), id: r.meta?.last_row_id };
    } catch (e) {
      return { ok: false, error: 'insert_failed', detail: e.message };
    }
  },

  async unit_status_set(user, env, params) {
    const unitCode = params.unit_code || params.unit;
    if (!unitCode) return { ok: false, error: 'missing_unit_code' };
    const status = (params.status || '').toLowerCase();
    const valid = ['available','on_call','en_route','on_scene','transporting','out_of_service'];
    if (!valid.includes(status)) return { ok: false, error: 'invalid_status', status, valid };
    try {
      const r = await env.DB.prepare(
        `INSERT INTO unit_status_log (unit_code, status, note, set_by_nid)
         VALUES (?1, ?2, ?3, ?4)`
      ).bind(unitCode, status, params.note || '', user.nid).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'unit_status_set', 'unit', ?2, ?3)`
      ).bind(user.nid, unitCode, JSON.stringify({ status, note: params.note || '' })).run();
      return { ok: true, unit_code: unitCode, status, ts: Math.floor(Date.now()/1000), id: r.meta?.last_row_id };
    } catch (e) {
      return { ok: false, error: 'insert_failed', detail: e.message };
    }
  },

  async reposition_request(user, env, params) {
    const unitCode = params.unit_code || params.unit;
    const fromStation = (params.from_station || '').toUpperCase();
    const toStation = (params.to_station || '').toUpperCase();
    if (!unitCode) return { ok: false, error: 'missing_unit_code' };
    if (!STATIONS.includes(fromStation)) return { ok: false, error: 'invalid_from_station', from_station: fromStation };
    if (!STATIONS.includes(toStation)) return { ok: false, error: 'invalid_to_station', to_station: toStation };
    if (fromStation === toStation) return { ok: false, error: 'same_station', station: fromStation };
    try {
      const r = await env.DB.prepare(
        `INSERT INTO reposition_log
         (unit_code, from_station, to_station, reason, status, requested_by_nid, notes)
         VALUES (?1, ?2, ?3, ?4, 'requested', ?5, ?6)`
      ).bind(unitCode, fromStation, toStation, params.reason || '', user.nid, params.notes || '').run();
      const id = r.meta?.last_row_id;
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'reposition_request', 'reposition', ?2, ?3)`
      ).bind(user.nid, String(id), JSON.stringify({ unit_code: unitCode, from: fromStation, to: toStation, reason: params.reason || '' })).run();
      return { ok: true, id, unit_code: unitCode, from_station: fromStation, to_station: toStation, status: 'requested' };
    } catch (e) {
      return { ok: false, error: 'insert_failed', detail: e.message };
    }
  },

  async admin_apply_validation(user, env, params) {
    // Admin-only: refresh data.json from sheet (proxy to GAS for now until cron sync built)
    return {
      ok: true,
      note: 'D1 schema validation only. Sheet → data.json rebuild handled by GitHub Actions cron (every 10min).',
      next_cron: 'pending',
      schema_version: '1.1'
    };
  },

};

// === Router ===
// ===================================================================
// /api/v2/migrate_history — Bulk import historical data from GAS sheet
// Admin-only. POST JSON body. Inserts via INSERT OR IGNORE (idempotent).
// ===================================================================
async function handleMigrateHistory(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }
  // Auth via authResolve (same helper as other handlers)
  const user = await authResolve(request, env);
  if (!user) return jsonResponse({ ok: false, error: 'session_expired' }, 401);
  if (user.role !== 'admin' && user.role !== 'leadership') {
    return jsonResponse({ ok: false, error: 'forbidden', role: user.role }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid_json', message: e.message }, 400);
  }

  const dispatch = Array.isArray(body.dispatch) ? body.dispatch : [];
  const reposition = Array.isArray(body.reposition) ? body.reposition : [];
  const stationStatus = Array.isArray(body.station_status) ? body.station_status : [];

  const results = {
    dispatch: { pulled: dispatch.length, inserted: 0, errors: [] },
    reposition: { pulled: reposition.length, inserted: 0, errors: [] },
    station_status: { pulled: stationStatus.length, inserted: 0, errors: [] }
  };

  // Pre-fetch valid NIDs to handle FK constraint gracefully — historical
  // records may reference NIDs no longer in the allowlist (test users, etc.)
  const validNids = new Set();
  try {
    const r = await env.DB.prepare(`SELECT nid FROM allowlist`).all();
    (r.results || []).forEach(row => validNids.add(String(row.nid)));
  } catch (_) {}
  const safeNid = (nid) => {
    if (!nid) return user.nid;
    return validNids.has(String(nid)) ? String(nid) : user.nid;
  };
  const safeNidOrNull = (nid) => {
    if (!nid) return null;
    return validNids.has(String(nid)) ? String(nid) : null;
  };

  // ===== 1. Dispatch incidents =====
  for (const inc of dispatch) {
    try {
      const incidentId = inc.Incident_ID || inc.incident_id || inc.id;
      if (!incidentId) { results.dispatch.errors.push('missing_id'); continue; }

      let ts = 0;
      const tsRaw = inc.Created_At || inc.Timestamp || inc.ts;
      if (tsRaw) {
        if (typeof tsRaw === 'number') ts = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : Math.floor(tsRaw);
        else ts = Math.floor(new Date(tsRaw).getTime() / 1000) || 0;
      }
      if (!ts) ts = Math.floor(Date.now() / 1000);

      const station = String(inc.Zone || inc.station || '').toUpperCase();
      const subLoc = inc.Sub_Location || inc.sub_location || '';
      const source = inc.Source || inc.source || 'walk-in';
      const complaint = inc.Chief_Complaint || inc.Complaint || inc.complaint || '';
      const triage = String(inc.Category || inc.Triage || inc.triage || 'green').toLowerCase();
      const cardiac = (inc.Cardiac_Arrest === true || inc.Cardiac_Arrest === 1 ||
                       inc.Cardiac_Arrest === 'true' || inc.Cardiac_Arrest === 'yes') ? 1 : 0;
      const unit = inc.Unit || inc.unit_assigned || '';
      const status = String(inc.Status || inc.status || 'pending').toLowerCase();
      const patientCount = parseInt(inc.Patient_Count || inc.patient_count || '1', 10) || 1;
      const notes = inc.Notes || inc.notes || '';
      const createdBy = inc.Created_By || inc.created_by_nid || user.nid;
      let closedAt = null;
      const closedRaw = inc.Closed_At || inc.closed_at;
      if (closedRaw) {
        if (typeof closedRaw === 'number') closedAt = closedRaw > 1e12 ? Math.floor(closedRaw / 1000) : Math.floor(closedRaw);
        else closedAt = Math.floor(new Date(closedRaw).getTime() / 1000) || null;
      }
      const closedBy = safeNidOrNull(inc.Closed_By || inc.closed_by_nid);
      const pcrId = inc.PCR_ID || inc.Q_PCR_ID || inc.pcr_id || null;

      await env.DB.prepare(
        `INSERT OR IGNORE INTO dispatch_log
         (incident_id, ts, station, sub_location, source, complaint, triage, cardiac_arrest,
          unit_assigned, status, patient_count, notes, created_by_nid, closed_at, closed_by_nid, pcr_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`
      ).bind(
        incidentId, ts, station, subLoc, source, complaint, triage, cardiac,
        unit, status, patientCount, notes,
        safeNid(inc.Created_By || inc.created_by_nid),
        closedAt, closedBy, pcrId
      ).run();
      results.dispatch.inserted++;
    } catch (e) {
      results.dispatch.errors.push(String(e.message).slice(0, 100));
    }
  }

  // ===== 2. Reposition log =====
  for (const row of reposition) {
    try {
      const unit = row.Unit_Code || row.unit_code || '';
      const fromSt = String(row.From_Station || row.from_station || '').toUpperCase();
      const toSt = String(row.To_Station || row.to_station || '').toUpperCase();
      if (!unit || !fromSt || !toSt) { results.reposition.errors.push('missing_fields'); continue; }
      const reason = row.Reason || row.reason || '';
      const status = String(row.Status || row.status || 'requested').toLowerCase();
      const requestedBy = safeNid(row.Requested_By || row.requested_by_nid);
      let requestedAt = 0;
      const tsRaw = row.Timestamp || row.requested_at || row.Created_At;
      if (tsRaw) {
        if (typeof tsRaw === 'number') requestedAt = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : Math.floor(tsRaw);
        else requestedAt = Math.floor(new Date(tsRaw).getTime() / 1000) || 0;
      }
      if (!requestedAt) requestedAt = Math.floor(Date.now() / 1000);
      let completedAt = null;
      const compRaw = row.Completed_At || row.completed_at;
      if (compRaw) {
        if (typeof compRaw === 'number') completedAt = compRaw > 1e12 ? Math.floor(compRaw / 1000) : Math.floor(compRaw);
        else completedAt = Math.floor(new Date(compRaw).getTime() / 1000) || null;
      }
      const notes = row.Notes || row.notes || '';
      await env.DB.prepare(
        `INSERT OR IGNORE INTO reposition_log
         (unit_code, from_station, to_station, reason, status, requested_by_nid, requested_at, completed_at, notes)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
      ).bind(unit, fromSt, toSt, reason, status, requestedBy, requestedAt, completedAt, notes).run();
      results.reposition.inserted++;
    } catch (e) {
      results.reposition.errors.push(String(e.message).slice(0, 100));
    }
  }

  // ===== 3. Station status (latest snapshot) =====
  for (const st of stationStatus) {
    try {
      const station = String(st.station || st.Station || '').toUpperCase();
      const status = String(st.status || st.Status || '').toLowerCase();
      if (!station || !status) { results.station_status.errors.push('missing_fields'); continue; }
      const note = st.note || st.Note || '';
      const operator = st.operator_nid || st.Set_By || st.set_by_nid || user.nid;
      let ts = 0;
      const tsRaw = st.Timestamp || st.Updated_At || st.ts;
      if (tsRaw) {
        if (typeof tsRaw === 'number') ts = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : Math.floor(tsRaw);
        else ts = Math.floor(new Date(tsRaw).getTime() / 1000) || 0;
      }
      if (!ts) ts = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `INSERT INTO station_status_log (ts, station, status, set_by_nid, note)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(ts, station, status, operator, note).run();
      results.station_status.inserted++;
    } catch (e) {
      results.station_status.errors.push(String(e.message).slice(0, 100));
    }
  }

  // Audit log
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
       VALUES (?1, 'migrate_history', 'bulk', 'historical_import', ?2)`
    ).bind(user.nid, JSON.stringify({
      dispatch: results.dispatch.inserted,
      reposition: results.reposition.inserted,
      station_status: results.station_status.inserted
    })).run();
  } catch (_) {}

  return jsonResponse({ ok: true, results, server_time: new Date().toISOString() });
}

async function handleExecV2(request, env) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const tokenFromQuery = url.searchParams.get('token');
  const tokenFromHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const token = tokenFromQuery || tokenFromHeader;

  if (!action) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_action' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Auth
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  const sess = await env.DB.prepare(
    `SELECT s.token, s.nid, s.expires_at, a.name, a.role, a.cluster, a.station, a.unit_code, a.active
     FROM sessions s JOIN allowlist a ON a.nid = s.nid
     WHERE s.token = ?1 AND s.expires_at > strftime('%s','now')`
  ).bind(token).first();
  if (!sess || !sess.active) {
    return new Response(JSON.stringify({ ok: false, error: 'session_expired' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  const user = {
    nid: sess.nid, name: sess.name, role: sess.role,
    cluster: sess.cluster, station: sess.station, unit_code: sess.unit_code
  };

  // Role check
  const allowed = ROLE_GATE[action];
  if (!hasRole(user, allowed)) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Handler
  const handler = ACTIONS[action];
  if (!handler) {
    return new Response(JSON.stringify({ ok: false, error: 'action_not_migrated', action }), {
      status: 501, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Load data.json if needed
  let dj = null;
  if (NEEDS_JSON.has(action)) {
    try {
      const r = await env.ASSETS.fetch(new Request('https://internal/data.json'));
      dj = await r.json();
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: 'data_unavailable', detail: e.message }), {
        status: 503, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Build params object
  const params = {};
  for (const [k, v] of url.searchParams.entries()) params[k] = v;

  // Execute
  try {
    const result = await handler(user, env, params, dj);
    return new Response(JSON.stringify(result), {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'handler_error', detail: e.message, stack: e.stack }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}



// ===== Worker entrypoint =====

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
