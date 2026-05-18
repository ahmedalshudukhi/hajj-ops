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
  if (pathname === "/api/v2/migrate_pcr") return handleMigratePCR(request, env);

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
  unit_positions_set: ['leadership','admin'],   // Chief/DCH (chief paramedic/deputy = admin role)
  unit_set_location: ['cluster_supervisor','dispatcher','leadership','admin'],
  unit_locations_list: null,                            // anyone signed in can read
  ambulances_list: null,
  ambulance_set_status: ['cluster_supervisor','dispatcher','leadership','admin'],
  overview_summary: null,                               // anyone signed in can read
  positioning_at: null,                                  // anyone signed in can read
  positioning_day: null,                                 // anyone signed in can read
  coverage_range: null,                                  // anyone signed in can read — multi-day station coverage
  metro_data: null,                                      // anyone signed in can read — SAR train movements
  card_get: null,
  cards_get_bulk: null,
  station_status_list: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  reposition_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  admin_allowlist_view: ['admin'],
  admin_sessions_view: ['admin'],
  admin_audit_list: ['admin'],
  admin_apply_validation: ['admin'],
  active_summary: ['cluster_supervisor','dispatcher','leadership','admin'],
  command_summary: ['leadership','admin','dispatcher'],
  mci_status: ['leadership','admin','dispatcher','cluster_supervisor'],
  mci_set: ['leadership','admin'],
  broadcast_send: ['leadership','admin'],
  broadcast_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  broadcast_ack: null,                 // any authed user
  unit_suggest: ['dispatcher','leadership','admin'],
  activity_feed: ['cluster_supervisor','dispatcher','leadership','admin'],
  report_daily: ['leadership','admin','dispatcher','cluster_supervisor'],
  report_shift_handoff: ['leadership','admin','dispatcher','cluster_supervisor'],
  report_incident_detail: ['leadership','admin','dispatcher','cluster_supervisor'],
  audit_search: ['admin','leadership'],
  presence_ping: null,                  // any authed user
  presence_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  surge_forecast: ['cluster_supervisor','dispatcher','leadership','admin'],
  drill_status: ['cluster_supervisor','dispatcher','leadership','admin'],
  drill_set: ['leadership','admin'],
  handoff_script: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  system_health: null,
  heat_index: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  timeline: ['cluster_supervisor','dispatcher','leadership','admin'],
  triage_suggest: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  hospitals_list: null,
  hospital_set_status: ['leadership','admin','dispatcher'],
  hospital_seed: ['admin'],
  unit_checkin: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  units_status_grid: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  messages_send: null,
  messages_list: null,
  messages_threads: null,
  incidents_search: ['cluster_supervisor','dispatcher','leadership','admin'],
  pcr_draft: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  pcr_save: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  pcr_list_mine: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  pcr_list_all: ['leadership','admin'],
  checklist_list: null,
  checklist_save: null,
  checklist_run: null,
  announcement_templates: ['dispatcher','cluster_supervisor','leadership','admin'],
  station_directory: null,
  escalation_matrix: null,
  shift_status: null,
  scoreboard: ['cluster_supervisor','dispatcher','leadership','admin'],
  replay: ['cluster_supervisor','dispatcher','leadership','admin'],
  translator_phrases: null,
  equipment_list: null,
  equipment_status_set: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'],
  equipment_seed: ['admin'],
  station_load_history: ['cluster_supervisor','dispatcher','leadership','admin'],
  transports_list: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'],
  mci_command_summary: ['cluster_supervisor','dispatcher','leadership','admin'],
  triage_tags_assign: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'],
  triage_tags_list: ['cluster_supervisor','dispatcher','leadership','admin','sar'],
  shifts_today: null,
  shifts_handoff_save: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'],
  shifts_handoff_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  alerts_recent: ['cluster_supervisor','dispatcher','leadership','admin'],
  code_blue_event: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'],
  code_blue_list: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'],
  heat_watch: null,
  schedule_overview: null,
  my_schedule: null,
  reposition_planned_create: ['cluster_supervisor','dispatcher','leadership','admin'],
  reposition_planned_list: null,
  reposition_planned_cancel: ['cluster_supervisor','dispatcher','leadership','admin'],
  reposition_planned_execute: ['cluster_supervisor','dispatcher','leadership','admin'],
  reposition_reverse: ['cluster_supervisor','dispatcher','leadership','admin'],
  escalation_set: ['leadership','admin'],
  escalation_delete: ['admin'],
  me_summary: null,
  board_summary: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'],
  pulse_feed: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'],
  handover_compose: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  supplies_request: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin'],
  supplies_list: ['paramedic','gp','cluster_supervisor','dispatcher','leadership','admin','sar'],
  supplies_set_status: ['cluster_supervisor','leadership','admin'],
  intake_save: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  intake_list: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  wellness_save: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  wellness_list: ['cluster_supervisor','leadership','admin'],
  wellness_my_recent: null,
  sla_summary: ['cluster_supervisor','dispatcher','leadership','admin'],
  training_scenarios: null,
  training_start_drill: ['paramedic','gp','dispatcher','cluster_supervisor','leadership','admin'],
  sar_summary: ['sar','admin'],
  dispatch_list: ['cluster_supervisor','dispatcher','leadership','admin'],
  dashboard_active: ['cluster_supervisor','dispatcher','leadership','admin'],
  dashboard_dispatch: ['cluster_supervisor','dispatcher','leadership','admin'],
  dashboard_sv: ['cluster_supervisor','dispatcher','leadership','admin'],
  // Writes
  dispatch_create: ['dispatcher','leadership','admin'],
  dispatch_event: ['dispatcher','leadership','admin'],
  dispatch_close: ['dispatcher','leadership','admin'],
  dispatch_edit: ['dispatcher','leadership','admin'],
  incident_audit_trail: ['dispatcher','cluster_supervisor','leadership','admin'],
  station_status_set: ['cluster_supervisor','leadership','admin'],
  unit_status_set: ['cluster_supervisor','dispatcher','leadership','admin'],
  reposition_request: ['cluster_supervisor','dispatcher','leadership','admin'],
  reposition_approve: ['cluster_supervisor','leadership','admin'],
  reposition_reject: ['cluster_supervisor','leadership','admin'],
  // Editable docs (protocols/runbook/training)
  docs_get: null,                                       // anyone signed in can read
  docs_save: ['leadership','admin'],                    // only leadership+ can edit
};

// Actions that need data.json loaded (cached in module scope after first call)
const NEEDS_JSON = new Set([
  'augmentations','mobilization_plan','roster_fill','unit_availability',
  'units_list','unit_positions','active_summary','dashboard_active',
  'dashboard_dispatch','dashboard_sv','sar_summary','roster','station_status_list',
  'unit_suggest','units_status_grid','ambulances_list','overview_summary','positioning_at','positioning_day','coverage_range','metro_data','schedule_overview','my_schedule','escalation_matrix'
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

// Returns the array of stations a cluster supervisor is scoped to, or null
// for any other role (no restriction). Used by read-side queries to auto-filter
// dispatches/incidents to a cluster sup's zone. Pass ?scope=all to opt out.
function clusterStationsFor(user) {
  if (user && user.role === 'cluster_supervisor' && user.cluster) {
    return CLUSTER_STATIONS[String(user.cluster).toLowerCase()] || null;
  }
  return null;
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
    // Date filter accepts:
    //   ?date=YYYY-MM-DD                      → single day
    //   ?start_date=YYYY-MM-DD&end_date=Y-M-D → inclusive range
    //   ?from=ISO&to=ISO                      → legacy timestamp range
    let where = '', binds = [];
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (params.start_date && params.end_date && isDate(params.start_date) && isDate(params.end_date)) {
      const startTs = Math.floor(new Date(params.start_date + 'T00:00:00Z').getTime() / 1000);
      const endTs   = Math.floor(new Date(params.end_date   + 'T23:59:59Z').getTime() / 1000);
      where = 'WHERE ts >= ?1 AND ts <= ?2';
      binds = [startTs, endTs, limit];
    } else if (params.date && isDate(params.date)) {
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
    const sql = `SELECT d.incident_id AS Incident_ID, d.ts, d.station AS Zone, d.sub_location,
                        d.source AS Source, d.complaint AS Chief_Complaint, d.triage AS Category,
                        d.cardiac_arrest, d.unit_assigned AS Unit, d.status AS Status,
                        d.patient_count, d.notes AS Notes, d.created_by_nid AS Created_By,
                        d.closed_at, d.closed_by_nid AS Closed_By, d.pcr_id AS PCR_ID,
                        (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type='en_route')         AS en_route_ts,
                        (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type='on_scene')        AS on_scene_ts,
                        (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type='patient_contact') AS patient_contact_ts,
                        (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type='transfer_start')  AS transfer_start_ts,
                        (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type='hospital_arrival')AS hospital_arrival_ts,
                        (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type='handover')        AS handover_ts
                 FROM dispatch_log d ${where.replace(/\b(ts|station|status|complaint|triage|sub_location|unit_assigned|cardiac_arrest|patient_count|notes|created_by_nid|closed_at|closed_by_nid|pcr_id|incident_id)\b/g, 'd.$1')} ORDER BY d.ts DESC LIMIT ?${binds.length}`;
    const r = await env.DB.prepare(sql).bind(...binds).all();
    const incidents = (r.results || []).map(row => {
      row.Created_At = new Date(row.ts * 1000).toISOString();
      if (row.closed_at) row.Closed_At = new Date(row.closed_at * 1000).toISOString();
      // Map timeline timestamps to the names the frontend reads
      const tsToISO = t => t ? new Date(t * 1000).toISOString() : null;
      row.En_Route_At        = tsToISO(row.en_route_ts);
      row.On_Scene_At        = tsToISO(row.on_scene_ts);
      row.Patient_Contact_At = tsToISO(row.patient_contact_ts);
      row.Transfer_Start     = tsToISO(row.transfer_start_ts);
      row.Hospital_Arrival   = tsToISO(row.hospital_arrival_ts);
      row.Handover           = tsToISO(row.handover_ts);
      // Mirror Station/Region for views that expect those keys
      row.Station = row.Zone; row.Region = row.Zone;
      // Cleanup raw ts fields
      delete row.ts; delete row.closed_at;
      delete row.en_route_ts; delete row.on_scene_ts; delete row.patient_contact_ts;
      delete row.transfer_start_ts; delete row.hospital_arrival_ts; delete row.handover_ts;
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
      filter: (params.start_date && params.end_date)
        ? `${params.start_date}..${params.end_date}`
        : (params.date || (params.from ? `${params.from}..${params.to}` : 'all')),
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
    // Map data.json.units_detail → frontend shape, INCLUDING staffing detail
    // (filled_count, total/size, members) so units.html doesn't show 0/0.
    const detail = (dj && dj.units_detail) || [];
    const out = detail.map(u => ({
      code: u.id || '',
      type: u.type || '',
      home_station: u.home || '',
      category: u.category || '',
      default_shift: u.default_shift || '',
      size: u.size || u.total_count || 0,
      filled_count: u.filled_count || 0,
      total_count: u.total_count || u.size || 0,
      members: u.members || [],
      tags: u.tags || '',
      notes: u.notes || ''
    })).filter(u => u.code);
    // Sort: Leadership → Command → Mike → Alpha → Romeo → other
    const catOrder = { Leadership: 0, Command: 1, Operational: 2 };
    const typeOrder = { Mike: 0, Alpha: 1, Romeo: 2 };
    out.sort((a, b) => {
      const ca = catOrder[a.category] !== undefined ? catOrder[a.category] : 9;
      const cb = catOrder[b.category] !== undefined ? catOrder[b.category] : 9;
      if (ca !== cb) return ca - cb;
      const ap = a.code.split('-')[0], bp = b.code.split('-')[0];
      const oa = typeOrder[ap] !== undefined ? typeOrder[ap] : 99;
      const ob = typeOrder[bp] !== undefined ? typeOrder[bp] : 99;
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

  // ==============================================================
  // unit_positions_set — Chief/DCH set initial unit positions.
  // Inserts a status='approved' reposition row so the existing
  // unit_positions handler picks it up.
  // ==============================================================
  async unit_positions_set(user, env, params, dj) {
    const unit_code = String(params.unit_code || params.unit || '').trim();
    const to_station = String(params.station || params.to_station || '').toUpperCase().trim();
    const note = String(params.note || 'Initial position by ' + (user.name || user.nid)).slice(0, 200);
    if (!unit_code) return { ok: false, error: 'missing_unit_code' };
    if (!STATIONS.includes(to_station)) return { ok: false, error: 'invalid_station', station: to_station };
    const now = Math.floor(Date.now() / 1000);
    try {
      // Ensure reposition_log exists
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS reposition_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_code TEXT NOT NULL,
        from_station TEXT,
        to_station TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'requested',
        requested_at INTEGER NOT NULL,
        requested_by_nid TEXT,
        approved_at INTEGER,
        approved_by_nid TEXT,
        completed_at INTEGER
      )`).run();
      // Mark prior approved for this unit as completed
      await env.DB.prepare(
        `UPDATE reposition_log SET status='completed', completed_at=?1
         WHERE unit_code=?2 AND status IN ('approved','active')`
      ).bind(now, unit_code).run();
      // Look up unit's current/home station for from_station (required NOT NULL)
      let fromStation = 'UNKNOWN';
      try {
        const detail = (dj && dj.units_detail) || [];
        const u = detail.find(x => x.id === unit_code);
        if (u && u.home) fromStation = u.home;
        // Also check most recent reposition
        const last = await env.DB.prepare(
          `SELECT to_station FROM reposition_log WHERE unit_code = ?1 AND status='completed' ORDER BY completed_at DESC LIMIT 1`
        ).bind(unit_code).first();
        if (last && last.to_station) fromStation = last.to_station;
      } catch (_) {}
      // Insert new approved position
      await env.DB.prepare(
        `INSERT INTO reposition_log
           (unit_code, from_station, to_station, reason, status, requested_at, requested_by_nid, approved_at, approved_by_nid)
         VALUES (?1, ?2, ?3, ?4, 'approved', ?5, ?6, ?5, ?6)`
      ).bind(unit_code, fromStation, to_station, note, now, user.nid).run();
      try {
        await env.DB.prepare(
          `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
           VALUES (?1, 'unit_position_set', 'unit', ?2, ?3)`
        ).bind(user.nid, unit_code, JSON.stringify({ to_station, note })).run();
      } catch (_) {}
      return { ok: true, unit_code, to_station, ts: now };
    } catch (e) { return { ok: false, error: 'set_failed', detail: e.message }; }
  },

  // ==============================================================
  // unit_set_location — free-form current location text per unit
  // (e.g. "Gate 3, near checkpoint B" — overlays station-level data)
  // ==============================================================
  async _ensureUnitLocationsTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS unit_locations (
      unit_code TEXT PRIMARY KEY,
      location TEXT,
      notes TEXT,
      set_by_nid TEXT,
      set_by_name TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`).run();
  },

  async unit_set_location(user, env, params) {
    await ACTIONS._ensureUnitLocationsTable(env);
    const unit_code = String(params.unit_code || params.unit || '').trim();
    const location = String(params.location || '').trim();
    const notes = String(params.notes || '').trim();
    if (!unit_code) return { ok: false, error: 'missing_unit_code' };
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `INSERT INTO unit_locations (unit_code, location, notes, set_by_nid, set_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(unit_code) DO UPDATE SET
           location = ?2, notes = ?3, set_by_nid = ?4, set_by_name = ?5, updated_at = ?6`
      ).bind(unit_code, location, notes, user.nid, user.name || '', now).run();
      return { ok: true, unit_code, location, ts: now };
    } catch (e) { return { ok: false, error: 'save_failed', detail: e.message }; }
  },

  async unit_locations_list(user, env) {
    await ACTIONS._ensureUnitLocationsTable(env);
    try {
      const r = await env.DB.prepare(
        `SELECT unit_code, location, notes, set_by_name, updated_at FROM unit_locations ORDER BY updated_at DESC`
      ).all();
      return { ok: true, locations: r.results || [] };
    } catch (e) { return { ok: false, error: 'fetch_failed', detail: e.message }; }
  },

  // ==============================================================
  // ambulances_list — full roster from data.json + live status overrides
  // ==============================================================
  async ambulances_list(user, env, params, dj) {
    const roster = (dj && dj.ambulance_roster) || [];
    // Get live status overrides
    let statusMap = {};
    let locMap = {};
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ambulance_status (
        ambulance_id TEXT PRIMARY KEY,
        status TEXT,
        current_location TEXT,
        crew_on_duty TEXT,
        notes TEXT,
        set_by_nid TEXT,
        set_by_name TEXT,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`).run();
      const r = await env.DB.prepare(`SELECT * FROM ambulance_status`).all();
      (r.results || []).forEach(row => { statusMap[row.ambulance_id] = row; });
    } catch (_) {}
    const merged = roster.map(a => {
      const live = statusMap[a.id] || {};
      return {
        id: a.id, type: a.type, cls: a.cls, home: a.home,
        day_crew: a.day_crew, night_crew: a.night_crew,
        status: live.status || a.status || 'Ready',
        current_location: live.current_location || '',
        crew_on_duty: live.crew_on_duty || '',
        notes: live.notes || a.notes || '',
        updated_at: live.updated_at || null,
        updated_by: live.set_by_name || ''
      };
    });
    // Aggregates
    const by_type = {};
    const by_station = {};
    const by_status = {};
    merged.forEach(a => {
      by_type[a.type] = (by_type[a.type] || 0) + 1;
      by_station[a.home] = (by_station[a.home] || 0) + 1;
      by_status[a.status] = (by_status[a.status] || 0) + 1;
    });
    return { ok: true, ambulances: merged, total: merged.length, by_type, by_station, by_status };
  },

  async ambulance_set_status(user, env, params) {
    const ambulance_id = String(params.ambulance_id || params.id || '').trim();
    if (!ambulance_id) return { ok: false, error: 'missing_ambulance_id' };
    const status = String(params.status || '').trim();
    const current_location = String(params.current_location || params.location || '').trim();
    const crew_on_duty = String(params.crew_on_duty || params.crew || '').trim();
    const notes = String(params.notes || '').trim();
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ambulance_status (
        ambulance_id TEXT PRIMARY KEY,
        status TEXT,
        current_location TEXT,
        crew_on_duty TEXT,
        notes TEXT,
        set_by_nid TEXT,
        set_by_name TEXT,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`).run();
      await env.DB.prepare(
        `INSERT INTO ambulance_status (ambulance_id, status, current_location, crew_on_duty, notes, set_by_nid, set_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(ambulance_id) DO UPDATE SET
           status = COALESCE(NULLIF(?2,''), status),
           current_location = ?3, crew_on_duty = ?4, notes = ?5,
           set_by_nid = ?6, set_by_name = ?7, updated_at = ?8`
      ).bind(ambulance_id, status, current_location, crew_on_duty, notes, user.nid, user.name || '', now).run();
      return { ok: true, ambulance_id, status, ts: now };
    } catch (e) { return { ok: false, error: 'save_failed', detail: e.message }; }
  },

  // ==============================================================
  // overview_summary — cross-section view by zone or whole
  // ==============================================================
  async overview_summary(user, env, params, dj) {
    const zone = String(params.zone || 'all').toLowerCase();
    const detail = (dj && dj.units_detail) || [];
    const roster = (dj && dj.ambulance_roster) || [];
    const ZONE_STATIONS = {
      arafat: ['ARF1','ARF2','ARF3'],
      muzdalifah: ['MUZ1','MUZ2','MUZ3'],
      mina: ['MIN1','MIN2','MIN3'],
      occ: ['OCC']
    };
    const stations = zone === 'all'
      ? [].concat(ZONE_STATIONS.arafat, ZONE_STATIONS.muzdalifah, ZONE_STATIONS.mina, ZONE_STATIONS.occ)
      : (ZONE_STATIONS[zone] || []);

    // Fetch reposition overrides for current station positions
    let posMap = {};
    try {
      const r = await env.DB.prepare(
        `SELECT unit_code, to_station FROM reposition_log
         WHERE status IN ('approved','active') ORDER BY requested_at DESC`
      ).all();
      (r.results || []).forEach(row => { if (!posMap[row.unit_code]) posMap[row.unit_code] = row.to_station; });
    } catch (_) {}

    // Locations
    let locMap = {};
    try {
      const r = await env.DB.prepare(`SELECT unit_code, location FROM unit_locations`).all();
      (r.results || []).forEach(row => { locMap[row.unit_code] = row.location; });
    } catch (_) {}

    // Per-station aggregates
    const byStation = {};
    stations.forEach(st => { byStation[st] = { station: st, units: [], unit_types: {}, ambulances: [], paramedics: 0 }; });

    detail.forEach(u => {
      const currentStation = posMap[u.id] || u.home || '';
      if (!stations.includes(currentStation)) return;
      const row = byStation[currentStation];
      row.units.push({
        code: u.id, type: u.type, category: u.category, size: u.size,
        home: u.home, current_station: currentStation,
        location: locMap[u.id] || '',
        members: u.members || [], filled: u.filled_count || 0, total: u.total_count || 0
      });
      row.unit_types[u.type] = (row.unit_types[u.type] || 0) + 1;
      row.paramedics += u.size || 0;
    });

    roster.forEach(a => {
      if (!stations.includes(a.home)) return;
      byStation[a.home].ambulances.push({
        id: a.id, type: a.type, cls: a.cls, status: a.status || 'Ready',
        day_crew: a.day_crew, night_crew: a.night_crew
      });
    });

    // Totals
    const totals = {
      stations: stations.length,
      units: 0, paramedics: 0, ambulances: 0,
      unit_types: {}, ambulance_types: {}, ambulance_classes: {}
    };
    Object.values(byStation).forEach(s => {
      totals.units += s.units.length;
      totals.paramedics += s.paramedics;
      totals.ambulances += s.ambulances.length;
      Object.entries(s.unit_types).forEach(([t, n]) => totals.unit_types[t] = (totals.unit_types[t] || 0) + n);
      s.ambulances.forEach(a => {
        totals.ambulance_types[a.type] = (totals.ambulance_types[a.type] || 0) + 1;
        totals.ambulance_classes[a.cls] = (totals.ambulance_classes[a.cls] || 0) + 1;
      });
    });

    return { ok: true, zone, stations, by_station: Object.values(byStation), totals };
  },

  // ==============================================================
  // positioning_at — schedule-driven view of unit positioning per
  // (DH day, hour, zone). Reads pre-computed hourly + schedule_grid
  // from data.json (built from the Schedule tab).
  // ==============================================================
  async positioning_at(user, env, params, dj) {
    const dh   = String(params.dh   || '9').replace(/[^0-9]/g, '') || '9';
    const hour = String(params.hour || '08:00');
    const zone = String(params.zone || 'all').toLowerCase();
    const mvtFilter = String(params.mvt || '').toUpperCase();

    const ZONE_STATIONS = {
      arafat:     ['ARF1','ARF2','ARF3'],
      muzdalifah: ['MUZ1','MUZ2','MUZ3'],
      mina:       ['MIN1','MIN2','MIN3'],
      occ:        ['OCC']
    };
    const ALL_STATIONS = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3','OCC'];
    const stations = (zone === 'all') ? ALL_STATIONS : (ZONE_STATIONS[zone] || ALL_STATIONS);

    const hourly = (dj && dj.hourly && dj.hourly.hours) || [];
    const allDH    = Array.from(new Set(hourly.map(r => String(r.dh).replace(' DH','')))).sort((a,b) => +a - +b);
    const allHours = Array.from(new Set(hourly.map(r => r.hour))).sort();
    const allMvts  = Array.from(new Set(hourly.map(r => r.mvt))).sort();
    const meta = { dh_days: allDH, hours: allHours, movements: allMvts };

    const entry = hourly.find(r => String(r.dh) === (dh + ' DH') && r.hour === hour);

    if (entry && mvtFilter && String(entry.mvt || '').toUpperCase() !== mvtFilter) {
      return { ok: true, dh: dh + ' DH', hour, zone, mvt: entry.mvt, shift: entry.shift,
               found: false, reason: 'mvt_mismatch', stations, by_station: [],
               totals: { paras: 0, ambulances: 0, units: 0, by_type: {} }, meta };
    }
    if (!entry) {
      return { ok: true, dh: dh + ' DH', hour, zone, found: false,
               stations, by_station: [], totals: { paras: 0, ambulances: 0, units: 0, by_type: {} }, meta };
    }

    // schedule_grid slot picker: 06:00-17:59 = slot1 (day), else slot2 (night)
    const h = parseInt(hour.split(':')[0], 10) || 0;
    const slotKey = (h >= 6 && h < 18) ? 'slot1' : 'slot2';
    const sg = (dj && dj.schedule_grid && dj.schedule_grid[dh]) || {};
    const slotGrid = sg[slotKey] || {};

    const byStation = stations.map(st => {
      const paras  = (entry.stations && entry.stations[st]) || 0;
      const ambs   = (entry.stations_amb && entry.stations_amb[st]) || 0;
      const gridSt = slotGrid[st] || {};
      return {
        station: st,
        units:   gridSt.units || 0,
        paras,
        ambulances: ambs,
        by_type: gridSt.by_type || {}
      };
    });

    let tParas=0, tAmbs=0, tUnits=0;
    const tType = {};
    byStation.forEach(s => {
      tParas += s.paras; tAmbs += s.ambulances; tUnits += s.units;
      Object.entries(s.by_type).forEach(([k,n]) => { tType[k] = (tType[k]||0) + n; });
    });

    return {
      ok: true, dh: dh + ' DH', hour, zone,
      mvt: entry.mvt || '', shift: entry.shift || '', slot: slotKey,
      found: true, stations, by_station: byStation,
      totals: { paras: tParas, ambulances: tAmbs, units: tUnits, by_type: tType },
      meta
    };
  },

  // ==============================================================
  // positioning_day — full-day table view. Returns 24 hourly rows
  // for the chosen DH, scoped to the chosen zone (or all).
  // ==============================================================
  async positioning_day(user, env, params, dj) {
    const dh   = String(params.dh   || '9').replace(/[^0-9]/g, '') || '9';
    const zone = String(params.zone || 'all').toLowerCase();

    const ZONE_STATIONS = {
      arafat:     ['ARF1','ARF2','ARF3'],
      muzdalifah: ['MUZ1','MUZ2','MUZ3'],
      mina:       ['MIN1','MIN2','MIN3'],
      occ:        ['OCC']
    };
    // Map UI zone keys to the canonical zone keys that build.py emits in by_zone_type / total_roster_by_zone
    const ZONE_NAMES = {
      arafat:     ['Arafat'],
      muzdalifah: ['Muzdalifah'],
      mina:       ['Mina'],
      occ:        ['Support'],
      all:        ['Arafat','Muzdalifah','Mina','Support']
    };
    const ALL_STATIONS = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3','OCC'];
    const stations = (zone === 'all') ? ALL_STATIONS : (ZONE_STATIONS[zone] || ALL_STATIONS);
    const zoneNames = ZONE_NAMES[zone] || ZONE_NAMES.all;

    const hourly = (dj && dj.hourly && dj.hourly.hours) || [];
    const allDH    = Array.from(new Set(hourly.map(r => String(r.dh).replace(' DH','')))).sort((a,b) => +a - +b);
    const allMvts  = Array.from(new Set(hourly.map(r => r.mvt))).sort();

    // Compute roster total within the selected zone scope.
    // build.py emits hourly.total_roster_by_zone — fall back to total_roster if missing.
    const rosterByZone = (dj && dj.hourly && dj.hourly.total_roster_by_zone) || {};
    const totalRoster  = (dj && dj.hourly && dj.hourly.total_roster) || 0;
    const scopedRoster = (zone === 'all')
      ? totalRoster
      : zoneNames.reduce((sum, z) => sum + (rosterByZone[z] || 0), 0);

    const dayRows = hourly.filter(r => String(r.dh) === (dh + ' DH'));
    dayRows.sort((a,b) => a.hour.localeCompare(b.hour));

    const rows = dayRows.map(r => {
      let paras = 0, ambs_crewed = 0, ambs_total = 0, doctors = 0;
      stations.forEach(st => {
        paras       += (r.stations && r.stations[st]) || 0;
        ambs_crewed += (r.stations_amb && r.stations_amb[st]) || 0;
        ambs_total  += (r.stations_amb_total && r.stations_amb_total[st]) || 0;
        doctors     += (r.stations_doctors && r.stations_doctors[st]) || 0;
      });

      // Compute zone-scoped by_type using r.by_zone_type when available, else fall back
      let by_type = {};
      if (r.by_zone_type) {
        zoneNames.forEach(z => {
          const zMap = r.by_zone_type[z] || {};
          Object.entries(zMap).forEach(([k, v]) => { by_type[k] = (by_type[k] || 0) + v; });
        });
      } else {
        // Older data.json without by_zone_type — use unscoped by_type
        by_type = r.by_type || {};
      }
      // build.py now emits 'Doctor' in by_type natively from Delta units;
      // fall back to the derived doctors count if a legacy data.json is in
      // play (no harm — they'll agree once the data refreshes).
      if (!by_type['Doctor']) by_type['Doctor'] = doctors;

      const perStation = {};
      stations.forEach(st => {
        const detail = (r.stations_detail && r.stations_detail[st]) || null;
        perStation[st] = {
          paras: (r.stations && r.stations[st]) || 0,
          paras_day:    (detail && detail.paras_day)    || 0,
          paras_night:  (detail && detail.paras_night)  || 0,
          paras_always: (detail && detail.paras_always) || 0,
          ambs_crewed:  (r.stations_amb && r.stations_amb[st]) || 0,
          ambs_total:   (r.stations_amb_total && r.stations_amb_total[st]) || 0,
          doctors:      (r.stations_doctors && r.stations_doctors[st]) || 0,
          by_type:      (detail && detail.by_type) || {},
          active_units: (detail && detail.active_units) || [],
          active_shifts:(detail && detail.active_shifts) || [],
          units_day:    (detail && detail.units_day)    || [],
          units_night:  (detail && detail.units_night)  || [],
          units_always: (detail && detail.units_always) || [],
        };
      });

      return {
        hour: r.hour,
        mvt: r.mvt || '',
        shift: r.shift || '',
        units: r.units_active || 0,
        paras,
        ambs: ambs_crewed,            // primary "currently crewed" count
        ambs_total,                   // total parked at home stations
        doctors,
        off_duty: Math.max(0, scopedRoster - paras),
        by_type,
        per_station: perStation,
        all_paras: r.grand_s || 0,
        all_ambs:  r.grand_a || 0,
        all_units: r.units_active || 0
      };
    });

    // ────────────────────────────────────────────────────────
    // Surface planned + recently executed repositions for this DH.
    // Read from D1 so /positioning reflects the same plans visible in /admin.
    // ────────────────────────────────────────────────────────
    let plannedMoves = [];
    let executedMoves = [];
    let activePlans = [];
    // projectedDelta[station] = { paras: ±N, units: ±N } — only counts
    // active planned moves overlapping this DH (start_dh <= dh <= end_dh)
    const projectedDelta = {};
    stations.forEach(st => { projectedDelta[st] = { paras: 0, units: 0, incoming: [], outgoing: [] }; });

    try {
      await ACTIONS._ensurePlannedRepositionTable(env);
      // Planned moves whose ACTIVE WINDOW overlaps this DH
      // (start_dh <= dh AND (end_dh IS NULL OR end_dh >= dh))
      const pr = await env.DB.prepare(
        `SELECT id, unit_code, from_station, to_station, planned_dh, planned_hour, planned_end_dh, planned_end_hour, reason, status, created_by_name, created_at
         FROM planned_repositions
         WHERE status IN ('pending','approved')
           AND planned_dh <= ?
           AND (planned_end_dh IS NULL OR planned_end_dh >= ?)
         ORDER BY planned_dh ASC, planned_hour ASC, created_at ASC`
      ).bind(parseInt(dh, 10), parseInt(dh, 10)).all();
      const allPlanned = pr.results || [];
      // Build unit lookup so we can fill in from_station = unit.home for un-executed plans
      const unitHomeById = {};
      ((dj && dj.units_detail) || []).forEach(u => {
        if (u && u.id) unitHomeById[String(u.id).toUpperCase()] = String(u.home || '').toUpperCase();
      });
      // Enrich every plan with a resolved from_station (home fallback) so the
      // Gantt overlay can match 'planned-out' on the unit's source station.
      const enrichedPlanned = allPlanned.map(p => {
        const fromResolved = p.from_station || unitHomeById[String(p.unit_code || '').toUpperCase()] || '';
        return { ...p, from_station: fromResolved };
      });
      // Keep the full set so the frontend can derive Gantt overlays
      activePlans = enrichedPlanned.filter(p =>
        !zone || zone === 'all' ||
        stations.includes(String(p.from_station || '').toUpperCase()) ||
        stations.includes(String(p.to_station || '').toUpperCase())
      );

      // For the banner, prefer plans that START on this DH (most actionable)
      plannedMoves = enrichedPlanned
        .filter(p => parseInt(p.planned_dh, 10) === parseInt(dh, 10))
        .filter(p => !zone || zone === 'all' || stations.includes(String(p.to_station || '').toUpperCase()));

      // Compute projection: for each plan active on this DH, look up the unit's size
      // (paras count) and shift its paras from from_station to to_station.
      const unitsById = {};
      ((dj && dj.units_detail) || []).forEach(u => { unitsById[String(u.id).toUpperCase()] = u; });

      enrichedPlanned.forEach(p => {
        const u = unitsById[String(p.unit_code).toUpperCase()];
        const paras = (u && (u.size || u.total_count)) || 1;
        const fromSt = String(p.from_station || (u && u.home) || '').toUpperCase();
        const toSt = String(p.to_station || '').toUpperCase();
        if (projectedDelta[fromSt]) {
          projectedDelta[fromSt].paras -= paras;
          projectedDelta[fromSt].units -= 1;
          projectedDelta[fromSt].outgoing.push({ unit: p.unit_code, to: toSt, dh: p.planned_dh, hour: p.planned_hour, paras });
        }
        if (projectedDelta[toSt]) {
          projectedDelta[toSt].paras += paras;
          projectedDelta[toSt].units += 1;
          projectedDelta[toSt].incoming.push({ unit: p.unit_code, from: fromSt, dh: p.planned_dh, hour: p.planned_hour, paras });
        }
      });

      // Executed moves in the last 24h whose from/to touches this zone
      const since = Math.floor(Date.now() / 1000) - 86400;
      const er = await env.DB.prepare(
        `SELECT unit_code, from_station, to_station, ts, notes
         FROM reposition_log
         WHERE status = 'approved' AND ts >= ?
         ORDER BY ts DESC LIMIT 30`
      ).bind(since).all();
      executedMoves = (er.results || []).filter(p =>
        !zone || zone === 'all' ||
        stations.includes(String(p.from_station || '').toUpperCase()) ||
        stations.includes(String(p.to_station || '').toUpperCase())
      );
    } catch (_) {}

    return {
      ok: true,
      dh: dh + ' DH',
      zone,
      stations,
      zone_scoped: zone !== 'all',
      total_roster: scopedRoster,
      rows,
      planned_moves: plannedMoves,
      active_plans: activePlans,
      executed_moves: executedMoves,
      projected_delta_per_station: projectedDelta,
      meta: { dh_days: allDH, movements: allMvts }
    };
  },

  // ==============================================================
  // coverage_range — multi-day station coverage summary. For each station
  // and each DH in [dh_from..dh_to], computes peak / min / avg paras,
  // peak ambulance crewed count, distinct units count, and active hours.
  // The positioning page uses this to power the day-range slider grid.
  // ==============================================================
  async coverage_range(user, env, params, dj) {
    const dhFrom = Math.max(4, Math.min(14, parseInt(params.dh_from || '4', 10) || 4));
    const dhTo   = Math.max(dhFrom, Math.min(14, parseInt(params.dh_to || '14', 10) || 14));
    const zone   = String(params.zone || 'all').toLowerCase();

    const ZONE_STATIONS = {
      arafat:     ['ARF1','ARF2','ARF3'],
      muzdalifah: ['MUZ1','MUZ2','MUZ3'],
      mina:       ['MIN1','MIN2','MIN3'],
      occ:        ['OCC']
    };
    const ALL_STATIONS = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3','OCC'];
    const stations = (zone === 'all') ? ALL_STATIONS : (ZONE_STATIONS[zone] || ALL_STATIONS);

    const hourly = (dj && dj.hourly && dj.hourly.hours) || [];
    const days = [];
    for (let d = dhFrom; d <= dhTo; d++) days.push(d);

    // Build matrix[station][dh] = { paras_peak, paras_min, paras_avg, ambs_peak, doctors_peak, unit_count, active_hours }
    const matrix = {};
    stations.forEach(st => { matrix[st] = {}; });

    days.forEach(dh => {
      const dayRows = hourly.filter(r => String(r.dh) === (dh + ' DH'));
      stations.forEach(st => {
        if (dayRows.length === 0) {
          matrix[st][dh] = {
            paras_peak: 0, paras_min: 0, paras_avg: 0,
            ambs_peak: 0, doctors_peak: 0, unit_count: 0, active_hours: 0,
            no_data: true
          };
          return;
        }
        let paras_peak = 0, paras_min = Infinity, paras_sum = 0, n = 0, active_h = 0;
        let ambs_peak = 0, doctors_peak = 0;
        const unitSet = new Set();
        dayRows.forEach(r => {
          const p = (r.stations && r.stations[st]) || 0;
          const a = (r.stations_amb && r.stations_amb[st]) || 0;
          const d = (r.stations_doctors && r.stations_doctors[st]) || 0;
          if (p > paras_peak) paras_peak = p;
          if (p < paras_min) paras_min = p;
          if (p > 0) active_h++;
          if (a > ambs_peak) ambs_peak = a;
          if (d > doctors_peak) doctors_peak = d;
          paras_sum += p;
          n++;
          const sd = r.stations_detail && r.stations_detail[st];
          (sd && sd.active_units || []).forEach(u => unitSet.add(u));
        });
        matrix[st][dh] = {
          paras_peak,
          paras_min: paras_min === Infinity ? 0 : paras_min,
          paras_avg: n ? Math.round(paras_sum / n) : 0,
          ambs_peak,
          doctors_peak,
          unit_count: unitSet.size,
          active_hours: active_h,
          no_data: false
        };
      });
    });

    // Per-station summary across the range (totals row, optional)
    const stationTotals = {};
    stations.forEach(st => {
      const cells = days.map(d => matrix[st][d]);
      stationTotals[st] = {
        paras_peak_max: Math.max(...cells.map(c => c.paras_peak)),
        paras_avg_avg: Math.round(cells.reduce((s,c) => s + c.paras_avg, 0) / Math.max(cells.length, 1)),
        unit_count_max: Math.max(...cells.map(c => c.unit_count)),
        ambs_peak_max: Math.max(...cells.map(c => c.ambs_peak))
      };
    });

    // Available DH days in data (for the slider min/max)
    const allDH = Array.from(new Set(hourly.map(r => String(r.dh).replace(' DH','')))).sort((a,b) => +a - +b);

    return {
      ok: true,
      dh_from: dhFrom,
      dh_to: dhTo,
      zone,
      stations,
      days,
      matrix,
      station_totals: stationTotals,
      meta: { dh_days: allDH }
    };
  },

  // ==============================================================
  // metro_data — SAR train movements operational view.
  // Returns the active movement (and adjacent movements) for the given
  // DH, plus per-station platform activity and expected pax flow for
  // the selected hour. The page can pull the full reference set via
  // params={"full":1}.
  //
  // v0.2.52 rebuild: PDF-precise timing (B2A=05:30, C=18:57→00:30),
  // gap reasons for non-movement hours, per-movement pax buckets,
  // and band-collapsed timeline (active-period bands only — no dead
  // "—" hours dominating the strip).
  // ==============================================================
  async metro_data(user, env, params, dj) {
    const dh   = String(params.dh   || '9').replace(/[^0-9]/g, '') || '9';
    const hour = params.hour != null ? String(params.hour).padStart(2,'0') + ':00' : null;
    const full = !!params.full;

    const metro = (dj && dj.metro) || {};
    const phases = metro.phases || [];
    const platforms = metro.platforms || {};
    const paxFlow = metro.pax_flow || [];
    const tafweej = metro.tafweej || [];
    const stationHours = metro.station_hours || {};

    const dhInt = parseInt(dh, 10);

    // Phase windows expressed in minutes from DH4 00:00 for easy overlap math.
    // dh part of "8 DH" → integer 8. "05:30" → 330 minutes.
    function parseDH(s) { return parseInt(String(s).split(' ')[0], 10); }
    function parseHM(s) {
      const [h, m] = String(s).split(':').map(x => parseInt(x, 10));
      return h * 60 + (m || 0);
    }
    function phaseStartMin(p) { return parseDH(p.start_dh) * 1440 + parseHM(p.start_hour); }
    function phaseEndMin(p)   { return parseDH(p.end_dh)   * 1440 + parseHM(p.end_hour); }

    // Phases that touch this DH at all.
    const dhStart = dhInt * 1440;
    const dhEnd   = (dhInt + 1) * 1440;
    const phasesForDH = phases.filter(p =>
      p.mvt !== 'PRE-B' && p.mvt !== 'DEMOB' &&
      phaseStartMin(p) < dhEnd && phaseEndMin(p) > dhStart
    );

    // Build active bands clipped to this DH window. Each band = one
    // continuous segment of one movement inside this DH.
    const bands = phasesForDH.map(p => {
      const s = Math.max(phaseStartMin(p), dhStart);
      const e = Math.min(phaseEndMin(p),   dhEnd);
      return {
        mvt: p.mvt,
        start_min: s - dhStart,                       // 0..1440
        end_min:   e - dhStart,
        start: fmtHM(s - dhStart),
        end:   fmtHM(e - dhStart),
        trains: p.trains || 0,
        desc: p.desc || '',
        shift: p.shift,
        crosses_midnight: phaseEndMin(p) > dhEnd,
        starts_yesterday: phaseStartMin(p) < dhStart,
      };
    }).sort((a,b) => a.start_min - b.start_min);

    function fmtHM(min) {
      const m = Math.max(0, Math.min(1440, min|0));
      const h = Math.floor(m / 60), mm = m % 60;
      return String(h).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
    }

    // Gaps between bands → labeled with the reason if known.
    // Reasons are derived from the calendar: between B-series and C on DH9
    // is the Wuquf (standing at Arafat); 02:00-04:00 on E-days is the
    // SAR-mandated daily maintenance window.
    function gapReason(dhI, startMin, endMin, prevMvt, nextMvt) {
      const durMin = endMin - startMin;
      // Daily 02:00-04:00 maintenance on DH 11, 12, 13
      if ((dhI >= 11 && dhI <= 13) && startMin >= 120 && endMin <= 240) {
        return { reason: 'Daily maintenance window (02:00–04:00)', kind: 'maintenance' };
      }
      // Short (<=45 min) gaps between two active bands = shift handover +
      // platform changeover, NOT idle. Two cases on the SAR schedule:
      //   DH 9 05:00-05:30 (B1B night → B2A day, direction reverses)
      //   DH 10 00:30-01:00 (C night Nafra → D night skip-stop)
      if (prevMvt && nextMvt && durMin <= 45) {
        const pSh = prevMvt.charAt(0);
        const nSh = nextMvt.charAt(0);
        // Both same family (B→B) → platform direction swap during shift change
        if (pSh === nSh && pSh === 'B') {
          return {
            reason: 'Shift handover · platform direction swap (Night → Day)',
            kind: 'handover'
          };
        }
        // Different families (C → D) → service handover, same shift
        return {
          reason: 'Service handover · ' + prevMvt + ' → ' + nextMvt + ' platform repositioning',
          kind: 'handover'
        };
      }
      // DH 9 Wuquf: between B2B end (11:00) and C start (18:57)
      if (dhI === 9 && prevMvt && prevMvt.startsWith('B') && nextMvt === 'C') {
        return { reason: 'Wuqūf at Arafat — pilgrims standing at Arafat until sunset Nafra', kind: 'ritual' };
      }
      // DH 8 between Movement A (ends 16:00) and B1A (starts 18:00)
      if (dhI === 8 && prevMvt === 'A' && nextMvt && nextMvt.startsWith('B')) {
        return { reason: 'Transition — handover from regular metro to convoy ops', kind: 'transition' };
      }
      // DH 8 02:00 → 04:00 maintenance during Movement A
      if (dhI === 8 && startMin >= 120 && endMin <= 240) {
        return { reason: 'Maintenance window (02:00–04:00)', kind: 'maintenance' };
      }
      return { reason: 'No train operations', kind: 'idle' };
    }

    // Compose timeline = bands + gaps. Display-only structure.
    // On DH 9, the Wuqūf gap (B2B end 11:00 → C start 18:57) gets split at
    // 18:10 — the moment Nafra Zone-1 boarding passes activate. The last
    // 47 min before trains depart is "pre-departure boarding" not idle.
    function pushGap(arr, dhI, startMin, endMin, prevMvt, nextMvt) {
      if (startMin >= endMin) return;
      if (dhI === 9 && prevMvt && prevMvt.startsWith('B') && nextMvt === 'C'
          && startMin < 18*60+10 && endMin > 18*60+10) {
        const split = 18*60 + 10;
        arr.push({
          type: 'gap',
          start: fmtHM(startMin), end: fmtHM(split),
          start_min: startMin, end_min: split,
          reason: 'Wuqūf at Arafat — pilgrims standing at Arafat until sunset Nafra',
          kind: 'ritual',
        });
        arr.push({
          type: 'gap',
          start: fmtHM(split), end: fmtHM(endMin),
          start_min: split, end_min: endMin,
          reason: 'Pre-departure boarding — Nafra Zone 1 active; first trains depart 18:57',
          kind: 'boarding',
        });
        return;
      }
      const g = gapReason(dhI, startMin, endMin, prevMvt, nextMvt);
      arr.push({
        type: 'gap',
        start: fmtHM(startMin), end: fmtHM(endMin),
        start_min: startMin, end_min: endMin,
        reason: g.reason, kind: g.kind,
      });
    }
    const timelineBands = [];
    let cursor = 0;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (b.start_min > cursor) {
        const prevMvt = i > 0 ? bands[i-1].mvt : null;
        pushGap(timelineBands, dhInt, cursor, b.start_min, prevMvt, b.mvt);
      }
      timelineBands.push({
        type: 'band', mvt: b.mvt, trains: b.trains, desc: b.desc,
        start: b.start, end: b.end,
        start_min: b.start_min, end_min: b.end_min,
        crosses_midnight: b.crosses_midnight, starts_yesterday: b.starts_yesterday,
        shift: b.shift,
      });
      cursor = b.end_min;
    }
    if (cursor < 1440 && bands.length > 0) {
      const prevMvt = bands[bands.length - 1].mvt;
      pushGap(timelineBands, dhInt, cursor, 1440, prevMvt, null);
    }
    if (bands.length === 0) {
      const note = dhInt < 7
        ? 'Pre-mobilization (medical setup, no train ops)'
        : dhInt === 14
          ? 'Demobilization day (no train ops)'
          : 'No train operations on this day';
      timelineBands.push({
        type: 'gap', start: '00:00', end: '24:00',
        start_min: 0, end_min: 1440,
        reason: note, kind: 'idle',
      });
    }

    // Per-hour movement label (kept for backward compatibility with
    // existing chart consumers; uses bands above for accurate lookup).
    const startHr = (dhInt >= 7) ? 0 : 6;
    const endHr   = (dhInt >= 7) ? 24 : 18;
    const hourlyTimeline = [];
    for (let h = startHr; h < endHr; h++) {
      const minStart = h * 60;
      const minEnd = minStart + 60;
      let label = "—", trains = 0, desc = "";
      // Any-overlap test: hour bucket [h*60, h*60+60) overlaps band [start, end).
      // Prefer the band that occupies the most of this hour.
      let bestOverlap = 0;
      for (const b of bands) {
        const ov = Math.max(0, Math.min(b.end_min, minEnd) - Math.max(b.start_min, minStart));
        if (ov > bestOverlap) {
          bestOverlap = ov; label = b.mvt; trains = b.trains; desc = b.desc;
        }
      }
      hourlyTimeline.push({hour: String(h).padStart(2,'0')+':00', mvt: label, trains, desc});
    }

    // Per-station, per-hour platform activity grid.
    const STATIONS = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3'];
    const grid = STATIONS.map(st => ({
      st,
      hours: hourlyTimeline.map(t => {
        const plats = platforms[t.mvt] || [];
        const here = plats.find(p => p.st === st);
        return {
          hour: t.hour,
          mvt: t.mvt,
          plat: here ? here.plat : null,
          role: here ? here.role : null,
          active: !!here
        };
      })
    }));

    // Pax flow filtered to this DH.
    const paxForDH = paxFlow.filter(p => p.dh === dhInt);
    const paxByStHr = {};
    const paxByPlatStHr = {};
    for (const p of paxForDH) {
      const stRaw = p.station;
      const stBase = stRaw.split('_')[0];
      const platSuffix = stRaw.includes('_') ? stRaw.split('_')[1] : null;
      const key = stBase + '@' + String(p.hour).padStart(2,'0');
      paxByStHr[key] = (paxByStHr[key] || 0) + p.count;
      if (platSuffix) {
        const pkey = stRaw + '@' + String(p.hour).padStart(2,'0');
        paxByPlatStHr[pkey] = (paxByPlatStHr[pkey] || 0) + p.count;
      }
    }
    for (const row of grid) {
      for (const cell of row.hours) {
        const h2 = cell.hour.split(':')[0];
        cell.pax = paxByStHr[row.st + '@' + h2] || 0;
        if (cell.plat === 'NS') {
          cell.pax_n = paxByPlatStHr[row.st + '_N@' + h2] || 0;
          cell.pax_s = paxByPlatStHr[row.st + '_S@' + h2] || 0;
        }
      }
    }

    // Per-movement aggregate pax for this DH (groups by movement family).
    // Each band on the timeline gets a total + per-station breakdown so
    // the page can show "Movement C: 303,950 pilgrims, peak at ARF1 18:00".
    //
    // Hour-bucket overlap rule: each pax record p represents arrivals in
    // bucket [p.hour*60, (p.hour+1)*60). It contributes to a band iff
    // those minutes overlap [band.start_min, band.end_min). This fixes the
    // Movement C edge case where the band starts at 18:57 but Period-1
    // boarding (78,517 pilgrims, hour 18) is operationally part of C.
    //
    // forecast_published: SAR only published pax flow for B/C/D (PDF §4).
    // Movements A and E have no public forecast — flag this so the UI can
    // say "no published forecast" instead of a misleading 0.
    const PUBLISHED_FAMILIES = new Set(['B', 'C', 'D']);
    const paxByBand = bands.map(b => {
      const family = b.mvt.charAt(0);  // B1A → B, E1 → E
      const stTotals = {};
      let total = 0;
      for (const p of paxForDH) {
        if (p.movement_group !== family) continue;
        const bucketStart = p.hour * 60;
        const bucketEnd = bucketStart + 60;
        // Overlap test: bucket overlaps band window?
        if (bucketEnd <= b.start_min || bucketStart >= b.end_min) continue;
        const stBase = p.station.split('_')[0];
        stTotals[stBase] = (stTotals[stBase] || 0) + p.count;
        total += p.count;
      }
      const top = Object.entries(stTotals)
        .map(([st, n]) => ({ st, n }))
        .sort((a,b) => b.n - a.n);
      return {
        mvt: b.mvt, start: b.start, end: b.end,
        total, top: top.slice(0, 4),
        per_station: stTotals,
        forecast_published: PUBLISHED_FAMILIES.has(family),
      };
    });

    // Tafweej zones apply only to DH 9 (Nafra prep at Arafat).
    const tafweejForDH = (dhInt === 9) ? tafweej : [];

    return {
      ok: true,
      dh,
      hour,
      meta: {
        dh_days: Array.from(new Set(phases.map(p =>
          parseInt(String(p.start_dh).split(' ')[0], 10)
        ).filter(x => x >= 4 && x <= 14))).sort((a,b)=>a-b).map(String),
        dh_dates: {
          // DH → Gregorian: DH 1 = 2026-05-22 (1 Dhul Hijjah 1447 per Saudi
          // National Center for Astronomy). DH 9 = Day of Arafah (May 30),
          // DH 10 = Eid Al-Adha (May 31). Primary operating window DH 7–13
          // = May 28 – June 3, matching the SAR operating calendar.
          "4": "2026-05-25", "5": "2026-05-26", "6": "2026-05-27",
          "7": "2026-05-28", "8": "2026-05-29", "9": "2026-05-30",
          "10":"2026-05-31", "11":"2026-06-01", "12":"2026-06-02",
          "13":"2026-06-03", "14":"2026-06-04",
        },
      },
      phases_for_dh: phasesForDH,
      bands,
      timeline_bands: timelineBands,
      pax_by_band: paxByBand,
      hourly_timeline: hourlyTimeline,
      grid,
      // platforms_for_dh: movement-code → [{st, plat, role}] for the
      // movements present on this DH. Lets the UI look up station/platform
      // activity directly by band.mvt instead of going via hourly grid
      // (which loses 30-min-band entries due to hour-rounding).
      platforms_for_dh: phasesForDH.reduce((acc, p) => {
        if (acc[p.mvt]) return acc;
        acc[p.mvt] = platforms[p.mvt] || [];
        return acc;
      }, {}),
      tafweej: tafweejForDH,
      station_hours: stationHours,
      all_phases: full ? phases : undefined,
      all_platforms: full ? platforms : undefined,
    };
  },

  // ==============================================================
  // card_get / card_save — per-card editable content
  // ==============================================================
  async card_get(user, env, params) {
    await ACTIONS._ensureDocsTable(env);
    const slug = String(params.slug || '').trim().toLowerCase();
    if (!slug) return { ok: false, error: 'missing_slug' };
    try {
      const r = await env.DB.prepare(
        `SELECT slug, title, content, version, updated_by_name, updated_at FROM editable_docs WHERE slug = ?1`
      ).bind(slug).first();
      if (!r) return { ok: true, slug, content: '', version: 0, exists: false };
      return { ok: true, ...r, exists: true };
    } catch (e) { return { ok: false, error: 'fetch_failed', detail: e.message }; }
  },

  // Bulk get for cards on a page (e.g. all "protocols:*" cards)
  async cards_get_bulk(user, env, params) {
    await ACTIONS._ensureDocsTable(env);
    const prefix = String(params.prefix || '').trim().toLowerCase();
    if (!prefix) return { ok: false, error: 'missing_prefix' };
    try {
      const r = await env.DB.prepare(
        `SELECT slug, content, version, updated_by_name, updated_at FROM editable_docs WHERE slug LIKE ?1`
      ).bind(prefix + '%').all();
      const cards = {};
      (r.results || []).forEach(row => { cards[row.slug] = row; });
      return { ok: true, cards };
    } catch (e) { return { ok: false, error: 'fetch_failed', detail: e.message }; }
  },

  async unit_availability(user, env, params, dj) {
    const detail = (dj && dj.units_detail) || [];
    const units = detail.map(u => ({
      // Identity
      code: u.id || '',
      id: u.id || '',                              // alias for frontend code that reads u.id
      type: u.type || '',
      category: u.category || '',
      // Locations
      home_station: (u.home || '').toUpperCase(),
      home: (u.home || '').toUpperCase(),          // alias
      current_station: (u.home || '').toUpperCase(),
      // Staffing — these were missing and caused units.html to show 0/0
      size: u.size || u.total_count || 0,
      total_count: u.size || u.total_count || 0,
      filled_count: u.filled_count || 0,
      default_shift: u.default_shift || '',
      members: u.members || [],
      tags: u.tags || [],
      notes: u.notes || '',
      // State (mutable runtime values)
      state: 'available',
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

    // Compute summary for dispatch dropdown header
    const summary = { available: 0, busy: 0, off_duty: 0, maintenance: 0, oos: 0, unknown: 0, total: units.length };
    units.forEach(u => { if (summary[u.state] !== undefined) summary[u.state]++; });

    return { ok: true, units, summary };
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
          (SELECT COUNT(*) FROM dispatch_log
             WHERE status NOT IN ('complete','cancelled')
               AND COALESCE(is_drill,0) = 0
               AND closed_at IS NULL
               AND ts >= ?1) AS open_n,
          (SELECT COUNT(*) FROM dispatch_log
             WHERE status = 'complete'
               AND COALESCE(is_drill,0) = 0
               AND closed_at >= ?1) AS closed_n,
          (SELECT COUNT(*) FROM dispatch_log
             WHERE status = 'transporting'
               AND COALESCE(is_drill,0) = 0
               AND closed_at IS NULL) AS transfer_n`
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
    // Date scope. Defaults to today UTC. Accepts:
    //   ?date=YYYY-MM-DD           → single day
    //   ?start_date=...&end_date=. → inclusive range
    //   ?days=N                    → last N days (1=today, 4=today+3 prior)
    const todayUTC = new Date().toISOString().slice(0, 10);
    let startDate = params.start_date || params.date || todayUTC;
    let endDate   = params.end_date   || params.date || todayUTC;
    if (params.days) {
      const n = Math.max(1, Math.min(60, parseInt(params.days, 10) || 1));
      const end = new Date(); end.setUTCHours(23, 59, 59, 999);
      const start = new Date(end); start.setUTCDate(start.getUTCDate() - n + 1); start.setUTCHours(0,0,0,0);
      startDate = start.toISOString().slice(0,10);
      endDate   = end.toISOString().slice(0,10);
    }
    const startTs = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000);
    const endTs   = Math.floor(new Date(endDate   + 'T23:59:59Z').getTime() / 1000);
    const todayStart = startTs;  // legacy variable name used below
    const STATIONS_LIST = STATIONS;

    // Initialize all fields the frontend reads (so missing data = 0, never undefined)
    const result = {
      ok: true,
      server_time: new Date().toISOString(),
      scope: { start_date: startDate, end_date: endDate, days: Math.round((endTs - startTs) / 86400) + 1 },
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

    // 1a. LIVE counts — currently-open incidents are time-INVARIANT. Always show real-time truth
    //     regardless of date window (an incident open from 3 days ago should still show as open today).
    try {
      // Optional explicit cluster filter via ?cluster=Arafat|Muzdalifah|Mina
      const _clusterParam = String(params.cluster || '').toLowerCase();
      const _cs = CLUSTER_STATIONS[_clusterParam] || null;
      let _liveQ = `SELECT incident_id, station, triage, cardiac_arrest, status
         FROM dispatch_log
         WHERE status NOT IN ('complete','cancelled','closed')`;
      const _liveBinds = [];
      if (_cs) {
        _liveQ += ` AND station IN (${_cs.map(() => '?').join(',')})`;
        _cs.forEach(st => _liveBinds.push(st));
      }
      const liveR = await env.DB.prepare(_liveQ).bind(..._liveBinds).all();
      (liveR.results || []).forEach(inc => {
        result.dispatch.open++;
        const station = inc.station || 'UNK';
        const bs = result.dispatch.by_station[station] || (result.dispatch.by_station[station] = { open: 0, red_open: 0, in_transfer: 0, closed_today: 0 });
        bs.open++;
        if (inc.triage === 'red')          { result.dispatch.red_open++;     bs.red_open++; }
        if (inc.cardiac_arrest)              result.dispatch.cardiac_open++;
        if (inc.status === 'transporting') { result.dispatch.in_transfer++; bs.in_transfer++; }
      });
    } catch (e) {
      result.dispatch._live_err = String(e.message);
    }

    // 1b. SCOPED query for the date window — populates incidents[], heatmap, recent[],
    //     response_time, closed_today (renamed from "today" but means in scope)
    try {
      const incR = await env.DB.prepare(
        `SELECT incident_id, ts, station, sub_location, source, complaint, triage,
                cardiac_arrest, unit_assigned, status, patient_count, notes,
                closed_at, closed_by_nid
         FROM dispatch_log
         WHERE (closed_at >= ?1 AND closed_at <= ?2)
            OR (ts >= ?1 AND ts <= ?2)
         ORDER BY ts DESC LIMIT 1000`
      ).bind(startTs, endTs).all();
      const incidents = incR.results || [];

      incidents.forEach(inc => {
        const closedInScope = inc.closed_at && inc.closed_at >= startTs && inc.closed_at <= endTs;
        const station = inc.station || 'UNK';
        const bs = result.dispatch.by_station[station] || (result.dispatch.by_station[station] = { open: 0, red_open: 0, in_transfer: 0, closed_today: 0 });
        if (closedInScope) {
          result.dispatch.closed_today++;
          bs.closed_today++;
        }
      });

      // 1c. RESPONSE TIME — for incidents in scope that have an on_scene event,
      //     compute mean/median/P95 of (on_scene_ts - dispatch.ts) in milliseconds.
      try {
        const rtR = await env.DB.prepare(
          `SELECT (e.ts - d.ts) AS delta_sec
           FROM dispatch_log d
           INNER JOIN (
             SELECT incident_id, MIN(ts) AS ts
             FROM incident_events
             WHERE event_type = 'on_scene'
             GROUP BY incident_id
           ) e ON e.incident_id = d.incident_id
           WHERE (d.ts >= ?1 AND d.ts <= ?2)
           AND (e.ts - d.ts) BETWEEN 0 AND 86400`
        ).bind(startTs, endTs).all();

        const deltas = (rtR.results || []).map(r => r.delta_sec).filter(s => s > 0);
        if (deltas.length > 0) {
          deltas.sort((a, b) => a - b);
          const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          const p50 = deltas[Math.floor(deltas.length * 0.5)];
          const p95 = deltas[Math.floor(deltas.length * 0.95)] || deltas[deltas.length - 1];
          result.dispatch.response_time = {
            mean_ms: Math.round(mean * 1000),
            p50_ms:  Math.round(p50 * 1000),
            p95_ms:  Math.round(p95 * 1000),
            count:   deltas.length
          };
        }
      } catch (e) {
        result.dispatch._response_time_err = String(e.message);
      }

      // Recent strip: last 20 in scope
      result.dispatch.recent = incidents
        .filter(i => i.ts >= startTs && i.ts <= endTs)
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
      const inScope = pcrs.filter(p => p.ts >= startTs && p.ts <= endTs);
      result.pcr.today = inScope.length;
      inScope.forEach(p => {
        const ac = (p.triage_category || 'unspecified').toLowerCase();
        result.pcr.by_acuity[ac] = (result.pcr.by_acuity[ac] || 0) + 1;
        const dp = (p.disposition || 'unspecified').toLowerCase();
        result.pcr.by_disposition[dp] = (result.pcr.by_disposition[dp] || 0) + 1;
        const cc = (p.chief_complaint || 'unspecified').toLowerCase();
        result.pcr.by_complaint[cc] = (result.pcr.by_complaint[cc] || 0) + 1;
      });
      result.pcr.recent = inScope.slice(0, 20).map(p => ({
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

    // 2b. Fallback: if PCRs are empty, aggregate complaints from dispatch_log so the panel isn't blank.
    //     Frontend reads pcr.top_complaints. We always populate it.
    if (Object.keys(result.pcr.by_complaint).length === 0) {
      const dispatchComplaints = {};
      try {
        const r2 = await env.DB.prepare(
          `SELECT complaint, COUNT(*) AS n FROM dispatch_log
           WHERE complaint IS NOT NULL AND complaint != ''
             AND ts >= ?1 AND ts <= ?2
           GROUP BY complaint ORDER BY n DESC LIMIT 10`
        ).bind(startTs, endTs).all();
        (r2.results || []).forEach(row => { dispatchComplaints[row.complaint.toLowerCase()] = row.n; });
      } catch (_) {}
      result.pcr.by_complaint = dispatchComplaints;
      result.pcr._fallback_source = 'dispatch_log';
    }
    result.pcr.top_complaints = Object.entries(result.pcr.by_complaint)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([complaint, count]) => ({ complaint, count }));

    // 3. Station status (use existing handler)
    try {
      const stationsResult = await ACTIONS.station_status_list(user, env, params, dj);
      result.stations = stationsResult.stations || [];
    } catch (e) {
      result.stations = STATIONS_LIST.map(s => ({ station: s, status: '', note: '' }));
    }

    return result;
  },

  // ==============================================================
  // command_summary — Executive Command Center single-call payload
  // Combines: live KPIs, station heatmap, alerts, recent activity,
  // resource grid, MCI status. Used by /command page (TV-ready OCC).
  // ==============================================================
  async command_summary(user, env, params, dj) {
    const now = Math.floor(Date.now() / 1000);
    const result = {
      ok: true,
      generated_at: now,
      user: { name: user.name, role: user.role, nid: user.nid },
      // Live ops counts
      live: {
        open: 0, red_open: 0, cardiac_open: 0, in_transfer: 0,
        on_scene: 0, en_route: 0,
        by_station: {},
        by_cluster: { Arafat: 0, Muzdalifah: 0, Mina: 0, Other: 0 }
      },
      // Last hour stats
      hour: { dispatched: 0, closed: 0, response_time_p95_sec: null },
      // Today (UTC date window)
      today: { dispatched: 0, closed: 0, by_triage: {} },
      // Stations: each has live data + per-station ops
      stations: [],
      // Alerts: surge predictions, anomalies
      alerts: [],
      // Recent activity feed (last 30)
      activity: [],
      // Resource snapshot
      resources: { units: { total: 0, available: 0, busy: 0, oos: 0 } },
      // MCI mode
      mci: { active: false, level: null, declared_at: null, declared_by: null, reason: null },
      // Hajj day
      hajj_day: ACTIONS._hajjDay(now)
    };

    // === LIVE — currently open incidents (no date filter) ===
    try {
      const liveR = await env.DB.prepare(
        `SELECT incident_id, station, triage, cardiac_arrest, status, ts
         FROM dispatch_log
         WHERE status NOT IN ('complete','cancelled','closed') AND COALESCE(is_drill,0) = 0`
      ).all();
      const ARFAT = ['ARF1','ARF2','ARF3'];
      const MUZ = ['MUZ1','MUZ2','MUZ3'];
      const MIN = ['MIN1','MIN2','MIN3'];
      (liveR.results || []).forEach(inc => {
        result.live.open++;
        if (inc.triage === 'red') result.live.red_open++;
        if (inc.cardiac_arrest)   result.live.cardiac_open++;
        if (inc.status === 'transporting') result.live.in_transfer++;
        if (inc.status === 'on_scene')     result.live.on_scene++;
        const st = inc.station || 'UNK';
        result.live.by_station[st] = (result.live.by_station[st] || 0) + 1;
        if (ARFAT.includes(st))   result.live.by_cluster.Arafat++;
        else if (MUZ.includes(st))   result.live.by_cluster.Muzdalifah++;
        else if (MIN.includes(st))   result.live.by_cluster.Mina++;
        else result.live.by_cluster.Other++;
      });
    } catch (e) { result._live_err = String(e.message); }

    // === LAST HOUR ===
    try {
      const hourAgo = now - 3600;
      const hR = await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN ts >= ?1 THEN 1 ELSE 0 END) AS dispatched,
           SUM(CASE WHEN closed_at >= ?1 THEN 1 ELSE 0 END) AS closed
         FROM dispatch_log WHERE COALESCE(is_drill,0) = 0`
      ).bind(hourAgo).first();
      result.hour.dispatched = Number(hR?.dispatched) || 0;
      result.hour.closed = Number(hR?.closed) || 0;

      // P95 response time over last hour
      const rtR = await env.DB.prepare(
        `SELECT (e.ts - d.ts) AS delta
         FROM dispatch_log d
         INNER JOIN (
           SELECT incident_id, MIN(ts) AS ts FROM incident_events
           WHERE event_type = 'on_scene' GROUP BY incident_id
         ) e ON e.incident_id = d.incident_id
         WHERE d.ts >= ?1 AND (e.ts - d.ts) BETWEEN 0 AND 86400
         ORDER BY delta DESC`
      ).bind(hourAgo).all();
      const deltas = (rtR.results || []).map(r => r.delta).filter(d => d > 0);
      if (deltas.length > 0) {
        const idx = Math.floor(deltas.length * 0.05); // already DESC, so 5% from top = p95
        result.hour.response_time_p95_sec = deltas[idx] || deltas[0];
      }
    } catch (e) { result._hour_err = String(e.message); }

    // === TODAY (UTC window) ===
    try {
      const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
      const tR = await env.DB.prepare(
        `SELECT triage, COUNT(*) AS n
         FROM dispatch_log WHERE ts >= ?1 GROUP BY triage`
      ).bind(todayStart).all();
      let totalToday = 0;
      (tR.results || []).forEach(r => {
        result.today.by_triage[r.triage || 'other'] = r.n;
        totalToday += r.n;
      });
      result.today.dispatched = totalToday;
      const cR = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM dispatch_log WHERE closed_at >= ?1`
      ).bind(todayStart).first();
      result.today.closed = Number(cR?.n) || 0;
    } catch (e) { result._today_err = String(e.message); }

    // === STATIONS — full breakdown ===
    try {
      const stations = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3'];
      const stR = await env.DB.prepare(
        `SELECT station, status, capacity_pct, sub_location, ts
         FROM (
           SELECT station, status, capacity_pct, sub_location, ts,
                  ROW_NUMBER() OVER (PARTITION BY station ORDER BY ts DESC) AS rn
           FROM station_status_log
         )
         WHERE rn = 1`
      ).all();
      const stMap = {};
      (stR.results || []).forEach(r => stMap[r.station] = r);
      stations.forEach(st => {
        const s = stMap[st] || {};
        const cluster = ['ARF1','ARF2','ARF3'].includes(st) ? 'Arafat'
                      : ['MUZ1','MUZ2','MUZ3'].includes(st) ? 'Muzdalifah' : 'Mina';
        result.stations.push({
          code: st,
          cluster,
          status: s.status || 'unknown',
          capacity_pct: s.capacity_pct,
          sub_location: s.sub_location,
          updated_at: s.ts ? new Date(s.ts * 1000).toISOString() : null,
          live_open: result.live.by_station[st] || 0
        });
      });
    } catch (e) { result._stations_err = String(e.message); }

    // === ALERTS — algorithmic surge & anomaly detection ===
    try {
      // Alert 1: any station with ≥3 open incidents
      result.stations.forEach(s => {
        if (s.live_open >= 3) {
          result.alerts.push({
            level: s.live_open >= 5 ? 'critical' : 'warning',
            kind: 'station_surge',
            station: s.code,
            text: `${s.code}: ${s.live_open} open incidents`,
            ts: now
          });
        }
      });
      // Alert 2: > 5 reds across system
      if (result.live.red_open >= 5) {
        result.alerts.push({
          level: 'critical', kind: 'red_surge',
          text: `${result.live.red_open} RED triage open simultaneously`, ts: now
        });
      }
      // Alert 3: cardiac arrests open
      if (result.live.cardiac_open > 0) {
        result.alerts.push({
          level: 'critical', kind: 'cardiac_arrest',
          text: `${result.live.cardiac_open} cardiac arrest${result.live.cardiac_open>1?'s':''} active`, ts: now
        });
      }
      // Alert 4: incident rate spike
      if (result.hour.dispatched >= 10) {
        result.alerts.push({
          level: result.hour.dispatched >= 20 ? 'critical' : 'warning',
          kind: 'volume_spike',
          text: `${result.hour.dispatched} incidents in past hour`, ts: now
        });
      }
      // Alert 5: response time degraded
      if (result.hour.response_time_p95_sec && result.hour.response_time_p95_sec > 600) {
        result.alerts.push({
          level: result.hour.response_time_p95_sec > 1200 ? 'critical' : 'warning',
          kind: 'response_time',
          text: `P95 response time: ${Math.round(result.hour.response_time_p95_sec/60)} min`, ts: now
        });
      }
    } catch (e) { result._alerts_err = String(e.message); }

    // === ACTIVITY FEED — last 30 events from audit_log ===
    try {
      const aR = await env.DB.prepare(
        `SELECT a.ts, a.actor_nid, a.action, a.resource, a.resource_id, a.details,
                w.name AS actor_name
         FROM audit_log a LEFT JOIN allowlist w ON w.nid = a.actor_nid
         ORDER BY a.ts DESC LIMIT 30`
      ).all();
      result.activity = (aR.results || []).map(r => ({
        ts: r.ts,
        ts_iso: new Date(r.ts * 1000).toISOString(),
        actor: r.actor_name || r.actor_nid || 'system',
        action: r.action,
        resource: r.resource,
        resource_id: r.resource_id,
        // Details JSON (truncated)
        details: r.details ? r.details.slice(0, 200) : null
      }));
    } catch (e) { result._activity_err = String(e.message); }

    // === RESOURCES — units status ===
    try {
      const uR = await env.DB.prepare(
        `SELECT unit_code, status FROM (
           SELECT unit_code, status, ts,
                  ROW_NUMBER() OVER (PARTITION BY unit_code ORDER BY ts DESC) AS rn
           FROM unit_status_log
         ) WHERE rn = 1`
      ).all();
      const stat = {};
      (uR.results || []).forEach(r => { stat[r.status] = (stat[r.status] || 0) + 1; });
      const units = (dj && dj.units_detail) || [];
      result.resources.units.total = units.length;
      result.resources.units.available = stat.available || 0;
      result.resources.units.busy = (stat.busy || 0) + (stat.dispatched || 0);
      result.resources.units.oos = (stat.oos || 0) + (stat.maintenance || 0);
      // Default everyone as available if no status logged
      const accounted = result.resources.units.available + result.resources.units.busy + result.resources.units.oos;
      const unaccounted = Math.max(0, units.length - accounted);
      result.resources.units.available += unaccounted;
    } catch (e) { result._resources_err = String(e.message); }

    // === MCI STATUS — read latest from sync_state ===
    try {
      const mR = await env.DB.prepare(
        `SELECT value FROM sync_state WHERE key = 'mci_status' LIMIT 1`
      ).first();
      if (mR && mR.value) {
        try { result.mci = JSON.parse(mR.value); } catch (_) {}
      }
    } catch (e) {}

    return result;
  },

  // ==============================================================
  // mci_status / mci_set — Mass Casualty Incident mode toggle
  // ==============================================================
  async mci_status(user, env) {
    try {
      const r = await env.DB.prepare(
        `SELECT value FROM sync_state WHERE key = 'mci_status' LIMIT 1`
      ).first();
      if (r && r.value) return { ok: true, mci: JSON.parse(r.value) };
    } catch (_) {}
    return { ok: true, mci: { active: false } };
  },

  async mci_set(user, env, params) {
    const active = !!params.active;
    const now = Math.floor(Date.now() / 1000);
    const mci = active ? {
      active: true,
      level: params.level || 'level_1',  // level_1 / level_2 / level_3
      reason: String(params.reason || '').slice(0, 500),
      declared_at: now,
      declared_by: user.nid,
      declared_by_name: user.name
    } : { active: false, deactivated_at: now, deactivated_by: user.nid };

    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('mci_status', ?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2`
        ).bind(JSON.stringify(mci), now),
        env.DB.prepare(
          `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
           VALUES (?1, ?2, 'mci', ?3, ?4)`
        ).bind(user.nid, active ? 'mci_activate' : 'mci_deactivate',
               mci.level || 'system', JSON.stringify(mci))
      ]);
      return { ok: true, mci };
    } catch (e) {
      return { ok: false, error: 'mci_set_failed', detail: e.message };
    }
  },

  // ==============================================================
  // broadcast_send / broadcast_list / broadcast_ack — system-wide alerts
  // ==============================================================
  async broadcast_send(user, env, params) {
    const text = String(params.text || '').slice(0, 1000);
    const audience = params.audience || 'all'; // all|cluster|station|role
    const target = String(params.target || '').slice(0, 200);
    const level = params.level || 'info';      // info|warn|critical
    if (!text) return { ok: false, error: 'missing_text' };
    const now = Math.floor(Date.now() / 1000);
    const id = 'BC-' + now + '-' + Math.floor(Math.random() * 9999);
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS broadcasts (
           id TEXT PRIMARY KEY, ts INTEGER NOT NULL, sender_nid TEXT,
           sender_name TEXT, text TEXT NOT NULL, audience TEXT, target TEXT,
           level TEXT, expires_at INTEGER
         )`).run();
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS broadcast_acks (
           broadcast_id TEXT, nid TEXT, ts INTEGER NOT NULL,
           PRIMARY KEY (broadcast_id, nid)
         )`).run();
      await env.DB.prepare(
        `INSERT INTO broadcasts (id, ts, sender_nid, sender_name, text, audience, target, level, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(id, now, user.nid, user.name, text, audience, target, level, now + 3600).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'broadcast_send', 'broadcast', ?2, ?3)`
      ).bind(user.nid, id, JSON.stringify({ text, audience, target, level })).run();
      return { ok: true, id, ts: now };
    } catch (e) {
      return { ok: false, error: 'broadcast_failed', detail: e.message };
    }
  },

  async broadcast_list(user, env, params) {
    const since = parseInt(params.since || (Math.floor(Date.now() / 1000) - 7200), 10);
    try {
      const r = await env.DB.prepare(
        `SELECT * FROM broadcasts WHERE ts >= ?1 ORDER BY ts DESC LIMIT 50`
      ).bind(since).all();
      // Mark ones the current user has acked
      const ackR = await env.DB.prepare(
        `SELECT broadcast_id FROM broadcast_acks WHERE nid = ?1`
      ).bind(user.nid).all();
      const acked = new Set((ackR.results || []).map(x => x.broadcast_id));
      const list = (r.results || []).map(b => ({ ...b, acked: acked.has(b.id) }));
      return { ok: true, broadcasts: list };
    } catch (e) {
      // Tables don't exist yet — return empty
      return { ok: true, broadcasts: [] };
    }
  },

  async broadcast_ack(user, env, params) {
    const id = String(params.id || '');
    if (!id) return { ok: false, error: 'missing_id' };
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO broadcast_acks (broadcast_id, nid, ts) VALUES (?1, ?2, ?3)`
      ).bind(id, user.nid, now).run();
      return { ok: true, ack_at: now };
    } catch (e) {
      return { ok: false, error: 'ack_failed', detail: e.message };
    }
  },

  // ==============================================================
  // unit_suggest — Smart "best unit for incident X" recommendation
  // Algorithm: prefer (1) station match, (2) cluster match, (3) availability, (4) ALS for red
  // ==============================================================
  async unit_suggest(user, env, params, dj) {
    const station = String(params.station || '').toUpperCase();
    const triage = String(params.triage || '').toLowerCase();
    if (!station) return { ok: false, error: 'missing_station' };
    const ARFAT = new Set(['ARF1','ARF2','ARF3']);
    const MUZ = new Set(['MUZ1','MUZ2','MUZ3']);
    const MIN = new Set(['MIN1','MIN2','MIN3']);
    const cluster = ARFAT.has(station) ? ARFAT : MUZ.has(station) ? MUZ : MIN.has(station) ? MIN : null;

    const units = (dj && dj.units_detail) || [];
    if (units.length === 0) return { ok: true, suggestions: [] };

    // Get current unit statuses
    let statusByUnit = {};
    try {
      const r = await env.DB.prepare(
        `SELECT unit_code, status FROM (
           SELECT unit_code, status, ts,
                  ROW_NUMBER() OVER (PARTITION BY unit_code ORDER BY ts DESC) AS rn
           FROM unit_status_log
         ) WHERE rn = 1`
      ).all();
      (r.results || []).forEach(x => statusByUnit[x.unit_code] = x.status);
    } catch (_) {}

    // Get current "busy" by checking dispatch_log
    let busyUnits = new Set();
    try {
      const r = await env.DB.prepare(
        `SELECT DISTINCT unit_assigned FROM dispatch_log
         WHERE status NOT IN ('complete','cancelled','closed')
         AND unit_assigned IS NOT NULL AND unit_assigned != ''`
      ).all();
      (r.results || []).forEach(x => busyUnits.add(x.unit_assigned));
    } catch (_) {}

    const scored = units.map(u => {
      const home = String(u.home || '').toUpperCase();
      let score = 0;
      let reason = [];
      // Same station: +100
      if (home === station) { score += 100; reason.push('same station'); }
      // Same cluster: +40
      else if (cluster && cluster.has(home)) { score += 40; reason.push('same cluster'); }
      // Available status: +20
      const stat = statusByUnit[u.id] || 'available';
      if (stat === 'available') { score += 20; reason.push('available'); }
      else if (stat === 'busy' || stat === 'dispatched') { score -= 50; reason.push('busy'); }
      else if (stat === 'oos' || stat === 'maintenance') { score -= 200; reason.push(stat); }
      // Currently on incident: heavy penalty
      if (busyUnits.has(u.id)) { score -= 100; reason.push('on incident'); }
      // ALS for red: bonus
      if (triage === 'red' && (u.type || '').toUpperCase().includes('ALS')) {
        score += 30; reason.push('ALS for red');
      }
      // Penalize basic ambulances for red
      if (triage === 'red' && (u.type || '').toUpperCase().includes('B-AMB')) {
        score -= 20;
      }
      return {
        unit_code: u.id,
        type: u.type,
        home_station: home,
        score,
        reason,
        status: stat,
        on_incident: busyUnits.has(u.id)
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return { ok: true, suggestions: scored.slice(0, 5), all_count: scored.length };
  },

  // ==============================================================
  // activity_feed — recent system activity, aggregated and humanized
  // ==============================================================
  async activity_feed(user, env, params) {
    const limit = Math.min(parseInt(params.limit || 100, 10), 200);
    const since = parseInt(params.since || (Math.floor(Date.now() / 1000) - 3600), 10);
    try {
      const r = await env.DB.prepare(
        `SELECT a.ts, a.actor_nid, a.action, a.resource, a.resource_id, a.details,
                w.name AS actor_name, w.role AS actor_role
         FROM audit_log a
         LEFT JOIN allowlist w ON w.nid = a.actor_nid
         WHERE a.ts >= ?1
         ORDER BY a.ts DESC LIMIT ?2`
      ).bind(since, limit).all();
      return { ok: true, events: (r.results || []).map(e => ({
        ts: e.ts,
        ts_iso: new Date(e.ts * 1000).toISOString(),
        actor: e.actor_name || 'system',
        actor_role: e.actor_role,
        action: e.action,
        resource: e.resource,
        resource_id: e.resource_id,
        details: e.details
      })) };
    } catch (e) {
      return { ok: false, error: 'feed_failed', detail: e.message };
    }
  },

  // ==============================================================
  // surge_forecast — predictive surge intelligence
  // Rule-based for Hajj 1447H windows + time-of-day + recent trend
  // ==============================================================
  async surge_forecast(user, env, params) {
    const now = Math.floor(Date.now() / 1000);
    const lookahead_hours = Math.min(parseInt(params.hours || 8, 10), 24);
    // KSA (UTC+3) hour
    const ksaNow = new Date((now + 3*3600) * 1000);
    const startKsaHour = ksaNow.getUTCHours();
    const dh = ACTIONS._hajjDay(now);

    // Rule library: returns risk score (0-100) for each cluster per window
    // For each hour in next N, compute risk by cluster
    const ARFAT = 'Arafat', MUZ = 'Muzdalifah', MIN = 'Mina';
    function dhBaseline(dhStr, ksaHour, cluster) {
      // Riyadh-aware Hajj day timing rules
      const dhNum = (dhStr.match(/DH (\d+)/) || [])[1];
      const n = dhNum ? parseInt(dhNum, 10) : 0;
      let risk = 10;  // base
      let reasons = [];
      if (n === 8) {
        // Tarwiyah day — massive movement to Mina, prep for Arafat the next day
        if (cluster === MIN && (ksaHour >= 5 && ksaHour <= 14)) { risk += 50; reasons.push('Tarwiyah Mina arrivals'); }
        if (cluster === ARFAT && (ksaHour >= 14)) { risk += 25; reasons.push('Pre-Arafat positioning'); }
      }
      if (n === 9) {
        // Day of Arafat — peak. Wuquf at Arafat, then Muzdalifah at sunset, then Nafra night
        if (cluster === ARFAT && (ksaHour >= 6 && ksaHour <= 17)) { risk += 60; reasons.push('Wuquf Arafat - peak'); }
        if (cluster === ARFAT && (ksaHour >= 12 && ksaHour <= 16)) { risk += 25; reasons.push('Afternoon heat'); }
        if (cluster === MUZ && (ksaHour >= 17 && ksaHour <= 23)) { risk += 70; reasons.push('Muzdalifah sunset/Nafra'); }
        if (cluster === MIN && (ksaHour >= 22)) { risk += 50; reasons.push('Nafra arrivals to Mina'); }
        if (cluster === MIN && (ksaHour <= 4)) { risk += 50; reasons.push('Nafra peak (post-midnight)'); }
      }
      if (n === 10) {
        // Eid al-Adha. Stoning Jamarat al-Aqaba. Major Mina activity
        if (cluster === MIN && (ksaHour >= 6 && ksaHour <= 18)) { risk += 55; reasons.push('Stoning Day 1 - Eid'); }
        if (cluster === MIN && (ksaHour >= 12 && ksaHour <= 16)) { risk += 20; reasons.push('Afternoon heat'); }
      }
      if (n >= 11 && n <= 13) {
        // Continued stoning (Tashreeq days)
        if (cluster === MIN && (ksaHour >= 13 && ksaHour <= 18)) { risk += 40; reasons.push('Stoning Day ' + (n-9) + ' (Tashreeq)'); }
        if (cluster === MIN && (ksaHour >= 12 && ksaHour <= 16)) { risk += 15; reasons.push('Afternoon heat'); }
      }
      // Heat illness risk in any afternoon during Hajj
      if (n >= 5 && n <= 13 && (ksaHour >= 11 && ksaHour <= 16)) {
        risk += 10;
        if (!reasons.length) reasons.push('Heat exposure window');
      }
      // Pre-dawn elderly fall risk
      if ((ksaHour >= 3 && ksaHour <= 5) && n >= 5) {
        risk += 5;
        reasons.push('Pre-dawn frailty');
      }
      return { risk: Math.min(risk, 100), reasons };
    }

    // Pull recent incident velocity (last hour) per cluster
    const trend = { Arafat: 0, Muzdalifah: 0, Mina: 0 };
    try {
      const r = await env.DB.prepare(
        `SELECT station, COUNT(*) AS n FROM dispatch_log
         WHERE ts >= ?1 AND COALESCE(is_drill,0) = 0 GROUP BY station`
      ).bind(now - 3600).all();
      (r.results || []).forEach(x => {
        const st = String(x.station || '');
        if (['ARF1','ARF2','ARF3'].includes(st)) trend.Arafat += x.n;
        else if (['MUZ1','MUZ2','MUZ3'].includes(st)) trend.Muzdalifah += x.n;
        else if (['MIN1','MIN2','MIN3'].includes(st)) trend.Mina += x.n;
      });
    } catch (_) {}

    const forecasts = [];
    for (let h = 0; h < lookahead_hours; h++) {
      const ksaHour = (startKsaHour + h) % 24;
      const ts = now + h * 3600;
      const dhAt = ACTIONS._hajjDay(ts);
      const cluster_risks = {};
      [ARFAT, MUZ, MIN].forEach(cl => {
        const base = dhBaseline(dhAt, ksaHour, cl);
        // Bump by current trend (each unit of trend adds 5 risk pts up to 30)
        const trendBonus = Math.min(30, trend[cl] * 5);
        if (trendBonus > 0) base.reasons.push(`${trend[cl]} incidents in past hour`);
        cluster_risks[cl] = { risk: Math.min(100, base.risk + trendBonus), reasons: base.reasons };
      });
      forecasts.push({
        offset_hours: h,
        ksa_hour: ksaHour,
        ts,
        ts_iso: new Date(ts * 1000).toISOString(),
        hajj_day: dhAt,
        clusters: cluster_risks,
        peak_risk: Math.max(...Object.values(cluster_risks).map(c => c.risk))
      });
    }

    // Top alerts: high-risk windows in next 4 hours
    const next4 = forecasts.slice(0, 4);
    const recommendations = [];
    next4.forEach(f => {
      Object.entries(f.clusters).forEach(([cl, info]) => {
        if (info.risk >= 70) {
          recommendations.push({
            cluster: cl,
            risk: info.risk,
            ts: f.ts,
            ksa_hour: f.ksa_hour,
            recommendation: `Consider pre-positioning units for ${cl} at ${String(f.ksa_hour).padStart(2,'0')}:00 — ${info.reasons.join(', ')}`
          });
        }
      });
    });

    return {
      ok: true,
      generated_at: now,
      hajj_day: dh,
      ksa_now_hour: startKsaHour,
      lookahead_hours,
      recent_trend_by_cluster: trend,
      forecasts,
      recommendations
    };
  },

  // ==============================================================
  // drill_status / drill_set — drill mode toggle (separates training from real ops)
  // ==============================================================
  async drill_status(user, env) {
    try {
      const r = await env.DB.prepare(
        `SELECT value FROM sync_state WHERE key = 'drill_mode' LIMIT 1`
      ).first();
      if (r && r.value) return { ok: true, drill: JSON.parse(r.value) };
    } catch (_) {}
    return { ok: true, drill: { active: false } };
  },

  async drill_set(user, env, params) {
    const active = !!params.active;
    const now = Math.floor(Date.now() / 1000);
    const dr = active ? {
      active: true,
      scenario: String(params.scenario || 'Training drill').slice(0, 200),
      started_at: now,
      started_by: user.nid,
      started_by_name: user.name
    } : { active: false, ended_at: now, ended_by: user.nid };
    try {
      // Batch both writes in ONE D1 round trip — was 2 sequential awaits (~200ms)
      // → now 1 batch (~100ms). Halves the perceived End-Drill latency.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('drill_mode', ?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2`
        ).bind(JSON.stringify(dr), now),
        env.DB.prepare(
          `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
           VALUES (?1, ?2, 'drill', ?3, ?4)`
        ).bind(user.nid, active ? 'drill_start' : 'drill_end', dr.scenario || 'system', JSON.stringify(dr))
      ]);
      return { ok: true, drill: dr };
    } catch (e) {
      return { ok: false, error: 'drill_set_failed', detail: e.message };
    }
  },

  // ==============================================================
  // presence_ping — keep-alive ping from any authed user every ~60s
  // presence_list — current online users (active in last 5 min)
  // ==============================================================
  async presence_ping(user, env, params) {
    const now = Math.floor(Date.now() / 1000);
    const page = String(params.page || '/').slice(0, 80);
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS presence (
           nid TEXT PRIMARY KEY,
           name TEXT, role TEXT, page TEXT,
           last_ts INTEGER NOT NULL,
           since_ts INTEGER NOT NULL,
           ip TEXT,
           ua TEXT
         )`).run();
      // since_ts only updates if no row exists or stale > 30 min
      const ip = (params.ip || '').slice(0, 64);
      const ua = (params.ua || '').slice(0, 200);
      await env.DB.prepare(
        `INSERT INTO presence (nid, name, role, page, last_ts, since_ts, ip, ua)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
         ON CONFLICT(nid) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           page = excluded.page,
           last_ts = excluded.last_ts,
           since_ts = CASE WHEN (excluded.last_ts - presence.last_ts) > 1800 THEN excluded.last_ts ELSE presence.since_ts END,
           ip = excluded.ip,
           ua = excluded.ua`
      ).bind(user.nid, user.name, user.role, page, now, ip, ua).run();
      return { ok: true, ts: now };
    } catch (e) {
      return { ok: false, error: 'ping_failed', detail: e.message };
    }
  },

  async presence_list(user, env, params) {
    const now = Math.floor(Date.now() / 1000);
    const window = parseInt(params.window || 300, 10);  // 5 min default
    try {
      const r = await env.DB.prepare(
        `SELECT nid, name, role, page, last_ts, since_ts
         FROM presence WHERE last_ts >= ?1 ORDER BY last_ts DESC`
      ).bind(now - window).all();
      const users = (r.results || []).map(u => ({
        ...u,
        seconds_ago: now - u.last_ts,
        session_minutes: Math.floor((now - u.since_ts) / 60)
      }));
      // Group by role
      const byRole = {};
      const byPage = {};
      users.forEach(u => {
        byRole[u.role || 'unknown'] = (byRole[u.role || 'unknown'] || 0) + 1;
        const p = (u.page || '/').replace(/\?.*$/, '').replace(/^\//, '') || 'lobby';
        byPage[p] = (byPage[p] || 0) + 1;
      });
      return { ok: true, count: users.length, users, by_role: byRole, by_page: byPage, window_sec: window };
    } catch (e) {
      // Table doesn't exist yet
      return { ok: true, count: 0, users: [], by_role: {}, by_page: {}, window_sec: window };
    }
  },

  // ==============================================================
  // handoff_script — generate hospital radio handoff (MIST/SBAR)
  // ==============================================================
  async handoff_script(user, env, params) {
    const incidentId = String(params.incident_id || '').trim();
    const format = String(params.format || 'mist').toLowerCase();  // 'mist' or 'sbar'
    const destination = String(params.destination || '').slice(0, 200);
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };

    try {
      const inc = await env.DB.prepare(
        `SELECT * FROM dispatch_log WHERE incident_id = ?1 LIMIT 1`
      ).bind(incidentId).first();
      if (!inc) return { ok: false, error: 'not_found' };

      const events = await env.DB.prepare(
        `SELECT event_type, ts, notes FROM incident_events
         WHERE incident_id = ?1 ORDER BY ts ASC`
      ).bind(incidentId).all();

      const triageWord = ({red:'CRITICAL', yellow:'URGENT', green:'STABLE', black:'EXPECTANT'})[(inc.triage||'').toLowerCase()] || (inc.triage||'unknown');
      const onScene = (events.results || []).find(e => e.event_type === 'on_scene');
      const ageStr = inc.age || 'unknown age';
      const genderWord = inc.gender ? (String(inc.gender).toLowerCase().startsWith('m') ? 'male' : 'female') : '';
      const ssVitals = inc.notes ? String(inc.notes).slice(0, 300) : '';
      const cardiacFlag = inc.cardiac_arrest ? ' — CARDIAC ARREST' : '';

      let script = '';
      if (format === 'sbar') {
        script = `=== SBAR HANDOFF ===
DESTINATION: ${destination || '[hospital]'}
INCIDENT: ${incidentId}
PATIENT: ${ageStr} ${genderWord}${cardiacFlag}

S — SITUATION
${triageWord} triage. ${inc.complaint || 'No chief complaint recorded'}.
Location: ${inc.station || '?'}${inc.sub_location ? ' / ' + inc.sub_location : ''}.

B — BACKGROUND
Dispatched: ${new Date(inc.ts*1000).toISOString().replace('T',' ').slice(0,19)} UTC.
${onScene ? 'On-scene at ' + new Date(onScene.ts*1000).toISOString().replace('T',' ').slice(0,19) + ' UTC.' : 'En route to scene.'}
${ssVitals ? 'Notes: ' + ssVitals : 'No additional notes.'}

A — ASSESSMENT
${cardiacFlag ? 'Cardiac arrest, CPR in progress.' : 'See triage and complaint.'}
Unit: ${inc.unit_assigned || '[no unit assigned]'}.

R — RECOMMENDATION
Receiving ETA: [crew to advise].
Prepare ${triageWord === 'CRITICAL' ? 'resuscitation bay' : 'standard triage'}.
${cardiacFlag ? 'Activate cardiac arrest team.' : ''}

=== End handoff ===`;
      } else {
        // MIST
        script = `=== MIST HANDOFF ===
DESTINATION: ${destination || '[hospital]'}
INCIDENT: ${incidentId}

M — MECHANISM
${inc.complaint || 'See chief complaint'} at ${inc.station || '?'}${inc.sub_location ? ' (' + inc.sub_location + ')' : ''}.

I — INJURIES / ILLNESS
Triage: ${triageWord}${cardiacFlag}.
${ssVitals ? 'Findings: ' + ssVitals : 'See on-arrival assessment.'}

S — SIGNS / VITALS
${ssVitals.includes('BP') || ssVitals.includes('vital') ? 'See notes.' : '[Crew to provide latest vitals on arrival]'}

T — TREATMENT GIVEN
${onScene ? 'On-scene since ' + new Date(onScene.ts*1000).toISOString().slice(11,19) + ' UTC.' : 'En route.'}
Unit ${inc.unit_assigned || '[unassigned]'}.
${inc.cardiac_arrest ? 'CPR + ALS interventions in progress.' : 'See PCR for full intervention list.'}

ETA: [crew to advise]
Patient age/sex: ${ageStr} ${genderWord || ''}

=== End MIST ===`;
      }

      return {
        ok: true,
        format,
        incident_id: incidentId,
        destination,
        script,
        radio_call: `${inc.unit_assigned || 'Unit'} to ${destination || 'control'}, inbound with ${triageWord} ${ageStr}-year-old ${genderWord || 'patient'}${cardiacFlag ? ', cardiac arrest, CPR in progress' : ''}, request ${triageWord === 'CRITICAL' ? 'resus bay' : 'triage'}, ETA pending.`,
        generated_at: Math.floor(Date.now() / 1000)
      };
    } catch (e) {
      return { ok: false, error: 'handoff_failed', detail: e.message };
    }
  },

  // ==============================================================
  // system_health — system status (no auth needed for status, but uses session)
  // ==============================================================
  async system_health(user, env) {
    const now = Math.floor(Date.now() / 1000);
    const out = {
      ok: true,
      timestamp: now,
      timestamp_iso: new Date(now * 1000).toISOString(),
      version: '__VERSION__',
      branch: 'testing',
      checks: {}
    };
    // D1 ping
    const d1Start = Date.now();
    try {
      const r = await env.DB.prepare(`SELECT 1 AS ping`).first();
      out.checks.d1 = { ok: !!r, ms: Date.now() - d1Start };
    } catch (e) {
      out.checks.d1 = { ok: false, error: e.message, ms: Date.now() - d1Start };
    }
    // Counts
    try {
      const counts = await env.DB.batch([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM dispatch_log`),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM dispatch_log WHERE status NOT IN ('complete','closed','cancelled') AND COALESCE(is_drill,0)=0`),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log`),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM presence WHERE last_ts >= ?1`).bind(now - 300)
      ]);
      out.counts = {
        total_incidents: counts[0]?.results?.[0]?.n || 0,
        live_open: counts[1]?.results?.[0]?.n || 0,
        audit_events: counts[2]?.results?.[0]?.n || 0,
        users_online_5m: counts[3]?.results?.[0]?.n || 0
      };
    } catch (e) {
      out.counts_error = e.message;
    }
    return out;
  },

  // ==============================================================
  // heat_index — current weather + heat illness risk for Mecca/Mina/Arafat
  // Uses Open-Meteo (free, no API key) cached at 10 min TTL via sync_state
  // ==============================================================
  async heat_index(user, env) {
    const now = Math.floor(Date.now() / 1000);
    // 10 min cache via sync_state
    try {
      const cached = await env.DB.prepare(
        `SELECT value, updated_at FROM sync_state WHERE key = 'heat_index' LIMIT 1`
      ).first();
      if (cached && cached.value && (now - cached.updated_at) < 600) {
        const j = JSON.parse(cached.value);
        return { ok: true, cached: true, ...j };
      }
    } catch (_) {}

    // Mecca coords: 21.4225, 39.8262
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=21.4225&longitude=39.8262&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,uv_index&timezone=Asia/Riyadh';
    let result = { ok: true, generated_at: now };
    try {
      const r = await fetch(url, { cf: { cacheTtl: 600 } });
      if (!r.ok) throw new Error('weather_fetch_failed');
      const data = await r.json();
      const c = data.current || {};
      const T = c.temperature_2m;
      const RH = c.relative_humidity_2m;
      const Tapp = c.apparent_temperature;
      const wind = c.wind_speed_10m;
      const uv = c.uv_index;

      // Heat illness risk score (0-100)
      // Based on US National Weather Service heat index brackets adjusted for pilgrim activity
      let risk = 0;
      let riskLevel = 'low';
      let riskNote = '';
      const hi = Tapp != null ? Tapp : T;
      if (hi == null) {
        riskLevel = 'unknown';
      } else if (hi >= 54) { risk = 100; riskLevel = 'extreme'; riskNote = 'Heat stroke imminent'; }
      else if (hi >= 49) { risk = 90; riskLevel = 'very_high'; riskNote = 'Heat stroke likely with prolonged exposure'; }
      else if (hi >= 41) { risk = 70; riskLevel = 'high'; riskNote = 'Heat stroke possible — heat exhaustion likely'; }
      else if (hi >= 35) { risk = 50; riskLevel = 'elevated'; riskNote = 'Heat exhaustion likely with prolonged activity'; }
      else if (hi >= 30) { risk = 30; riskLevel = 'moderate'; riskNote = 'Caution with elderly / vulnerable pilgrims'; }
      else { risk = 10; riskLevel = 'low'; riskNote = 'Standard precautions'; }

      result = {
        ok: true,
        generated_at: now,
        location: 'Mecca / Mashaer',
        temp_c: T,
        feels_c: Tapp,
        humidity_pct: RH,
        wind_kmh: wind,
        uv_index: uv,
        heat_risk: { score: risk, level: riskLevel, note: riskNote },
        cached: false
      };
      // Cache
      try {
        await env.DB.prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES ('heat_index', ?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2`
        ).bind(JSON.stringify(result), now).run();
      } catch (_) {}
    } catch (e) {
      result = { ok: false, error: 'weather_unavailable', detail: e.message };
    }
    return result;
  },

  // ==============================================================
  // timeline — Gantt-style data for visualization
  // ==============================================================
  async timeline(user, env, params) {
    const now = Math.floor(Date.now() / 1000);
    const lookback_hours = Math.min(parseInt(params.lookback_hours || 6, 10), 48);
    const winStart = now - lookback_hours * 3600;
    const includeDrills = params.include_drills === '1' || params.include_drills === true;
    const stationFilter = params.station ? String(params.station).toUpperCase() : null;
    const triageFilter = params.triage ? String(params.triage).toLowerCase() : null;

    let where = `WHERE (ts >= ?1 OR (status NOT IN ('complete','closed','cancelled')))`;
    const binds = [winStart];
    if (!includeDrills) where += ` AND COALESCE(is_drill,0) = 0`;
    if (stationFilter) { where += ` AND station = ?` + (binds.length + 1); binds.push(stationFilter); }
    if (triageFilter) { where += ` AND triage = ?` + (binds.length + 1); binds.push(triageFilter); }

    try {
      const incR = await env.DB.prepare(
        `SELECT incident_id, ts, station, sub_location, triage, status, complaint,
                cardiac_arrest, unit_assigned, closed_at, COALESCE(is_drill,0) AS is_drill
         FROM dispatch_log ${where}
         ORDER BY ts DESC LIMIT 200`
      ).bind(...binds).all();
      const incidents = incR.results || [];
      const ids = incidents.map(i => i.incident_id);
      let eventsByInc = {};
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => '?' + (i + 1)).join(',');
        try {
          const evR = await env.DB.prepare(
            `SELECT incident_id, event_type, ts FROM incident_events
             WHERE incident_id IN (${placeholders}) ORDER BY ts ASC`
          ).bind(...ids).all();
          (evR.results || []).forEach(e => {
            if (!eventsByInc[e.incident_id]) eventsByInc[e.incident_id] = [];
            eventsByInc[e.incident_id].push({ type: e.event_type, ts: e.ts });
          });
        } catch (_) {}
      }
      const lanes = incidents.map(inc => {
        const events = eventsByInc[inc.incident_id] || [];
        const phases = [{ phase: 'dispatched', start: inc.ts }];
        ['en_route', 'on_scene', 'transporting'].forEach(p => {
          const ev = events.find(e => e.type === p);
          if (ev) phases.push({ phase: p, start: ev.ts });
        });
        const endTs = inc.closed_at || now;
        phases.forEach((p, i) => p.end = (i + 1 < phases.length) ? phases[i+1].start : endTs);
        return {
          incident_id: inc.incident_id, station: inc.station, sub_location: inc.sub_location,
          triage: inc.triage, status: inc.status, complaint: inc.complaint,
          cardiac_arrest: inc.cardiac_arrest, unit_assigned: inc.unit_assigned,
          is_drill: inc.is_drill, ts: inc.ts, closed_at: inc.closed_at,
          duration_sec: endTs - inc.ts, phases,
          is_open: !inc.closed_at && !['complete','closed','cancelled'].includes(inc.status)
        };
      });
      return { ok: true, generated_at: now, window: { start: winStart, end: now, lookback_hours }, count: lanes.length, lanes };
    } catch (e) { return { ok: false, error: 'timeline_failed', detail: e.message }; }
  },

  // ==============================================================
  // triage_suggest — rule-based triage suggestion
  // ==============================================================
  async triage_suggest(user, env, params) {
    const complaint = String(params.complaint || '').toLowerCase().trim();
    const cardiac = params.cardiac_arrest === true || params.cardiac_arrest === 'true' || params.cardiac_arrest === '1';
    const age = parseInt(params.age || 0, 10) || null;
    const consciousness = String(params.consciousness || '').toLowerCase();
    let suggested = 'green', confidence = 'low';
    const reasons = [];
    if (cardiac) { suggested = 'red'; confidence = 'high'; reasons.push('Cardiac arrest flag set'); }
    else if (consciousness.includes('unresponsive') || consciousness.includes('unconscious')) {
      suggested = 'red'; confidence = 'high'; reasons.push('Unresponsive');
    } else {
      const REDS = ['cardiac arrest','cpr','no pulse','unconscious','unresponsive','active seizure','seizing now','status epilepticus','severe bleeding','hemorrhage','arterial bleed','heat stroke','anaphylaxis','anaphylactic','stroke','cva','fast positive','major trauma','crush','stampede','airway compromise','cannot breathe','choking','shock','hypotension severe'];
      const YELLOWS = ['chest pain','shortness of breath','sob','dyspnea','head injury','fracture','broken','altered mental status','confusion','ams','heat exhaustion','moderate bleed','laceration','severe pain','abdominal pain severe','allergic reaction','gi bleed','diabetic emergency','hypoglycemia','hyperglycemia','pregnancy emergency','asthma attack'];
      const GREENS = ['minor cut','abrasion','sprain','mild dehydration','sunburn','lost','separated','welfare check','refusal of care','blister','mild headache','minor bruise'];
      const matches = (kws) => kws.some(kw => complaint.includes(kw));
      if (matches(REDS)) { suggested = 'red'; confidence = 'medium'; reasons.push('Red keyword match'); }
      else if (matches(YELLOWS)) { suggested = 'yellow'; confidence = 'medium'; reasons.push('Yellow keyword match'); }
      else if (matches(GREENS)) { suggested = 'green'; confidence = 'medium'; reasons.push('Green keyword match'); }
      else if (complaint.length > 0) { suggested = 'yellow'; confidence = 'low'; reasons.push('No clear keyword match — defaulting yellow for safety'); }
      else reasons.push('No complaint provided');
    }
    if (age && age >= 70 && suggested === 'green') { suggested = 'yellow'; reasons.push('Elderly (' + age + ') bump'); }
    if (age && age <= 5 && suggested === 'green') { suggested = 'yellow'; reasons.push('Pediatric (' + age + ') bump'); }
    return { ok: true, suggested, confidence, reasons, decision_path: 'rule-based · ' + reasons.length + ' factors' };
  },

  // ==============================================================
  // hospitals — receiving facility directory + ED bed status
  // ==============================================================
  async _ensureHospitalsTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS hospitals (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_ar TEXT,
      city TEXT, address TEXT, phone TEXT, radio_channel TEXT,
      capabilities TEXT, helipad INTEGER DEFAULT 0,
      ed_status TEXT DEFAULT 'normal', ed_capacity_pct INTEGER DEFAULT 0,
      ed_note TEXT, ed_status_ts INTEGER, ed_status_by TEXT,
      lat REAL, lng REAL, distance_km REAL,
      sort_order INTEGER DEFAULT 100,
      created_at INTEGER, updated_at INTEGER
    )`).run();
  },

  async hospital_seed(user, env) {
    await ACTIONS._ensureHospitalsTable(env);
    const now = Math.floor(Date.now() / 1000);
    const seeds = [
      ['HSP-001', 'King Fahd Hospital (Mecca)', 'مستشفى الملك فهد بمكة', 'Mecca', 'Aziziyah, Mecca', '+966125660000', 'CH-1', 'ER, Trauma, Cath Lab, ICU, Stroke', 1, 21.4267, 39.8492, 0, 1],
      ['HSP-002', 'King Abdullah Medical City', 'مدينة الملك عبدالله الطبية', 'Mecca', 'Al-Mashayer, Mecca', '+966125740000', 'CH-1', 'ER, Trauma, ICU, Stroke, Cardiac', 1, 21.3833, 39.8611, 0, 2],
      ['HSP-003', 'Mina Emergency Hospital', 'مستشفى منى للطوارئ', 'Mina', 'Mina, Saudi Arabia', '+966125330000', 'CH-2', 'ER, Heat illness, Trauma', 0, 21.4119, 39.8917, 0, 3],
      ['HSP-004', 'Arafat Field Hospital', 'مستشفى عرفات الميداني', 'Arafat', 'Arafat plain', '+966125440000', 'CH-3', 'ER, Heat illness, Resus', 0, 21.3548, 39.9831, 0, 4],
      ['HSP-005', 'Muzdalifah Field Hospital', 'مستشفى مزدلفة الميداني', 'Muzdalifah', 'Muzdalifah', '+966125550000', 'CH-4', 'ER, Heat illness', 0, 21.4022, 39.9333, 0, 5],
      ['HSP-006', 'King Faisal Hospital (Mecca)', 'مستشفى الملك فيصل', 'Mecca', 'Sharaie, Mecca', '+966125770000', 'CH-1', 'ER, ICU', 0, 21.4500, 39.8200, 0, 6],
      ['HSP-007', 'Hera General Hospital', 'مستشفى حراء العام', 'Mecca', 'Al-Aziziyah, Mecca', '+966125540000', 'CH-1', 'ER, General', 0, 21.4350, 39.8400, 0, 7]
    ];
    let n = 0;
    for (const s of seeds) {
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO hospitals
           (id, name, name_ar, city, address, phone, radio_channel, capabilities, helipad, lat, lng, distance_km, sort_order, ed_status, ed_capacity_pct, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'normal', 0, ?14, ?14)`
        ).bind(...s, now).run();
        n++;
      } catch (e) {}
    }
    return { ok: true, seeded_or_existing: n };
  },

  async hospitals_list(user, env, params) {
    try {
      await ACTIONS._ensureHospitalsTable(env);
      const r = await env.DB.prepare(
        `SELECT * FROM hospitals ORDER BY sort_order ASC, name ASC`
      ).all();
      return { ok: true, hospitals: r.results || [], count: (r.results || []).length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async hospital_set_status(user, env, params) {
    const id = String(params.id || '');
    const status = String(params.status || 'normal').toLowerCase();
    const cap = parseInt(params.ed_capacity_pct || 0, 10);
    const note = String(params.note || '').slice(0, 300);
    if (!['normal','busy','divert','closed'].includes(status)) return { ok: false, error: 'invalid_status' };
    if (!id) return { ok: false, error: 'missing_id' };
    const now = Math.floor(Date.now() / 1000);
    try {
      await ACTIONS._ensureHospitalsTable(env);
      await env.DB.prepare(
        `UPDATE hospitals SET ed_status = ?1, ed_capacity_pct = ?2, ed_note = ?3,
                              ed_status_ts = ?4, ed_status_by = ?5, updated_at = ?4 WHERE id = ?6`
      ).bind(status, cap, note, now, user.name || user.nid, id).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'hospital_set_status', 'hospital', ?2, ?3)`
      ).bind(user.nid, id, JSON.stringify({ status, cap, note })).run();
      return { ok: true, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // unit_checkin — paramedic check-in (location, status)
  // units_status_grid — quick view for dispatcher
  // ==============================================================
  async unit_checkin(user, env, params) {
    const unit_code = String(params.unit_code || '').toUpperCase();
    const station = String(params.station || '').toUpperCase();
    const status = String(params.status || 'available').toLowerCase();
    const note = String(params.note || '').slice(0, 200);
    if (!unit_code) return { ok: false, error: 'missing_unit_code' };
    if (!['available','busy','dispatched','oos','maintenance','break'].includes(status))
      return { ok: false, error: 'invalid_status' };
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `INSERT INTO unit_status_log (unit_code, status, station, ts, set_by_nid, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(unit_code, status, station, now, user.nid, note).run();
      return { ok: true, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async units_status_grid(user, env, params, dj) {
    try {
      const r = await env.DB.prepare(
        `SELECT unit_code, status, station, ts, note, set_by_nid FROM (
           SELECT unit_code, status, station, ts, note, set_by_nid,
                  ROW_NUMBER() OVER (PARTITION BY unit_code ORDER BY ts DESC) AS rn
           FROM unit_status_log
         ) WHERE rn = 1`
      ).all();
      const stat = {};
      (r.results || []).forEach(x => stat[x.unit_code] = x);
      const units = (dj && dj.units_detail) || [];
      const now = Math.floor(Date.now() / 1000);
      const enriched = units.map(u => {
        const s = stat[u.id] || {};
        return {
          unit_code: u.id,
          type: u.type,
          home_station: u.home,
          status: s.status || 'available',
          current_station: s.station || u.home,
          last_check_ts: s.ts || null,
          last_check_by: s.set_by_nid || null,
          last_note: s.note || null,
          minutes_since_check: s.ts ? Math.floor((now - s.ts) / 60) : null,
          stale: s.ts ? (now - s.ts) > 1800 : true   // > 30 min = stale
        };
      });
      // Tally
      const tally = { available: 0, busy: 0, dispatched: 0, oos: 0, maintenance: 0, break: 0, total: enriched.length, stale: 0 };
      enriched.forEach(u => {
        if (tally[u.status] !== undefined) tally[u.status]++;
        if (u.stale) tally.stale++;
      });
      return { ok: true, generated_at: now, units: enriched, tally };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // messages — internal direct messaging + threads
  // ==============================================================
  async _ensureMessagesTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      from_nid TEXT NOT NULL,
      from_name TEXT,
      to_nid TEXT,
      to_name TEXT,
      body TEXT,
      channel TEXT DEFAULT 'dm',
      ts INTEGER NOT NULL,
      read_at INTEGER
    )`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_key, ts)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_nid, read_at)`).run();
  },

  async messages_send(user, env, params) {
    const to_nid = String(params.to_nid || '').trim();
    const body = String(params.body || '').slice(0, 2000);
    const channel = String(params.channel || 'dm').slice(0, 30);
    if (!body) return { ok: false, error: 'missing_body' };
    if (channel === 'dm' && !to_nid) return { ok: false, error: 'missing_to_nid' };
    const now = Math.floor(Date.now() / 1000);
    const id = 'MSG-' + now + '-' + Math.floor(Math.random() * 9999);
    // Resolve recipient name
    let to_name = '';
    try {
      const w = await env.DB.prepare(`SELECT name FROM allowlist WHERE nid = ?1 LIMIT 1`).bind(to_nid).first();
      if (w) to_name = w.name;
    } catch (_) {}
    // Thread key (deterministic for DMs, channel name for channels)
    let thread_key;
    if (channel === 'dm') {
      const a = [user.nid, to_nid].sort();
      thread_key = 'dm:' + a[0] + ':' + a[1];
    } else {
      thread_key = 'ch:' + channel;
    }
    try {
      await ACTIONS._ensureMessagesTable(env);
      await env.DB.prepare(
        `INSERT INTO messages (id, thread_key, from_nid, from_name, to_nid, to_name, body, channel, ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(id, thread_key, user.nid, user.name, to_nid, to_name, body, channel, now).run();
      return { ok: true, id, thread_key, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async messages_list(user, env, params) {
    const thread_key = String(params.thread_key || '');
    const since = parseInt(params.since || 0, 10);
    if (!thread_key) return { ok: false, error: 'missing_thread_key' };
    try {
      await ACTIONS._ensureMessagesTable(env);
      const r = await env.DB.prepare(
        `SELECT id, thread_key, from_nid, from_name, to_nid, to_name, body, channel, ts, read_at
         FROM messages WHERE thread_key = ?1 AND ts >= ?2 ORDER BY ts ASC LIMIT 200`
      ).bind(thread_key, since).all();
      // Mark messages addressed to current user as read
      try {
        await env.DB.prepare(
          `UPDATE messages SET read_at = ?1
           WHERE thread_key = ?2 AND to_nid = ?3 AND read_at IS NULL`
        ).bind(Math.floor(Date.now()/1000), thread_key, user.nid).run();
      } catch (_) {}
      return { ok: true, messages: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async messages_threads(user, env, params) {
    try {
      await ACTIONS._ensureMessagesTable(env);
      // Get last message per thread the user is part of
      const r = await env.DB.prepare(
        `SELECT m.thread_key, m.body, m.from_name, m.from_nid, m.to_name, m.to_nid, m.ts,
                (SELECT COUNT(*) FROM messages m2 WHERE m2.thread_key = m.thread_key AND m2.to_nid = ?1 AND m2.read_at IS NULL) AS unread
         FROM messages m
         INNER JOIN (
           SELECT thread_key, MAX(ts) AS maxts FROM messages
           WHERE from_nid = ?1 OR to_nid = ?1 OR thread_key LIKE 'ch:%'
           GROUP BY thread_key
         ) latest ON m.thread_key = latest.thread_key AND m.ts = latest.maxts
         ORDER BY m.ts DESC LIMIT 50`
      ).bind(user.nid).all();
      return { ok: true, threads: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // incidents_search — full incident library search
  // ==============================================================
  async incidents_search(user, env, params) {
    const q = String(params.q || '').trim();
    const station = String(params.station || '').toUpperCase();
    const triage = String(params.triage || '').toLowerCase();
    const status_filter = String(params.status || '').toLowerCase();
    const include_drills = params.include_drills === '1' || params.include_drills === true;
    const from_ts = params.from_ts ? parseInt(params.from_ts, 10) : null;
    const to_ts = params.to_ts ? parseInt(params.to_ts, 10) : null;
    const limit = Math.min(parseInt(params.limit || 100, 10), 500);

    const where = [];
    const binds = [];
    if (q) {
      where.push(`(incident_id LIKE ?${binds.length + 1} OR complaint LIKE ?${binds.length + 1} OR sub_location LIKE ?${binds.length + 1} OR srca_case_number LIKE ?${binds.length + 1})`);
      binds.push('%' + q + '%');
    }
    if (station) { where.push(`station = ?${binds.length + 1}`); binds.push(station); }
    // Optional explicit cluster filter — pass ?cluster=Arafat|Muzdalifah|Mina to scope
    // to a zone's 3 stations. Any role can use this (cluster sups, dispatchers, leadership).
    // Default behavior: NO auto-filtering — every user sees all zones unless they pick one.
    const _clusterParam = String(params.cluster || '').toLowerCase();
    if (_clusterParam && CLUSTER_STATIONS[_clusterParam]) {
      const _cs = CLUSTER_STATIONS[_clusterParam];
      if (station && !_cs.includes(station)) {
        // Station + cluster contradicting each other → empty
        return { ok: true, count: 0, results: [], _cluster: _clusterParam, _denied_station: station };
      }
      if (!station) {
        const ph = _cs.map((_, i) => `?${binds.length + 1 + i}`).join(',');
        where.push(`station IN (${ph})`);
        _cs.forEach(st => binds.push(st));
      }
    }
    if (triage) { where.push(`triage = ?${binds.length + 1}`); binds.push(triage); }
    if (status_filter === 'open') where.push(`status NOT IN ('complete','closed','cancelled')`);
    else if (status_filter === 'closed') where.push(`status IN ('complete','closed')`);
    else if (status_filter === 'cancelled') where.push(`status = 'cancelled'`);
    if (!include_drills) where.push(`COALESCE(is_drill,0) = 0`);
    if (from_ts != null) { where.push(`ts >= ?${binds.length + 1}`); binds.push(from_ts); }
    if (to_ts != null) { where.push(`ts <= ?${binds.length + 1}`); binds.push(to_ts); }
    const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    try {
      const r = await env.DB.prepare(
        `SELECT incident_id, ts, station, sub_location, triage, status, complaint,
                cardiac_arrest, unit_assigned, closed_at, COALESCE(is_drill,0) AS is_drill,
                age, gender, patient_count, srca_case_number
         FROM dispatch_log ${wsql}
         ORDER BY ts DESC LIMIT ${limit}`
      ).bind(...binds).all();
      return { ok: true, count: (r.results || []).length, results: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // pcr — Patient Care Report drafting
  // ==============================================================
  async _ensurePcrTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pcr_drafts (
      id TEXT PRIMARY KEY,
      incident_id TEXT,
      author_nid TEXT NOT NULL,
      author_name TEXT,
      patient_age INTEGER, patient_gender TEXT, patient_nationality TEXT,
      chief_complaint TEXT, history TEXT, allergies TEXT, medications TEXT,
      vitals_initial TEXT, vitals_final TEXT,
      gcs_e INTEGER, gcs_v INTEGER, gcs_m INTEGER,
      assessment TEXT, interventions TEXT, response_to_treatment TEXT,
      disposition TEXT, transport_to TEXT, transport_unit TEXT,
      handoff_to TEXT, on_scene_ts INTEGER, departed_ts INTEGER, arrived_ts INTEGER,
      status TEXT DEFAULT 'draft',
      created_at INTEGER, updated_at INTEGER
    )`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pcr_author ON pcr_drafts(author_nid, updated_at DESC)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pcr_incident ON pcr_drafts(incident_id)`).run();
  },

  async pcr_draft(user, env, params) {
    const incident_id = String(params.incident_id || '').trim();
    if (!incident_id) return { ok: false, error: 'missing_incident_id' };
    try {
      await ACTIONS._ensurePcrTable(env);
      // Look for existing PCR for this incident by this author
      const ex = await env.DB.prepare(
        `SELECT * FROM pcr_drafts WHERE incident_id = ?1 AND author_nid = ?2 LIMIT 1`
      ).bind(incident_id, user.nid).first();
      if (ex) return { ok: true, pcr: ex, prefilled: false };
      // Auto-fill from incident
      const inc = await env.DB.prepare(
        `SELECT * FROM dispatch_log WHERE incident_id = ?1 LIMIT 1`
      ).bind(incident_id).first();
      if (!inc) return { ok: false, error: 'incident_not_found' };
      // Get on_scene event ts
      let onSceneTs = null;
      try {
        const ev = await env.DB.prepare(
          `SELECT ts FROM incident_events WHERE incident_id = ?1 AND event_type = 'on_scene' ORDER BY ts ASC LIMIT 1`
        ).bind(incident_id).first();
        if (ev) onSceneTs = ev.ts;
      } catch (_) {}
      const now = Math.floor(Date.now() / 1000);
      const id = 'PCR-' + now + '-' + Math.floor(Math.random() * 9999);
      const draft = {
        id, incident_id, author_nid: user.nid, author_name: user.name,
        patient_age: inc.age || null, patient_gender: inc.gender || null,
        chief_complaint: inc.complaint || '', transport_unit: inc.unit_assigned || '',
        on_scene_ts: onSceneTs, transport_to: inc.transport_to || null,
        status: 'draft', created_at: now, updated_at: now
      };
      await env.DB.prepare(
        `INSERT INTO pcr_drafts (id, incident_id, author_nid, author_name, patient_age, patient_gender,
                                  chief_complaint, transport_unit, on_scene_ts, transport_to,
                                  status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`
      ).bind(id, incident_id, user.nid, user.name, draft.patient_age, draft.patient_gender,
             draft.chief_complaint, draft.transport_unit, draft.on_scene_ts, draft.transport_to,
             'draft', now).run();
      return { ok: true, pcr: draft, prefilled: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async pcr_save(user, env, params) {
    const id = String(params.id || '');
    if (!id) return { ok: false, error: 'missing_id' };
    const allowed = ['patient_age','patient_gender','patient_nationality','chief_complaint','history','allergies','medications','vitals_initial','vitals_final','gcs_e','gcs_v','gcs_m','assessment','interventions','response_to_treatment','disposition','transport_to','transport_unit','handoff_to','on_scene_ts','departed_ts','arrived_ts','status','arrest_start_ts','first_shock_ts','cpr_cycles','rosc_status','rosc_ts','glucose_initial','glucose_final','medications_administered','transfer_clinic_meds'];
    const updates = [];
    const binds = [];
    let i = 1;
    allowed.forEach(k => {
      if (k in params) { updates.push(k + ' = ?' + i++); binds.push(params[k]); }
    });
    if (!updates.length) return { ok: false, error: 'no_fields_to_update' };
    const now = Math.floor(Date.now() / 1000);
    updates.push('updated_at = ?' + i++);
    binds.push(now);
    binds.push(id, user.nid);
    try {
      await ACTIONS._ensurePcrTable(env);
      await env.DB.prepare(
        `UPDATE pcr_drafts SET ${updates.join(', ')}
         WHERE id = ?${i++} AND author_nid = ?${i}`
      ).bind(...binds).run();
      return { ok: true, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async pcr_list_mine(user, env, params) {
    try {
      await ACTIONS._ensurePcrTable(env);
      const r = await env.DB.prepare(
        `SELECT * FROM pcr_drafts WHERE author_nid = ?1 ORDER BY updated_at DESC LIMIT 100`
      ).bind(user.nid).all();
      return { ok: true, drafts: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async pcr_list_all(user, env, params) {
    try {
      await ACTIONS._ensurePcrTable(env);
      const r = await env.DB.prepare(
        `SELECT * FROM pcr_drafts ORDER BY updated_at DESC LIMIT 200`
      ).all();
      return { ok: true, drafts: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // checklist — operational checklists (shift open/close, MCI activation, etc.)
  // ==============================================================
  async _ensureChecklistTables(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS checklist_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      template_name TEXT,
      runner_nid TEXT NOT NULL,
      runner_name TEXT,
      station TEXT,
      progress TEXT,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();
  },

  async checklist_list(user, env, params) {
    // Templates are baked in for now (later: table-backed)
    const TEMPLATES = [
      { id: 'shift_open', name: 'Shift Open Checklist', items: [
        'Sign-in to CAD', 'Review handoff document from prior shift', 'Confirm unit assignments',
        'Test radio comms (CH-1, CH-2, CH-3)', 'Inspect ALS bag (drugs/dates)', 'Check defib battery + pads',
        'Verify oxygen tank levels', 'Confirm hospital divert status', 'Brief team on shift priorities'
      ]},
      { id: 'shift_close', name: 'Shift Close Checklist', items: [
        'Complete all open PCRs', 'Restock used supplies', 'Document any equipment issues',
        'Submit incident reports for closure', 'Generate handoff document', 'Brief incoming shift lead',
        'Sign off CAD'
      ]},
      { id: 'mci_activation', name: 'MCI Activation', items: [
        'Confirm MCI threshold met (≥5 simultaneous serious casualties)', 'Notify OCC immediately',
        'Declare MCI in CAD (Command Center → MCI)', 'Establish casualty collection point upstream',
        'Assign Triage / Treatment / Transport officers', 'Begin START triage', 'Place red/yellow/green/black tags',
        'Notify nearest hospitals (divert assessment)', 'Request additional units', 'Set up command post',
        'Document all actions for after-action review'
      ]},
      { id: 'cardiac_arrest', name: 'Cardiac Arrest On-Scene', items: [
        'Confirm pulse absent (5-10 sec)', 'Begin compressions 100-120/min, depth 5-6cm',
        'Attach defibrillator/AED', 'Analyze rhythm, shock if indicated', 'IV/IO access',
        'Adrenaline 1mg q3-5min IV/IO', 'Consider amiodarone 300mg after 3rd shock',
        'Treat reversible causes (4H 4T)', 'Mechanical CPR for transport if available',
        'Receiving hospital pre-alert', 'Document all interventions'
      ]},
      { id: 'heat_stroke', name: 'Heat Stroke', items: [
        'Confirm T > 40°C + altered mental status', 'Move to cool area, remove excess clothing',
        'Aggressive cooling: ice packs (groin/axillae/neck)', 'Cool mist + fan',
        'IV access — NS 500mL bolus', 'Monitor core temperature',
        'Avoid antipyretics (ineffective)', 'Watch for seizures, rhabdomyolysis',
        'Rapid transport — high mortality', 'Pre-alert receiving hospital'
      ]},
      { id: 'unit_morning', name: 'Unit Morning Inspection', items: [
        'Vehicle fuel + fluids', 'Lights, sirens, warning devices', 'Radios + spare batteries',
        'Cardiac monitor + defib pads', 'O2 tank levels (main + portable)', 'ALS bag drug expiries',
        'Suction + airway adjuncts', 'IV start kit + fluids', 'Splints + immobilization',
        'PPE + gloves stock', 'Stretcher operation', 'Patient compartment cleanliness'
      ]}
    ];
    return { ok: true, templates: TEMPLATES };
  },

  async checklist_run(user, env, params) {
    const template_id = String(params.template_id || '');
    const action = String(params.action || 'start');  // start | progress | complete | get
    const id = String(params.id || '');
    const now = Math.floor(Date.now() / 1000);
    try {
      await ACTIONS._ensureChecklistTables(env);
      if (action === 'start') {
        if (!template_id) return { ok: false, error: 'missing_template_id' };
        const newId = 'CL-' + now + '-' + Math.floor(Math.random() * 9999);
        await env.DB.prepare(
          `INSERT INTO checklist_runs (id, template_id, template_name, runner_nid, runner_name, station, progress, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, ?7)`
        ).bind(newId, template_id, params.template_name || '', user.nid, user.name, params.station || '', now).run();
        return { ok: true, id: newId, action: 'started' };
      }
      if (action === 'progress' && id) {
        await env.DB.prepare(
          `UPDATE checklist_runs SET progress = ?1, updated_at = ?2 WHERE id = ?3 AND runner_nid = ?4`
        ).bind(JSON.stringify(params.progress || {}), now, id, user.nid).run();
        return { ok: true, ts: now };
      }
      if (action === 'complete' && id) {
        await env.DB.prepare(
          `UPDATE checklist_runs SET completed_at = ?1, updated_at = ?1
           WHERE id = ?2 AND runner_nid = ?3`
        ).bind(now, id, user.nid).run();
        return { ok: true, completed_at: now };
      }
      if (action === 'get') {
        const r = await env.DB.prepare(
          `SELECT * FROM checklist_runs WHERE runner_nid = ?1 ORDER BY updated_at DESC LIMIT 30`
        ).bind(user.nid).all();
        return { ok: true, runs: r.results || [] };
      }
      return { ok: false, error: 'invalid_action' };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Convenience aliases (alt names for clarity in some pages)
  async checklist_save(user, env, params) { return ACTIONS.checklist_run(user, env, { ...params, action: 'progress' }); },

  // ==============================================================
  // announcement_templates — pre-canned broadcast messages
  // ==============================================================
  async announcement_templates(user, env) {
    return { ok: true, templates: [
      { id: 'shift_change', label: 'Shift change reminder', text: 'Reminder: Shift change in 30 minutes. Complete open PCRs and prepare handoff document.', level: 'info' },
      { id: 'heat_warning', label: 'Heat warning', text: 'Heat advisory: Temperatures are reaching dangerous levels. Increase patient hydration assessments. Treat heat exhaustion aggressively.', level: 'warn' },
      { id: 'movement_active', label: 'Movement active', text: 'Movement is now active. Surge readiness expected. Pre-position units per movement plan.', level: 'info' },
      { id: 'low_supplies', label: 'Supplies running low', text: 'Notice: ALS bags require restock. Submit needs through your cluster supervisor.', level: 'info' },
      { id: 'mci_drill', label: 'MCI drill', text: 'A scheduled MCI exercise will be conducted today. All real incidents continue to be handled normally. Drill incidents will be flagged in the system.', level: 'info' },
      { id: 'comms_check', label: 'Comms check', text: 'Radio check on all channels (CH-1/2/3). Respond on channel.', level: 'info' },
      { id: 'security_alert', label: 'Security advisory', text: 'Security advisory issued. Maintain situational awareness. Coordinate with on-site security before approach.', level: 'warn' },
      { id: 'critical_only', label: 'CRITICAL — system issue', text: 'CRITICAL: Operational issue detected. Switch to backup procedures. OCC will issue updates.', level: 'critical' }
    ]};
  },

  // ==============================================================
  // station_directory — full station info for any UI
  // ==============================================================
  async station_directory(user, env) {
    const stations = [
      { code: 'ARF1', name: 'Arafat 1', name_ar: 'عرفات ١', cluster: 'Arafat', radio: 'CH-3', sequence: 1, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-004' },
      { code: 'ARF2', name: 'Arafat 2', name_ar: 'عرفات ٢', cluster: 'Arafat', radio: 'CH-3', sequence: 2, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-004' },
      { code: 'ARF3', name: 'Arafat 3', name_ar: 'عرفات ٣', cluster: 'Arafat', radio: 'CH-3', sequence: 3, has_clinic: true, has_helipad: true, hospital_nearest: 'HSP-004' },
      { code: 'MUZ1', name: 'Muzdalifah 1', name_ar: 'مزدلفة ١', cluster: 'Muzdalifah', radio: 'CH-4', sequence: 4, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-005' },
      { code: 'MUZ2', name: 'Muzdalifah 2', name_ar: 'مزدلفة ٢', cluster: 'Muzdalifah', radio: 'CH-4', sequence: 5, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-005' },
      { code: 'MUZ3', name: 'Muzdalifah 3', name_ar: 'مزدلفة ٣', cluster: 'Muzdalifah', radio: 'CH-4', sequence: 6, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-005' },
      { code: 'MIN1', name: 'Mina 1', name_ar: 'منى ١', cluster: 'Mina', radio: 'CH-2', sequence: 7, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-003' },
      { code: 'MIN2', name: 'Mina 2', name_ar: 'منى ٢', cluster: 'Mina', radio: 'CH-2', sequence: 8, has_clinic: true, has_helipad: false, hospital_nearest: 'HSP-003' },
      { code: 'MIN3', name: 'Mina 3', name_ar: 'منى ٣', cluster: 'Mina', radio: 'CH-2', sequence: 9, has_clinic: true, has_helipad: true, hospital_nearest: 'HSP-003' }
    ];
    return { ok: true, stations };
  },

  // ==============================================================
  // escalation_matrix — reads from data.json 'escalation' if present
  // (so Ahmed can edit phones in the Google Sheet), falls back to
  // hardcoded list. Add an 'Escalation' tab to Mobilization_Plan
  // with columns: tier, role, when, name, phone, contact.
  // ==============================================================
  async _ensureEscalationTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS escalation_overrides (
      tier INTEGER PRIMARY KEY,
      role TEXT,
      when_text TEXT,
      name TEXT,
      phone TEXT,
      contact TEXT,
      updated_by_nid TEXT,
      updated_by_name TEXT,
      updated_at INTEGER
    )`).run();
  },

  async escalation_matrix(user, env, params, dj) {
    // Hybrid pattern: D1 overrides > Google Sheet > hardcoded fallback.
    await ACTIONS._ensureEscalationTable(env);
    let d1List = [];
    try {
      const r = await env.DB.prepare(`SELECT * FROM escalation_overrides ORDER BY tier ASC`).all();
      d1List = (r.results || []).map(row => ({
        tier: row.tier,
        role: row.role || '',
        when: row.when_text || '',
        name: row.name || '',
        phone: row.phone || '',
        contact: row.contact || ((row.name || '') + (row.phone ? ' · ' + row.phone : ''))
      }));
    } catch (_) {}

    // Build sheet-driven list (from data.json.escalation if present)
    const sheetList = (dj && dj.escalation && Array.isArray(dj.escalation) && dj.escalation.length)
      ? dj.escalation.map(r => ({
          tier: parseInt(r.tier || r.Tier || 0, 10) || 0,
          role: String(r.role || r.Role || ''),
          when: String(r.when || r.When || r.scenario || ''),
          name: String(r.name || r.Name || ''),
          phone: String(r.phone || r.Phone || r.Number || ''),
          contact: String(r.contact || r.Contact ||
            (r.name + (r.phone ? ' · ' + r.phone : ''))).trim()
        })).sort((a,b) => a.tier - b.tier)
      : [];

    // Merge D1 overrides over sheet (tier-keyed)
    if (d1List.length || sheetList.length) {
      const byTier = {};
      sheetList.forEach(r => { byTier[r.tier] = r; });
      // D1 overrides take precedence
      d1List.forEach(r => { byTier[r.tier] = r; });
      const merged = Object.values(byTier).sort((a,b) => a.tier - b.tier);
      const source = d1List.length && sheetList.length ? 'd1_overrides_sheet'
                   : d1List.length ? 'd1_only'
                   : 'google_sheet';
      return { ok: true, levels: merged, source };
    }
    // Fallback: hardcoded list (legacy). Edit /escalation tab or admin UI to override.
    return { ok: true, source: 'hardcoded_fallback', levels: [
      { tier: 1, role: 'Cluster Supervisor', when: 'First-line clinical/operational issue',
        name: 'Cluster supervisors (Arafat / Muzdalifah / Mina)', phone: 'Radio CH-2/3/4',
        contact: 'Radio CH-2/3/4 by cluster' },
      { tier: 2, role: 'Chief Paramedic (CHF)', when: 'Multi-cluster issue, MCI ramp-up, supply crisis',
        name: 'Abdulrahman Bukhari', phone: '+966 50 000 0000',
        contact: 'Bukhari · +966 50 000 0000 · radio + phone' },
      { tier: 3, role: 'Deputy Chief Paramedic (DCH)', when: 'Backup CHF, secondary command',
        name: 'Hayil Aljabri', phone: '+966 50 000 0000',
        contact: 'Hayil Aljabri · +966 50 000 0000 · radio + phone' },
      { tier: 4, role: 'Medical Director Lead (MDL)', when: 'Clinical governance, drug protocol issues',
        name: 'Dr. Khalid Aljuaidy', phone: '+966 50 000 0000',
        contact: 'Dr. Khalid Aljuaidy · +966 50 000 0000' },
      { tier: 5, role: 'Deputy Project Manager (DPM)', when: 'Operational direction, resource conflicts',
        name: 'Dr. Nawaf Alsaadon', phone: '+966 50 000 0000',
        contact: 'Dr. Nawaf Alsaadon · +966 50 000 0000' },
      { tier: 6, role: 'Project Manager (PM)', when: 'Strategic decisions, external coordination',
        name: 'Ahmed Alshudukhi', phone: '+966 50 000 0000',
        contact: 'Ahmed Alshudukhi · +966 50 000 0000 · phone + WhatsApp' },
      { tier: 7, role: 'External — MoH / SRCA', when: 'Beyond HMG scope, mass casualty, regional surge',
        name: 'MoH EOC / SRCA Dispatch', phone: '997 / 911',
        contact: 'MoH EOC (997) · SRCA Dispatch (911) · Liaison via OCC' },
      { tier: 8, role: 'HMG Senior Medical Director', when: 'Highest internal escalation',
        name: 'HMG Senior Medical Director', phone: 'Through PM',
        contact: 'Through PM' }
    ]};
  },
  // ==============================================================
  // my_schedule — personal shift schedule (for me.html and schedule.html)
  // ==============================================================
  async my_schedule(user, env, params, dj) {
    const nid = String(params.nid || (user && user.nid) || '').trim();
    if (!nid) return { ok: false, error: 'missing_nid' };
    const detail = (dj && dj.units_detail) || [];
    const hourly = (dj && dj.hourly_grid) || [];
    // Find the unit(s) this person belongs to
    const myUnits = detail.filter(u => (u.members || []).some(m => String(m.staff_id || m.nid || '') === nid));
    if (!myUnits.length) return { ok: true, nid, unit: null, member: null, shifts: [], person: null };
    const u = myUnits[0];
    const member = (u.members || []).find(m => String(m.staff_id || m.nid || '') === nid);
    const shifts = [];
    // For each DH day, check if u is on duty (default_shift dictates) — return a row per day
    const DH_DAYS = [4,5,6,7,8,9,10,11,12,13,14];
    DH_DAYS.forEach(dh => {
      shifts.push({
        dh,
        unit_id: u.id,
        shift_code: u.default_shift || '',
        station: u.home || '',
        label: u.default_shift ? `DH ${dh} · ${u.default_shift}` : `DH ${dh}`,
        type: u.type || '',
        size: u.size || 0
      });
    });
    return {
      ok: true, nid,
      person: { name: member ? member.name : '', call_sign: member ? member.call_sign : '', role: member ? member.role : '', phone: member ? member.phone : '' },
      unit: { id: u.id, type: u.type, home: u.home, category: u.category, size: u.size, default_shift: u.default_shift, member_count: (u.members || []).length },
      shifts
    };
  },

  // ==============================================================
  // planned_reposition — schedule a unit move at a future time
  // Backed by D1 table planned_repositions (auto-created)
  // ==============================================================
  async _ensurePlannedRepositionTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS planned_repositions (
      id TEXT PRIMARY KEY,
      unit_code TEXT NOT NULL,
      from_station TEXT,
      to_station TEXT NOT NULL,
      planned_at INTEGER NOT NULL,
      planned_dh INTEGER,
      planned_hour TEXT,
      planned_end_at INTEGER,
      planned_end_dh INTEGER,
      planned_end_hour TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by_nid TEXT,
      created_by_name TEXT,
      created_at INTEGER NOT NULL,
      executed_at INTEGER,
      cancelled_at INTEGER,
      cancelled_by_nid TEXT,
      reversed_at INTEGER,
      reversed_by_nid TEXT,
      notes TEXT
    )`).run();
    // Idempotent column-adds for existing tables that pre-date end-window
    try { await env.DB.prepare(`ALTER TABLE planned_repositions ADD COLUMN planned_end_at INTEGER`).run(); } catch(_) {}
    try { await env.DB.prepare(`ALTER TABLE planned_repositions ADD COLUMN planned_end_dh INTEGER`).run(); } catch(_) {}
    try { await env.DB.prepare(`ALTER TABLE planned_repositions ADD COLUMN planned_end_hour TEXT`).run(); } catch(_) {}
    try { await env.DB.prepare(`ALTER TABLE planned_repositions ADD COLUMN reversed_at INTEGER`).run(); } catch(_) {}
    try { await env.DB.prepare(`ALTER TABLE planned_repositions ADD COLUMN reversed_by_nid TEXT`).run(); } catch(_) {}
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_planned_repos_status ON planned_repositions(status, planned_at)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_planned_repos_unit ON planned_repositions(unit_code, planned_at)`).run();
  },

  async reposition_planned_create(user, env, params) {
    await ACTIONS._ensurePlannedRepositionTable(env);
    const unit_code = String(params.unit_code || '').toUpperCase();
    const to_station = String(params.to_station || '').toUpperCase();
    const planned_dh = parseInt(params.planned_dh, 10) || null;
    const planned_hour = String(params.planned_hour || '00:00').trim();
    const planned_end_dh = parseInt(params.planned_end_dh, 10) || null;
    const planned_end_hour = String(params.planned_end_hour || '').trim();
    const reason = String(params.reason || '').slice(0, 500);
    if (!unit_code || !to_station) return { ok: false, error: 'missing_unit_or_station' };

    // Convert DH + hour to a unix ts.
    // DH 1 anchors to 27 May 2026 (KSA) per existing convention.
    function dhToTs(dh, hour) {
      if (!dh) return 0;
      const base = new Date('2026-05-27T00:00:00+03:00').getTime() / 1000;
      const h = (hour.match(/^(\d{1,2})(:(\d{2}))?$/) || []);
      const hh = parseInt(h[1] || 0, 10);
      const mm = parseInt(h[3] || 0, 10);
      return Math.floor(base + (dh - 1) * 86400 + hh * 3600 + mm * 60);
    }
    const planned_at = planned_dh ? dhToTs(planned_dh, planned_hour) : Math.floor(Date.now() / 1000);
    const planned_end_at = planned_end_dh ? dhToTs(planned_end_dh, planned_end_hour || '23:59') : null;

    // Validate: end must be after start
    if (planned_end_at && planned_end_at <= planned_at) {
      return { ok: false, error: 'end_before_start', detail: 'End time must be after start time' };
    }

    const id = 'PRP-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `INSERT INTO planned_repositions
         (id, unit_code, from_station, to_station, planned_at, planned_dh, planned_hour, planned_end_at, planned_end_dh, planned_end_hour, reason, status, created_by_nid, created_by_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, unit_code, params.from_station || null, to_station, planned_at, planned_dh, planned_hour, planned_end_at, planned_end_dh, planned_end_hour || null, reason, 'pending', user.nid, user.name || '', now).run();
      return { ok: true, id, unit_code, to_station, planned_at, planned_dh, planned_hour, planned_end_at, planned_end_dh, planned_end_hour };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },

  async reposition_planned_list(user, env, params) {
    await ACTIONS._ensurePlannedRepositionTable(env);
    const includeDone = params.include_done === '1' || params.include_done === 'true';
    try {
      const sql = includeDone
        ? `SELECT * FROM planned_repositions ORDER BY planned_at ASC LIMIT 500`
        : `SELECT * FROM planned_repositions WHERE status IN ('pending','approved') ORDER BY planned_at ASC LIMIT 500`;
      const r = await env.DB.prepare(sql).all();
      return { ok: true, items: r.results || [] };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },

  async reposition_planned_cancel(user, env, params) {
    await ACTIONS._ensurePlannedRepositionTable(env);
    const id = String(params.id || '').trim();
    if (!id) return { ok: false, error: 'missing_id' };
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `UPDATE planned_repositions SET status='cancelled', cancelled_at=?, cancelled_by_nid=? WHERE id = ?`
      ).bind(now, user.nid, id).run();
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },

  async reposition_planned_execute(user, env, params, dj) {
    // Execute a planned move NOW (push to reposition_log as approved)
    await ACTIONS._ensurePlannedRepositionTable(env);
    const id = String(params.id || '').trim();
    if (!id) return { ok: false, error: 'missing_id' };
    try {
      const plan = await env.DB.prepare(
        `SELECT * FROM planned_repositions WHERE id = ?`
      ).bind(id).first();
      if (!plan) return { ok: false, error: 'not_found' };
      if (plan.status !== 'pending' && plan.status !== 'approved') {
        return { ok: false, error: 'already_' + plan.status };
      }
      // If the plan has no from_station recorded, derive it from current state:
      //   1. last approved reposition_log for this unit (= current location)
      //   2. else units_detail.home from data.json
      let from_station = plan.from_station;
      if (!from_station) {
        const lastRepo = await env.DB.prepare(
          `SELECT to_station FROM reposition_log WHERE unit_code = ? AND status = 'approved' ORDER BY ts DESC LIMIT 1`
        ).bind(plan.unit_code).first();
        if (lastRepo && lastRepo.to_station) {
          from_station = lastRepo.to_station;
        } else if (dj && dj.units_detail) {
          const u = dj.units_detail.find(x => String(x.id || '').toUpperCase() === String(plan.unit_code).toUpperCase());
          if (u && u.home) from_station = String(u.home).toUpperCase();
        }
      }
      const now = Math.floor(Date.now() / 1000);
      // Insert into the same reposition_log that unit_availability/positioning read
      await env.DB.prepare(
        `INSERT INTO reposition_log (id, unit_code, from_station, to_station, status, requested_by_nid, ts, approved_at, approved_by_nid, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        'RP-EXEC-' + id,
        plan.unit_code,
        from_station || null,
        plan.to_station,
        'approved',
        plan.created_by_nid,
        now, now, user.nid,
        'Executed from planned reposition ' + id + (plan.reason ? ' · ' + plan.reason : '')
      ).run();
      // Update plan with the resolved from_station so the row in /admin reflects truth
      await env.DB.prepare(
        `UPDATE planned_repositions SET status='executed', executed_at=?, from_station=COALESCE(from_station, ?) WHERE id = ?`
      ).bind(now, from_station || null, id).run();
      return { ok: true, id, executed_at: now, from_station, to_station: plan.to_station };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },
  // ==============================================================
  // reposition_reverse — undo an already-executed reposition. Creates
  // an inverse entry in reposition_log moving the unit back. Marks the
  // original planned row as 'reversed' for audit, if there was one.
  // ==============================================================
  async reposition_reverse(user, env, params) {
    await ACTIONS._ensurePlannedRepositionTable(env);
    const planId = String(params.plan_id || params.id || '').trim();
    if (!planId) return { ok: false, error: 'missing_plan_id' };
    try {
      const plan = await env.DB.prepare(
        `SELECT * FROM planned_repositions WHERE id = ?`
      ).bind(planId).first();
      if (!plan) return { ok: false, error: 'plan_not_found' };
      if (plan.status !== 'executed') return { ok: false, error: 'plan_not_executed', status: plan.status };
      if (!plan.from_station) return { ok: false, error: 'no_from_station_to_revert_to' };

      const now = Math.floor(Date.now() / 1000);
      // Insert reverse reposition: was at to_station, now back to from_station
      await env.DB.prepare(
        `INSERT INTO reposition_log (id, unit_code, from_station, to_station, status, requested_by_nid, ts, approved_at, approved_by_nid, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        'RP-REV-' + planId + '-' + now,
        plan.unit_code,
        plan.to_station,                     // current location (where we executed to)
        plan.from_station,                   // back to original
        'approved',
        user.nid,
        now, now, user.nid,
        'Reversed planned reposition ' + planId + (plan.reason ? ' (orig: ' + plan.reason + ')' : '')
      ).run();
      // Mark the planned row as reversed
      await env.DB.prepare(
        `UPDATE planned_repositions SET status='reversed', reversed_at=?, reversed_by_nid=? WHERE id = ?`
      ).bind(now, user.nid, planId).run();
      return { ok: true, plan_id: planId, unit_code: plan.unit_code, from: plan.to_station, to: plan.from_station, reversed_at: now };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },




  // ==============================================================
  // escalation_set — admin writes an override for a tier into D1
  // (takes precedence over the Google Sheet)
  // ==============================================================
  async escalation_set(user, env, params) {
    await ACTIONS._ensureEscalationTable(env);
    const tier = parseInt(params.tier, 10);
    if (!tier || tier < 1 || tier > 99) return { ok: false, error: 'invalid_tier' };
    const role = String(params.role || '').slice(0, 200);
    const when_text = String(params.when || params.when_text || '').slice(0, 500);
    const name = String(params.name || '').slice(0, 200);
    const phone = String(params.phone || '').slice(0, 60);
    const contact = String(params.contact || (name + (phone ? ' · ' + phone : ''))).slice(0, 500);
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `INSERT INTO escalation_overrides (tier, role, when_text, name, phone, contact, updated_by_nid, updated_by_name, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tier) DO UPDATE SET role=excluded.role, when_text=excluded.when_text, name=excluded.name, phone=excluded.phone, contact=excluded.contact, updated_by_nid=excluded.updated_by_nid, updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`
      ).bind(tier, role, when_text, name, phone, contact, user.nid, user.name || '', now).run();
      return { ok: true, tier };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },

  async escalation_delete(user, env, params) {
    await ACTIONS._ensureEscalationTable(env);
    const tier = parseInt(params.tier, 10);
    if (!tier) return { ok: false, error: 'invalid_tier' };
    try {
      await env.DB.prepare(`DELETE FROM escalation_overrides WHERE tier = ?`).bind(tier).run();
      return { ok: true, tier };
    } catch (e) {
      return { ok: false, error: 'db_error', detail: String(e.message) };
    }
  },

  // ==============================================================
  // shift_status — current shift indicator for UI
  // ==============================================================
  async shift_status(user, env) {
    const now = Math.floor(Date.now() / 1000);
    const ksaHour = ((now + 3*3600) / 3600 | 0) % 24;
    let shift = 'day';
    let nextChange = null;
    if (ksaHour >= 7 && ksaHour < 19) {
      shift = 'day';
      nextChange = '19:00 KSA';
    } else {
      shift = 'night';
      nextChange = ksaHour >= 19 ? '07:00 KSA next day' : '07:00 KSA';
    }
    return { ok: true, shift, ksa_hour: ksaHour, next_change: nextChange };
  },

  // ==============================================================
  // transports_list — currently active transports (post-on_scene, pre-arrived)
  // ==============================================================
  async transports_list(user, env, params) {
    try {
      const lookback = parseInt(params.lookback_hours || 24, 10);
      const since = Math.floor(Date.now() / 1000) - lookback * 3600;
      const r = await env.DB.prepare(
        `SELECT d.incident_id, d.station, d.sub_location, d.triage, d.complaint,
                d.cardiac_arrest, d.unit_assigned, d.status, d.ts AS dispatched_at,
                d.closed_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'on_scene') AS on_scene_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'transporting') AS transporting_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'transfer_start') AS transfer_start_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'arrived_hospital') AS arrived_at
         FROM dispatch_log d
         WHERE d.ts >= ?1 AND COALESCE(d.is_drill,0) = 0
         ORDER BY d.ts DESC LIMIT 200`
      ).bind(since).all();
      const all = r.results || [];
      const active = all.filter(t => (t.transporting_at || t.transfer_start_at) && !t.arrived_at && !t.closed_at);
      const completed = all.filter(t => t.arrived_at);
      return { ok: true, active, completed: completed.slice(0, 50), total_window: all.length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // mci_command_summary — MCI command center data
  // ==============================================================
  async mci_command_summary(user, env) {
    try {
      let mciActive = false, mciDeclaredAt = null, mciDeclaredBy = null, mciLocation = null;
      try {
        const ms = await env.DB.prepare(`SELECT v FROM sync_state WHERE k = 'mci_state' LIMIT 1`).first();
        if (ms && ms.v) {
          const state = JSON.parse(ms.v);
          mciActive = state.active === true;
          mciDeclaredAt = state.declared_at;
          mciDeclaredBy = state.declared_by;
          mciLocation = state.location;
        }
      } catch (_) {}

      const since = Math.floor(Date.now() / 1000) - 6 * 3600;
      const tR = await env.DB.prepare(
        `SELECT triage, COUNT(*) AS n FROM dispatch_log WHERE ts >= ?1 AND COALESCE(is_drill,0) = 0 GROUP BY triage`
      ).bind(since).all();
      const triageCounts = { red: 0, yellow: 0, green: 0, black: 0 };
      (tR.results || []).forEach(row => { if (triageCounts[row.triage] != null) triageCounts[row.triage] = row.n; });

      let hospitals = [];
      try {
        const hR = await env.DB.prepare(
          `SELECT id, name, name_ar, ed_status, ed_capacity_pct, last_updated FROM hospitals ORDER BY ed_capacity_pct DESC`
        ).all();
        hospitals = hR.results || [];
      } catch (_) {}

      let unitCounts = { available: 0, busy: 0, oos: 0 };
      try {
        const uR = await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM units GROUP BY status`).all();
        (uR.results || []).forEach(row => { if (unitCounts[row.status] != null) unitCounts[row.status] = row.n; });
      } catch (_) {}

      const stR = await env.DB.prepare(
        `SELECT station, COUNT(*) AS n FROM dispatch_log WHERE status NOT IN ('complete','closed') AND COALESCE(is_drill,0) = 0 GROUP BY station ORDER BY n DESC`
      ).all();
      const openByStation = stR.results || [];

      // Triage tags counts (if MCI mode)
      let tagCounts = { red: 0, yellow: 0, green: 0, black: 0 };
      try {
        await ACTIONS._ensureTriageTagsTable(env);
        const tgR = await env.DB.prepare(
          `SELECT tag_color, COUNT(*) AS n FROM triage_tags WHERE assigned_at >= ?1 GROUP BY tag_color`
        ).bind(since).all();
        (tgR.results || []).forEach(row => { if (tagCounts[row.tag_color] != null) tagCounts[row.tag_color] = row.n; });
      } catch (_) {}

      return {
        ok: true,
        mci: { active: mciActive, declared_at: mciDeclaredAt, declared_by: mciDeclaredBy, location: mciLocation },
        triage_counts: triageCounts,
        tag_counts: tagCounts,
        hospitals,
        unit_counts: unitCounts,
        open_by_station: openByStation,
        total_open: openByStation.reduce((a, b) => a + (b.n || 0), 0)
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // triage_tags — MCI patient triage tag tracking
  // ==============================================================
  async _ensureTriageTagsTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS triage_tags (
      id TEXT PRIMARY KEY,
      incident_id TEXT,
      tag_number TEXT,
      tag_color TEXT,
      patient_age TEXT,
      patient_gender TEXT,
      chief_complaint TEXT,
      assigned_by_nid TEXT,
      assigned_by_name TEXT,
      assigned_at INTEGER,
      station TEXT,
      sublocation TEXT,
      disposition TEXT,
      transported_to TEXT,
      notes TEXT
    )`).run();
  },

  async triage_tags_assign(user, env, params) {
    await ACTIONS._ensureTriageTagsTable(env);
    const id = 'TT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `INSERT INTO triage_tags (id, incident_id, tag_number, tag_color, patient_age, patient_gender, chief_complaint, assigned_by_nid, assigned_by_name, assigned_at, station, sublocation, notes)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
      ).bind(
        id, String(params.incident_id || ''), String(params.tag_number || ''),
        String(params.tag_color || 'green').toLowerCase(),
        String(params.patient_age || ''), String(params.patient_gender || ''),
        String(params.chief_complaint || ''), user.nid, user.name || '',
        now, String(params.station || ''), String(params.sublocation || ''),
        String(params.notes || '')
      ).run();
      return { ok: true, id, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async triage_tags_list(user, env, params) {
    await ACTIONS._ensureTriageTagsTable(env);
    try {
      let where = '', binds = [];
      if (params.incident_id) { where = 'WHERE incident_id = ?1'; binds = [params.incident_id]; }
      else { where = 'WHERE assigned_at >= ?1'; binds = [Math.floor(Date.now()/1000) - 86400]; }
      const r = await env.DB.prepare(
        `SELECT * FROM triage_tags ${where} ORDER BY assigned_at DESC LIMIT 500`
      ).bind(...binds).all();
      const tags = r.results || [];
      const counts = { red: 0, yellow: 0, green: 0, black: 0 };
      tags.forEach(t => { if (counts[t.tag_color] != null) counts[t.tag_color]++; });
      return { ok: true, tags, counts, total: tags.length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // shifts — today's schedule + handoff queue
  // ==============================================================
  async _ensureShiftsTables(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shift_handoffs (
      id TEXT PRIMARY KEY,
      shift_date TEXT,
      shift_period TEXT,
      station TEXT,
      author_nid TEXT,
      author_name TEXT,
      content TEXT,
      acknowledged_by_nid TEXT,
      acknowledged_by_name TEXT,
      acknowledged_at INTEGER,
      created_at INTEGER
    )`).run();
  },

  async shifts_today(user, env) {
    await ACTIONS._ensureShiftsTables(env);
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      // KSA is UTC+3 — current shift in local
      const ksaHour = (now.getUTCHours() + 3) % 24;
      const currentShift = (ksaHour >= 7 && ksaHour < 19) ? 'day' : 'night';

      let onShift = [];
      try {
        const r = await env.DB.prepare(
          `SELECT DISTINCT nid, name FROM presence WHERE last_seen >= ?1 ORDER BY name`
        ).bind(Math.floor(Date.now()/1000) - 3600).all();
        onShift = r.results || [];
      } catch (_) {}

      const hoR = await env.DB.prepare(
        `SELECT * FROM shift_handoffs WHERE shift_date = ?1 AND (acknowledged_at IS NULL OR acknowledged_at = 0)
         ORDER BY created_at DESC LIMIT 50`
      ).bind(today).all();

      return {
        ok: true,
        date: today,
        current_shift: currentShift,
        on_shift_count: onShift.length,
        on_shift: onShift.slice(0, 100),
        pending_handoffs: hoR.results || []
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async shifts_handoff_save(user, env, params) {
    await ACTIONS._ensureShiftsTables(env);
    const id = 'HO-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const now = Math.floor(Date.now() / 1000);
    const today = new Date().toISOString().slice(0, 10);
    try {
      await env.DB.prepare(
        `INSERT INTO shift_handoffs (id, shift_date, shift_period, station, author_nid, author_name, content, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      ).bind(id, String(params.shift_date || today), String(params.shift_period || 'day'),
        String(params.station || ''), user.nid, user.name || '',
        String(params.content || ''), now).run();
      return { ok: true, id, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async shifts_handoff_list(user, env, params) {
    await ACTIONS._ensureShiftsTables(env);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await env.DB.prepare(
        `SELECT * FROM shift_handoffs WHERE shift_date = ?1 ORDER BY created_at DESC LIMIT 100`
      ).bind(params.date || today).all();
      return { ok: true, handoffs: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // alerts_recent — critical events for audio alert system
  // ==============================================================
  async alerts_recent(user, env, params) {
    try {
      const since = parseInt(params.since || (Math.floor(Date.now()/1000) - 600), 10);
      const r = await env.DB.prepare(
        `SELECT incident_id, ts, station, triage, complaint, cardiac_arrest
         FROM dispatch_log
         WHERE ts > ?1 AND COALESCE(is_drill,0) = 0
           AND (triage = 'red' OR cardiac_arrest = 1)
         ORDER BY ts DESC LIMIT 20`
      ).bind(since).all();
      return { ok: true, alerts: r.results || [], queried_at: Math.floor(Date.now()/1000) };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // code_blue — capture timed events during a cardiac arrest run
  // ==============================================================
  async _ensureCodeBlueTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS code_blue_events (
      id TEXT PRIMARY KEY,
      incident_id TEXT,
      ts INTEGER,
      event_type TEXT,
      detail TEXT,
      by_nid TEXT,
      by_name TEXT,
      station TEXT
    )`).run();
  },

  async code_blue_event(user, env, params) {
    await ACTIONS._ensureCodeBlueTable(env);
    const id = 'CB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const ts = parseInt(params.ts || Math.floor(Date.now()/1000), 10);
    try {
      await env.DB.prepare(
        `INSERT INTO code_blue_events (id, incident_id, ts, event_type, detail, by_nid, by_name, station)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      ).bind(
        id, String(params.incident_id || ''), ts,
        String(params.event_type || ''), String(params.detail || ''),
        user.nid, user.name || '', String(params.station || '')
      ).run();
      return { ok: true, id, ts };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async code_blue_list(user, env, params) {
    await ACTIONS._ensureCodeBlueTable(env);
    try {
      let where, binds;
      if (params.incident_id) { where = 'WHERE incident_id = ?1'; binds = [params.incident_id]; }
      else { where = 'WHERE ts >= ?1'; binds = [Math.floor(Date.now()/1000) - 86400]; }
      const r = await env.DB.prepare(
        `SELECT * FROM code_blue_events ${where} ORDER BY ts ASC LIMIT 500`
      ).bind(...binds).all();
      return { ok: true, events: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // heat_watch — compute heat-related risk + currently active red incidents
  // ==============================================================
  async heat_watch(user, env) {
    try {
      // Try to fetch latest Mecca weather (cached or via heat_index)
      let weather = null;
      try {
        const w = await ACTIONS.heat_index(user, env);
        if (w && w.ok) weather = w;
      } catch (_) {}

      // Count heat-related complaints in last 6h
      const since = Math.floor(Date.now()/1000) - 6 * 3600;
      const heatKeywords = ['heat', 'stroke', 'exhaust', 'dehydra', 'cramp', 'syncope', 'collapse'];
      // crude SQL OR
      const likeClauses = heatKeywords.map((_, i) => `LOWER(complaint) LIKE ?${i + 2}`).join(' OR ');
      const r = await env.DB.prepare(
        `SELECT incident_id, ts, station, triage, complaint, cardiac_arrest
         FROM dispatch_log
         WHERE ts >= ?1 AND COALESCE(is_drill,0) = 0
           AND (${likeClauses})
         ORDER BY ts DESC LIMIT 50`
      ).bind(since, ...heatKeywords.map(k => '%' + k + '%')).all();
      const heatIncidents = r.results || [];

      // By station
      const byStation = {};
      heatIncidents.forEach(h => {
        byStation[h.station] = (byStation[h.station] || 0) + 1;
      });

      // Risk level
      let riskLevel = 'low';
      let recommendation = 'Normal vigilance. Standard cooling stations.';
      const temp = weather && weather.temperature ? weather.temperature : null;
      const heatIdx = weather && weather.heat_index ? weather.heat_index : null;

      if (heatIdx && heatIdx >= 54) { riskLevel = 'extreme'; recommendation = 'EXTREME HEAT — activate full cooling kit deployment, increase IV fluids, mandate paramedic hydration breaks every 15min.'; }
      else if (heatIdx && heatIdx >= 41) { riskLevel = 'high'; recommendation = 'High risk — pre-position cooling kits, increase IV fluid stock, paramedic breaks every 30min.'; }
      else if (heatIdx && heatIdx >= 32) { riskLevel = 'moderate'; recommendation = 'Moderate risk — verify cooling kit availability, watch for vulnerable pilgrims.'; }
      if (heatIncidents.length >= 10) { riskLevel = 'high'; recommendation += ' (Surge: ' + heatIncidents.length + ' heat-related cases in last 6h)'; }

      return {
        ok: true,
        weather,
        risk_level: riskLevel,
        recommendation,
        heat_incidents_6h: heatIncidents.length,
        by_station: byStation,
        recent: heatIncidents.slice(0, 20)
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================

  // ==============================================================
  // schedule_overview — staff + unit schedule view for the new
  // /schedule page. Returns:
  //   units: [ { code, type, home_station, default_shift, category,
  //              filled_count, size, members: [...] } ]
  //   dh_range: [4..14]
  // The frontend renders this as a per-unit timeline.
  // ==============================================================
  async schedule_overview(user, env, params, dj) {
    const detail = (dj && dj.units_detail) || [];
    const dailyView = (dj && dj.daily_view) || [];
    const filter_station = String(params.station || '').toUpperCase();
    const filter_cat = String(params.category || '');

    // Build map: DH day → Set of active shift codes (from daily_view)
    const activeShiftsByDH = {};
    dailyView.forEach(row => {
      const dh = parseInt(row.dh, 10);
      const codes = Object.keys(row.shifts || {});
      activeShiftsByDH[dh] = new Set(codes);
    });
    const DH_RANGE = [4,5,6,7,8,9,10,11,12,13,14];

    function activeDhsForShift(shiftCode) {
      // Compute which DH days this shift code is active on.
      // A unit's shift can be "D7", "N15", "24/7", "D3-12" (compound), etc.
      // We check daily_view; if a DH lists this shift code, the unit is on.
      // Also handle compound codes like "D3-12" (synonym for D3 between DH 3-12).
      const out = [];
      const base = String(shiftCode || '').trim();
      if (!base) return out;
      DH_RANGE.forEach(dh => {
        const codes = activeShiftsByDH[dh];
        if (!codes) return;
        // Exact match
        if (codes.has(base)) { out.push(dh); return; }
        // Compound match — e.g. "D3-12" appears for DH9 alongside "D3"
        for (const c of codes) {
          if (c.startsWith(base + '-') || c.startsWith(base + ' ')) { out.push(dh); return; }
          // Reverse: if unit shift is "D3-12" but daily_view shows "D3"
          if (base.startsWith(c + '-') || base.startsWith(c + ' ')) { out.push(dh); return; }
        }
      });
      return out;
    }

    let units = detail.map(u => {
      const shift = u.default_shift || '';
      const active_dh = activeDhsForShift(shift);
      return {
        code: u.id || '',
        type: u.type || '',
        home_station: u.home || '',
        category: u.category || '',
        default_shift: shift,
        size: u.size || u.total_count || 0,
        filled_count: u.filled_count || 0,
        // NEW: actual days this unit is on-duty (derived from daily_view)
        active_dh: active_dh,
        // If we couldn't derive (no daily_view), assume all 11 days
        active_dh_fallback: active_dh.length === 0,
        members: (u.members || []).map(m => ({
          staff_id: m.staff_id || '',
          name: m.name || '',
          role: m.role || '',
          call_sign: m.call_sign || '',
          phone: m.phone || '',
          status: m.status || ''
        }))
      };
    }).filter(u => u.code);
    if (filter_station) units = units.filter(u => u.home_station === filter_station);
    if (filter_cat) units = units.filter(u => u.category === filter_cat);
    units.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    return { ok: true, units, dh_range: DH_RANGE, total: units.length };
  },

  // me_summary — personal page data (your shift, your stats)
  // ==============================================================
  async me_summary(user, env) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const today = new Date().toISOString().slice(0, 10);
      const dayStart = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 1000) - 3 * 3600;  // KSA midnight

      // Recent activity (dispatches I created, PCRs I drafted)
      let myDispatches = [];
      try {
        const r = await env.DB.prepare(
          `SELECT incident_id, ts, station, triage, complaint, status FROM dispatch_log
           WHERE created_by_nid = ?1 AND ts >= ?2 ORDER BY ts DESC LIMIT 20`
        ).bind(user.nid, dayStart).all();
        myDispatches = r.results || [];
      } catch (_) {}

      let myPcrs = [];
      try {
        const r = await env.DB.prepare(
          `SELECT id, incident_id, status, chief_complaint, updated_at FROM pcr_drafts
           WHERE author_nid = ?1 ORDER BY updated_at DESC LIMIT 10`
        ).bind(user.nid).all();
        myPcrs = r.results || [];
      } catch (_) {}

      // Unread messages count
      let unreadMessages = 0;
      try {
        const r = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE recipient_nid = ?1 AND read_at IS NULL`
        ).bind(user.nid).first();
        unreadMessages = r ? (r.n || 0) : 0;
      } catch (_) {}

      // Last presence ping
      let lastPresence = null;
      try {
        const r = await env.DB.prepare(
          `SELECT last_seen FROM presence WHERE nid = ?1`
        ).bind(user.nid).first();
        lastPresence = r ? r.last_seen : null;
      } catch (_) {}

      return {
        ok: true,
        user: { nid: user.nid, name: user.name, role: user.role },
        today,
        my_dispatches_today: myDispatches,
        my_dispatches_count: myDispatches.length,
        my_pcrs: myPcrs,
        my_pcrs_count: myPcrs.length,
        unread_messages: unreadMessages,
        last_presence: lastPresence,
        server_now: now
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // board_summary — kanban-style operations board
  // ==============================================================
  async board_summary(user, env, params) {
    try {
      const lookback = parseInt(params.lookback_hours || 12, 10);
      const since = Math.floor(Date.now()/1000) - lookback * 3600;
      const r = await env.DB.prepare(
        `SELECT d.incident_id, d.ts, d.station, d.sub_location, d.triage, d.complaint,
                d.cardiac_arrest, d.unit_assigned, d.status, d.closed_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'on_scene') AS on_scene_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'transporting') AS transporting_at
         FROM dispatch_log d
         WHERE d.ts >= ?1 AND COALESCE(d.is_drill,0) = 0
         ORDER BY d.ts DESC LIMIT 300`
      ).bind(since).all();
      const all = r.results || [];
      const cols = { new: [], en_route: [], on_scene: [], transporting: [], closed: [] };
      const now = Math.floor(Date.now()/1000);
      all.forEach(inc => {
        if (inc.closed_at) { cols.closed.push(inc); return; }
        if (inc.transporting_at) { cols.transporting.push(inc); return; }
        if (inc.on_scene_at) { cols.on_scene.push(inc); return; }
        // Otherwise check events for en_route
        cols.new.push(inc);
      });
      // Try to upgrade items in cols.new to en_route if they have en_route event
      // (do this in a single query)
      const newIds = cols.new.map(i => i.incident_id);
      if (newIds.length > 0) {
        try {
          const placeholders = newIds.map((_, i) => '?' + (i+1)).join(',');
          const er = await env.DB.prepare(
            `SELECT incident_id, MIN(ts) AS ts FROM incident_events WHERE incident_id IN (${placeholders}) AND event_type = 'en_route' GROUP BY incident_id`
          ).bind(...newIds).all();
          const erSet = new Map();
          (er.results || []).forEach(r => erSet.set(r.incident_id, r.ts));
          const stillNew = [], enroute = [];
          cols.new.forEach(i => {
            if (erSet.has(i.incident_id)) { i.en_route_at = erSet.get(i.incident_id); enroute.push(i); }
            else stillNew.push(i);
          });
          cols.new = stillNew;
          cols.en_route = enroute;
        } catch (_) {}
      }
      return {
        ok: true, lookback_hours: lookback, columns: cols,
        counts: { new: cols.new.length, en_route: cols.en_route.length, on_scene: cols.on_scene.length, transporting: cols.transporting.length, closed: cols.closed.length },
        total: all.length, server_now: now
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // pulse_feed — chronological activity stream across all sources
  // ==============================================================
  async pulse_feed(user, env, params) {
    try {
      const lookback = parseInt(params.lookback_minutes || 60, 10);
      const since = Math.floor(Date.now()/1000) - lookback * 60;
      const events = [];
      // dispatches created
      const dR = await env.DB.prepare(
        `SELECT incident_id, ts, station, triage, complaint, cardiac_arrest, created_by_nid
         FROM dispatch_log WHERE ts >= ?1 AND COALESCE(is_drill,0) = 0
         ORDER BY ts DESC LIMIT 100`
      ).bind(since).all();
      (dR.results || []).forEach(d => events.push({
        ts: d.ts, kind: 'dispatch', station: d.station,
        text: 'Dispatch ' + d.incident_id + ' @ ' + (d.station || '?') + (d.complaint ? ': ' + d.complaint.slice(0, 50) : ''),
        triage: d.triage, cardiac: d.cardiac_arrest, ref: d.incident_id
      }));
      // closed
      const cR = await env.DB.prepare(
        `SELECT incident_id, closed_at, station, triage FROM dispatch_log
         WHERE closed_at >= ?1 AND COALESCE(is_drill,0) = 0 ORDER BY closed_at DESC LIMIT 100`
      ).bind(since).all();
      (cR.results || []).forEach(d => events.push({
        ts: d.closed_at, kind: 'closed', station: d.station,
        text: 'Closed ' + d.incident_id, triage: d.triage, ref: d.incident_id
      }));
      // event milestones
      try {
        const eR = await env.DB.prepare(
          `SELECT incident_id, event_type, ts FROM incident_events
           WHERE ts >= ?1 ORDER BY ts DESC LIMIT 100`
        ).bind(since).all();
        (eR.results || []).forEach(e => events.push({
          ts: e.ts, kind: 'event_' + e.event_type,
          text: e.event_type.replace(/_/g, ' ').toUpperCase() + ' · ' + e.incident_id, ref: e.incident_id
        }));
      } catch (_) {}
      // broadcasts
      try {
        const bR = await env.DB.prepare(
          `SELECT id, ts, text, level, sender_name FROM broadcasts WHERE ts >= ?1 ORDER BY ts DESC LIMIT 30`
        ).bind(since).all();
        (bR.results || []).forEach(b => events.push({
          ts: b.ts, kind: 'broadcast_' + (b.level || 'info'),
          text: 'Broadcast (' + (b.sender_name || '?') + '): ' + (b.text || '').slice(0, 80)
        }));
      } catch (_) {}
      // code blue
      try {
        const cbR = await env.DB.prepare(
          `SELECT incident_id, ts, event_type, by_name FROM code_blue_events
           WHERE ts >= ?1 AND event_type IN ('arrest_start', 'rosc', 'termination') ORDER BY ts DESC LIMIT 20`
        ).bind(since).all();
        (cbR.results || []).forEach(c => events.push({
          ts: c.ts, kind: 'code_' + c.event_type,
          text: 'Code Blue ' + c.event_type.toUpperCase() + ' · ' + (c.incident_id || '?') + (c.by_name ? ' by ' + c.by_name : '')
        }));
      } catch (_) {}
      // MCI state changes
      try {
        const mR = await env.DB.prepare(
          `SELECT action, ts, details FROM audit_log WHERE action = 'mci_set' AND ts >= ?1 ORDER BY ts DESC LIMIT 10`
        ).bind(since).all();
        (mR.results || []).forEach(m => events.push({
          ts: m.ts, kind: 'mci',
          text: 'MCI ' + (m.details || '')
        }));
      } catch (_) {}
      events.sort((a, b) => b.ts - a.ts);
      return { ok: true, events: events.slice(0, 100), lookback_minutes: lookback, server_now: Math.floor(Date.now()/1000) };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // handover_compose — build a hospital pre-arrival report from incident data
  // ==============================================================
  async handover_compose(user, env, params) {
    const incidentId = String(params.incident_id || '');
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };
    try {
      const d = await env.DB.prepare(
        `SELECT * FROM dispatch_log WHERE incident_id = ?1 LIMIT 1`
      ).bind(incidentId).first();
      if (!d) return { ok: false, error: 'incident_not_found' };
      // PCR if any
      let pcr = null;
      try {
        const p = await env.DB.prepare(
          `SELECT * FROM pcr_drafts WHERE incident_id = ?1 ORDER BY updated_at DESC LIMIT 1`
        ).bind(incidentId).first();
        pcr = p;
      } catch (_) {}
      // Build MIST report (Mechanism, Injuries, Signs, Treatment)
      const mist = {
        M: d.complaint || (pcr && pcr.chief_complaint) || 'unknown mechanism',
        I: (pcr && pcr.assessment) || (pcr && pcr.chief_complaint) || 'see complaint',
        S: (pcr && pcr.vitals_initial) || 'vitals pending',
        T: (pcr && pcr.interventions) || 'transport initiated'
      };
      const sbar = {
        S: 'Patient with ' + (d.complaint || 'medical complaint') + ' at ' + (d.station || '?') + (d.sub_location ? ' / ' + d.sub_location : '') + '. Triage: ' + (d.triage || '?').toUpperCase() + '.',
        B: pcr ? 'Pt age ' + (pcr.patient_age || '?') + ', ' + (pcr.patient_gender || '?') + '. PMHx: ' + (pcr.history || 'unknown') + '. Allergies: ' + (pcr.allergies || 'NKDA') + '.' : 'Demographics pending PCR.',
        A: 'Assessment: ' + ((pcr && pcr.assessment) || 'see complaint') + '. Initial vitals: ' + ((pcr && pcr.vitals_initial) || 'pending') + '.',
        R: 'Recommend: receiving facility prep. ETA per dispatcher. ' + (d.cardiac_arrest ? '⚠ CARDIAC ARREST CASE.' : '')
      };
      // Radio call (one-liner)
      const triageWord = { red: 'PRIORITY 1', yellow: 'PRIORITY 2', green: 'PRIORITY 3', black: 'EXPECTANT' }[d.triage] || 'PRIORITY UNK';
      const radio = (d.unit_assigned || 'Unit') + ' inbound, ' + triageWord +
        ', ' + (pcr && pcr.patient_age ? pcr.patient_age + 'y/o ' + (pcr.patient_gender || '') + ', ' : '') +
        (d.complaint || 'medical') + '. From ' + (d.station || '?') + (d.cardiac_arrest ? ', CARDIAC ARREST' : '') + '. ETA pending.';
      return { ok: true, incident_id: incidentId, dispatch: d, pcr, mist, sbar, radio };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // supplies — request and track supply needs (often tied to equipment.status='low')
  // ==============================================================
  async _ensureSuppliesTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS supply_requests (
      id TEXT PRIMARY KEY,
      station TEXT,
      item TEXT,
      quantity TEXT,
      urgency TEXT,
      reason TEXT,
      requested_by_nid TEXT,
      requested_by_name TEXT,
      requested_at INTEGER,
      status TEXT DEFAULT 'open',
      fulfilled_by_nid TEXT,
      fulfilled_by_name TEXT,
      fulfilled_at INTEGER,
      notes TEXT
    )`).run();
  },

  async supplies_request(user, env, params) {
    await ACTIONS._ensureSuppliesTable(env);
    const id = 'SR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const now = Math.floor(Date.now()/1000);
    try {
      await env.DB.prepare(
        `INSERT INTO supply_requests (id, station, item, quantity, urgency, reason, requested_by_nid, requested_by_name, requested_at, status)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'open')`
      ).bind(
        id, String(params.station || ''), String(params.item || ''),
        String(params.quantity || '1'), String(params.urgency || 'normal'),
        String(params.reason || ''), user.nid, user.name || '', now
      ).run();
      return { ok: true, id, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async supplies_list(user, env, params) {
    await ACTIONS._ensureSuppliesTable(env);
    try {
      let where = '', binds = [];
      const filters = [];
      if (params.station) { filters.push('station = ?' + (binds.length + 1)); binds.push(params.station); }
      if (params.status) { filters.push('status = ?' + (binds.length + 1)); binds.push(params.status); }
      if (!filters.length) {
        filters.push('requested_at >= ?1');
        binds.push(Math.floor(Date.now()/1000) - 7 * 86400);
      }
      where = 'WHERE ' + filters.join(' AND ');
      const r = await env.DB.prepare(
        `SELECT * FROM supply_requests ${where} ORDER BY requested_at DESC LIMIT 200`
      ).bind(...binds).all();
      const requests = r.results || [];
      const counts = { open: 0, in_progress: 0, fulfilled: 0, cancelled: 0 };
      requests.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });
      return { ok: true, requests, counts };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async supplies_set_status(user, env, params) {
    await ACTIONS._ensureSuppliesTable(env);
    const id = String(params.id || '');
    const status = String(params.status || 'open');
    const notes = String(params.notes || '');
    if (!id) return { ok: false, error: 'missing_id' };
    if (!['open','in_progress','fulfilled','cancelled'].includes(status)) return { ok: false, error: 'invalid_status' };
    const now = Math.floor(Date.now()/1000);
    try {
      await env.DB.prepare(
        `UPDATE supply_requests SET status = ?1, notes = COALESCE(notes, '') || CASE WHEN ?2 != '' THEN char(10) || ?2 ELSE '' END,
         fulfilled_by_nid = CASE WHEN ?1 = 'fulfilled' THEN ?3 ELSE fulfilled_by_nid END,
         fulfilled_by_name = CASE WHEN ?1 = 'fulfilled' THEN ?4 ELSE fulfilled_by_name END,
         fulfilled_at = CASE WHEN ?1 = 'fulfilled' THEN ?5 ELSE fulfilled_at END
         WHERE id = ?6`
      ).bind(status, notes, user.nid, user.name || '', now, id).run();
      return { ok: true, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // INTAKE — quick patient intake (less than full PCR, just essentials)
  // ==============================================================
  async _ensureIntakeTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS intake_records (
      id TEXT PRIMARY KEY,
      incident_id TEXT,
      author_nid TEXT,
      author_name TEXT,
      patient_age TEXT,
      patient_gender TEXT,
      patient_nationality TEXT,
      patient_mrn TEXT,
      chief_complaint TEXT,
      bp TEXT,
      hr TEXT,
      rr TEXT,
      spo2 TEXT,
      temp TEXT,
      gcs TEXT,
      pain_0_10 TEXT,
      allergies TEXT,
      medications TEXT,
      notes TEXT,
      station TEXT,
      created_at INTEGER,
      converted_to_pcr_id TEXT
    )`).run();
  },

  async intake_save(user, env, params) {
    await ACTIONS._ensureIntakeTable(env);
    const id = 'INT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const now = Math.floor(Date.now()/1000);
    try {
      await env.DB.prepare(
        `INSERT INTO intake_records (id, incident_id, author_nid, author_name, patient_age, patient_gender,
         patient_nationality, patient_mrn, chief_complaint, bp, hr, rr, spo2, temp, gcs, pain_0_10,
         allergies, medications, notes, station, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`
      ).bind(
        id, String(params.incident_id || ''), user.nid, user.name || '',
        String(params.patient_age || ''), String(params.patient_gender || ''),
        String(params.patient_nationality || ''), String(params.patient_mrn || ''),
        String(params.chief_complaint || ''),
        String(params.bp || ''), String(params.hr || ''), String(params.rr || ''),
        String(params.spo2 || ''), String(params.temp || ''), String(params.gcs || ''),
        String(params.pain_0_10 || ''),
        String(params.allergies || ''), String(params.medications || ''),
        String(params.notes || ''), String(params.station || ''), now
      ).run();
      return { ok: true, id, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async intake_list(user, env, params) {
    await ACTIONS._ensureIntakeTable(env);
    try {
      let where, binds;
      if (params.incident_id) { where = 'WHERE incident_id = ?1'; binds = [params.incident_id]; }
      else if (params.mine) { where = 'WHERE author_nid = ?1 AND created_at >= ?2'; binds = [user.nid, Math.floor(Date.now()/1000) - 86400]; }
      else { where = 'WHERE created_at >= ?1'; binds = [Math.floor(Date.now()/1000) - 86400]; }
      const r = await env.DB.prepare(
        `SELECT * FROM intake_records ${where} ORDER BY created_at DESC LIMIT 200`
      ).bind(...binds).all();
      return { ok: true, intakes: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // WELLNESS — paramedic wellness check-in (hydration, fatigue, breaks)
  // ==============================================================
  async _ensureWellnessTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS wellness_checkins (
      id TEXT PRIMARY KEY,
      author_nid TEXT,
      author_name TEXT,
      station TEXT,
      cups_water TEXT,
      hours_since_break TEXT,
      fatigue_1_10 INTEGER,
      mood_1_10 INTEGER,
      heat_exposure TEXT,
      concerns TEXT,
      created_at INTEGER
    )`).run();
  },

  async wellness_save(user, env, params) {
    await ACTIONS._ensureWellnessTable(env);
    const id = 'WL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const now = Math.floor(Date.now()/1000);
    try {
      await env.DB.prepare(
        `INSERT INTO wellness_checkins (id, author_nid, author_name, station, cups_water, hours_since_break,
         fatigue_1_10, mood_1_10, heat_exposure, concerns, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      ).bind(
        id, user.nid, user.name || '', String(params.station || ''),
        String(params.cups_water || ''), String(params.hours_since_break || ''),
        parseInt(params.fatigue_1_10 || 5, 10), parseInt(params.mood_1_10 || 5, 10),
        String(params.heat_exposure || ''), String(params.concerns || ''), now
      ).run();
      return { ok: true, id, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async wellness_list(user, env, params) {
    await ACTIONS._ensureWellnessTable(env);
    try {
      let where, binds;
      const window = params.station ? '?1' : '?1';
      if (params.station) {
        where = 'WHERE station = ?1 AND created_at >= ?2';
        binds = [params.station, Math.floor(Date.now()/1000) - 24 * 3600];
      } else {
        where = 'WHERE created_at >= ?1';
        binds = [Math.floor(Date.now()/1000) - 24 * 3600];
      }
      const r = await env.DB.prepare(
        `SELECT * FROM wellness_checkins ${where} ORDER BY created_at DESC LIMIT 200`
      ).bind(...binds).all();
      const records = r.results || [];
      // Aggregate: avg fatigue, avg mood, count by station
      const byStation = {};
      let totFatigue = 0, totMood = 0, totN = 0;
      records.forEach(rec => {
        if (!byStation[rec.station]) byStation[rec.station] = { count: 0, fatigue: 0, mood: 0 };
        byStation[rec.station].count++;
        byStation[rec.station].fatigue += rec.fatigue_1_10 || 0;
        byStation[rec.station].mood += rec.mood_1_10 || 0;
        totFatigue += rec.fatigue_1_10 || 0;
        totMood += rec.mood_1_10 || 0;
        totN++;
      });
      Object.keys(byStation).forEach(s => {
        const bs = byStation[s];
        bs.avg_fatigue = bs.count > 0 ? (bs.fatigue / bs.count).toFixed(1) : '0';
        bs.avg_mood = bs.count > 0 ? (bs.mood / bs.count).toFixed(1) : '0';
      });
      return {
        ok: true, records,
        summary: {
          n: totN,
          avg_fatigue: totN > 0 ? (totFatigue / totN).toFixed(1) : '0',
          avg_mood: totN > 0 ? (totMood / totN).toFixed(1) : '0',
          by_station: byStation
        }
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async wellness_my_recent(user, env) {
    await ACTIONS._ensureWellnessTable(env);
    try {
      const r = await env.DB.prepare(
        `SELECT * FROM wellness_checkins WHERE author_nid = ?1 ORDER BY created_at DESC LIMIT 5`
      ).bind(user.nid).all();
      return { ok: true, records: r.results || [] };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // SLA — service level agreement metrics from dispatch + events
  // ==============================================================
  async sla_summary(user, env, params) {
    try {
      const lookback = parseInt(params.lookback_hours || 24, 10);
      const since = Math.floor(Date.now()/1000) - lookback * 3600;
      // Targets (seconds)
      const TARGETS = {
        dispatch_to_enroute: 60,       // 1 min
        dispatch_to_on_scene: 8 * 60,  // 8 min
        on_scene_time: 20 * 60,        // 20 min standard
        dispatch_to_close: 60 * 60     // 1 hour
      };
      // Pull dispatches in window
      const dR = await env.DB.prepare(
        `SELECT d.incident_id, d.ts AS dispatched_at, d.station, d.triage, d.closed_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'en_route') AS en_route_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'on_scene') AS on_scene_at,
                (SELECT MIN(ts) FROM incident_events WHERE incident_id = d.incident_id AND event_type = 'transporting') AS transporting_at
         FROM dispatch_log d
         WHERE d.ts >= ?1 AND COALESCE(d.is_drill,0) = 0
         ORDER BY d.ts DESC LIMIT 500`
      ).bind(since).all();
      const incs = dR.results || [];
      // Compute metrics
      const metrics = {
        dispatch_to_enroute: { values: [], breaches: 0 },
        dispatch_to_on_scene: { values: [], breaches: 0 },
        on_scene_time: { values: [], breaches: 0 },
        dispatch_to_close: { values: [], breaches: 0 }
      };
      const byStation = {};
      incs.forEach(i => {
        if (!byStation[i.station]) byStation[i.station] = { n: 0, breach: 0 };
        byStation[i.station].n++;
        if (i.en_route_at) {
          const d = i.en_route_at - i.dispatched_at;
          if (d >= 0) { metrics.dispatch_to_enroute.values.push(d); if (d > TARGETS.dispatch_to_enroute) { metrics.dispatch_to_enroute.breaches++; byStation[i.station].breach++; } }
        }
        if (i.on_scene_at) {
          const d = i.on_scene_at - i.dispatched_at;
          if (d >= 0) { metrics.dispatch_to_on_scene.values.push(d); if (d > TARGETS.dispatch_to_on_scene) { metrics.dispatch_to_on_scene.breaches++; byStation[i.station].breach++; } }
        }
        if (i.on_scene_at && i.transporting_at) {
          const d = i.transporting_at - i.on_scene_at;
          if (d >= 0) { metrics.on_scene_time.values.push(d); if (d > TARGETS.on_scene_time) metrics.on_scene_time.breaches++; }
        }
        if (i.closed_at) {
          const d = i.closed_at - i.dispatched_at;
          if (d >= 0) { metrics.dispatch_to_close.values.push(d); if (d > TARGETS.dispatch_to_close) metrics.dispatch_to_close.breaches++; }
        }
      });
      // Aggregate stats per metric
      Object.keys(metrics).forEach(k => {
        const m = metrics[k];
        if (m.values.length === 0) { m.avg = null; m.median = null; m.p90 = null; m.compliance = null; return; }
        const sorted = m.values.slice().sort((a,b)=>a-b);
        m.avg = Math.round(sorted.reduce((a,b)=>a+b,0) / sorted.length);
        m.median = sorted[Math.floor(sorted.length / 2)];
        m.p90 = sorted[Math.floor(sorted.length * 0.9)];
        m.n = sorted.length;
        m.compliance = (((m.n - m.breaches) / m.n) * 100).toFixed(1);
        m.target = TARGETS[k];
        delete m.values;
      });
      return {
        ok: true, lookback_hours: lookback,
        total_incidents: incs.length,
        metrics, by_station: byStation,
        targets: TARGETS
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // TRAINING — drill scenario library + drill creation
  // ==============================================================
  async training_scenarios(user, env) {
    const scenarios = [
      { id: 'card1', title: 'Cardiac Arrest at Station Platform', category: 'cardiac',
        description: '52y/o M collapses on platform during boarding. Bystander CPR initiated. No AED visible nearby.',
        targets: { dispatch_to_on_scene: 6 * 60, rosc_attempt: 25 * 60 },
        expected_actions: ['Activate Code Blue', 'Verify arrest', 'CPR 30:2', 'Apply pads', 'IV/IO access', 'Epi 1mg q3-5min', 'Search Hs&Ts', 'Pre-alert hospital'] },
      { id: 'card2', title: 'Cardiac Arrest with Bystander AED', category: 'cardiac',
        description: '65y/o F collapses near cooling tent in Arafat. AED applied by bystander before EMS arrival. Pulse absent.',
        targets: { dispatch_to_on_scene: 6 * 60 },
        expected_actions: ['Verify AED', 'Resume CPR', 'IV access', 'Epi q3-5min', 'Rhythm check q2min', 'Hospital pre-alert'] },
      { id: 'mci1', title: 'MCI — Crush Event on Walkway', category: 'mci',
        description: '15+ casualties from compression injury on Jamarat walkway. Triage required, mutual aid needed.',
        targets: { mci_declaration: 3 * 60 },
        expected_actions: ['Declare MCI', 'Establish IC + Triage', 'START triage', 'Apply triage tags', 'Notify hospitals', 'Request mutual aid SRCA/MoH'] },
      { id: 'mci2', title: 'MCI — Bus Incident with Multiple Casualties', category: 'mci',
        description: 'Bus collision with 25 passengers, mixed severity. Closer to MIN3 station.',
        targets: { mci_declaration: 3 * 60 },
        expected_actions: ['Declare MCI', 'Triage Officer assignment', 'Treatment + Transport Officers', 'Stage units', 'Hospital distribution'] },
      { id: 'heat1', title: 'Heat Stroke — Severe', category: 'heat',
        description: '45y/o M altered mental status, temp 41.2°C, found near MUZ1 station midday. Family states he was walking for 3+ hours in sun.',
        targets: { dispatch_to_on_scene: 5 * 60, cool_to_39: 30 * 60 },
        expected_actions: ['Recognize heat stroke vs exhaustion', 'Strip + rapid cooling', 'IV fluids', 'Cooling kit deployment', 'Monitor core temp', 'Stop cooling at 39°C', 'Transport'] },
      { id: 'heat2', title: 'Heat Exhaustion Surge', category: 'heat',
        description: '6 pilgrims at ARF2 with combinations of dizziness, cramping, nausea, sweating. Temp 38-39°C range.',
        targets: { triage_complete: 5 * 60 },
        expected_actions: ['Triage by severity', 'Oral rehydration if alert', 'IV NS for severe', 'Cooling chairs', 'Watch for stroke conversion'] },
      { id: 'anaphylaxis', title: 'Anaphylaxis at Cooling Tent', category: 'allergic',
        description: '28y/o F reaction after taking unknown medication. Lip swelling, wheeze, hypotension at MIN1.',
        targets: { epi_within: 60 },
        expected_actions: ['Recognize anaphylaxis', 'Epi 0.5mg IM thigh FIRST', 'O2 + airway prep', 'IV access + fluids', 'Adjunct meds after epi', 'Transport'] },
      { id: 'stroke', title: 'Suspected Stroke', category: 'stroke',
        description: '70y/o M sudden right-sided weakness + slurred speech 30 min ago. Last known well documented.',
        targets: { dispatch_to_on_scene: 6 * 60 },
        expected_actions: ['FAST/Cincinnati screen', 'Time last known well', 'BGL check', 'Avoid aggressive BP lowering', 'Pre-notify stroke center', 'Rapid transport'] },
      { id: 'trauma1', title: 'Major Trauma — Fall', category: 'trauma',
        description: '38y/o M fell from elevated walkway, unconscious, multi-system trauma signs.',
        targets: { dispatch_to_on_scene: 5 * 60, transport_decision: 10 * 60 },
        expected_actions: ['XABCDE primary', 'Airway + C-spine', 'Needle decompression if tension PTX', 'TXA within 3h', 'Permissive hypotension', 'Pre-alert trauma center'] },
      { id: 'pediatric', title: 'Pediatric Seizure', category: 'pediatric',
        description: '6y/o child with febrile seizure ongoing for 8 minutes at family camp.',
        targets: { sedation_within: 5 * 60 },
        expected_actions: ['Protect airway', 'Check BGL', 'Midazolam IM/IN', 'Cooling for fever', 'Reassess + transport'] }
    ];
    return { ok: true, scenarios, categories: ['cardiac','mci','heat','allergic','stroke','trauma','pediatric'] };
  },

  async training_start_drill(user, env, params) {
    try {
      const scenarioId = String(params.scenario_id || '');
      const station = String(params.station || '');
      if (!scenarioId) return { ok: false, error: 'missing_scenario_id' };
      const incidentId = 'DRILL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
      const now = Math.floor(Date.now()/1000);
      // Look up scenario for context
      const all = await ACTIONS.training_scenarios(user, env);
      const sc = (all.scenarios || []).find(s => s.id === scenarioId);
      if (!sc) return { ok: false, error: 'scenario_not_found' };
      // Insert as drill incident
      try {
        await env.DB.prepare(
          `INSERT INTO dispatch_log (incident_id, ts, station, sub_location, triage, complaint, cardiac_arrest,
           status, is_drill, created_by_nid)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'new', 1, ?8)`
        ).bind(
          incidentId, now, station || 'OCC',
          'DRILL — ' + (sc.title || ''), 'yellow',
          'DRILL: ' + (sc.description || sc.title), sc.category === 'cardiac' ? 1 : 0,
          user.nid
        ).run();
      } catch (e) {
        return { ok: false, error: 'dispatch_insert_failed: ' + e.message };
      }
      return { ok: true, incident_id: incidentId, scenario: sc, started_at: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // scoreboard — KPI scoreboard by station/unit/team
  // ==============================================================
  async scoreboard(user, env, params) {
    const now = Math.floor(Date.now() / 1000);
    const lookback_hours = Math.min(parseInt(params.lookback_hours || 24, 10), 168);
    const winStart = now - lookback_hours * 3600;
    const result = { ok: true, generated_at: now, window: { start: winStart, end: now, lookback_hours }, by_station: [], by_unit: [], by_cluster: [], overall: {} };
    try {
      // By station
      const stR = await env.DB.prepare(
        `SELECT station, COUNT(*) AS total,
                SUM(CASE WHEN status IN ('complete','closed') THEN 1 ELSE 0 END) AS closed,
                SUM(CASE WHEN triage = 'red' THEN 1 ELSE 0 END) AS reds,
                SUM(CASE WHEN cardiac_arrest = 1 THEN 1 ELSE 0 END) AS cardiac
         FROM dispatch_log
         WHERE ts >= ?1 AND ts <= ?2 AND COALESCE(is_drill,0) = 0
         GROUP BY station ORDER BY total DESC`
      ).bind(winStart, now).all();
      result.by_station = stR.results || [];

      // By unit
      const uR = await env.DB.prepare(
        `SELECT unit_assigned AS unit, COUNT(*) AS total,
                SUM(CASE WHEN status IN ('complete','closed') THEN 1 ELSE 0 END) AS closed,
                SUM(CASE WHEN triage = 'red' THEN 1 ELSE 0 END) AS reds
         FROM dispatch_log
         WHERE ts >= ?1 AND ts <= ?2 AND COALESCE(is_drill,0) = 0
           AND unit_assigned IS NOT NULL AND unit_assigned != ''
         GROUP BY unit_assigned ORDER BY total DESC LIMIT 15`
      ).bind(winStart, now).all();
      result.by_unit = uR.results || [];

      // Response time per station (median + p95)
      const rtR = await env.DB.prepare(
        `SELECT d.station, (e.ts - d.ts) AS delta
         FROM dispatch_log d
         INNER JOIN (
           SELECT incident_id, MIN(ts) AS ts FROM incident_events
           WHERE event_type = 'on_scene' GROUP BY incident_id
         ) e ON e.incident_id = d.incident_id
         WHERE d.ts >= ?1 AND d.ts <= ?2 AND COALESCE(d.is_drill,0) = 0
           AND (e.ts - d.ts) BETWEEN 0 AND 86400
         ORDER BY d.station, delta ASC`
      ).bind(winStart, now).all();
      const deltasByStation = {};
      (rtR.results || []).forEach(r => {
        if (!deltasByStation[r.station]) deltasByStation[r.station] = [];
        deltasByStation[r.station].push(r.delta);
      });
      // Attach RT stats to by_station rows
      result.by_station.forEach(row => {
        const d = deltasByStation[row.station] || [];
        if (d.length > 0) {
          row.rt_median_sec = d[Math.floor(d.length / 2)];
          row.rt_p95_sec = d[Math.floor(d.length * 0.95)];
          row.rt_n = d.length;
        } else { row.rt_median_sec = null; row.rt_p95_sec = null; row.rt_n = 0; }
      });

      // Aggregate clusters
      const clusters = { Arafat: { total:0, closed:0, reds:0, cardiac:0 }, Muzdalifah: {total:0,closed:0,reds:0,cardiac:0}, Mina: {total:0,closed:0,reds:0,cardiac:0} };
      const ARFAT = ['ARF1','ARF2','ARF3'], MUZ = ['MUZ1','MUZ2','MUZ3'], MIN = ['MIN1','MIN2','MIN3'];
      result.by_station.forEach(r => {
        let cl = null;
        if (ARFAT.includes(r.station)) cl = 'Arafat';
        else if (MUZ.includes(r.station)) cl = 'Muzdalifah';
        else if (MIN.includes(r.station)) cl = 'Mina';
        if (cl && clusters[cl]) {
          clusters[cl].total += Number(r.total) || 0;
          clusters[cl].closed += Number(r.closed) || 0;
          clusters[cl].reds += Number(r.reds) || 0;
          clusters[cl].cardiac += Number(r.cardiac) || 0;
        }
      });
      result.by_cluster = Object.entries(clusters).map(([cluster, v]) => ({ cluster, ...v }));

      // Overall
      let total = 0, closed = 0, reds = 0, cardiac = 0;
      result.by_station.forEach(r => { total += Number(r.total)||0; closed += Number(r.closed)||0; reds += Number(r.reds)||0; cardiac += Number(r.cardiac)||0; });
      // Aggregate response time across all
      const allDeltas = Object.values(deltasByStation).flat().sort((a,b) => a-b);
      result.overall = {
        total, closed, reds, cardiac,
        close_pct: total > 0 ? Math.round(closed / total * 100) : 0,
        rt_median_sec: allDeltas.length ? allDeltas[Math.floor(allDeltas.length / 2)] : null,
        rt_p95_sec: allDeltas.length ? allDeltas[Math.floor(allDeltas.length * 0.95)] : null
      };

      return result;
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // replay — historical data for a specific time window
  // ==============================================================
  async replay(user, env, params) {
    const from_ts = parseInt(params.from_ts || 0, 10);
    const to_ts = parseInt(params.to_ts || 0, 10);
    if (!from_ts || !to_ts) return { ok: false, error: 'missing_window' };
    if (to_ts <= from_ts) return { ok: false, error: 'invalid_window' };
    try {
      // Get all incidents in window
      const incR = await env.DB.prepare(
        `SELECT incident_id, ts, station, sub_location, triage, status, complaint,
                cardiac_arrest, unit_assigned, closed_at
         FROM dispatch_log
         WHERE ts >= ?1 AND ts <= ?2 AND COALESCE(is_drill,0) = 0
         ORDER BY ts ASC`
      ).bind(from_ts, to_ts).all();
      const incidents = incR.results || [];
      const ids = incidents.map(i => i.incident_id);
      // Events
      let eventsByInc = {};
      if (ids.length > 0) {
        const placeholders = ids.map((_, i) => '?' + (i + 1)).join(',');
        try {
          const evR = await env.DB.prepare(
            `SELECT incident_id, event_type, ts FROM incident_events WHERE incident_id IN (${placeholders}) ORDER BY ts ASC`
          ).bind(...ids).all();
          (evR.results || []).forEach(e => {
            if (!eventsByInc[e.incident_id]) eventsByInc[e.incident_id] = [];
            eventsByInc[e.incident_id].push({ type: e.event_type, ts: e.ts });
          });
        } catch (_) {}
      }
      // Build event stream (chronological merge of dispatch + events + close)
      const stream = [];
      incidents.forEach(inc => {
        stream.push({ ts: inc.ts, type: 'dispatch', incident_id: inc.incident_id, station: inc.station, triage: inc.triage, complaint: inc.complaint, cardiac: inc.cardiac_arrest });
        (eventsByInc[inc.incident_id] || []).forEach(e => {
          stream.push({ ts: e.ts, type: e.type, incident_id: inc.incident_id, station: inc.station, triage: inc.triage });
        });
        if (inc.closed_at) stream.push({ ts: inc.closed_at, type: 'close', incident_id: inc.incident_id, station: inc.station });
      });
      stream.sort((a, b) => a.ts - b.ts);

      return {
        ok: true,
        from_ts, to_ts,
        duration_sec: to_ts - from_ts,
        incident_count: incidents.length,
        event_count: stream.length,
        events: stream.slice(0, 500),
        incidents: incidents.slice(0, 200)
      };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // translator_phrases — common medical phrases in pilgrim languages
  // ==============================================================
  async translator_phrases(user, env) {
    // Curated list of essential medical phrases in major pilgrim languages
    return { ok: true, phrases: [
      { en: "Where does it hurt?", ar: "أين تشعر بالألم؟", id: "Di mana sakitnya?", ur: "درد کہاں ہے؟", tr: "Neresi ağrıyor?", fa: "کجا درد می کند؟", fr: "Où avez-vous mal?", category: "assessment" },
      { en: "Can you breathe?", ar: "هل تستطيع التنفس؟", id: "Bisa bernapas?", ur: "آپ سانس لے سکتے ہیں؟", tr: "Nefes alabiliyor musun?", fa: "می توانید نفس بکشید؟", fr: "Pouvez-vous respirer?", category: "airway" },
      { en: "Are you on any medication?", ar: "هل تتناول أي دواء؟", id: "Apakah Anda minum obat?", ur: "کیا آپ کوئی دوا لے رہے ہیں؟", tr: "İlaç alıyor musunuz?", fa: "آیا دارو می خورید؟", fr: "Prenez-vous des médicaments?", category: "history" },
      { en: "Do you have allergies?", ar: "هل عندك حساسية؟", id: "Apakah Anda alergi?", ur: "کیا آپ کو الرجی ہے؟", tr: "Alerjiniz var mı?", fa: "آلرژی دارید؟", fr: "Avez-vous des allergies?", category: "history" },
      { en: "How long have you felt this way?", ar: "منذ متى وأنت تشعر هكذا؟", id: "Sudah berapa lama merasa seperti ini?", ur: "آپ کب سے ایسا محسوس کر رہے ہیں؟", tr: "Bu şikayet ne zaman başladı?", fa: "از کی این طور احساس می کنید؟", fr: "Depuis quand ressentez-vous cela?", category: "history" },
      { en: "We are taking you to hospital.", ar: "سنأخذك إلى المستشفى.", id: "Kami akan membawa Anda ke rumah sakit.", ur: "ہم آپ کو ہسپتال لے جا رہے ہیں۔", tr: "Sizi hastaneye götürüyoruz.", fa: "شما را به بیمارستان می بریم.", fr: "Nous vous emmenons à l'hôpital.", category: "treatment" },
      { en: "Please stay calm.", ar: "ابق هادئاً من فضلك.", id: "Mohon tetap tenang.", ur: "براہ کرم پرسکون رہیں۔", tr: "Lütfen sakin olun.", fa: "لطفاً آرام باشید.", fr: "Restez calme s'il vous plaît.", category: "reassurance" },
      { en: "I am a paramedic.", ar: "أنا مسعف.", id: "Saya paramedis.", ur: "میں پیرامیڈک ہوں۔", tr: "Ben sağlık görevlisiyim.", fa: "من امدادگر هستم.", fr: "Je suis ambulancier.", category: "intro" },
      { en: "We need to give you an injection.", ar: "نحتاج أن نعطيك حقنة.", id: "Kami perlu memberi Anda suntikan.", ur: "ہمیں آپ کو انجیکشن دینا ہوگا۔", tr: "Size iğne yapmamız gerekiyor.", fa: "باید به شما تزریق کنیم.", fr: "Nous devons vous faire une injection.", category: "treatment" },
      { en: "Open your eyes please.", ar: "افتح عينيك من فضلك.", id: "Buka mata Anda.", ur: "اپنی آنکھیں کھولیں۔", tr: "Lütfen gözünüzü açın.", fa: "لطفاً چشمانتان را باز کنید.", fr: "Ouvrez les yeux s'il vous plaît.", category: "assessment" },
      { en: "Squeeze my hand.", ar: "اضغط على يدي.", id: "Genggam tangan saya.", ur: "میرا ہاتھ دبائیں۔", tr: "Elimi sıkın.", fa: "دستم را فشار دهید.", fr: "Serrez ma main.", category: "assessment" },
      { en: "Do you have chest pain?", ar: "هل عندك ألم في الصدر؟", id: "Apakah dada sakit?", ur: "کیا آپ کو سینے میں درد ہے؟", tr: "Göğüs ağrınız var mı?", fa: "درد قفسه سینه دارید؟", fr: "Avez-vous mal à la poitrine?", category: "assessment" },
      { en: "Are you pregnant?", ar: "هل أنت حامل؟", id: "Apakah Anda hamil?", ur: "کیا آپ حاملہ ہیں؟", tr: "Hamile misiniz?", fa: "باردار هستید؟", fr: "Êtes-vous enceinte?", category: "assessment" },
      { en: "When did you last eat or drink?", ar: "متى آخر مرة أكلت أو شربت؟", id: "Kapan terakhir makan atau minum?", ur: "آپ نے آخری بار کب کھایا یا پیا؟", tr: "Son ne zaman yediniz veya içtiniz?", fa: "آخرین بار کی غذا یا نوشیدنی خوردید؟", fr: "Quand avez-vous mangé ou bu pour la dernière fois?", category: "history" },
      { en: "Are you feeling dizzy?", ar: "هل تشعر بالدوار؟", id: "Apakah Anda merasa pusing?", ur: "کیا آپ کو چکر آرہا ہے؟", tr: "Baş dönmesi var mı?", fa: "گیج می شوید؟", fr: "Avez-vous des vertiges?", category: "assessment" },
      { en: "Is anyone with you?", ar: "هل معك أحد؟", id: "Ada yang menemani Anda?", ur: "آپ کے ساتھ کوئی ہے؟", tr: "Yanınızda biri var mı?", fa: "کسی همراه شماست؟", fr: "Quelqu'un est-il avec vous?", category: "social" },
      { en: "Drink this water.", ar: "اشرب هذا الماء.", id: "Minum air ini.", ur: "یہ پانی پیجئے۔", tr: "Bu suyu için.", fa: "این آب را بنوشید.", fr: "Buvez cette eau.", category: "treatment" },
      { en: "Sit down please.", ar: "اجلس من فضلك.", id: "Silakan duduk.", ur: "براہ کرم بیٹھ جائیں۔", tr: "Lütfen oturun.", fa: "لطفاً بنشینید.", fr: "Asseyez-vous s'il vous plaît.", category: "guidance" },
      { en: "Do you understand?", ar: "هل تفهم؟", id: "Anda mengerti?", ur: "کیا آپ سمجھ رہے ہیں؟", tr: "Anlıyor musunuz?", fa: "متوجه می شوید؟", fr: "Comprenez-vous?", category: "comms" },
      { en: "What is your name?", ar: "ما اسمك؟", id: "Siapa nama Anda?", ur: "آپ کا نام کیا ہے؟", tr: "Adınız nedir?", fa: "اسم شما چیست؟", fr: "Quel est votre nom?", category: "ident" }
    ]};
  },

  // ==============================================================
  // equipment — track inventory of critical equipment per station
  // ==============================================================
  async _ensureEquipmentTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      station TEXT,
      unit_code TEXT,
      label TEXT,
      serial TEXT,
      status TEXT DEFAULT 'ok',
      last_check_ts INTEGER,
      last_check_by TEXT,
      note TEXT,
      expires_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    )`).run();
  },

  async equipment_seed(user, env) {
    await ACTIONS._ensureEquipmentTable(env);
    const now = Math.floor(Date.now() / 1000);
    const stations = ['ARF1','ARF2','ARF3','MUZ1','MUZ2','MUZ3','MIN1','MIN2','MIN3'];
    const types = [
      { type: 'als_bag', label: 'ALS Bag', count_per_station: 2 },
      { type: 'defibrillator', label: 'AED/Defib', count_per_station: 2 },
      { type: 'o2_tank_main', label: 'O2 Tank (Main)', count_per_station: 1 },
      { type: 'o2_tank_portable', label: 'O2 Tank (Portable)', count_per_station: 4 },
      { type: 'suction_unit', label: 'Suction Unit', count_per_station: 2 },
      { type: 'splints', label: 'Splint Set', count_per_station: 2 },
      { type: 'cooling_kit', label: 'Heat Stroke Cooling Kit', count_per_station: 2 },
      { type: 'iv_kit', label: 'IV Start Kit', count_per_station: 5 },
      { type: 'spine_board', label: 'Spine Board', count_per_station: 1 },
      { type: 'triage_tags', label: 'Triage Tag Set (MCI)', count_per_station: 1 }
    ];
    let n = 0;
    for (const st of stations) {
      for (const t of types) {
        for (let i = 1; i <= t.count_per_station; i++) {
          const id = `EQ-${st}-${t.type}-${i}`;
          try {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO equipment (id, type, station, label, status, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, 'ok', ?5, ?5)`
            ).bind(id, t.type, st, t.label + ' #' + i, now).run();
            n++;
          } catch (_) {}
        }
      }
    }
    return { ok: true, seeded: n };
  },

  async equipment_list(user, env, params) {
    try {
      await ACTIONS._ensureEquipmentTable(env);
      let where = '', binds = [];
      if (params.station) { where = 'WHERE station = ?1'; binds = [String(params.station).toUpperCase()]; }
      const r = await env.DB.prepare(
        `SELECT * FROM equipment ${where} ORDER BY station, type`
      ).bind(...binds).all();
      // Tally
      const tally = { total: 0, ok: 0, low: 0, defective: 0, expired: 0 };
      (r.results || []).forEach(e => {
        tally.total++;
        if (e.status === 'ok') tally.ok++;
        else if (e.status === 'low') tally.low++;
        else if (e.status === 'defective') tally.defective++;
        else if (e.status === 'expired') tally.expired++;
      });
      return { ok: true, equipment: r.results || [], tally };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async equipment_status_set(user, env, params) {
    const id = String(params.id || '');
    const status = String(params.status || 'ok').toLowerCase();
    const note = String(params.note || '').slice(0, 300);
    if (!id) return { ok: false, error: 'missing_id' };
    if (!['ok','low','defective','expired','restocked'].includes(status)) return { ok: false, error: 'invalid_status' };
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(
        `UPDATE equipment SET status = ?1, note = ?2, last_check_ts = ?3, last_check_by = ?4, updated_at = ?3 WHERE id = ?5`
      ).bind(status, note, now, user.name || user.nid, id).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details) VALUES (?1, 'equipment_status', 'equipment', ?2, ?3)`
      ).bind(user.nid, id, JSON.stringify({ status, note })).run();
      return { ok: true, ts: now };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // station_load_history — hourly load per station for past N hours
  // ==============================================================
  async station_load_history(user, env, params) {
    const hours = Math.min(parseInt(params.hours || 24, 10), 168);
    const now = Math.floor(Date.now() / 1000);
    const winStart = now - hours * 3600;
    try {
      const r = await env.DB.prepare(
        `SELECT station, CAST((ts - ?1) / 3600 AS INTEGER) AS hour_offset, COUNT(*) AS n
         FROM dispatch_log
         WHERE ts >= ?1 AND ts <= ?2 AND COALESCE(is_drill,0) = 0
         GROUP BY station, hour_offset
         ORDER BY station, hour_offset`
      ).bind(winStart, now).all();
      const grid = {};
      (r.results || []).forEach(row => {
        if (!grid[row.station]) grid[row.station] = new Array(hours).fill(0);
        if (row.hour_offset >= 0 && row.hour_offset < hours) grid[row.station][row.hour_offset] = row.n;
      });
      return { ok: true, win_start: winStart, hours, grid };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ==============================================================
  // report_daily — full operational summary for any date
  // Returns: per-triage counts, per-station, hourly breakdown,
  //   top units, response time stats, key events
  // ==============================================================
  async report_daily(user, env, params) {
    // Date param: YYYY-MM-DD or default today (Riyadh +03 timezone for ops)
    const dateStr = String(params.date || '').slice(0, 10);
    let dayStart, dayEnd, dateLabel;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [y,m,d] = dateStr.split('-').map(Number);
      // Riyadh +03 — day starts at 00:00 KSA
      dayStart = Math.floor(Date.UTC(y, m-1, d, -3) / 1000);  // -3hr offset
      dayEnd = dayStart + 86400;
      dateLabel = dateStr;
    } else {
      const now = new Date();
      // Riyadh date today
      const ksa = new Date(now.getTime() + (3*3600 - now.getTimezoneOffset()*60) * 1000);
      const y = ksa.getUTCFullYear(), m = ksa.getUTCMonth(), d = ksa.getUTCDate();
      dayStart = Math.floor(Date.UTC(y, m, d, -3) / 1000);
      dayEnd = dayStart + 86400;
      dateLabel = ksa.toISOString().slice(0,10);
    }

    const out = {
      ok: true,
      date: dateLabel,
      hajj_day: ACTIONS._hajjDay((dayStart + dayEnd) / 2),
      window: { start_ts: dayStart, end_ts: dayEnd },
      generated_at: Math.floor(Date.now() / 1000),
      generated_by: { name: user.name, role: user.role },
      summary: { total: 0, closed: 0, still_open: 0, cancelled: 0 },
      by_triage: {},
      by_station: {},
      by_hour: [],            // 24 buckets
      by_cluster: { Arafat: 0, Muzdalifah: 0, Mina: 0, Other: 0 },
      top_units: [],          // [{unit_code, count}]
      response_time: { count: 0, mean_sec: null, median_sec: null, p95_sec: null, max_sec: null },
      cardiac_arrests: 0,
      mci_events: [],
      key_events: []          // significant audit events
    };

    try {
      // Fetch all incidents created on this day
      const r = await env.DB.prepare(
        `SELECT incident_id, triage, station, status, ts, closed_at,
                cardiac_arrest, unit_assigned, sub_location
         FROM dispatch_log WHERE ts >= ?1 AND ts < ?2 ORDER BY ts ASC`
      ).bind(dayStart, dayEnd).all();
      const incs = r.results || [];

      out.summary.total = incs.length;
      const ARFAT = ['ARF1','ARF2','ARF3'], MUZ = ['MUZ1','MUZ2','MUZ3'], MIN = ['MIN1','MIN2','MIN3'];
      // Init hourly buckets (KSA hours)
      for (let h = 0; h < 24; h++) out.by_hour.push({ hour: h, dispatched: 0, closed: 0, by_triage: {} });

      const unitCounts = {};
      incs.forEach(i => {
        // Status
        if (i.status === 'complete' || i.status === 'closed') out.summary.closed++;
        else if (i.status === 'cancelled') out.summary.cancelled++;
        else out.summary.still_open++;

        // Triage
        const tri = i.triage || 'unknown';
        out.by_triage[tri] = (out.by_triage[tri] || 0) + 1;

        // Station
        const st = i.station || 'UNK';
        if (!out.by_station[st]) out.by_station[st] = { total: 0, by_triage: {} };
        out.by_station[st].total++;
        out.by_station[st].by_triage[tri] = (out.by_station[st].by_triage[tri] || 0) + 1;

        // Cluster
        if (ARFAT.includes(st)) out.by_cluster.Arafat++;
        else if (MUZ.includes(st)) out.by_cluster.Muzdalifah++;
        else if (MIN.includes(st)) out.by_cluster.Mina++;
        else out.by_cluster.Other++;

        // Hour bucket (KSA local)
        const ksaHour = Math.floor((i.ts - dayStart) / 3600);
        if (ksaHour >= 0 && ksaHour < 24) {
          out.by_hour[ksaHour].dispatched++;
          out.by_hour[ksaHour].by_triage[tri] = (out.by_hour[ksaHour].by_triage[tri] || 0) + 1;
        }
        if (i.closed_at) {
          const closedHour = Math.floor((i.closed_at - dayStart) / 3600);
          if (closedHour >= 0 && closedHour < 24) out.by_hour[closedHour].closed++;
        }

        // Unit attribution
        if (i.unit_assigned) {
          unitCounts[i.unit_assigned] = (unitCounts[i.unit_assigned] || 0) + 1;
        }
        if (i.cardiac_arrest) out.cardiac_arrests++;
      });

      // Top units (top 10)
      out.top_units = Object.entries(unitCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([unit_code, count]) => ({ unit_code, count }));

      // Response time stats — JOIN with incident_events
      const rtR = await env.DB.prepare(
        `SELECT (e.ts - d.ts) AS delta
         FROM dispatch_log d
         INNER JOIN (
           SELECT incident_id, MIN(ts) AS ts FROM incident_events
           WHERE event_type = 'on_scene' GROUP BY incident_id
         ) e ON e.incident_id = d.incident_id
         WHERE d.ts >= ?1 AND d.ts < ?2
           AND (e.ts - d.ts) BETWEEN 0 AND 86400
         ORDER BY delta ASC`
      ).bind(dayStart, dayEnd).all();
      const deltas = (rtR.results || []).map(x => x.delta);
      if (deltas.length > 0) {
        const sum = deltas.reduce((s,v) => s+v, 0);
        out.response_time.count = deltas.length;
        out.response_time.mean_sec = Math.round(sum / deltas.length);
        out.response_time.median_sec = deltas[Math.floor(deltas.length / 2)];
        out.response_time.p95_sec = deltas[Math.floor(deltas.length * 0.95)];
        out.response_time.max_sec = deltas[deltas.length - 1];
      }

      // Key events: MCI activations + critical broadcasts within day
      try {
        const keyR = await env.DB.prepare(
          `SELECT a.ts, a.action, a.resource_id, a.details, w.name AS actor
           FROM audit_log a LEFT JOIN allowlist w ON w.nid = a.actor_nid
           WHERE a.ts >= ?1 AND a.ts < ?2
             AND a.action IN ('mci_activate','mci_deactivate','broadcast_send')
           ORDER BY a.ts ASC`
        ).bind(dayStart, dayEnd).all();
        out.key_events = (keyR.results || []).map(e => ({
          ts: e.ts, ts_iso: new Date(e.ts*1000).toISOString(),
          actor: e.actor, action: e.action, resource_id: e.resource_id, details: e.details
        }));
        out.mci_events = out.key_events.filter(e => e.action.startsWith('mci_'));
      } catch (_) {}
    } catch (e) {
      out.error = String(e.message);
    }
    return out;
  },

  // ==============================================================
  // report_shift_handoff — for shift change documentation
  // Returns: open incidents, recent activity, station status, MCI status
  // ==============================================================
  async report_shift_handoff(user, env, params) {
    const now = Math.floor(Date.now() / 1000);
    const lookback = parseInt(params.lookback_hours || 4, 10) * 3600;
    const out = {
      ok: true,
      generated_at: now,
      generated_by: { name: user.name, role: user.role },
      shift_window: { from_ts: now - lookback, to_ts: now, hours: lookback/3600 },
      hajj_day: ACTIONS._hajjDay(now),
      open_incidents: [],
      open_count_by_triage: {},
      open_count_by_station: {},
      recent_closures: [],
      recent_dispatches_count: 0,
      recent_closures_count: 0,
      mci: { active: false },
      station_status: [],
      pending_repositions: 0,
      notes_for_next_shift: []
    };

    try {
      // Open incidents
      const oR = await env.DB.prepare(
        `SELECT incident_id, triage, station, sub_location, status, ts,
                cardiac_arrest, unit_assigned, chief_complaint, age, gender
         FROM dispatch_log
         WHERE status NOT IN ('complete','closed','cancelled')
         ORDER BY
           CASE WHEN cardiac_arrest = 1 THEN 0 ELSE 1 END,
           CASE triage WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END,
           ts DESC`
      ).all();
      out.open_incidents = (oR.results || []).map(i => ({
        ...i,
        age_min: Math.floor((now - i.ts) / 60),
        ts_iso: new Date(i.ts * 1000).toISOString()
      }));
      out.open_incidents.forEach(i => {
        const t = i.triage || 'unknown';
        const s = i.station || 'UNK';
        out.open_count_by_triage[t] = (out.open_count_by_triage[t] || 0) + 1;
        out.open_count_by_station[s] = (out.open_count_by_station[s] || 0) + 1;
      });

      // Recent closures
      const cR = await env.DB.prepare(
        `SELECT incident_id, triage, station, ts, closed_at,
                (closed_at - ts) AS duration_sec
         FROM dispatch_log
         WHERE closed_at >= ?1 AND closed_at < ?2
         ORDER BY closed_at DESC LIMIT 30`
      ).bind(now - lookback, now).all();
      out.recent_closures = cR.results || [];
      out.recent_closures_count = out.recent_closures.length;

      // Recent dispatches count
      const dR = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM dispatch_log WHERE ts >= ?1`
      ).bind(now - lookback).first();
      out.recent_dispatches_count = Number(dR?.n) || 0;

      // MCI status
      try {
        const m = await env.DB.prepare(
          `SELECT value FROM sync_state WHERE key = 'mci_status'`
        ).first();
        if (m && m.value) out.mci = JSON.parse(m.value);
      } catch (_) {}

      // Station status (latest per station)
      const sR = await env.DB.prepare(
        `SELECT station, status, capacity_pct, sub_location, ts
         FROM (
           SELECT station, status, capacity_pct, sub_location, ts,
                  ROW_NUMBER() OVER (PARTITION BY station ORDER BY ts DESC) AS rn
           FROM station_status_log
         ) WHERE rn = 1`
      ).all();
      out.station_status = sR.results || [];

      // Pending repositions
      try {
        const pR = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM reposition_log WHERE status = 'requested'`
        ).first();
        out.pending_repositions = Number(pR?.n) || 0;
      } catch (_) {}

      // Generate notes for next shift
      if (out.mci.active) out.notes_for_next_shift.push('⚠ MCI MODE IS ACTIVE — review level and reason');
      const reds = out.open_count_by_triage.red || 0;
      if (reds >= 3) out.notes_for_next_shift.push(`⚠ ${reds} RED triage incidents open`);
      const cardiac = out.open_incidents.filter(i => i.cardiac_arrest).length;
      if (cardiac > 0) out.notes_for_next_shift.push(`⚠ ${cardiac} cardiac arrest incident${cardiac>1?'s':''} active`);
      const long = out.open_incidents.filter(i => i.age_min >= 60).length;
      if (long > 0) out.notes_for_next_shift.push(`⚠ ${long} incident${long>1?'s':''} open >1hr — review for status update`);
      if (out.pending_repositions > 0) out.notes_for_next_shift.push(`${out.pending_repositions} reposition request${out.pending_repositions>1?'s':''} pending approval`);
      if (out.notes_for_next_shift.length === 0) out.notes_for_next_shift.push('No critical items requiring escalation');

    } catch (e) {
      out.error = String(e.message);
    }
    return out;
  },

  // ==============================================================
  // report_incident_detail — full timeline of one incident
  // ==============================================================
  async report_incident_detail(user, env, params) {
    const id = String(params.incident_id || '').trim();
    if (!id) return { ok: false, error: 'missing_incident_id' };
    try {
      const incR = await env.DB.prepare(
        `SELECT * FROM dispatch_log WHERE incident_id = ?1 LIMIT 1`
      ).bind(id).first();
      if (!incR) return { ok: false, error: 'not_found' };

      const evR = await env.DB.prepare(
        `SELECT e.event_type, e.ts, e.actor_nid, e.notes, w.name AS actor
         FROM incident_events e
         LEFT JOIN allowlist w ON w.nid = e.actor_nid
         WHERE e.incident_id = ?1 ORDER BY e.ts ASC`
      ).bind(id).all();

      const auR = await env.DB.prepare(
        `SELECT a.ts, a.action, a.actor_nid, a.details, w.name AS actor
         FROM audit_log a
         LEFT JOIN allowlist w ON w.nid = a.actor_nid
         WHERE a.resource_id = ?1 ORDER BY a.ts ASC`
      ).bind(id).all();

      // Compute response time if we have on_scene
      let response_sec = null;
      const events = evR.results || [];
      const onScene = events.find(e => e.event_type === 'on_scene');
      if (onScene && incR.ts) response_sec = onScene.ts - incR.ts;

      return {
        ok: true,
        incident: { ...incR, ts_iso: new Date(incR.ts * 1000).toISOString() },
        events: events.map(e => ({ ...e, ts_iso: new Date(e.ts * 1000).toISOString() })),
        audit: (auR.results || []).map(a => ({ ...a, ts_iso: new Date(a.ts * 1000).toISOString() })),
        response_time_sec: response_sec
      };
    } catch (e) {
      return { ok: false, error: 'detail_failed', detail: e.message };
    }
  },

  // ==============================================================
  // audit_search — filter audit log
  // ==============================================================
  async audit_search(user, env, params) {
    const filters = [];
    const binds = [];
    let i = 1;
    if (params.actor_nid) { filters.push('a.actor_nid = ?' + i++); binds.push(String(params.actor_nid)); }
    if (params.action)    { filters.push("a.action LIKE ?" + i++); binds.push('%' + params.action + '%'); }
    if (params.resource)  { filters.push('a.resource = ?' + i++); binds.push(String(params.resource)); }
    if (params.resource_id) { filters.push('a.resource_id = ?' + i++); binds.push(String(params.resource_id)); }
    if (params.from_ts)   { filters.push('a.ts >= ?' + i++); binds.push(parseInt(params.from_ts, 10)); }
    if (params.to_ts)     { filters.push('a.ts <= ?' + i++); binds.push(parseInt(params.to_ts, 10)); }
    const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
    const limit = Math.min(parseInt(params.limit || 200, 10), 500);
    try {
      const r = await env.DB.prepare(
        `SELECT a.ts, a.actor_nid, a.action, a.resource, a.resource_id, a.details,
                w.name AS actor_name, w.role AS actor_role
         FROM audit_log a LEFT JOIN allowlist w ON w.nid = a.actor_nid
         ${where}
         ORDER BY a.ts DESC LIMIT ${limit}`
      ).bind(...binds).all();
      return { ok: true, count: (r.results || []).length, results: (r.results || []).map(e => ({
        ...e, ts_iso: new Date(e.ts * 1000).toISOString()
      })) };
    } catch (e) {
      return { ok: false, error: 'search_failed', detail: e.message };
    }
  },

    _hajjDay(ts) {
    // DH 1 = May 27, 2026 = unix ts 1779408000 (00:00 +03:00)
    const dh1 = Date.UTC(2026, 4, 27) / 1000 - 3 * 3600;  // May 27 +03 midnight
    const day = Math.floor((ts - dh1) / 86400) + 1;
    if (day < 1) return 'D-' + (1 - day);
    if (day > 14) return 'Post-DH';
    return 'DH ' + day;
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
    // === DRILL MODE: tag this incident as drill if drill mode is active ===
    let _is_drill = 0;
    try {
      const dm = await env.DB.prepare(`SELECT value FROM sync_state WHERE key = 'drill_mode' LIMIT 1`).first();
      if (dm && dm.value) {
        const j = JSON.parse(dm.value);
        if (j && j.active) _is_drill = 1;
      }
    } catch (_) {}
    if (params && typeof params === 'object') params._is_drill = _is_drill;
    // Accept frontend legacy aliases (zone/category/case/case_field/unit) for backward compat with GAS-era forms
    const stationRaw = params.station || params.zone || params.region || '';
    const station = String(stationRaw).toUpperCase();
    if (!STATIONS.includes(station)) {
      return { ok: false, error: 'invalid_station', station, hint: 'send station=ARF1|...|MIN3' };
    }
    const triageRaw = params.triage || params.category || 'green';  // NOTE: NOT params.type — that's UNIT type
    const triage = String(triageRaw).toLowerCase();
    if (!['red','yellow','green','black'].includes(triage)) {
      return { ok: false, error: 'invalid_triage', triage };
    }
    const complaint = params.complaint || params.case_field || params.case || params.chief_complaint || '';
    const unitAssigned = params.unit_assigned || params.unit || null;
    const subLocation = params.sub_location || params.location || '';
    // Generate incident_id: DSP-YYYYMMDD-NNNN (sequential per day)
    const now = Math.floor(Date.now() / 1000);
    const dateStr = new Date(now * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    const seqRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM dispatch_log WHERE incident_id LIKE ?1`
    ).bind(`DSP-${dateStr}-%`).first();
    const seq = String((seqRow?.n || 0) + 1).padStart(4, '0');
    const incidentId = `DSP-${dateStr}-${seq}`;
    const cardiacArrest = (params.cardiac_arrest === 'true' || params.cardiac_arrest === '1' || params.cardiac_arrest === 'yes' || params.cardiac_arrest === true) ? 1 : 0;
    const patientCount = Math.max(1, parseInt(params.patient_count || '1', 10));
    const status = unitAssigned ? 'on_scene' : 'pending';
    try {
      await env.DB.prepare(
        `INSERT INTO dispatch_log
         (incident_id, ts, station, sub_location, source, complaint, triage,
          cardiac_arrest, unit_assigned, status, patient_count, notes, created_by_nid,
          age, gender, srca_case_number)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
      ).bind(
        incidentId, now, station,
        subLocation,
        params.source || 'walk-in',
        complaint,
        triage,
        cardiacArrest,
        unitAssigned,
        status,
        patientCount,
        params.notes || '',
        user.nid,
        params.age ? parseInt(params.age, 10) : null,
        params.gender || null,
        (params.srca_case_number || params.srca_case || params.srcaCase || '').trim() || null
      ).run();
      // Audit
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'dispatch_create', 'incident', ?2, ?3)`
      ).bind(user.nid, incidentId, JSON.stringify({ station, triage, status, complaint, unit: unitAssigned })).run();
      if (_is_drill === 1) {
        try {
          await env.DB.prepare(`UPDATE dispatch_log SET is_drill = 1 WHERE incident_id = ?1`).bind(incidentId).run();
        } catch (_) {}
      }
      return { ok: true, incident_id: incidentId, status, ts: now, is_drill: _is_drill };
    } catch (e) {
      return { ok: false, error: 'insert_failed', detail: e.message };
    }
  },

  async dispatch_event(user, env, params) {
    const incidentId = params.incident_id;
    const eventRaw = (params.event || params.event_type || '').toLowerCase();
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };
    // Canonical events tracked in incident_events table:
    const canonical = ['en_route','on_scene','patient_contact','transfer_start','hospital_arrival','handover'];
    // Aliases — accept legacy + alternate names from any frontend
    const aliasMap = {
      'unit_assigned': 'on_scene',     // legacy
      'arrived_hospital': 'hospital_arrival',
      'transporting': 'transfer_start',
      'transfer': 'transfer_start',
      'arrived': 'hospital_arrival'
    };
    const event = aliasMap[eventRaw] || eventRaw;
    if (!canonical.includes(event)) {
      return { ok: false, error: 'invalid_event', event: eventRaw, canonical_attempted: event, valid: canonical };
    }
    // Map event → dispatch_log.status (only major status transitions)
    const statusMap = {
      'on_scene': 'on_scene',
      'transfer_start': 'transporting',
      'hospital_arrival': 'transporting',
      'handover': 'transporting'
    };
    const newStatus = statusMap[event];   // undefined for en_route, patient_contact (timeline-only)
    const now = Math.floor(Date.now() / 1000);
    try {
      // 1) Always log the timeline event (each click = 1 row)
      await env.DB.prepare(
        `INSERT INTO incident_events (incident_id, event_type, ts, actor_nid, notes)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(incidentId, event, now, user.nid, params.notes || '').run();

      // 2) If event triggers a status change, update dispatch_log
      if (newStatus) {
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
      } else if (params.unit_assigned) {
        await env.DB.prepare(
          `UPDATE dispatch_log SET unit_assigned = ?1 WHERE incident_id = ?2`
        ).bind(params.unit_assigned, incidentId).run();
      }

      // 3) Audit
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'dispatch_event', 'incident', ?2, ?3)`
      ).bind(user.nid, incidentId, JSON.stringify({
        event, alias_from: eventRaw !== event ? eventRaw : null,
        new_status: newStatus || null, notes: params.notes || ''
      })).run();

      return { ok: true, incident_id: incidentId, event, status: newStatus || null, ts: now };
    } catch (e) {
      return { ok: false, error: 'update_failed', detail: e.message };
    }
  },

  async dispatch_close(user, env, params) {
    const incidentId = params.incident_id;
    let outcome = (params.outcome || params.decision || '').toLowerCase();
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };
    // Accept frontend aliases (Treat/Transfer/Refusal) → canonical
    const aliasMap = {
      'treat': 'treated_released',
      'treated': 'treated_released',
      'transfer': 'transferred',
      'refusal': 'refused',
      'refuse': 'refused',
      'cancel': 'cancelled',
      'death': 'deceased'
    };
    if (aliasMap[outcome]) outcome = aliasMap[outcome];
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
    // Accept both color (red/yellow/green/black) and operational (open/closed/degraded/surge/offline) vocabularies.
    const VALID_STATUSES = ['red','yellow','green','black','open','closed','degraded','surge','offline'];
    if (!VALID_STATUSES.includes(status)) {
      return { ok: false, error: 'invalid_status', status, valid: VALID_STATUSES };
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

  // ==================== REPOSITION APPROVE / REJECT ====================

  async reposition_approve(user, env, params) {
    const id = parseInt(params.id, 10);
    if (!id) return { ok: false, error: 'missing_id' };
    const now = Math.floor(Date.now() / 1000);
    try {
      const row = await env.DB.prepare(
        `SELECT * FROM reposition_log WHERE id = ?1`
      ).bind(id).first();
      if (!row) return { ok: false, error: 'not_found', id };
      if (row.status !== 'requested') return { ok: false, error: 'already_processed', current_status: row.status };

      // Cluster supervisor can only approve repositions touching their cluster
      if (user.role === 'cluster_supervisor' && user.cluster) {
        const clusterStations = CLUSTER_STATIONS[user.cluster.toLowerCase()] || [];
        if (!clusterStations.includes(row.from_station) && !clusterStations.includes(row.to_station)) {
          return { ok: false, error: 'cross_cluster_forbidden' };
        }
      }

      await env.DB.prepare(
        `UPDATE reposition_log SET status = 'approved', approved_at = ?1, approved_by_nid = ?2 WHERE id = ?3`
      ).bind(now, user.nid, id).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'reposition_approve', 'reposition', ?2, ?3)`
      ).bind(user.nid, String(id), JSON.stringify({
        unit_code: row.unit_code, from: row.from_station, to: row.to_station
      })).run();
      return { ok: true, id, status: 'approved', completed_at: now };
    } catch (e) {
      return { ok: false, error: 'approve_failed', detail: e.message };
    }
  },

  async reposition_reject(user, env, params) {
    const id = parseInt(params.id, 10);
    if (!id) return { ok: false, error: 'missing_id' };
    const now = Math.floor(Date.now() / 1000);
    try {
      const row = await env.DB.prepare(`SELECT * FROM reposition_log WHERE id = ?1`).bind(id).first();
      if (!row) return { ok: false, error: 'not_found', id };
      if (row.status !== 'requested') return { ok: false, error: 'already_processed', current_status: row.status };
      if (user.role === 'cluster_supervisor' && user.cluster) {
        const clusterStations = CLUSTER_STATIONS[user.cluster.toLowerCase()] || [];
        if (!clusterStations.includes(row.from_station) && !clusterStations.includes(row.to_station)) {
          return { ok: false, error: 'cross_cluster_forbidden' };
        }
      }
      await env.DB.prepare(
        `UPDATE reposition_log SET status = 'rejected', approved_at = ?1, approved_by_nid = ?2,
         notes = COALESCE(notes,'') || ?3 WHERE id = ?4`
      ).bind(now, user.nid, params.reason ? `\n[reject]: ${params.reason}` : '', id).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'reposition_reject', 'reposition', ?2, ?3)`
      ).bind(user.nid, String(id), JSON.stringify({
        unit_code: row.unit_code, from: row.from_station, to: row.to_station, reason: params.reason || ''
      })).run();
      return { ok: true, id, status: 'rejected', completed_at: now };
    } catch (e) {
      return { ok: false, error: 'reject_failed', detail: e.message };
    }
  },

  // ==================== DISPATCH EDIT (with audit trail) ====================

  async dispatch_edit(user, env, params) {
    const incidentId = params.incident_id;
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };

    // Editable fields only — incident_id, ts, created_by, closed_at, closed_by are immutable
    const EDITABLE = ['station','sub_location','source','complaint','triage','cardiac_arrest',
                      'unit_assigned','status','patient_count','notes'];
    const updates = {};
    EDITABLE.forEach(f => {
      if (params[f] !== undefined && params[f] !== null && params[f] !== '') {
        updates[f] = params[f];
      }
    });
    if (Object.keys(updates).length === 0) {
      return { ok: false, error: 'no_changes' };
    }

    // Validate constrained fields
    if (updates.station) {
      updates.station = updates.station.toUpperCase();
      if (!STATIONS.includes(updates.station)) {
        return { ok: false, error: 'invalid_station', station: updates.station };
      }
    }
    if (updates.triage && !['red','yellow','green','black'].includes(updates.triage.toLowerCase())) {
      return { ok: false, error: 'invalid_triage', triage: updates.triage };
    }
    if (updates.triage) updates.triage = updates.triage.toLowerCase();
    if (updates.status) {
      const validStatuses = ['pending','on_scene','transporting','complete','cancelled'];
      updates.status = updates.status.toLowerCase();
      if (!validStatuses.includes(updates.status)) {
        return { ok: false, error: 'invalid_status', status: updates.status, valid: validStatuses };
      }
    }
    if (updates.cardiac_arrest !== undefined) {
      updates.cardiac_arrest = (updates.cardiac_arrest === 'true' || updates.cardiac_arrest === '1' ||
                               updates.cardiac_arrest === true || updates.cardiac_arrest === 1) ? 1 : 0;
    }
    if (updates.patient_count !== undefined) {
      updates.patient_count = Math.max(1, parseInt(updates.patient_count, 10) || 1);
    }

    try {
      // Fetch current state for audit diff
      const before = await env.DB.prepare(
        `SELECT incident_id, station, sub_location, source, complaint, triage,
                cardiac_arrest, unit_assigned, status, patient_count, notes
         FROM dispatch_log WHERE incident_id = ?1`
      ).bind(incidentId).first();
      if (!before) return { ok: false, error: 'incident_not_found', incident_id: incidentId };

      // Build SET clause dynamically
      const setClauses = [];
      const bindVals = [];
      Object.keys(updates).forEach((k, i) => {
        setClauses.push(`${k} = ?${i + 1}`);
        bindVals.push(updates[k]);
      });
      bindVals.push(incidentId);

      const r = await env.DB.prepare(
        `UPDATE dispatch_log SET ${setClauses.join(', ')} WHERE incident_id = ?${bindVals.length}`
      ).bind(...bindVals).run();
      if (r.meta?.changes === 0) return { ok: false, error: 'no_rows_updated' };

      // Compute the diff for audit log
      const changes = {};
      Object.keys(updates).forEach(k => {
        if (before[k] !== updates[k]) {
          changes[k] = { from: before[k], to: updates[k] };
        }
      });
      await env.DB.prepare(
        `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
         VALUES (?1, 'dispatch_edit', 'incident', ?2, ?3)`
      ).bind(user.nid, incidentId, JSON.stringify({ changes, edit_time: new Date().toISOString() })).run();

      return { ok: true, incident_id: incidentId, changes, edited_at: new Date().toISOString() };
    } catch (e) {
      return { ok: false, error: 'edit_failed', detail: e.message };
    }
  },

  async incident_audit_trail(user, env, params) {
    // Returns audit log entries for a specific incident
    const incidentId = params.incident_id;
    if (!incidentId) return { ok: false, error: 'missing_incident_id' };
    try {
      const r = await env.DB.prepare(
        `SELECT a.id, a.ts, a.actor_nid, a.action, a.details, l.name AS actor_name
         FROM audit_log a LEFT JOIN allowlist l ON l.nid = a.actor_nid
         WHERE a.resource = 'incident' AND a.resource_id = ?1
         ORDER BY a.ts ASC`
      ).bind(incidentId).all();
      const entries = (r.results || []).map(row => ({
        id: row.id,
        ts: new Date(row.ts * 1000).toISOString(),
        actor_nid: row.actor_nid,
        actor_name: row.actor_name,
        action: row.action,
        details: row.details ? JSON.parse(row.details) : {}
      }));
      return { ok: true, incident_id: incidentId, entries, count: entries.length };
    } catch (e) {
      return { ok: false, error: 'fetch_failed', detail: e.message };
    }
  },

  // ==============================================================
  // docs_get / docs_save — editable in-app docs (protocols, runbook, training)
  // Stored in editable_docs table; markdown content, versioned.
  // ==============================================================
  async _ensureDocsTable(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS editable_docs (
      slug TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      updated_by_nid TEXT,
      updated_by_name TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`).run();
  },

  async docs_get(user, env, params) {
    await ACTIONS._ensureDocsTable(env);
    const slug = String(params.slug || '').trim().toLowerCase();
    if (!slug) return { ok: false, error: 'missing_slug' };
    try {
      const r = await env.DB.prepare(
        `SELECT slug, title, content, version, updated_by_nid, updated_by_name, updated_at
         FROM editable_docs WHERE slug = ?1`
      ).bind(slug).first();
      if (!r) return { ok: true, slug, content: '', version: 0, exists: false };
      return { ok: true, ...r, exists: true };
    } catch (e) { return { ok: false, error: 'fetch_failed', detail: e.message }; }
  },

  async docs_save(user, env, params) {
    await ACTIONS._ensureDocsTable(env);
    const slug = String(params.slug || '').trim().toLowerCase();
    const title = String(params.title || '').trim();
    const content = String(params.content || '');
    if (!slug) return { ok: false, error: 'missing_slug' };
    const now = Math.floor(Date.now() / 1000);
    try {
      // Upsert with version increment
      await env.DB.prepare(
        `INSERT INTO editable_docs (slug, title, content, version, updated_by_nid, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
         ON CONFLICT(slug) DO UPDATE SET
           title = COALESCE(NULLIF(?2, ''), title),
           content = ?3,
           version = version + 1,
           updated_by_nid = ?4,
           updated_by_name = ?5,
           updated_at = ?6`
      ).bind(slug, title, content, user.nid, user.name || '', now).run();
      const r = await env.DB.prepare(
        `SELECT version, updated_at FROM editable_docs WHERE slug = ?1`
      ).bind(slug).first();
      return { ok: true, slug, version: r?.version || 1, updated_at: r?.updated_at || now };
    } catch (e) { return { ok: false, error: 'save_failed', detail: e.message }; }
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

// ===================================================================
// /api/v2/migrate_pcr — Bulk import historical PCRs from PCR Apps Script
// Admin/leadership-only. POST JSON body. Inserts via INSERT OR IGNORE.
// ===================================================================
async function handleMigratePCR(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }
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

  const pcrs = Array.isArray(body.pcrs) ? body.pcrs : (Array.isArray(body) ? body : []);
  const result = { pulled: pcrs.length, inserted: 0, skipped: 0, errors: [] };

  // Pre-fetch valid NIDs for FK safety
  const validNids = new Set();
  try {
    const r = await env.DB.prepare(`SELECT nid FROM allowlist`).all();
    (r.results || []).forEach(row => validNids.add(String(row.nid)));
  } catch (_) {}
  const safeNid = (nid) => {
    if (!nid) return null;
    return validNids.has(String(nid)) ? String(nid) : null;
  };

  for (const pcr of pcrs) {
    try {
      // Accept many possible field names — GAS PCR sheets vary
      const pcrId = pcr.PCR_ID || pcr.pcr_id || pcr.id || pcr.Id;
      if (!pcrId) { result.errors.push({ reason: 'missing_pcr_id', sample: JSON.stringify(pcr).slice(0, 100) }); continue; }

      let ts = 0;
      const tsRaw = pcr.Timestamp || pcr.timestamp || pcr.Created_At || pcr.created_at || pcr.ts || pcr.Date || pcr.date;
      if (tsRaw) {
        if (typeof tsRaw === 'number') ts = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : Math.floor(tsRaw);
        else { const d = new Date(tsRaw); ts = isNaN(d) ? 0 : Math.floor(d.getTime() / 1000); }
      }
      if (!ts) ts = Math.floor(Date.now() / 1000);

      const station = String(pcr.Station || pcr.Zone || pcr.station || '').toUpperCase() || null;
      const unitCode = pcr.Unit || pcr.unit_code || pcr.Unit_Code || null;
      const incidentId = pcr.Incident_ID || pcr.incident_id || null;
      const triage = String(pcr.Triage || pcr.Category || pcr.triage_category || '').toLowerCase() || null;
      const disposition = String(pcr.Disposition || pcr.disposition || pcr.Decision || '').toLowerCase().replace(/\s+/g, '_') || null;

      // Build vitals JSON from common keys
      const vitals = {};
      ['BP','HR','RR','SpO2','SPO2','Temp','Temperature','GCS','Pain'].forEach(k => {
        if (pcr[k] !== undefined && pcr[k] !== null && pcr[k] !== '') vitals[k.toLowerCase()] = pcr[k];
      });
      const vitalsJson = Object.keys(vitals).length ? JSON.stringify(vitals) : null;

      const insertResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO qpcr_log (
           pcr_id, ts, incident_id, station, unit_code,
           patient_name, patient_age, patient_gender, patient_nationality,
           chief_complaint, triage_category, vitals_json, treatment, disposition,
           transferred_to, responder_nid, notes, raw_json
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5,
           ?6, ?7, ?8, ?9,
           ?10, ?11, ?12, ?13, ?14,
           ?15, ?16, ?17, ?18
         )`
      ).bind(
        String(pcrId), ts, incidentId, station, unitCode,
        pcr.Patient_Name || pcr.patient_name || null,
        parseInt(pcr.Age || pcr.patient_age || '0', 10) || null,
        pcr.Gender || pcr.patient_gender || null,
        pcr.Nationality || pcr.patient_nationality || null,
        pcr.Chief_Complaint || pcr.chief_complaint || pcr.Complaint || null,
        triage,
        vitalsJson,
        pcr.Treatment || pcr.treatment || null,
        disposition,
        pcr.Transferred_To || pcr.transferred_to || pcr.Hospital || null,
        safeNid(pcr.Responder_NID || pcr.responder_nid || pcr.Crew),
        pcr.Notes || pcr.notes || null,
        JSON.stringify(pcr).slice(0, 4000)
      ).run();

      if (insertResult.meta && insertResult.meta.changes > 0) result.inserted++;
      else result.skipped++;
    } catch (e) {
      result.errors.push({ pcr_id: pcr.PCR_ID || pcr.pcr_id || '?', error: String(e.message).slice(0, 200) });
    }
  }

  // Audit log
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (actor_nid, action, resource, resource_id, details)
       VALUES (?1, 'migrate_pcr', 'bulk', 'pcr_import', ?2)`
    ).bind(user.nid, JSON.stringify(result)).run();
  } catch (_) {}

  return jsonResponse({ ok: true, result });
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
