# DCH PCR Script — Surgical Patches

You have access to DCH's Apps Script. Three small additions enable: incident_id flow-through (auto-link from /dispatch), Nusuk ID as primary patient identifier, and structured logging back to PCR_Log with incident_id.

## Files involved

The script has two files:
- `Code.gs` — server (doGet, generatePDF, logPCR_)
- `index.html` — form template

## Patch 1 — `Code.gs` doGet (replaces existing doGet)

```javascript
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('index');
  t.incidentId     = (e && e.parameter && e.parameter.incident_id)     || '';
  t.prefillStation = (e && e.parameter && e.parameter.prefill_station) || '';
  t.prefillUnit    = (e && e.parameter && e.parameter.prefill_unit)    || '';
  return t.evaluate();
}
```

This passes URL parameters into the form template. When `/dispatch` opens the PCR form via `{DCH_URL}?incident_id=INC-...&prefill_station=MIN2&prefill_unit=Alpha-12`, the values flow through.

## Patch 2 — `index.html` (3 additions)

### 2a. At the top of the form (right after opening `<form>` tag), add:

```html
<input type="hidden" id="incident_id" name="incident_id" value="<?= incidentId ?>">
<script>
  window.PCR_PREFILL = {
    incident_id: '<?= incidentId ?>',
    station:     '<?= prefillStation ?>',
    unit:        '<?= prefillUnit ?>'
  };
</script>
```

### 2b. Replace existing Patient ID input with this group of 5 inputs:

```html
<label class="field-label">Patient ID</label>
<div style="display:flex; flex-direction:column; gap:6px;">
  <input type="text" id="patient_nusuk_id" name="patient_nusuk_id"
         placeholder="Nusuk ID (preferred)" autocomplete="off">
  <details style="font-size:13px; color:#666;">
    <summary style="cursor:pointer;">No Nusuk? Use a fallback ID</summary>
    <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
      <input type="text" id="patient_nid"      name="patient_nid"      placeholder="Saudi NID (10 digits)">
      <input type="text" id="patient_iqama"    name="patient_iqama"    placeholder="Iqama number">
      <input type="text" id="patient_passport" name="patient_passport" placeholder="Passport number">
      <input type="text" id="patient_unknown_description"
             name="patient_unknown_description"
             placeholder="Unknown — describe (e.g. adult male, ~40)">
    </div>
  </details>
</div>
```

### 2c. Inside your existing initialization `<script>` block in index.html, add:

```javascript
(function() {
  const pre = window.PCR_PREFILL || {};
  if (pre.station && document.getElementById('station')) {
    document.getElementById('station').value = pre.station;
  }
  if (pre.unit && document.getElementById('treating_unit')) {
    document.getElementById('treating_unit').value = pre.unit;
  }
  if (pre.incident_id) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#dcfce7; border:1px solid #22c55e; padding:10px; margin-bottom:14px; border-radius:6px; font-size:13px; color:#166534;';
    banner.textContent = 'Linked to dispatch incident: ' + pre.incident_id;
    const form = document.querySelector('form');
    if (form) form.parentElement.insertBefore(banner, form);
  }
})();
```

## Patch 3 — `Code.gs` logPCR_ (header row + appendRow)

In `logPCR_`, find the first-run header creation:

```javascript
sh.appendRow([
  'Timestamp','PDF_URL','Station','Patient_ID','Age','Gender',
  'Nationality','Complaint','Acuity','Disposition','Treating_Unit',
  'Incident_ID','Notes','Raw_JSON'
]);
```

Replace with:

```javascript
sh.appendRow([
  'Timestamp','PDF_URL','Station',
  'Patient_Nusuk_ID','Patient_NID','Patient_Iqama','Patient_Passport','Patient_Unknown_Description',
  'Age','Gender','Nationality','Complaint','Acuity','Disposition',
  'Treating_Unit','Incident_ID','Notes','Raw_JSON'
]);
```

Then find the data-write `appendRow` (the second one, with `f_(data,...)` calls). Replace it with:

```javascript
sh.appendRow([
  new Date(),
  pdfUrl,
  f_(data, 'station', 'Station'),
  f_(data, 'patient_nusuk_id', 'nusuk_id', 'Patient_Nusuk_ID'),
  f_(data, 'patient_nid', 'Patient_NID'),
  f_(data, 'patient_iqama', 'Patient_Iqama'),
  f_(data, 'patient_passport', 'Patient_Passport'),
  f_(data, 'patient_unknown_description', 'Patient_Unknown_Description'),
  f_(data, 'age', 'Age'),
  f_(data, 'gender', 'Gender', 'sex', 'Sex'),
  f_(data, 'nationality', 'Nationality'),
  f_(data, 'complaint', 'chief_complaint', 'Complaint', 'cc'),
  f_(data, 'acuity', 'Acuity', 'triage', 'severity'),
  f_(data, 'disposition', 'Disposition', 'dispo'),
  f_(data, 'treating_unit', 'unit', 'Unit', 'crew'),
  f_(data, 'incident_id', 'incidentId', 'Incident_ID'),
  f_(data, 'notes', 'Notes', 'comments'),
  JSON.stringify(data)
]);
```

This writes 18 columns matching the new header.

## Migration: existing PCR_Log rows

Your current PCR_Log has 14-column rows (the old format). The first time the new logPCR_ runs after these patches, getLastRow() check will skip the header creation (rows already exist). So your headers stay 14-column but new rows write 18 columns.

**Two options:**

**A. Preserve historical data (recommended).** Leave it as-is. Old rows have 14 columns, new rows have 18. Active Insights pulls by named column so works fine.

**B. Reset the log.** Delete all rows including the header. Next PCR submission will create the new 18-column header. Loses historical PCRs (probably fine since they were test entries).

## Apply

1. Open DCH's Apps Script project
2. **Code.gs** — apply Patch 1 + Patch 3
3. **index.html** — apply Patch 2 (3 additions)
4. **Save** — `Cmd+S`
5. **Deploy → Manage deployments → ✏️ → New version → Deploy**

## Verify

1. Open DCH form via plain URL (no params) → loads normally, no banner
2. Open `{DCH_URL}?incident_id=TEST-123&prefill_station=MIN2&prefill_unit=Alpha-12` → green banner appears showing "Linked to dispatch incident: TEST-123", station and unit pre-filled
3. Submit a test PCR → check PCR_Log → new row has Patient_Nusuk_ID and Incident_ID populated

After this, I'll wire the dispatch console's "File PCR" button to open the DCH form with the right URL params.
