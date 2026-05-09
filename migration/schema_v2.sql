-- Hajj CAD — schema v1.1 additions
-- Idempotent: safe to apply multiple times.

-- Q_PCR: patient care reports
CREATE TABLE IF NOT EXISTS qpcr_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pcr_id TEXT UNIQUE NOT NULL,
  ts INTEGER NOT NULL,
  incident_id TEXT,                -- optional link to dispatch_log
  station TEXT,
  unit_code TEXT,
  patient_name TEXT,
  patient_age INTEGER,
  patient_gender TEXT,
  patient_nationality TEXT,
  chief_complaint TEXT,
  triage_category TEXT,            -- red|yellow|green|black
  vitals_json TEXT,                -- JSON blob: bp, hr, rr, spo2, temp, gcs
  treatment TEXT,
  disposition TEXT,                -- transferred|treated_released|refused|deceased
  transferred_to TEXT,
  responder_nid TEXT,
  notes TEXT,
  raw_json TEXT,                   -- full original payload for traceability
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (responder_nid) REFERENCES allowlist(nid)
);
CREATE INDEX IF NOT EXISTS idx_qpcr_ts ON qpcr_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_qpcr_station_ts ON qpcr_log(station, ts DESC);
CREATE INDEX IF NOT EXISTS idx_qpcr_incident ON qpcr_log(incident_id);
CREATE INDEX IF NOT EXISTS idx_qpcr_responder ON qpcr_log(responder_nid);

-- Migration metadata
INSERT OR REPLACE INTO sync_state (key, value) VALUES ('schema_version', '1.1');
INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_history_migration_at', '0');
