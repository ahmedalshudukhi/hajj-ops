/**
 * HMG Hajj 2026 — Backend (v3: Unified Mob Sheet)
 *
 * Single source of truth: Mobilization_Plan - Backend
 *   ID: 16nlZuencav9uB9o9Kscgmb5UvVGeKcu4e3YxqdKohiw
 *
 * Reads (from Mob plan, edited by Ahmed/HR/cluster leads):
 *   Allowlist · Schedule · Stations · Units · Ambulances · Sub_Locations
 *
 * Writes (operational, never edited by humans):
 *   Sessions · Auth_Log · Dispatch_Log · Dispatch_Events · Q_PCR
 *   Reposition_Log · Reposition_Pending · Station_Status_Log · Admin_Audit_Log
 *
 * External read: PCR_Log (DCH script, ID 1BnFW2D...)
 *
 * SETUP: After pasting + saving, run setupMobBackend() once from editor.
 *        Creates operational tabs idempotently. Safe to re-run.
 */

const CONFIG = {
  MOB_SHEET_ID: '16nlZuencav9uB9o9Kscgmb5UvVGeKcu4e3YxqdKohiw',
  PCR_LOG_SHEET_ID: '1BnFW2Dr-v9GH1nI9ExNSvqEtroc-4tX3uv2bt_eQUG0',
  PCR_LOG_TAB: 'PCR_Log',
  SESSION_HOURS: 72,
  TOKEN_LENGTH: 32,
  DISPATCH_LIST_LOOKBACK_HOURS: 24,
  REPOSITION_AUTO_APPROVE_MINUTES: 2,
  RATE_LIMIT_DISABLED: true
};

const SHEETS = {
  ALLOWLIST: 'Allowlist',
  SCHEDULE: 'Schedule',
  STATIONS: 'Stations',
  UNITS: 'Units',
  AMBULANCES: 'Ambulances',
  SUB_LOCATIONS: 'Sub_Locations',
  SESSIONS: 'Sessions',
  AUTH_LOG: 'Auth_Log',
  DISPATCH_LOG: 'Dispatch_Log',
  DISPATCH_EVENTS: 'Dispatch_Events',
  Q_PCR: 'Q_PCR',
  REPOSITION_LOG: 'Reposition_Log',
  REPOSITION_PENDING: 'Reposition_Pending',
  STATION_STATUS_LOG: 'Station_Status_Log',
  ADMIN_AUDIT_LOG: 'Admin_Audit_Log'
};

const ROLES = {
  PARAMEDIC: 'paramedic', GP: 'gp', SAR: 'sar',
  CLUSTER_SUPERVISOR: 'cluster_supervisor', DISPATCHER: 'dispatcher',
  LEADERSHIP: 'leadership', ADMIN: 'admin'
};

// Inheritance: leadership inherits dispatcher + cluster_supervisor; admin inherits all
const ROLE_INHERITS = {
  admin:              ['leadership','dispatcher','cluster_supervisor','gp','paramedic','sar'],
  leadership:         ['dispatcher','cluster_supervisor'],
  dispatcher:         [],
  cluster_supervisor: [],
  gp:                 [],
  paramedic:          [],
  sar:                []
};

// Cluster → station prefix mapping for SV scoping
const CLUSTER_STATIONS = {
  arafat:      ['ARF1','ARF2','ARF3'],
  muzdalifah:  ['MUZ1','MUZ2','MUZ3'],
  mina:        ['MIN1','MIN2','MIN3']
};


// ============================================================
// INSPECTION (run before setup; dumps tab structure)
// ============================================================

function inspectMobSheet() {
  const ss = mobSpreadsheet_();
  Logger.log('=== Mobilization_Plan - Backend ===');
  Logger.log('Sheet name: ' + ss.getName());
  Logger.log('Sheet ID:   ' + ss.getId());
  Logger.log('');

  const allTabs = ss.getSheets();
  Logger.log('Total tabs: ' + allTabs.length);
  Logger.log('');

  const REQUIRED = {
    'Allowlist': ['NID', 'Name', 'Mobile', 'Role', 'Active'],
    'Stations':  ['Station_Code'],
    'Units':     ['Unit_Code', 'Home_Station'],
    'Schedule':  ['NID']
  };
  const OPERATIONAL = [
    'Sessions','Auth_Log','Dispatch_Log','Dispatch_Events',
    'Q_PCR','Reposition_Log','Reposition_Pending',
    'Station_Status_Log','Admin_Audit_Log'
  ];

  Logger.log('--- ALL TABS (name, rows, cols, first row) ---');
  allTabs.forEach(function(sh) {
    const name = sh.getName();
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    let firstRow = '';
    if (lastRow >= 1 && lastCol >= 1) {
      firstRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].join(' | ');
    }
    Logger.log('TAB "' + name + '"  rows=' + lastRow + '  cols=' + lastCol);
    Logger.log('  row1: ' + firstRow);
  });
  Logger.log('');

  Logger.log('--- REFERENCE TAB CHECK ---');
  Object.keys(REQUIRED).forEach(function(tabName) {
    const sh = ss.getSheetByName(tabName);
    if (!sh) {
      Logger.log('MISSING: "' + tabName + '" — please create');
      return;
    }
    const cols = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String);
    const missing = REQUIRED[tabName].filter(function(c) { return cols.indexOf(c) < 0; });
    if (missing.length === 0) {
      Logger.log('OK: "' + tabName + '" — has required columns: ' + REQUIRED[tabName].join(', '));
    } else {
      Logger.log('WARN: "' + tabName + '" — missing columns: ' + missing.join(', '));
      Logger.log('  has: ' + cols.join(', '));
    }
  });
  Logger.log('');

  Logger.log('--- OPERATIONAL TAB STATUS ---');
  OPERATIONAL.forEach(function(tabName) {
    const exists = ss.getSheetByName(tabName) !== null;
    Logger.log((exists ? 'EXISTS: ' : 'WILL CREATE: ') + '"' + tabName + '"');
  });
  Logger.log('');
  Logger.log('Inspection complete. Send this log to Claude.');
}


// ============================================================
// SETUP — run once after paste
// ============================================================

function setupMobBackend() {
  const ss = mobSpreadsheet_();
  const TABS = [
    { name: SHEETS.SESSIONS,           headers: ['Token','NID','Created_At','Expires','Last_Activity','IP','UA'] },
    { name: SHEETS.AUTH_LOG,           headers: ['Timestamp','NID','IP','UA','Result'] },
    { name: SHEETS.DISPATCH_LOG, headers: [
      'Incident_ID','Created_At','Created_By','Region','Zone','Station','Sub_Location',
      'Source','Case','Unit_Assigned','Type','Shift','Category','Cardiac_Arrest','Movement',
      'En_Route_At','On_Scene_At','Patient_Contact_At','Transfer_Start','Hospital_Arrival',
      'Handover','Closed_At','Decision','Transfer_Hospital','Notes','Status','Q_PCR_ID','Long_PCR_URL'
    ]},
    { name: SHEETS.DISPATCH_EVENTS, headers: ['Timestamp','Incident_ID','Event_Type','Operator_NID','Payload_JSON'] },
    { name: SHEETS.Q_PCR, headers: [
      'Q_PCR_ID','Created_At','Created_By','Incident_ID','Station','Sub_Location',
      'Patient_Nusuk_ID','Patient_NID','Patient_Iqama','Patient_Passport','Patient_Unknown_Description',
      'Age','Gender','Nationality','Chief_Complaint','Chief_Complaint_Other',
      'Acuity','Cardiac_Arrest','BP','HR','RR','SpO2','Temp','GCS',
      'Interventions','Disposition','Notes','Treating_Unit','Crew_NIDs','Signature_NID'
    ]},
    { name: SHEETS.REPOSITION_LOG, headers: [
      'Timestamp','Unit_Code','From_Station','To_Station','To_Sub_Location',
      'Reason','Operator_NID','Requested_By_NID','Auto_Revert_At','Status'
    ]},
    { name: SHEETS.REPOSITION_PENDING, headers: [
      'Request_ID','Created_At','Requested_By_NID','Unit_Code','From_Station','To_Station',
      'To_Sub_Location','Reason','Status','Reviewed_At','Reviewed_By_NID','Reject_Reason'
    ]},
    { name: SHEETS.STATION_STATUS_LOG, headers: ['Timestamp','Station','Status','Note','Operator_NID'] },
    { name: SHEETS.ADMIN_AUDIT_LOG, headers: ['Timestamp','Action','Operator_NID','Target','Payload_JSON'] }
  ];

  const created = [], skipped = [];
  for (const t of TABS) {
    let sh = ss.getSheetByName(t.name);
    if (sh) { skipped.push(t.name); continue; }
    sh = ss.insertSheet(t.name);
    sh.getRange(1, 1, 1, t.headers.length).setValues([t.headers]);
    sh.getRange(1, 1, 1, t.headers.length)
      .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    created.push(t.name);
  }

  // Verify reference tabs exist (read-only — created/edited by humans)
  const REQUIRED_READ = [SHEETS.ALLOWLIST, SHEETS.STATIONS, SHEETS.UNITS];
  const missingRead = REQUIRED_READ.filter(n => !ss.getSheetByName(n));

  Logger.log('=== Setup complete ===');
  Logger.log('Operational tabs created: ' + (created.length ? created.join(', ') : 'none'));
  Logger.log('Already existed: ' + (skipped.length ? skipped.join(', ') : 'none'));
  if (missingRead.length) {
    Logger.log('⚠ MISSING reference tabs (you need to create these manually): ' + missingRead.join(', '));
  } else {
    Logger.log('✓ All required reference tabs present');
  }

  // Create Reposition auto-approve trigger if not present
  ensureRepositionTrigger_();
  Logger.log('✓ Reposition auto-approve trigger ensured (every 1 min)');

  return { created, skipped, missingRead };
}

function ensureRepositionTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(t => t.getHandlerFunction() === 'processRepositionAutoApprove_');
  if (!exists) {
    ScriptApp.newTrigger('processRepositionAutoApprove_')
      .timeBased().everyMinutes(1).create();
  }
}


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
      response = { ok: true, ts: new Date().toISOString(), version: 'v3-unified' };
    } else if (action === 'auth') {
      response = authenticate_(params);
    } else {
      const session = validateToken_(params.token);
      if (!session.ok) {
        response = { ok: false, error: 'unauthorized' };
      } else {
        const u = session.user;
        switch (action) {
          // basic
          case 'whoami':              response = { ok:true, user: publicUser_(u) }; break;
          case 'roster':              response = getRoster_(u); break;
          case 'logout':              response = logout_(params.token); break;

          // dispatch
          case 'dispatch_create':     response = dispatchCreate_(u, params); break;
          case 'dispatch_event':      response = dispatchEvent_(u, params); break;
          case 'dispatch_list':       response = dispatchList_(u, params); break;
          case 'dispatch_close':      response = dispatchClose_(u, params); break;

          // q-pcr
          case 'qpcr_submit':         response = qpcrSubmit_(u, params); break;

          // reposition
          case 'reposition_request':  response = repositionRequest_(u, params); break;
          case 'reposition_approve':  response = repositionApprove_(u, params); break;
          case 'reposition_reject':   response = repositionReject_(u, params); break;
          case 'reposition_list':     response = repositionList_(u, params); break;
          case 'unit_positions':      response = unitPositions_(u, params); break;

          // station status
          case 'station_status_set':  response = stationStatusSet_(u, params); break;
          case 'station_status_list': response = stationStatusList_(u, params); break;

          // sar / active / stats
          case 'sar_summary':         response = getSarSummary_(u); break;
          case 'active_summary':      response = getActiveSummary_(u, params); break;
          case 'stats':               response = getStats_(u, params); break;

          // admin
          case 'admin_audit_list':    response = adminAuditList_(u, params); break;
          case 'admin_audit_log':     response = adminAuditLog_(u, params); break;

          default: response = { ok: false, error: 'unknown_action', action };
        }
      }
    }
  } catch (err) {
    response = { ok: false, error: 'server_error', message: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// AUTH
// ============================================================

function authenticate_(params) {
  const nid   = String(params.nid || '').trim();
  const last4 = String(params.last4 || '').trim();
  const ip    = String(params.ip || 'unknown');
  const ua    = String(params.ua || '');

  if (!/^\d{10}$/.test(nid))   return logAuth_(nid, ip, ua, 'invalid_nid_format', { ok:false, error:'invalid_credentials' });
  if (!/^\d{4}$/.test(last4))  return logAuth_(nid, ip, ua, 'invalid_last4_format', { ok:false, error:'invalid_credentials' });

  const user = findInAllowlist_(nid);
  if (!user)            return logAuth_(nid, ip, ua, 'nid_not_found', { ok:false, error:'invalid_credentials' });
  if (!isActive_(user)) return logAuth_(nid, ip, ua, 'inactive', { ok:false, error:'invalid_credentials' });

  const stored = String(user.Mobile || '').replace(/\D/g, '').slice(-4);
  if (stored !== last4) return logAuth_(nid, ip, ua, 'wrong_last4', { ok:false, error:'invalid_credentials' });

  const token = randomToken_();
  const now = new Date();
  const expires = new Date(now.getTime() + CONFIG.SESSION_HOURS * 3600 * 1000);
  appendRow_(SHEETS.SESSIONS, [token, nid, now, expires, now, ip, ua]);
  logAuth_(nid, ip, ua, 'success', null);

  return { ok:true, token, expires: expires.toISOString(), user: publicUser_(user) };
}

function validateToken_(token) {
  if (!token) return { ok:false };
  const sh = sheet_(SHEETS.SESSIONS);
  if (!sh) return { ok:false };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok:false };
  const h = data[0];
  const ti = h.indexOf('Token'), ei = h.indexOf('Expires'), ni = h.indexOf('NID'), li = h.indexOf('Last_Activity');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ti]) === String(token)) {
      if (new Date(data[i][ei]) < new Date()) return { ok:false };
      const user = findInAllowlist_(String(data[i][ni]));
      if (!user || !isActive_(user)) return { ok:false };
      // bump last_activity (best-effort, don't await)
      try { sh.getRange(i + 1, li + 1).setValue(new Date()); } catch (_) {}
      return { ok:true, user };
    }
  }
  return { ok:false };
}

function logout_(token) {
  if (!token) return { ok:true };
  const sh = sheet_(SHEETS.SESSIONS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok:true };
  const h = data[0]; const ti = h.indexOf('Token'); const ei = h.indexOf('Expires');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ti]) === String(token)) {
      sh.getRange(i + 1, ei + 1).setValue(new Date(0));
      break;
    }
  }
  return { ok:true };
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
  const h = data[0]; const ni = h.indexOf('NID');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ni]) === String(nid)) return rowToObject_(h, data[i]);
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
    role: user.Role, cluster: user.Cluster || '',
    station: user.Station, zone: user.Zone, unit: user.Unit, callsign: user.Callsign,
    accommodation: user.Accommodation,
    team_lead: user.Team_Lead, team_lead_mobile: user.Team_Lead_Mobile
  };
}


// ============================================================
// ROSTER
// ============================================================

function getRoster_(user) {
  return { ok:true, user: publicUser_(user), schedule: getScheduleForNID_(user.NID) };
}

function getScheduleForNID_(nid) {
  const sh = sheet_(SHEETS.SCHEDULE);
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  const h = data[0]; const ni = h.indexOf('NID');
  if (ni < 0) return [];
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][ni]) === String(nid)) out.push(rowToObject_(h, data[i]));
  }
  const di = h.indexOf('Date');
  if (di >= 0) out.sort((a, b) => new Date(a.Date) - new Date(b.Date));
  return out;
}

// ============================================================
// DISPATCH
// ============================================================

function dispatchCreate_(user, params) {
  if (!hasRole_(user, ['dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const id = 'INC-' + Utilities.formatDate(new Date(), 'GMT+3', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random()*1000);
  const now = new Date();
  appendRow_(SHEETS.DISPATCH_LOG, [
    id, now, user.NID,
    params.region || '', params.zone || '', params.station || '', params.sub_location || '',
    params.source || '', params.case_field || params['case'] || '', params.unit || '',
    params.type || '', params.shift || '',
    String(params.category || '').toLowerCase(),
    !!(params.cardiac_arrest === true || params.cardiac_arrest === 'true'),
    params.movement || '',
    '', '', '', '', '', '', '',
    '', '',
    params.notes || '',
    'open', '', ''
  ]);
  appendRow_(SHEETS.DISPATCH_EVENTS, [now, id, 'dispatch_created', user.NID, JSON.stringify(stripMeta_(params))]);
  return { ok:true, incident_id: id, created_at: now.toISOString() };
}

function dispatchEvent_(user, params) {
  if (!hasRole_(user, ['dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const id = String(params.incident_id || '');
  const ev = String(params.event_type || '').toLowerCase();
  if (!id || !ev) return { ok:false, error:'missing_params' };
  const now = new Date();
  const colMap = {
    'en_route':'En_Route_At','on_scene':'On_Scene_At','patient_contact':'Patient_Contact_At',
    'transfer_start':'Transfer_Start','hospital_arrival':'Hospital_Arrival','handover':'Handover'
  };
  const col = colMap[ev];
  if (col) updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, col, now);
  appendRow_(SHEETS.DISPATCH_EVENTS, [now, id, ev, user.NID, JSON.stringify(stripMeta_(params))]);
  return { ok:true, timestamp: now.toISOString() };
}

function dispatchList_(user, params) {
  const sh = sheet_(SHEETS.DISPATCH_LOG);
  if (!sh) return { ok:true, incidents: [] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok:true, incidents: [] };
  const h = data[0]; const ci = h.indexOf('Created_At'); const stationIdx = h.indexOf('Station');
  const sinceTs = params.since ? new Date(params.since) : new Date(Date.now() - CONFIG.DISPATCH_LIST_LOOKBACK_HOURS*3600*1000);
  const allowedStations = filterStationsForUser_(user);
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (new Date(data[i][ci]) < sinceTs) continue;
    if (allowedStations && !allowedStations.has(String(data[i][stationIdx] || '').toUpperCase())) continue;
    out.push(rowToObject_(h, data[i]));
  }
  return { ok:true, incidents: out, server_time: new Date().toISOString() };
}

function dispatchClose_(user, params) {
  if (!hasRole_(user, ['dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const id = String(params.incident_id || ''); const dec = String(params.decision || '');
  if (!id || !dec) return { ok:false, error:'missing_params' };
  const now = new Date();
  updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Closed_At', now);
  updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Decision', dec);
  updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Status', 'closed');
  if (params.transfer_hospital)
    updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Transfer_Hospital', String(params.transfer_hospital));
  if (params.long_pcr_url)
    updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', id, 'Long_PCR_URL', String(params.long_pcr_url));
  appendRow_(SHEETS.DISPATCH_EVENTS, [now, id, 'closed:' + dec, user.NID, JSON.stringify(stripMeta_(params))]);
  return { ok:true, closed_at: now.toISOString() };
}

// ============================================================
// Q-PCR (short form)
// ============================================================

function qpcrSubmit_(user, params) {
  const id = 'QPCR-' + Utilities.formatDate(new Date(), 'GMT+3', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random()*1000);
  const now = new Date();
  const incidentId = String(params.incident_id || '');
  appendRow_(SHEETS.Q_PCR, [
    id, now, user.NID, incidentId,
    params.station || '', params.sub_location || '',
    params.patient_nusuk_id || '', params.patient_nid || '', params.patient_iqama || '',
    params.patient_passport || '', params.patient_unknown_description || '',
    params.age || '', params.gender || '', params.nationality || '',
    params.chief_complaint || '', params.chief_complaint_other || '',
    String(params.acuity || '').toLowerCase(),
    !!(params.cardiac_arrest === true || params.cardiac_arrest === 'true'),
    params.bp || '', params.hr || '', params.rr || '', params.spo2 || '', params.temp || '', params.gcs || '',
    Array.isArray(params.interventions) ? params.interventions.join(', ') : (params.interventions || ''),
    params.disposition || '', params.notes || '',
    params.treating_unit || '', params.crew_nids || '', user.NID
  ]);
  if (incidentId) updateCellByID_(SHEETS.DISPATCH_LOG, 'Incident_ID', incidentId, 'Q_PCR_ID', id);
  return { ok:true, qpcr_id: id, submitted_at: now.toISOString() };
}


// ============================================================
// REPOSITION (units · 2-min auto-approve)
// ============================================================

function repositionRequest_(user, params) {
  if (!hasRole_(user, ['cluster_supervisor','dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const unit = String(params.unit_code || '');
  const to   = String(params.to_station || '');
  if (!unit || !to) return { ok:false, error:'missing_params' };

  // SV scoping: SV can only request moves where BOTH from and to are within their cluster
  const role = String(user.Role || '').toLowerCase();
  if (role === 'cluster_supervisor') {
    const cluster = String(user.Cluster || '').toLowerCase();
    const allowed = CLUSTER_STATIONS[cluster] || [];
    const fromOK = !params.from_station || allowed.includes(String(params.from_station).toUpperCase());
    const toOK   = allowed.includes(to.toUpperCase());
    if (!fromOK || !toOK) return { ok:false, error:'out_of_cluster' };
  }

  // Direct repositioning by dispatcher/leadership/admin → write Reposition_Log directly
  if (role === 'dispatcher' || role === 'leadership' || role === 'admin') {
    const now = new Date();
    appendRow_(SHEETS.REPOSITION_LOG, [
      now, unit, params.from_station || '', to, params.to_sub_location || '',
      params.reason || '', user.NID, '', params.auto_revert_at || '', 'active'
    ]);
    return { ok:true, applied: true, at: now.toISOString() };
  }

  // SV → goes to pending queue, auto-approves in 2 min if no dispatcher review
  const reqId = 'REP-' + Utilities.formatDate(new Date(), 'GMT+3', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random()*1000);
  appendRow_(SHEETS.REPOSITION_PENDING, [
    reqId, new Date(), user.NID, unit, params.from_station || '', to,
    params.to_sub_location || '', params.reason || '', 'pending', '', '', ''
  ]);
  return { ok:true, request_id: reqId, status: 'pending' };
}

function repositionApprove_(user, params) {
  if (!hasRole_(user, ['dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const reqId = String(params.request_id || '');
  if (!reqId) return { ok:false, error:'missing_params' };
  return repositionResolve_(reqId, 'approved', user.NID, '');
}

function repositionReject_(user, params) {
  if (!hasRole_(user, ['dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const reqId = String(params.request_id || ''); const reason = String(params.reason || '');
  if (!reqId) return { ok:false, error:'missing_params' };
  return repositionResolve_(reqId, 'rejected', user.NID, reason);
}

function repositionResolve_(reqId, status, reviewerNID, rejectReason) {
  const sh = sheet_(SHEETS.REPOSITION_PENDING);
  if (!sh) return { ok:false, error:'no_pending_sheet' };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok:false, error:'not_found' };
  const h = data[0];
  const idIdx = h.indexOf('Request_ID');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) !== reqId) continue;
    if (String(data[i][h.indexOf('Status')]) !== 'pending') return { ok:false, error:'not_pending' };
    const now = new Date();
    sh.getRange(i + 1, h.indexOf('Status') + 1).setValue(status);
    sh.getRange(i + 1, h.indexOf('Reviewed_At') + 1).setValue(now);
    sh.getRange(i + 1, h.indexOf('Reviewed_By_NID') + 1).setValue(reviewerNID);
    if (status === 'rejected') sh.getRange(i + 1, h.indexOf('Reject_Reason') + 1).setValue(rejectReason);
    if (status === 'approved' || status === 'auto_approved') {
      const r = data[i];
      appendRow_(SHEETS.REPOSITION_LOG, [
        now, r[h.indexOf('Unit_Code')], r[h.indexOf('From_Station')],
        r[h.indexOf('To_Station')], r[h.indexOf('To_Sub_Location')],
        r[h.indexOf('Reason')], reviewerNID, r[h.indexOf('Requested_By_NID')],
        '', 'active'
      ]);
    }
    return { ok:true, status, at: now.toISOString() };
  }
  return { ok:false, error:'not_found' };
}

// Trigger function — runs every 1 min via setupMobBackend trigger
function processRepositionAutoApprove_() {
  const sh = sheet_(SHEETS.REPOSITION_PENDING);
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return;
  const h = data[0];
  const cutoff = new Date(Date.now() - CONFIG.REPOSITION_AUTO_APPROVE_MINUTES * 60 * 1000);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][h.indexOf('Status')]) !== 'pending') continue;
    if (new Date(data[i][h.indexOf('Created_At')]) > cutoff) continue;
    const reqId = String(data[i][h.indexOf('Request_ID')]);
    repositionResolve_(reqId, 'auto_approved', 'system:auto', '');
  }
}

function repositionList_(user, params) {
  const sh = sheet_(SHEETS.REPOSITION_PENDING);
  const out = { pending: [], recent: [] };
  if (sh) {
    const data = sh.getDataRange().getValues();
    if (data.length > 1) {
      const h = data[0];
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][h.indexOf('Status')]) === 'pending') out.pending.push(rowToObject_(h, data[i]));
      }
    }
  }
  const sh2 = sheet_(SHEETS.REPOSITION_LOG);
  if (sh2) {
    const data = sh2.getDataRange().getValues();
    if (data.length > 1) {
      const h = data[0];
      for (let i = Math.max(1, data.length - 30); i < data.length; i++) {
        out.recent.push(rowToObject_(h, data[i]));
      }
    }
  }
  return { ok:true, pending: out.pending, recent: out.recent };
}

// Returns {unit_code: latest position} from Reposition_Log + Mob.Units defaults
function unitPositions_(user, params) {
  const positions = {};
  const unitsSh = sheet_(SHEETS.UNITS);
  if (unitsSh) {
    const data = unitsSh.getDataRange().getValues();
    if (data.length > 1) {
      const h = data[0];
      const ci = h.indexOf('Unit_Code'), hi = h.indexOf('Home_Station');
      for (let i = 1; i < data.length; i++) {
        const code = String(data[i][ci] || ''); if (!code) continue;
        positions[code] = { unit: code, station: data[i][hi] || '', sub_location: '', since: null, source: 'home' };
      }
    }
  }
  const repSh = sheet_(SHEETS.REPOSITION_LOG);
  if (repSh) {
    const data = repSh.getDataRange().getValues();
    if (data.length > 1) {
      const h = data[0];
      for (let i = 1; i < data.length; i++) {
        const code = String(data[i][h.indexOf('Unit_Code')] || '');
        if (!code) continue;
        if (String(data[i][h.indexOf('Status')]) !== 'active') continue;
        positions[code] = {
          unit: code,
          station: data[i][h.indexOf('To_Station')] || '',
          sub_location: data[i][h.indexOf('To_Sub_Location')] || '',
          since: new Date(data[i][h.indexOf('Timestamp')]).toISOString(),
          source: 'reposition'
        };
      }
    }
  }
  return { ok:true, positions: Object.values(positions) };
}


// ============================================================
// STATION STATUS
// ============================================================

function stationStatusSet_(user, params) {
  if (!hasRole_(user, ['cluster_supervisor','dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const station = String(params.station || ''); const status = String(params.status || '').toLowerCase();
  if (!station || !['red','yellow','green','black'].includes(status)) return { ok:false, error:'invalid_params' };
  const role = String(user.Role || '').toLowerCase();
  if (role === 'cluster_supervisor') {
    const cluster = String(user.Cluster || '').toLowerCase();
    const allowed = CLUSTER_STATIONS[cluster] || [];
    if (!allowed.includes(station.toUpperCase())) return { ok:false, error:'out_of_cluster' };
  }
  appendRow_(SHEETS.STATION_STATUS_LOG, [new Date(), station.toUpperCase(), status, params.note || '', user.NID]);
  return { ok:true, station: station.toUpperCase(), status };
}

function stationStatusList_(user, params) {
  const sh = sheet_(SHEETS.STATION_STATUS_LOG);
  const latest = {};
  if (sh) {
    const data = sh.getDataRange().getValues();
    if (data.length > 1) {
      const h = data[0];
      for (let i = 1; i < data.length; i++) {
        const station = String(data[i][h.indexOf('Station')] || '').toUpperCase();
        if (!station) continue;
        latest[station] = {
          station,
          status: data[i][h.indexOf('Status')],
          note: data[i][h.indexOf('Note')],
          ts: new Date(data[i][h.indexOf('Timestamp')]).toISOString(),
          operator: data[i][h.indexOf('Operator_NID')]
        };
      }
    }
  }
  return { ok:true, stations: Object.values(latest) };
}

// ============================================================
// SAR · ACTIVE · STATS
// ============================================================

function getSarSummary_(user) {
  if (!hasRole_(user, ['sar','admin'])) return { ok:false, error:'forbidden' };
  const d = aggregateDispatch_();
  const stations = stationStatusList_(user, {}).stations;
  // Stripped down: open count, closed today, station status colors only
  const colorOnly = stations.map(s => ({ station: s.station, status: s.status }));
  return {
    ok:true,
    open: d.open, closed_today: d.closed_today, in_transfer: d.in_transfer,
    stations: colorOnly,
    server_time: new Date().toISOString()
  };
}

function getActiveSummary_(user, params) {
  if (!hasRole_(user, ['cluster_supervisor','dispatcher','leadership','admin'])) return { ok:false, error:'forbidden' };
  const allowedStations = filterStationsForUser_(user);
  return {
    ok:true,
    dispatch: aggregateDispatch_(allowedStations),
    pcr:      aggregatePCR_(allowedStations),
    stations: stationStatusList_(user, {}).stations,
    units:    unitPositions_(user, {}).positions,
    server_time: new Date().toISOString()
  };
}

function getStats_(user, params) {
  // legacy endpoint for current dispatch.html
  const d = aggregateDispatch_();
  const sh = sheet_(SHEETS.Q_PCR);
  const qpcrCount = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
  return {
    ok:true,
    dispatch: { open: d.open, closed: d.closed_today, total: d.open + d.closed_today, by_category: d.by_category, by_station: d.by_station },
    qpcr: { total: qpcrCount },
    server_time: new Date().toISOString()
  };
}

function aggregateDispatch_(allowedStations) {
  const sh = sheet_(SHEETS.DISPATCH_LOG);
  if (!sh) return emptyDispatchAgg_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return emptyDispatchAgg_();
  const h = data[0]; const idx = (n) => h.indexOf(n);
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const byStation = {}, byCategory = { red:0, yellow:0, green:0, black:0 };
  let openTotal = 0, closedToday = 0, inTransfer = 0, redOpen = 0, cardiacOpen = 0;
  const responseTimesMs = [], recentStrip = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const station = String(r[idx('Station')] || r[idx('Zone')] || 'unknown').toUpperCase();
    if (allowedStations && !allowedStations.has(station)) continue;
    const status = String(r[idx('Status')] || '');
    const category = String(r[idx('Category')] || '').toLowerCase();
    const cardiac = !!r[idx('Cardiac_Arrest')];
    const created = r[idx('Created_At')] ? new Date(r[idx('Created_At')]) : null;
    const closedAt = r[idx('Closed_At')] ? new Date(r[idx('Closed_At')]) : null;
    const transferStart = r[idx('Transfer_Start')] ? new Date(r[idx('Transfer_Start')]) : null;
    const ptContact = r[idx('Patient_Contact_At')] ? new Date(r[idx('Patient_Contact_At')]) : null;

    if (!byStation[station]) byStation[station] = { open:0, closed_today:0, in_transfer:0, red_open:0 };
    if (status === 'open') {
      openTotal++; byStation[station].open++;
      if (transferStart && !closedAt) { inTransfer++; byStation[station].in_transfer++; }
      if (category === 'red') { redOpen++; byStation[station].red_open++; if (cardiac) cardiacOpen++; }
    }
    if (status === 'closed' && closedAt && closedAt >= todayStart) { closedToday++; byStation[station].closed_today++; }
    if (byCategory[category] !== undefined) byCategory[category]++;
    if (created && ptContact && ptContact > created) responseTimesMs.push(ptContact - created);
    if (created && created >= todayStart) {
      recentStrip.push({
        id: r[idx('Incident_ID')], created: created.toISOString(),
        station, category, cardiac, status,
        decision: r[idx('Decision')] || '', in_transfer: !!transferStart && !closedAt,
        case: r[idx('Case')] || '', q_pcr_id: r[idx('Q_PCR_ID')] || '', long_pcr_url: r[idx('Long_PCR_URL')] || ''
      });
    }
  }

  recentStrip.sort((a,b) => new Date(b.created) - new Date(a.created));
  return {
    open: openTotal, closed_today: closedToday, in_transfer: inTransfer,
    red_open: redOpen, cardiac_open: cardiacOpen,
    by_category: byCategory, by_station: byStation,
    response_time: percentiles_(responseTimesMs),
    recent: recentStrip.slice(0, 20)
  };
}

function aggregatePCR_(allowedStations) {
  let sh;
  try { sh = SpreadsheetApp.openById(CONFIG.PCR_LOG_SHEET_ID).getSheetByName(CONFIG.PCR_LOG_TAB); }
  catch (e) { return Object.assign(emptyPcrAgg_(), { error: 'pcr_log_unreachable' }); }
  if (!sh) return emptyPcrAgg_();
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return emptyPcrAgg_();
  const h = data[0]; const idx = (n) => h.indexOf(n);
  const ti = idx('Timestamp'), si = idx('Station'), ai = idx('Acuity'), di = idx('Disposition'),
        ci = idx('Complaint'), agei = idx('Age'), gi = idx('Gender');
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  let total = 0, today = 0;
  const byAcuity = {}, byDispo = {}, byStation = {}, complaints = {}, recent = [];

  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const station = String(r[si] || '').toUpperCase().trim() || 'UNK';
    if (allowedStations && !allowedStations.has(station)) continue;
    const ts = ti >= 0 && r[ti] ? new Date(r[ti]) : null;
    total++; if (ts && ts >= todayStart) today++;
    const acuity = String(r[ai] || '').toLowerCase().trim() || 'unspecified';
    byAcuity[acuity] = (byAcuity[acuity]||0) + 1;
    const dispo = String(r[di] || '').trim() || 'unspecified';
    byDispo[dispo] = (byDispo[dispo]||0) + 1;
    byStation[station] = (byStation[station]||0) + 1;
    const c = String(r[ci] || '').toLowerCase().trim();
    if (c) complaints[c] = (complaints[c]||0) + 1;
    if (ts && ts >= todayStart) {
      recent.push({ ts: ts.toISOString(), station, acuity,
        complaint: r[ci] || '', age: r[agei] || '', gender: r[gi] || '', dispo });
    }
  }
  recent.sort((a,b) => new Date(b.ts) - new Date(a.ts));
  const topComplaints = Object.entries(complaints).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>({complaint:k,count:v}));
  return { total, today, by_acuity: byAcuity, by_disposition: byDispo, by_station: byStation, top_complaints: topComplaints, recent: recent.slice(0,20) };
}

function emptyDispatchAgg_() {
  return { open:0, closed_today:0, in_transfer:0, red_open:0, cardiac_open:0,
    by_category:{red:0,yellow:0,green:0,black:0}, by_station:{},
    response_time:{mean_ms:0,p50_ms:0,p95_ms:0,count:0}, recent:[] };
}
function emptyPcrAgg_() {
  return { total:0, today:0, by_acuity:{}, by_disposition:{}, by_station:{}, top_complaints:[], recent:[] };
}
function percentiles_(arr) {
  const n = arr.length; if (!n) return { mean_ms:0, p50_ms:0, p95_ms:0, count:0 };
  const sorted = arr.slice().sort((a,b)=>a-b);
  const mean = arr.reduce((s,v)=>s+v,0)/n;
  const p = (q) => sorted[Math.min(n-1, Math.floor(q*n))];
  return { mean_ms: Math.round(mean), p50_ms: p(0.5), p95_ms: p(0.95), count: n };
}


// ============================================================
// ADMIN
// ============================================================

function adminAuditLog_(user, params) {
  if (!hasRole_(user, ['admin'])) return { ok:false, error:'forbidden' };
  appendRow_(SHEETS.ADMIN_AUDIT_LOG, [
    new Date(), params.action_label || 'manual',
    user.NID, params.target || '', JSON.stringify(stripMeta_(params))
  ]);
  return { ok:true };
}

function adminAuditList_(user, params) {
  if (!hasRole_(user, ['admin'])) return { ok:false, error:'forbidden' };
  const sh = sheet_(SHEETS.ADMIN_AUDIT_LOG);
  if (!sh) return { ok:true, entries:[] };
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok:true, entries:[] };
  const h = data[0];
  const out = [];
  for (let i = Math.max(1, data.length - 100); i < data.length; i++) {
    out.push(rowToObject_(h, data[i]));
  }
  return { ok:true, entries: out };
}

// ============================================================
// HELPERS
// ============================================================

function mobSpreadsheet_() { return SpreadsheetApp.openById(CONFIG.MOB_SHEET_ID); }
function sheet_(name) { return mobSpreadsheet_().getSheetByName(name); }
function appendRow_(sheetName, row) { const sh = sheet_(sheetName); if (sh) sh.appendRow(row); }

function rowToObject_(headers, row) {
  const o = {}; for (let i = 0; i < headers.length; i++) o[headers[i]] = row[i]; return o;
}

function updateCellByID_(sheetName, idCol, idVal, targetCol, value) {
  const sh = sheet_(sheetName); if (!sh) return false;
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return false;
  const h = data[0];
  const idIdx = h.indexOf(idCol), tIdx = h.indexOf(targetCol);
  if (idIdx < 0 || tIdx < 0) return false;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === String(idVal)) {
      sh.getRange(i + 1, tIdx + 1).setValue(value);
      return true;
    }
  }
  return false;
}

function randomToken_() {
  return (Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')).substring(0, CONFIG.TOKEN_LENGTH);
}

// hasRole_ — uses inheritance map. Admin always passes.
function hasRole_(user, allowed) {
  const role = String(user.Role || '').toLowerCase();
  if (allowed.indexOf(role) >= 0) return true;
  // check inherited roles
  const inherited = ROLE_INHERITS[role] || [];
  for (const inh of inherited) if (allowed.indexOf(inh) >= 0) return true;
  return false;
}

// Returns Set of UPPERCASE station codes the user is allowed to see, or null = all
function filterStationsForUser_(user) {
  const role = String(user.Role || '').toLowerCase();
  if (role !== 'cluster_supervisor') return null;  // unrestricted for everyone except SV
  const cluster = String(user.Cluster || '').toLowerCase();
  const stations = CLUSTER_STATIONS[cluster] || [];
  return new Set(stations.map(s => s.toUpperCase()));
}

function stripMeta_(params) {
  const out = {};
  for (const k in params) {
    if (k === 'token' || k === 'action' || k === 'ip' || k === 'ua') continue;
    out[k] = params[k];
  }
  return out;
}
