-- Hajj CAD seed_static.sql — stations + ambulance units (no PII)
-- Generated from data.json on import

-- Stations
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('ARF1', 'arafat', 'Arafat Station 1');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('ARF2', 'arafat', 'Arafat Station 2');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('ARF3', 'arafat', 'Arafat Station 3');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('MUZ1', 'muzdalifah', 'Muzdalifah Station 1');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('MUZ2', 'muzdalifah', 'Muzdalifah Station 2');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('MUZ3', 'muzdalifah', 'Muzdalifah Station 3');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('MIN1', 'mina', 'Mina Station 1');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('MIN2', 'mina', 'Mina Station 2');
INSERT OR REPLACE INTO stations (station_code, cluster, name) VALUES ('MIN3', 'mina', 'Mina Station 3 (Jamarat)');

-- Ambulance units (25 ALS)
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E01', 'ARF1', 'ARF1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B01', 'ARF1', 'ARF1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E02', 'ARF2', 'ARF2', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B02', 'ARF2', 'ARF2', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E03', 'ARF3', 'ARF3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B03', 'ARF3', 'ARF3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E04', 'MUZ1', 'MUZ1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B04', 'MUZ1', 'MUZ1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E05', 'MUZ2', 'MUZ2', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B05', 'MUZ2', 'MUZ2', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E06', 'MUZ3', 'MUZ3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B06', 'MUZ3', 'MUZ3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E07', 'MIN1', 'MIN1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B07', 'MIN1', 'MIN1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E08', 'MIN2', 'MIN2', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B08', 'MIN2', 'MIN2', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E09', 'MIN3', 'MIN3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('B09', 'MIN3', 'MIN3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('E10', 'OCC', 'OCC', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('R01', 'ARF1', 'ARF1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('R02', 'ARF3', 'ARF3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('R03', 'MUZ1', 'MUZ1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('R04', 'MUZ3', 'MUZ3', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('R05', 'MIN1', 'MIN1', 'available');
INSERT OR REPLACE INTO units (unit_code, station, current_station, status) VALUES ('R06', 'MIN3', 'MIN3', 'available');
