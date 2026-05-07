/**
 * HMG Hajj 2026 — Backend (v2: Active Insights)
 * Apps Script web app backing hajj.shuki.tech
 *
 * Sheets in the bound spreadsheet (run setupSheets() once to create):
 *   Allowlist        staff roster + auth (NID + Mobile last-4)
 *   Schedule         per-NID per-day shift assignments
 *   Sessions         active session tokens
 *   Auth_Log         every login attempt (success or fail)
 *   Dispatch_Log     incident records (one row per incident)
 *   Dispatch_Events  full audit trail of card events
 *   Q_PCR            backup quick patient care reports (DCH's PCR_Log is primary)
 *   Check_Ins        Tier 1 paramedic check-ins (used later)
 *
 * External sheets read by `active_summary`:
 *   PCR_Log (in DCH's Q-PCR Log spreadsheet — owned by Ahmed)
 */

const CONFIG = {
  SESSION_HOURS: 12,
  RATE_LIMIT_WINDOW_SEC: 300,
  RATE_LIMIT_MAX_FAILURES: 5,
  TOKEN_LENGTH: 32,
  DISPATCH_LIST_LOOKBACK_HOURS: 24,
  // Active Insights — read PCR aggregations from DCH's PCR_Log sheet
  PCR_LOG_SHEET_ID: '1BnFW2Dr-v9GH1nI9ExNSvqEtroc-4tX3uv2bt_eQUG0',
  PCR_LOG_TAB: 'PCR_Log'
};

const SHEETS = {
  ALLOWLIST: 'Allowlist',
  SCHEDULE: 'Schedule',
  SESSIONS: 'Sessions',
  AUTH_LOG: 'Auth_Log',
  DISPATCH_LOG: 'Dispatch_Log',
  DISPATCH_EVENTS: 'Dispatch_Events',
  Q_PCR: 'Q_PCR',
  CHECK_INS: 'Check_Ins'
};

const ROLES = {
  PARAMEDIC: 'paramedic',
  GP: 'gp',
  DISPATCHER: 'dispatcher',
  CLUSTER_SUPERVISOR: 'cluster_supervisor',
  LEADERSHIP: 'leadership',
  ADMIN: 'admin'
};

// ============================================================
// ROUTER
// ============================================================

function doGet(e)  { return route_(e); }
function doPost(e) { return route_(e); }

function route_(e) {
  let response;
  try {
    const action = String((e.parameter && e.parameter.action) || '').toLowerCase();
    let body = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (_) {}
    }
    const params = Object.assign({}, e.parameter || {}, body);

    if (action === 'ping') {
      response = { ok: true, ts: new Date().toISOString() };
    } else if (action === 'auth') {
      response = authenticate_(params);
    } else {
      const session = validateToken_(params.token);
      if (!session.ok) {
        response = { ok: false, error: 'unauthorized' };
      } else {
        switch (action) {
          case 'roster':           response = getRoster_(session.user); break;
          case 'whoami':           response = { ok: true, user: publicUser_(session.user) }; break;
          case 'logout':           response = logout_(params.token); break;
          case 'dispatch_create':  response = dispatchCreate_(session.user, params); break;
          case 'dispatch_event':   response = dispatchEvent_(session.user, params); break;
          case 'dispatch_list':    response = dispatchList_(session.user, params); break;
          case 'dispatch_close':   response = dispatchClose_(session.user, params); break;
          case 'qpcr_submit':      response = qpcrSubmit_(session.user, params); break;
          case 'stats':            response = getStats_(session.user, params); break;
          case 'active_summary':   response = getActiveSummary_(session.user, params); break;
          default:                 response = { ok: false, error: 'unknown_action', action: action };
        }
      }
    }
  } catch (err) {
    response = { ok: false, error: 'server_error', message: String(err && err.message || err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// AUTH
// ============================================================

function authenticate_(params) {
  const nid = String(params.nid || '').trim();
  const last4 = String(params.last4 || '').trim();
  const ip = String(params.ip || 'unknown');
  const ua = String(params.ua || '');

  if (!/^\d{10}$/.test(nid)) {
    return logAuth_(nid, ip, ua, 'invalid_nid_format', { ok: false, error: 'invalid_credentials' });
  }
  if (!/^\d{4}$/.test(last4)) {
    return logAuth_(nid, ip, ua, 'invalid_last4_format', { ok: false, error: 'invalid_credentials' });
  }

  if (isRateLimited_(nid, ip)) {
    return logAuth_(nid, ip, ua, 'rate_limited', { ok: false, error: 'rate_limited' });
  }

  const user = findInAllowlist_(nid);
  if (!user) {
    return logAuth_(nid, ip, ua, 'nid_not_found', { ok: false, error: 'invalid_credentials' });
  }
  if (!isActive_(user)) {
    return logAuth_(nid, ip, ua, 'inactive', { ok: false, error: 'invalid_credentials' });
  }

  const storedLast4 = String(user.Mobile || '').replace(/\D/g, '').slice(-4);
  if (storedLast4 !== last4) {
    return logAuth_(nid, ip, ua, 'wrong_last4', { ok: false, error: 'invalid_credentials' });
  }

  const token = randomToken_();
  const now = new Date();
  const expires = new Date(now.getTime() + CONFIG.SESSION_HOURS * 3600 * 1000);
  appendRow_(SHEETS.SESSIONS, [token, nid, now, expires, now, ip, ua]);
  logAuth_(nid, ip, ua, 'success', null);

  return {
    ok: true, token: token, expires: expires.toISOString(),
    user: publicUser_(user)
  };
}

function validateToken_(token) {
  if (!token) return { ok: false };
  const sh = sheet_(SHEETS.SESSIONS);
  if (!sh) return { ok: false };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: false };
  const headers = data[0];
  const tokenIdx = headers.indexOf('Token');
  const expiresIdx = headers.indexOf('Expires');
  const nidIdx = headers.indexOf('NID');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][tokenIdx]) === String(token)) {
      const exp = new Date(data[i][expiresIdx]);
      if (exp < new Date()) return { ok: false };
      const user = findInAllowlist_(String(data[i][nidIdx]));
      if (!user || !isActive_(user)) return { ok: false };
      return { ok: true, user: user };
    }
  }
  return { ok: false };
}

function logout_(token) {
  if (!token) return { ok: true };
  const sh = sheet_(SHEETS.SESSIONS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: true };
  const headers = data[0];
  const tokenIdx = headers.indexOf('Token');
  const expiresIdx = headers.indexOf('Expires');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][tokenIdx]) === String(token)) {
      sh.getRange(i + 1, expiresIdx + 1).setValue(new Date(0));
      break;
    }
  }
  return { ok: true };
}

function isRateLimited_(nid, ip) {
  // Disabled per ops decision (2026-05-06). Auth_Log still records attempts.
  return false;
}

function logAuth_(nid, ip, ua, result, passthrough) {
  appendRow_(SHEETS.AUTH_LOG, [new Date(), nid, ip, ua, result]);
  return passthrough;
}

function findInAllowlist_(nid) {
  const sh = sheet_(SHEETS.ALLOWLIST);
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  const headers = data[0];
  const nidIdx = headers.indexOf('NID');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nidIdx]) === String(nid)) {
      return rowToObject_(headers, data[i]);
    }
  }
  return null;
}

function isActive_(user) {
  const v = user.Active;
  return v === true || String(v).toLowerCase() === 'true' || v === 1 || String(v).toLowerCase() === 'yes';
}

function publicUser_(user) {
  return {
    nid: user.NID, name: user.Name, name_ar: user.Name_AR,
    role: user.Role, station: user.Station, zone: user.Zone,
    unit: user.Unit, callsign: user.Callsign,
    accommodation: user.Accommodation,
    team_lead: user.Team_Lead, team_lead_mobile: user.Team_Lead_Mobile
  };
}

// ============================================================
// ROSTER
// ============================================================

function getRoster_(user) {
  return { ok: true, user: publicUser_(user), schedule: getScheduleForNID_(user.NID) };
}

function getScheduleForNID_(nid) {
  const sh = sheet_(SHEETS.SCHEDULE);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const nidIdx = headers.indexOf('NID');
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nidIdx]) === String(nid)) {
      out.push(rowToObject_(headers, data[i]));
    }
  }
  const dateIdx = headers.indexOf('Date');
  if (dateIdx >= 0) out.sort((a, b) => new Date(a.Date) - new Date(b.Date));
  return out;
}

// ============================================================
// DISPATCH
// ============================================================

function dispatchCreate_(user, params) {
  if (!hasRole_(user, [ROLES.DISPATCHER, ROLES.LEADERSHIP, ROLES.ADMIN])) {
    return { ok: false, error: 'forbidden' };
  }
  const id = 'INC-' + Utilities.formatDate(new Date(), 'GMT+3', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random()*1000);
  const now = new Date();
  appendRow_(SHEETS.DISPATCH_LOG, [
    id, now, user.NID,
    params.region || '', params.zone || '', params.station || '',
    params.source || '', params.case_field || params['case'] || '', params.unit || '',
    params.type || '', params.shift || '', params.category || '',
    '', '', '',
    '',
    '', '', '', '',
    '',
    params.notes || '',
    'open', ''
  ]);
  appendRow_(SHEETS.DISPATCH_EVENTS, [now, id, 'dispatch_created', user.NID, JSON.stringify(stripMeta_(params))]);
  return { ok: true, incident_id: id, created_at: now.toISOString() };
}

function dispatchEvent_(user, params) {
  if (!hasRole_(user, [ROLES.DISPATCHER, ROLES.LEADERSHIP, ROLES.ADMIN])) {
    return { ok: false, error: 'forbidden' };
  }
  const id = String(params.incident_id || '');
  const eventType = String(params.event_type || '').toLowerCase();
  if (!id || !eventType) return { ok: false, error: 'missing_params' };

  const now = new Date();
  const colMap = {
    'en_route': 'En_Route_At', 'on_scene': 'On_Scene_At',
    'patient_contact': 'Patient_Contact_At', 'transfer_start': 'Transfer_Start',
    'hospital_arrival': 'Hospital_Arrival', 'handover': 'Handover'
  };
  const col = colMap[eventType];
  if (col) updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, col, now);
  appendRow_(SHEETS.DISPATCH_EVENTS, [now, id, eventType, user.NID, JSON.stringify(stripMeta_(params))]);
  return { ok: true, timestamp: now.toISOString() };
}

function dispatchList_(user, params) {
  const sh = sheet_(SHEETS.DISPATCH_LOG);
  if (!sh) return { ok: true, incidents: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: true, incidents: [] };
  const headers = data[0];
  const out = [];
  const sinceTs = params.since
    ? new Date(params.since)
    : new Date(Date.now() - CONFIG.DISPATCH_LIST_LOOKBACK_HOURS * 3600 * 1000);
  const createdIdx = headers.indexOf('Created_At');
  for (let i = 1; i < data.length; i++) {
    const created = new Date(data[i][createdIdx]);
    if (created >= sinceTs) out.push(rowToObject_(headers, data[i]));
  }
  return { ok: true, incidents: out, server_time: new Date().toISOString() };
}

function dispatchClose_(user, params) {
  if (!hasRole_(user, [ROLES.DISPATCHER, ROLES.LEADERSHIP, ROLES.ADMIN])) {
    return { ok: false, error: 'forbidden' };
  }
  const id = String(params.incident_id || '');
  const decision = String(params.decision || '');
  if (!id || !decision) return { ok: false, error: 'missing_params' };

  const now = new Date();
  updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Closed_At', now);
  updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Decision', decision);
  updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Status', 'closed');
  if (params.transfer_hospital) {
    updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Transfer_Hospital', String(params.transfer_hospital));
  }
  appendRow_(SHEETS.DISPATCH_EVENTS, [now, id, 'closed:' + decision, user.NID, JSON.stringify(stripMeta_(params))]);
  return { ok: true, closed_at: now.toISOString() };
}

// ============================================================
// Q-PCR (backup; primary writer is DCH's script)
// ============================================================

function qpcrSubmit_(user, params) {
  const id = 'PCR-' + Utilities.formatDate(new Date(), 'GMT+3', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random()*1000);
  const now = new Date();
  const incidentId = String(params.incident_id || '');
  const payload = stripMeta_(params);
  appendRow_(SHEETS.Q_PCR, [id, now, user.NID, incidentId, JSON.stringify(payload)]);
  if (incidentId) {
    updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', incidentId, 'Q_PCR_ID', id);
  }
  return { ok: true, qpcr_id: id, submitted_at: now.toISOString() };
}

// ============================================================
// STATS (legacy — used by dispatch.html)
// ============================================================

function getStats_(user, params) {
  const dispatch = sheet_(SHEETS.DISPATCH_LOG).getDataRange().getValues();
  let open = 0, closed = 0;
  const byCategory = { resus: 0, urgent: 0, less: 0 };
  const byStation = {};
  if (dispatch.length > 1) {
    const h = dispatch[0];
    const statusIdx = h.indexOf('Status');
    const catIdx = h.indexOf('Category');
    const stationIdx = h.indexOf('Station');
    const zoneIdx = h.indexOf('Zone');
    for (let i = 1; i < dispatch.length; i++) {
      if (dispatch[i][statusIdx] === 'open') open++;
      else if (dispatch[i][statusIdx] === 'closed') closed++;
      const cat = String(dispatch[i][catIdx] || '').toLowerCase();
      if (byCategory[cat] !== undefined) byCategory[cat]++;
      const stationKey = String(dispatch[i][stationIdx] || dispatch[i][zoneIdx] || 'unknown');
      byStation[stationKey] = (byStation[stationKey] || 0) + 1;
    }
  }
  const qpcr = sheet_(SHEETS.Q_PCR).getDataRange().getValues();
  return {
    ok: true,
    dispatch: { open: open, closed: closed, total: open + closed, by_category: byCategory, by_station: byStation },
    qpcr: { total: Math.max(0, qpcr.length - 1) },
    server_time: new Date().toISOString()
  };
}

// ============================================================
// ACTIVE SUMMARY (Tier 3 leadership view)
// ============================================================

function getActiveSummary_(user, params) {
  if (!hasRole_(user, [ROLES.LEADERSHIP, ROLES.ADMIN, ROLES.CLUSTER_SUPERVISOR])) {
    return { ok: false, error: 'forbidden' };
  }
  return {
    ok: true,
    dispatch: aggregateDispatch_(),
    pcr:      aggregatePCR_(),
    server_time: new Date().toISOString()
  };
}

function aggregateDispatch_() {
  const sh = sheet_(SHEETS.DISPATCH_LOG);
  if (!sh) return emptyDispatchAgg_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return emptyDispatchAgg_();

  const h = data[0];
  const idx = (n) => h.indexOf(n);
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);

  const byStation = {};
  const byCategory = { resus: 0, urgent: 0, less: 0 };
  let openTotal = 0, closedToday = 0, inTransfer = 0, resusOpen = 0;
  const responseTimesMs = [];
  const recentStrip = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const status   = String(r[idx('Status')] || '');
    const station  = String(r[idx('Station')] || r[idx('Zone')] || 'unknown');
    const category = String(r[idx('Category')] || '').toLowerCase();
    const created  = r[idx('Created_At')] ? new Date(r[idx('Created_At')]) : null;
    const closedAt = r[idx('Closed_At')]  ? new Date(r[idx('Closed_At')])  : null;
    const transferStart = r[idx('Transfer_Start')] ? new Date(r[idx('Transfer_Start')]) : null;
    const ptContact     = r[idx('Patient_Contact_At')] ? new Date(r[idx('Patient_Contact_At')]) : null;

    if (!byStation[station]) byStation[station] = { open: 0, closed_today: 0, in_transfer: 0, resus_open: 0 };

    if (status === 'open') {
      openTotal++;
      byStation[station].open++;
      if (transferStart && !closedAt) { inTransfer++; byStation[station].in_transfer++; }
      if (category === 'resus') { resusOpen++; byStation[station].resus_open++; }
    }
    if (status === 'closed' && closedAt && closedAt >= todayStart) {
      closedToday++;
      byStation[station].closed_today++;
    }

    if (byCategory[category] !== undefined) byCategory[category]++;

    if (created && ptContact && ptContact > created) {
      responseTimesMs.push(ptContact - created);
    }

    if (created && created >= todayStart) {
      recentStrip.push({
        id: r[idx('Incident_ID')],
        created: created.toISOString(),
        station: station,
        category: category,
        status: status,
        decision: r[idx('Decision')] || '',
        in_transfer: !!transferStart && !closedAt,
        case: r[idx('Case')] || ''
      });
    }
  }

  recentStrip.sort((a,b) => new Date(b.created) - new Date(a.created));

  return {
    open: openTotal,
    closed_today: closedToday,
    in_transfer: inTransfer,
    resus_open: resusOpen,
    by_category: byCategory,
    by_station: byStation,
    response_time: percentiles_(responseTimesMs),
    recent: recentStrip.slice(0, 20)
  };
}

function aggregatePCR_() {
  let sh;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.PCR_LOG_SHEET_ID);
    sh = ss.getSheetByName(CONFIG.PCR_LOG_TAB);
  } catch (e) {
    return { ok: false, error: 'pcr_log_unreachable', message: String(e && e.message || e) };
  }
  if (!sh) return emptyPcrAgg_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return emptyPcrAgg_();

  const h = data[0];
  const idx = (n) => h.indexOf(n);
  const tsIdx        = idx('Timestamp');
  const stationIdx   = idx('Station');
  const acuityIdx    = idx('Acuity');
  const dispoIdx     = idx('Disposition');
  const complaintIdx = idx('Complaint');
  const ageIdx       = idx('Age');
  const genderIdx    = idx('Gender');

  const todayStart = new Date(); todayStart.setHours(0,0,0,0);

  let total = 0, today = 0;
  const byAcuity   = {};
  const byDispo    = {};
  const byStation  = {};
  const complaints = {};
  const recent     = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const ts = tsIdx >= 0 && r[tsIdx] ? new Date(r[tsIdx]) : null;
    total++;
    if (ts && ts >= todayStart) today++;

    const acuity = String(r[acuityIdx] || '').toLowerCase().trim() || 'unspecified';
    byAcuity[acuity] = (byAcuity[acuity] || 0) + 1;

    const dispo = String(r[dispoIdx] || '').trim() || 'unspecified';
    byDispo[dispo] = (byDispo[dispo] || 0) + 1;

    const station = String(r[stationIdx] || '').toUpperCase().trim() || 'UNK';
    byStation[station] = (byStation[station] || 0) + 1;

    const c = String(r[complaintIdx] || '').toLowerCase().trim();
    if (c) complaints[c] = (complaints[c] || 0) + 1;

    if (ts && ts >= todayStart) {
      recent.push({
        ts: ts.toISOString(),
        station: station,
        acuity: acuity,
        complaint: r[complaintIdx] || '',
        age: r[ageIdx] || '',
        gender: r[genderIdx] || '',
        dispo: dispo
      });
    }
  }

  recent.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const topComplaints = Object.entries(complaints)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => ({ complaint: k, count: v }));

  return {
    total: total, today: today,
    by_acuity: byAcuity, by_disposition: byDispo, by_station: byStation,
    top_complaints: topComplaints,
    recent: recent.slice(0, 20)
  };
}

function emptyDispatchAgg_() {
  return { open: 0, closed_today: 0, in_transfer: 0, resus_open: 0,
           by_category: { resus:0, urgent:0, less:0 }, by_station: {},
           response_time: { mean_ms: 0, p50_ms: 0, p95_ms: 0, count: 0 },
           recent: [] };
}
function emptyPcrAgg_() {
  return { total: 0, today: 0, by_acuity: {}, by_disposition: {},
           by_station: {}, top_complaints: [], recent: [] };
}

function percentiles_(arr) {
  const n = arr.length;
  if (!n) return { mean_ms: 0, p50_ms: 0, p95_ms: 0, count: 0 };
  const sorted = arr.slice().sort((a, b) => a - b);
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const p = (q) => sorted[Math.min(n - 1, Math.floor(q * n))];
  return { mean_ms: Math.round(mean), p50_ms: p(0.5), p95_ms: p(0.95), count: n };
}

// ============================================================
// HELPERS
// ============================================================

function sheet_(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }
function appendRow_(sheetName, row) { const sh = sheet_(sheetName); if (sh) sh.appendRow(row); }
function rowToObject_(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
  return obj;
}
function updateCellByID_(sheetName, idCol, idVal, targetCol, value) {
  const sh = sheet_(sheetName); if (!sh) return false;
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  const headers = data[0];
  const idIdx = headers.indexOf(idCol);
  const targetIdx = headers.indexOf(targetCol);
  if (idIdx < 0 || targetIdx < 0) return false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(idVal)) {
      sh.getRange(i + 1, targetIdx + 1).setValue(value);
      return true;
    }
  }
  return false;
}
function randomToken_() {
  const raw = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  return raw.substring(0, CONFIG.TOKEN_LENGTH);
}
function hasRole_(user, allowed) {
  const role = String(user.Role || '').toLowerCase();
  for (let i = 0; i < allowed.length; i++) {
    if (role === allowed[i]) return true;
  }
  return false;
}
function stripMeta_(params) {
  const out = {};
  for (const k in params) {
    if (k === 'token' || k === 'action' || k === 'ip' || k === 'ua') continue;
    out[k] = params[k];
  }
  return out;
}
