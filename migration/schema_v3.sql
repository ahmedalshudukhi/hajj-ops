-- Hajj CAD — schema v1.2: planning data tables (raw rows from Mob Sheet)
-- Replaces empty placeholder tables with shapes that match Mobilization_Plan.xlsx

DROP TABLE IF EXISTS augmentations;
DROP TABLE IF EXISTS mobilization_plan;
DROP TABLE IF EXISTS staff_assignment;

-- Augmentations: 1 row per paramedic redeployment
CREATE TABLE augmentations (
  aug_id TEXT PRIMARY KEY,           -- e.g. "AUG-001"
  from_unit TEXT,
  to_station TEXT,
  movement TEXT,
  dh_day INTEGER,
  hour TEXT,
  status TEXT,                       -- Planned|Active|Returned|Cancelled
  reason TEXT,
  notes TEXT,
  imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_aug_status ON augmentations(status);
CREATE INDEX idx_aug_movement ON augmentations(movement);
CREATE INDEX idx_aug_to_station ON augmentations(to_station);
CREATE INDEX idx_aug_dh_day ON augmentations(dh_day);

-- Mobilization Plan: pivoted long format from Schedule tab
-- Each row = (unit_id, slot_key, value)
CREATE TABLE mobilization_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id TEXT NOT NULL,
  unit_type TEXT,
  unit_size INTEGER,
  home TEXT,
  slot_key TEXT NOT NULL,           -- "4DH-S1", "5DH-S2", ...
  dh_day INTEGER,                   -- parsed from slot_key
  shift INTEGER,                    -- 1 or 2
  value TEXT,                       -- station code or shift code
  imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(unit_id, slot_key)
);
CREATE INDEX idx_mp_unit ON mobilization_plan(unit_id);
CREATE INDEX idx_mp_slot ON mobilization_plan(slot_key);
CREATE INDEX idx_mp_dh ON mobilization_plan(dh_day, shift);
CREATE INDEX idx_mp_value ON mobilization_plan(value);

-- Staff Assignment: roster from Staff tab
CREATE TABLE staff_assignment (
  staff_id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT,
  unit TEXT,
  slot INTEGER,
  phone TEXT,
  email TEXT,
  radio_call_sign TEXT,
  status TEXT,
  total_hours INTEGER,
  imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX idx_staff_role ON staff_assignment(role);
CREATE INDEX idx_staff_unit ON staff_assignment(unit);
CREATE INDEX idx_staff_status ON staff_assignment(status);
CREATE INDEX idx_staff_email ON staff_assignment(email);

INSERT OR REPLACE INTO sync_state (key, value) VALUES ('schema_version', '1.2');
