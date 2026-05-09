-- Hajj CAD — D1 schema v1.0
-- Single source of truth for all live ops data.
-- Mob Sheet is for team editing only; sync layer pushes one-way to D1.

-- ============================================================
-- AUTH
-- ============================================================

-- Allowlist: who is authorized to log in. Synced from Mob Sheet.
CREATE TABLE IF NOT EXISTS allowlist (
  nid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- paramedic|gp|sar|cluster_supervisor|dispatcher|leadership|admin
  cluster TEXT,                  -- arafat|muzdalifah|mina|null
  station TEXT,                  -- ARF1..MIN3 or null
  unit_code TEXT,                -- assigned ambulance unit, optional
  mobile_last4 TEXT NOT NULL,    -- last 4 digits of mobile, used as PIN
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_allowlist_role ON allowlist(role);
CREATE INDEX IF NOT EXISTS idx_allowlist_station ON allowlist(station);
CREATE INDEX IF NOT EXISTS idx_allowlist_active ON allowlist(active);

-- Sessions: 72h auth tokens.
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  nid TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ua TEXT,
  ip_hash TEXT,
  FOREIGN KEY (nid) REFERENCES allowlist(nid)
);
CREATE INDEX IF NOT EXISTS idx_sessions_nid ON sessions(nid);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- Login attempts: rate limiting + audit.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nid TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  success INTEGER NOT NULL,
  ip_hash TEXT,
  ua TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_nid_ts ON login_attempts(nid, ts);

-- ============================================================
-- LIVE OPS (D1-only, never touch sheet)
-- ============================================================

-- Dispatch log: every incident created during ops.
CREATE TABLE IF NOT EXISTS dispatch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT UNIQUE NOT NULL,        -- e.g. "DSP-20260526-0001"
  ts INTEGER NOT NULL,                     -- created_at unix seconds
  station TEXT NOT NULL,                   -- ARF1..MIN3
  sub_location TEXT,                       -- North-Clinic, Ramp-3-North, Jamarat-Bridge-1, etc.
  source TEXT,                             -- walk-in, emergency-call, ambulance, OCC, other
  complaint TEXT,                          -- chest pain, syncope, trauma, etc.
  triage TEXT,                             -- red|yellow|green|black
  cardiac_arrest INTEGER NOT NULL DEFAULT 0,
  unit_assigned TEXT,                      -- unit_code if dispatched
  status TEXT NOT NULL,                    -- pending|on_scene|transporting|complete|cancelled
  pcr_id TEXT,                             -- link to PCR if filed
  patient_count INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_by_nid TEXT NOT NULL,
  closed_at INTEGER,
  closed_by_nid TEXT,
  FOREIGN KEY (created_by_nid) REFERENCES allowlist(nid)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_ts ON dispatch_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_station ON dispatch_log(station, ts DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_log(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_unit ON dispatch_log(unit_assigned);

-- Station status log: append-only, persists forever.
CREATE TABLE IF NOT EXISTS station_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  station TEXT NOT NULL,
  sub_location TEXT,
  status TEXT NOT NULL,                    -- open|closed|degraded|surge|offline
  capacity_pct INTEGER,                    -- 0-100, optional
  set_by_nid TEXT NOT NULL,
  note TEXT,
  FOREIGN KEY (set_by_nid) REFERENCES allowlist(nid)
);
CREATE INDEX IF NOT EXISTS idx_sslog_ts ON station_status_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_sslog_station_ts ON station_status_log(station, ts DESC);

-- Reposition log: unit movements between stations.
CREATE TABLE IF NOT EXISTS reposition_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_code TEXT NOT NULL,
  from_station TEXT NOT NULL,
  to_station TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,                    -- requested|approved|in_transit|completed|cancelled
  requested_by_nid TEXT NOT NULL,
  requested_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  approved_by_nid TEXT,
  approved_at INTEGER,
  completed_at INTEGER,
  notes TEXT,
  FOREIGN KEY (requested_by_nid) REFERENCES allowlist(nid),
  FOREIGN KEY (approved_by_nid) REFERENCES allowlist(nid)
);
CREATE INDEX IF NOT EXISTS idx_reposition_unit ON reposition_log(unit_code, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_reposition_status ON reposition_log(status);

-- Unit status log: status changes for each unit.
CREATE TABLE IF NOT EXISTS unit_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  unit_code TEXT NOT NULL,
  status TEXT NOT NULL,                    -- available|on_call|en_route|on_scene|transporting|out_of_service
  note TEXT,
  set_by_nid TEXT NOT NULL,
  FOREIGN KEY (set_by_nid) REFERENCES allowlist(nid)
);
CREATE INDEX IF NOT EXISTS idx_unitlog_unit_ts ON unit_status_log(unit_code, ts DESC);
CREATE INDEX IF NOT EXISTS idx_unitlog_ts ON unit_status_log(ts DESC);

-- ============================================================
-- DENORMALIZED CURRENT STATE (for fast reads)
-- ============================================================

-- Units: current state of each ambulance.
CREATE TABLE IF NOT EXISTS units (
  unit_code TEXT PRIMARY KEY,
  station TEXT NOT NULL,
  current_station TEXT,                    -- if repositioned, where it is now
  status TEXT NOT NULL DEFAULT 'available',
  crew_nids TEXT,                          -- JSON array of paramedic NIDs
  last_status_ts INTEGER,
  last_dispatch_id TEXT,
  notes TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_units_station ON units(station);
CREATE INDEX IF NOT EXISTS idx_units_current_station ON units(current_station);
CREATE INDEX IF NOT EXISTS idx_units_status ON units(status);

-- Stations: current state per station.
CREATE TABLE IF NOT EXISTS stations (
  station_code TEXT PRIMARY KEY,           -- ARF1..MIN3
  cluster TEXT NOT NULL,                   -- arafat|muzdalifah|mina
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  capacity_pct INTEGER DEFAULT 100,
  last_status_ts INTEGER,
  last_set_by_nid TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_stations_cluster ON stations(cluster);

-- ============================================================
-- SHEET-MIRRORED (one-way sync from Mob Sheet)
-- ============================================================

-- Augmentations: planned movements per Hajj day.
CREATE TABLE IF NOT EXISTS augmentations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hajj_day TEXT NOT NULL,                  -- DH4..DH14
  date_g TEXT,                             -- gregorian date
  donor_station TEXT NOT NULL,
  recipient_station TEXT NOT NULL,
  staff_count INTEGER DEFAULT 0,
  unit_count INTEGER DEFAULT 0,
  notes TEXT,
  status TEXT DEFAULT 'planned',
  sheet_synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_aug_day ON augmentations(hajj_day);

-- Mobilization plan: full daily allocation.
CREATE TABLE IF NOT EXISTS mobilization_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hajj_day TEXT NOT NULL,
  date_g TEXT,
  station TEXT NOT NULL,
  shift TEXT,                              -- morning|evening|24h
  staff_required INTEGER,
  units_assigned INTEGER,
  pax_direction TEXT,
  notes TEXT,
  sheet_synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_mob_day_station ON mobilization_plan(hajj_day, station);

-- Staff assignment: per-day per-staff assignments.
CREATE TABLE IF NOT EXISTS staff_assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nid TEXT NOT NULL,
  hajj_day TEXT NOT NULL,
  date_g TEXT,
  station TEXT NOT NULL,
  shift TEXT,
  unit_code TEXT,
  role TEXT,
  sheet_synced_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_sa_nid ON staff_assignment(nid, hajj_day);
CREATE INDEX IF NOT EXISTS idx_sa_station_day ON staff_assignment(station, hajj_day);

-- ============================================================
-- AUDIT
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  actor_nid TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  resource_id TEXT,
  details TEXT,                            -- JSON blob
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_nid, ts DESC);

-- ============================================================
-- META
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

INSERT OR REPLACE INTO sync_state (key, value) VALUES ('schema_version', '1.0');
INSERT OR REPLACE INTO sync_state (key, value) VALUES ('migrated_at', strftime('%s','now'));
