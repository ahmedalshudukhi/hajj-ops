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
    const limit = Math.min(parseInt(params.limit || '100', 10), 500);
    const r = await env.DB.prepare(
      `SELECT incident_id AS Incident_ID, ts, station AS Zone, sub_location,
              source AS Source, complaint AS Chief_Complaint, triage AS Category,
              cardiac_arrest, unit_assigned AS Unit, status AS Status,
              patient_count, notes AS Notes, created_by_nid AS Created_By
       FROM dispatch_log ORDER BY ts DESC LIMIT ?1`
    ).bind(limit).all();
    const incidents = (r.results || []).map(row => {
      row.Created_At = new Date(row.ts * 1000).toISOString();
      delete row.ts;
      return row;
    });
    return { ok: true, incidents, server_time: new Date().toISOString() };
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
    const a = (dj && dj.augmentations) || {};
    // Apps Script returns rows array; data.json has summary + matrix
    // For diag compatibility we return summary-shape with rows:[] when not available
    return {
      ok: true,
      total: a.total || 0,
      active: a.active || 0,
      planned: a.planned || 0,
      returned: a.returned || 0,
      cancelled: a.cancelled || 0,
      total_para_moved: a.total_para_moved || 0,
      by_movement: a.by_movement || {},
      by_donor: a.by_donor || {},
      by_recipient: a.by_recipient || {},
      matrix: a.matrix || {},
      rows: a.sample || []   // sample rows for inspection
    };
  },

  async mobilization_plan(user, env, params, dj) {
    // Apps Script returns rows from sheet. data.json doesn't have raw sheet rows.
    // Return empty rows + headers; frontend usually shows summary anyway.
    return { ok: true, rows: [], total: 0, headers: [] };
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
    // Aggregate dispatch + station status + unit positions
    let dispatchAgg = { open: 0, closed_today: 0, in_transfer: 0 };
    const todayStart = Math.floor(new Date().setHours(0,0,0,0) / 1000);
    try {
      const r = await env.DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM dispatch_log WHERE status NOT IN ('complete','cancelled')) AS open_n,
          (SELECT COUNT(*) FROM dispatch_log WHERE status = 'complete' AND closed_at >= ?1) AS closed_n,
          (SELECT COUNT(*) FROM dispatch_log WHERE status = 'transporting') AS transfer_n`
      ).bind(todayStart).first();
      dispatchAgg = { open: r.open_n || 0, closed_today: r.closed_n || 0, in_transfer: r.transfer_n || 0 };
    } catch (_) {}

    const stationsResult = await ACTIONS.station_status_list(user, env, params, dj);
    const unitsResult = await ACTIONS.unit_positions(user, env, params, dj);

    return {
      ok: true,
      dispatch: dispatchAgg,
      pcr: { total: 0, today: 0 },  // placeholder until we wire PCR aggregation
      stations: stationsResult.stations,
      units: unitsResult.positions,
      server_time: new Date().toISOString()
    };
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
    const [units, incidents, stations] = await Promise.all([
      ACTIONS.unit_availability(user, env, params, dj),
      ACTIONS.dispatch_list(user, env, params, dj),
      ACTIONS.station_status_list(user, env, params, dj)
    ]);
    return {
      ok: true,
      server_time: new Date().toISOString(),
      units: units.units, incidents: incidents.incidents,
      station_status: stations.stations
    };
  },

  async dashboard_sv(user, env, params, dj) {
    const [stations, repos, units] = await Promise.all([
      ACTIONS.station_status_list(user, env, params, dj),
      ACTIONS.reposition_list(user, env, params, dj),
      ACTIONS.unit_availability(user, env, params, dj)
    ]);
    return {
      ok: true,
      server_time: new Date().toISOString(),
      station_status: stations.stations,
      repositions: repos,
      units: units.units
    };
  },

};

// === Router ===
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

export { handleExecV2, ACTIONS };
