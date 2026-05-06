/**
 * Hajj Ops Dashboard — Google Apps Script template
 * ─────────────────────────────────────────────────
 * Exposes PCR (Patient Care Records) and Patient Census data from Google Sheets
 * as a JSON endpoint that the dashboard at hajj.shuki.tech consumes.
 *
 * SETUP:
 *  1. Open script.google.com → New project
 *  2. Paste this entire file as Code.gs
 *  3. Update the SHEET_IDS below with your own Google Sheet IDs
 *  4. Deploy → New deployment → Type: Web app
 *     - Execute as: Me
 *     - Who has access: Anyone (or "Anyone with Google account" if you require auth)
 *  5. Copy the deployed Web App URL
 *  6. Open the dashboard → Settings → paste URL into "Google Apps Script endpoint"
 *
 * ENDPOINTS (called by the dashboard):
 *  GET ?endpoint=summary       → counts, by_acuity, by_station, last_updated
 *  GET ?endpoint=encounters    → recent N encounters (default 50)
 *  GET ?endpoint=stations      → station-level census
 *  GET ?endpoint=health        → simple ping
 *
 * SHEET STRUCTURE (PCR sheet — first sheet/tab):
 *   Column A: Encounter ID (auto-generated like PCR-001)
 *   Column B: Timestamp (e.g. 2026-05-28 14:23)
 *   Column C: Station (e.g. ARF1, MUZ2, MIN3)
 *   Column D: Patient ID (anonymized)
 *   Column E: Age
 *   Column F: Gender
 *   Column G: Chief Complaint
 *   Column H: Acuity (Critical | Urgent | Standard | Minor)
 *   Column I: Disposition (Discharged | Transferred | Hospitalized | Refused)
 *   Column J: Treating Unit (e.g. Mike-1, Alpha-3, Romeo-12)
 *   Column K: Notes
 *
 * SHEET STRUCTURE (Census sheet — second sheet/tab "Census"):
 *   Column A: Station
 *   Column B: Active patients (current count)
 *   Column C: Total seen today
 *   Column D: Last updated timestamp
 */

// ═══ CONFIGURE THESE ═══════════════════════════════════════════════
const PCR_SHEET_ID = '__REPLACE_WITH_PCR_SHEET_ID__';
const CENSUS_SHEET_ID = '__REPLACE_WITH_CENSUS_SHEET_ID__';
// If your PCR and Census are in the same spreadsheet on different tabs,
// set both IDs to the same value and use the tab names below
const PCR_TAB_NAME = 'PCR';
const CENSUS_TAB_NAME = 'Census';
// ═══════════════════════════════════════════════════════════════════

function doGet(e) {
  const endpoint = (e.parameter.endpoint || 'summary').toLowerCase();
  const limit = parseInt(e.parameter.limit) || 50;

  let result;
  try {
    switch (endpoint) {
      case 'health':
        result = { status: 'ok', service: 'hajj-pcr-gas', time: new Date().toISOString() };
        break;
      case 'summary':
        result = getSummary();
        break;
      case 'encounters':
        result = { encounters: getRecentEncounters(limit) };
        break;
      case 'stations':
        result = { stations: getStationCensus() };
        break;
      default:
        result = { error: 'unknown endpoint', valid: ['summary', 'encounters', 'stations', 'health'] };
    }
  } catch (err) {
    result = { error: 'internal', message: err.message, stack: err.stack };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function getPCRRows() {
  const ss = SpreadsheetApp.openById(PCR_SHEET_ID);
  const sheet = ss.getSheetByName(PCR_TAB_NAME) || ss.getSheets()[0];
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h.toString().toLowerCase().trim().replace(/\s+/g, '_')] = row[i]; });
    // Normalise common field names
    obj.id = obj.encounter_id || obj.id || obj.pcr_id || '';
    obj.time = obj.timestamp ? formatTime(obj.timestamp) : '';
    obj.station = (obj.station || '').toString().trim().toUpperCase();
    obj.acuity = (obj.acuity || 'standard').toString().toLowerCase();
    obj.complaint = obj.chief_complaint || obj.complaint || '';
    return obj;
  }).filter(r => r.id);
}

function getSummary() {
  const rows = getPCRRows();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const byAcuity = { critical: 0, urgent: 0, standard: 0, minor: 0 };
  const byStation = {};
  let todayCount = 0;
  let activeCount = 0;
  let criticalToday = 0;

  rows.forEach(r => {
    const acuity = r.acuity || 'standard';
    if (byAcuity[acuity] !== undefined) byAcuity[acuity]++;

    const station = r.station;
    if (station) byStation[station] = (byStation[station] || 0) + 1;

    const ts = r.timestamp ? new Date(r.timestamp) : null;
    if (ts && ts >= today) {
      todayCount++;
      if (acuity === 'critical') criticalToday++;
    }

    const dispo = (r.disposition || '').toString().toLowerCase();
    if (dispo === '' || dispo === 'active' || dispo === 'in progress' || dispo === 'pending') {
      activeCount++;
    }
  });

  return {
    total_encounters: rows.length,
    today_encounters: todayCount,
    active_patients: activeCount,
    critical_today: criticalToday,
    by_acuity: byAcuity,
    by_station: byStation,
    last_updated: new Date().toISOString(),
  };
}

function getRecentEncounters(limit) {
  const rows = getPCRRows();
  // Sort by timestamp descending
  rows.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return tb - ta;
  });
  return rows.slice(0, limit).map(r => ({
    id: r.id,
    time: r.time,
    station: r.station,
    complaint: r.complaint,
    acuity: r.acuity,
    disposition: r.disposition || '',
    unit: r.treating_unit || '',
  }));
}

function getStationCensus() {
  try {
    const ss = SpreadsheetApp.openById(CENSUS_SHEET_ID);
    const sheet = ss.getSheetByName(CENSUS_TAB_NAME);
    if (!sheet) return [];
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return [];
    return values.slice(1).map(row => ({
      station: (row[0] || '').toString().trim().toUpperCase(),
      active: parseInt(row[1]) || 0,
      total_today: parseInt(row[2]) || 0,
      last_updated: row[3] ? formatTime(row[3]) : '',
    })).filter(r => r.station);
  } catch (e) {
    // Fall back to deriving from PCR rows
    const rows = getPCRRows();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const byStation = {};
    rows.forEach(r => {
      const ts = r.timestamp ? new Date(r.timestamp) : null;
      if (ts && ts >= today && r.station) {
        if (!byStation[r.station]) byStation[r.station] = { station: r.station, active: 0, total_today: 0 };
        byStation[r.station].total_today++;
        const dispo = (r.disposition || '').toString().toLowerCase();
        if (dispo === '' || dispo === 'active' || dispo === 'pending') {
          byStation[r.station].active++;
        }
      }
    });
    return Object.values(byStation);
  }
}

function formatTime(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  const dt = new Date(d);
  if (isNaN(dt)) return d.toString();
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Q-PCR write endpoint. Called by dispatch.html when a card closes.
 *
 * Body: JSON with at minimum complaint + station. All other fields optional.
 *   patient_id, age, gender, complaint, acuity, disposition, treating_unit,
 *   station, notes, incident_id, submitter_nid, submitter_name
 *
 * Returns: { ok: true, encounter_id: "PCR-YYYYMMDD-HHMMSS-XXX" }
 *
 * The sheet schema columns (A–K, see header comment above) are filled in order.
 * If the sheet is missing or empty, we create the header row first.
 */
function doPost(e) {
  try {
    const body = e.postData && e.postData.contents
      ? JSON.parse(e.postData.contents)
      : {};

    const ss = SpreadsheetApp.openById(PCR_SHEET_ID);
    let sheet = ss.getSheetByName(PCR_TAB_NAME);
    if (!sheet) sheet = ss.insertSheet(PCR_TAB_NAME);

    // Ensure header row exists
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'Encounter ID', 'Timestamp', 'Station', 'Patient ID', 'Age',
        'Gender', 'Chief Complaint', 'Acuity', 'Disposition',
        'Treating Unit', 'Notes', 'Source', 'Incident ID', 'Submitter'
      ]);
      sheet.getRange(1, 1, 1, 14).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }

    const now = new Date();
    const encounterId = 'PCR-'
      + Utilities.formatDate(now, 'GMT+3', 'yyyyMMdd-HHmmss')
      + '-' + Math.floor(Math.random() * 1000);

    sheet.appendRow([
      encounterId,
      now,
      String(body.station || '').trim().toUpperCase(),
      String(body.patient_id || ''),
      body.age || '',
      String(body.gender || ''),
      String(body.complaint || ''),
      String(body.acuity || 'standard').toLowerCase(),
      String(body.disposition || ''),
      String(body.treating_unit || ''),
      String(body.notes || ''),
      'Q-PCR (dispatch)',
      String(body.incident_id || ''),
      String(body.submitter_name || body.submitter_nid || '')
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, encounter_id: encounterId, time: now.toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'server_error', message: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
