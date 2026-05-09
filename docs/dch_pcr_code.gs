/**
 * HMG Hajj 2026 — Q-PCR Apps Script
 *
 * Server-side code for the Quick Patient Care Report web app.
 * Pairs with index.html (the form).
 *
 * Endpoints/flow:
 *   GET request -> doGet -> renders index.html with URL-param scriptlets
 *                 (incident_id, prefill_station, prefill_unit)
 *
 *   Form submit -> google.script.run.generatePDF(data)
 *                  -> creates PDF in Drive
 *                  -> writes row to PCR_Log sheet (18 cols)
 *                  -> returns PDF URL
 *
 * SETUP (one-time):
 *   1. Set PDF_FOLDER_ID below to your target Drive folder for PCR PDFs
 *      (or leave blank to save to Drive root).
 *   2. PCR_LOG_SHEET_ID is hardcoded to your PCR_Log sheet — change if
 *      you ever rotate.
 *   3. Save, then Deploy -> New deployment -> Web app -> Execute as: Me,
 *      Access: Anyone with link (or Anyone with Google account).
 */

const PCR_CONFIG = {
  PCR_LOG_SHEET_ID:    '1BnFW2Dr-v9GH1nI9ExNSvqEtroc-4tX3uv2bt_eQUG0',
  PCR_LOG_TAB:         'PCR_Log',
  PDF_FOLDER_ID:       '',  // <-- Optional: set to your PCR PDFs folder ID. Blank = Drive root.
  PDF_FILENAME_PREFIX: 'PCR'
};

// ============================================================
// WEB APP ENTRY POINT
// ============================================================

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('index');
  t.incidentId     = (e && e.parameter && e.parameter.incident_id)     || '';
  t.prefillStation = (e && e.parameter && e.parameter.prefill_station) || '';
  t.prefillUnit    = (e && e.parameter && e.parameter.prefill_unit)    || '';
  return t.evaluate()
    .setTitle('Q-PCR  HMG Hajj 2026')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

// HTML-include helper if you ever split styles/scripts into separate .html files
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============================================================
// FORM SUBMISSION HANDLER
// ============================================================

function generatePDF(data) {
  try {
    const pdfUrl = createPdfFromData_(data);
    logPCR_(data, pdfUrl);
    return pdfUrl;
  } catch (err) {
    Logger.log('generatePDF error: ' + err);
    throw err;  // surfaces to client withFailureHandler
  }
}

// ============================================================
// PDF GENERATION
// ============================================================

function createPdfFromData_(data) {
  const ts = new Date();
  const tsStr = Utilities.formatDate(ts, 'GMT+3', 'yyyyMMdd-HHmmss');
  const station = String(data.station || 'XXX');
  const incident = data.incident_id ? '_' + data.incident_id.replace(/[^A-Za-z0-9-]/g, '') : '';
  const docName = PCR_CONFIG.PDF_FILENAME_PREFIX + '_' + station + '_' + tsStr + incident;

  // Build a temp Google Doc with the report content
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  body.setMarginTop(36).setMarginBottom(36).setMarginLeft(36).setMarginRight(36);

  // ----- Header -----
  const h = body.appendParagraph('Quick Patient Care Report');
  h.setHeading(DocumentApp.ParagraphHeading.TITLE);

  body.appendParagraph('HMG Aviation Medical Services  Hajj 2026 MMMP-SL').setItalic(true);

  if (data.incident_id) {
    body.appendParagraph('Linked dispatch: ' + data.incident_id).setBold(true);
  }
  body.appendParagraph('Report generated: ' + Utilities.formatDate(ts, 'GMT+3', 'yyyy-MM-dd HH:mm:ss') + ' (KSA)');
  body.appendHorizontalRule();

  // ----- Sections -----
  appendSection_(body, 'Encounter', [
    ['Station',          data.station],
    ['Sub-location',     data.sub_location],
    ['Time of contact',  data.contact_time],
    ['Treating unit',    data.treating_unit],
    ['Crew NIDs',        data.crew_nids]
  ]);

  appendSection_(body, 'Patient', [
    ['Nusuk ID',     data.patient_nusuk_id],
    ['NID',          data.patient_nid],
    ['Iqama',        data.patient_iqama],
    ['Passport',     data.patient_passport],
    ['Description',  data.patient_unknown_description],
    ['Age',          data.age],
    ['Gender',       data.gender],
    ['Nationality',  data.nationality]
  ]);

  appendSection_(body, 'Clinical', [
    ['Chief complaint', data.complaint],
    ['Acuity',          String(data.acuity || '').toUpperCase()],
    ['Cardiac arrest',  data.cardiac_arrest ? 'YES' : ''],
    ['BP',              data.bp],
    ['HR',              data.hr],
    ['RR',              data.rr],
    ['SpO2',            data.spo2],
    ['Temp',            data.temp],
    ['GCS',             data.gcs],
    ['Interventions',   data.interventions]
  ]);

  appendSection_(body, 'Disposition', [
    ['Disposition', data.disposition]
  ]);

  if (data.form_route === 'long') {
    appendSection_(body, 'Long PCR', [
      ['Onset / narrative',     data.narrative],
      ['Secondary survey',      data.secondary_survey],
      ['Medications',           data.medications],
      ['Hospital destination',  data.hospital_destination],
      ['Transfer started',      data.transfer_started],
      ['NoK notified',          data.nok_notified]
    ]);
  }

  if (data.notes) {
    appendSection_(body, 'Notes', [['Notes', data.notes]]);
  }

  body.appendHorizontalRule();
  body.appendParagraph('Form path: ' + (data.form_route || 'quick'));
  body.appendParagraph('Submitted at: ' + (data.submitted_at || ts.toISOString()));

  doc.saveAndClose();

  // Export Doc as PDF blob
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs('application/pdf').setName(docName + '.pdf');

  // Save PDF to target folder (or root if not configured)
  let pdfFile;
  if (PCR_CONFIG.PDF_FOLDER_ID) {
    const folder = DriveApp.getFolderById(PCR_CONFIG.PDF_FOLDER_ID);
    pdfFile = folder.createFile(pdfBlob);
  } else {
    pdfFile = DriveApp.createFile(pdfBlob);
  }

  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // Trash the temporary Doc
  docFile.setTrashed(true);

  return pdfFile.getUrl();
}

function appendSection_(body, sectionTitle, rows) {
  // Filter out empty rows
  const filled = rows.filter(function(r) { return r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== ''; });
  if (filled.length === 0) return;

  body.appendParagraph(sectionTitle).setHeading(DocumentApp.ParagraphHeading.HEADING2);

  const table = body.appendTable();
  filled.forEach(function(r) {
    const row = table.appendTableRow();
    const labelCell = row.appendTableCell(String(r[0]));
    const valueCell = row.appendTableCell(String(r[1]));
    labelCell.setWidth(140);
    labelCell.editAsText().setBold(true);
  });
}

// ============================================================
// PCR_LOG WRITER (18-column schema)
// ============================================================

function logPCR_(data, pdfUrl) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);

    const ss = SpreadsheetApp.openById(PCR_CONFIG.PCR_LOG_SHEET_ID);
    let sh = ss.getSheetByName(PCR_CONFIG.PCR_LOG_TAB);
    if (!sh) {
      sh = ss.insertSheet(PCR_CONFIG.PCR_LOG_TAB);
    }

    // First-run header creation (only if sheet is empty)
    if (sh.getLastRow() === 0) {
      sh.appendRow([
        'Timestamp','PDF_URL','Station',
        'Patient_Nusuk_ID','Patient_NID','Patient_Iqama','Patient_Passport','Patient_Unknown_Description',
        'Age','Gender','Nationality','Complaint','Acuity','Disposition',
        'Treating_Unit','Incident_ID','Notes','Raw_JSON'
      ]);
      sh.getRange(1, 1, 1, 18)
        .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }

    sh.appendRow([
      new Date(),
      pdfUrl || '',
      f_(data, 'station', 'Station'),
      f_(data, 'patient_nusuk_id', 'nusuk_id', 'Patient_Nusuk_ID'),
      f_(data, 'patient_nid',      'Patient_NID'),
      f_(data, 'patient_iqama',    'Patient_Iqama'),
      f_(data, 'patient_passport', 'Patient_Passport'),
      f_(data, 'patient_unknown_description', 'Patient_Unknown_Description'),
      f_(data, 'age',         'Age'),
      f_(data, 'gender',      'Gender', 'sex', 'Sex'),
      f_(data, 'nationality', 'Nationality'),
      f_(data, 'complaint',   'chief_complaint', 'Complaint', 'cc'),
      f_(data, 'acuity',      'Acuity', 'triage', 'severity'),
      f_(data, 'disposition', 'Disposition', 'dispo'),
      f_(data, 'treating_unit', 'unit', 'Unit', 'crew'),
      f_(data, 'incident_id', 'incidentId', 'Incident_ID'),
      f_(data, 'notes',       'Notes', 'comments'),
      JSON.stringify(data)
    ]);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// Variadic field-lookup helper: given data + any number of candidate keys,
// returns the first non-empty value. Tolerates camelCase / snake_case / Pascal.
function f_(data) {
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (data && data[k] !== undefined && data[k] !== null && String(data[k]) !== '') {
      return data[k];
    }
  }
  return '';
}

// ============================================================
// (OPTIONAL) Setup helpers — run from editor
// ============================================================

function testGeneratePDF_() {
  // Run from editor to verify PDF generation + sheet write work end-to-end
  const sample = {
    incident_id: 'TEST-' + new Date().getTime(),
    station: 'MIN2',
    sub_location: 'south ramp',
    contact_time: new Date().toISOString().slice(0,16),
    treating_unit: 'Alpha-12',
    crew_nids: '1234567890',
    patient_nusuk_id: 'NUSUK-TEST-001',
    age: '45', gender: 'Male', nationality: 'Saudi',
    complaint: 'Heat exhaustion',
    acuity: 'yellow', cardiac_arrest: false,
    bp: '110/70', hr: '92', rr: '20', spo2: '96', temp: '38.2', gcs: '15',
    interventions: 'O2, IV access, Cooling',
    disposition: 'Treat & Release',
    notes: 'Test PCR submission from script editor.',
    form_route: 'quick',
    submitted_at: new Date().toISOString()
  };
  const url = generatePDF(sample);
  Logger.log('Test PDF: ' + url);
  return url;
}
