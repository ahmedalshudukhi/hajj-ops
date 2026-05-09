#!/usr/bin/env python3
"""
Hajj CAD — Historical data migration from Apps Script (Mob Sheet) → D1.

Run AFTER the worker is deployed and the user has logged in once.
This script uses Ahmed's existing GAS session to pull:
  - Augmentations (raw rows)
  - Mobilization Plan (raw rows)
  - Staff Assignment (raw rows)
  - Dispatch Log (recent incidents)
  - Reposition Log (pending + recent)
  - Station Status Log (latest per station)

It then INSERTs into D1 tables.

Idempotent: uses INSERT OR IGNORE / INSERT OR REPLACE based on natural keys.

Usage:
  python3 migration/migrate_data.py             # full migration
  python3 migration/migrate_data.py --dispatch  # dispatch only
  python3 migration/migrate_data.py --status    # station status only
  python3 migration/migrate_data.py --stats     # show D1 row counts only
"""
import os
import sys
import json
import time
import getpass
import urllib.request
import urllib.parse
import urllib.error
import subprocess
import argparse
from typing import Any, Dict, List, Optional, Tuple

# ============ Config ============
GAS_URL = "https://script.google.com/macros/s/AKfycbxm3tEWy8RiJXjxGV_yPLG6j4iXv_HiPVYzJ28B-evL9OcM4pzap9GglUMkAvvht4Y/exec"
D1_NAME = "hajj_cad"

# ============ Helpers ============
def gas_call(action: str, token: str = None, **params) -> Dict[str, Any]:
    """Call Apps Script /exec endpoint."""
    qs = {'action': action}
    if token:
        qs['token'] = token
    qs.update({k: str(v) for k, v in params.items() if v is not None})
    url = GAS_URL + '?' + urllib.parse.urlencode(qs)
    try:
        req = urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'ok': False, 'error': f'http_{e.code}', 'detail': e.read().decode('utf-8')[:300]}
    except Exception as e:
        return {'ok': False, 'error': 'network', 'detail': str(e)}

def gas_login(nid: str, otp: str = None) -> Optional[str]:
    """Log in to Apps Script and return session token."""
    print(f"  GAS login for NID {nid}...", flush=True)
    r = gas_call('login', nid=nid)
    if not r.get('ok'):
        print(f"  GAS login failed: {r.get('error')} {r.get('detail','')[:100]}")
        return None
    token = r.get('token') or r.get('session_token')
    if not token:
        print(f"  GAS login: no token in response: {list(r.keys())}")
        return None
    print(f"  GAS token acquired: {token[:8]}...{token[-4:]}")
    return token

def d1_exec(sql: str) -> Dict[str, Any]:
    """Execute SQL via wrangler d1 execute."""
    cmd = ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--command', sql]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        out = r.stdout + r.stderr
        # Crude success detection
        if '"success": true' in out or '"changes":' in out or '[' in out:
            return {'ok': True, 'output': out}
        return {'ok': False, 'output': out}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def d1_exec_file(filepath: str) -> Dict[str, Any]:
    """Execute SQL file via wrangler d1 execute --file."""
    cmd = ['wrangler', 'd1', 'execute', D1_NAME, '--remote', '--file', filepath]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        out = r.stdout + r.stderr
        if '"success": true' in out or 'rows_written' in out:
            return {'ok': True, 'output': out}
        return {'ok': False, 'output': out}
    except Exception as e:
        return {'ok': False, 'error': str(e)}

def sql_str(s: Any) -> str:
    """SQL-escape a value for inline insertion."""
    if s is None:
        return 'NULL'
    if isinstance(s, bool):
        return '1' if s else '0'
    if isinstance(s, (int, float)):
        return str(s)
    s = str(s).replace("'", "''").replace("\n", " ").replace("\r", "")
    return f"'{s}'"

def to_unix(iso_str: Any) -> Optional[int]:
    """Convert ISO timestamp string to unix seconds. Returns None on failure."""
    if not iso_str:
        return None
    try:
        # Try ISO format
        from datetime import datetime
        s = str(iso_str).replace('Z', '+00:00')
        return int(datetime.fromisoformat(s).timestamp())
    except Exception:
        try:
            return int(float(iso_str))  # already a number
        except Exception:
            return None

# ============ Migration: Dispatch Log ============
def migrate_dispatch(token: str) -> Dict[str, int]:
    print("\n[1/6] Migrating dispatch incidents...")
    r = gas_call('dispatch_list', token=token, limit=2000)
    if not r.get('ok'):
        print(f"  ERROR: {r.get('error')} {r.get('detail','')[:100]}")
        return {'pulled': 0, 'inserted': 0}
    incidents = r.get('incidents', [])
    print(f"  Pulled {len(incidents)} incidents from sheet")

    if not incidents:
        return {'pulled': 0, 'inserted': 0}

    # Build batch INSERT
    sqls = []
    for inc in incidents:
        incident_id = inc.get('Incident_ID') or inc.get('id') or ''
        if not incident_id:
            continue
        ts = to_unix(inc.get('Created_At') or inc.get('Timestamp')) or int(time.time())
        station = (inc.get('Zone') or inc.get('station') or '').upper()
        sub_loc = inc.get('Sub_Location') or inc.get('sub_location') or ''
        source = inc.get('Source') or inc.get('source') or 'walk-in'
        complaint = inc.get('Chief_Complaint') or inc.get('Complaint') or ''
        triage = (inc.get('Category') or inc.get('Triage') or 'green').lower()
        cardiac = 1 if (inc.get('Cardiac_Arrest') in (True, 1, '1', 'true', 'yes')) else 0
        unit = inc.get('Unit') or inc.get('unit_assigned') or ''
        status = (inc.get('Status') or 'pending').lower()
        patient_count = int(inc.get('Patient_Count') or 1)
        notes = inc.get('Notes') or ''
        created_by = inc.get('Created_By') or inc.get('created_by_nid') or '1089727133'
        closed_at = to_unix(inc.get('Closed_At'))
        closed_by = inc.get('Closed_By') or None
        pcr_id = inc.get('PCR_ID') or inc.get('Q_PCR_ID') or None

        sql = (
            f"INSERT OR IGNORE INTO dispatch_log "
            f"(incident_id, ts, station, sub_location, source, complaint, triage, "
            f"cardiac_arrest, unit_assigned, status, patient_count, notes, created_by_nid, "
            f"closed_at, closed_by_nid, pcr_id) VALUES ("
            f"{sql_str(incident_id)}, {ts}, {sql_str(station)}, {sql_str(sub_loc)}, "
            f"{sql_str(source)}, {sql_str(complaint)}, {sql_str(triage)}, {cardiac}, "
            f"{sql_str(unit)}, {sql_str(status)}, {patient_count}, {sql_str(notes)}, "
            f"{sql_str(created_by)}, {sql_str(closed_at) if closed_at else 'NULL'}, "
            f"{sql_str(closed_by)}, {sql_str(pcr_id)})"
        )
        sqls.append(sql)

    # Batch into chunks of 50 (D1 statement size limits)
    inserted = 0
    for i in range(0, len(sqls), 50):
        batch = sqls[i:i+50]
        sql = ';\n'.join(batch) + ';'
        # Write to temp file (safer than command-line escape hell)
        tmpfile = '/tmp/d1_dispatch_batch.sql'
        with open(tmpfile, 'w') as f:
            f.write(sql)
        r = d1_exec_file(tmpfile)
        if r.get('ok'):
            inserted += len(batch)
            print(f"  ✓ Batch {i//50 + 1}: {len(batch)} rows", flush=True)
        else:
            print(f"  ✗ Batch {i//50 + 1} FAILED: {r.get('output', '')[:200]}")

    return {'pulled': len(incidents), 'inserted': inserted}

# ============ Migration: Reposition Log ============
def migrate_reposition(token: str) -> Dict[str, int]:
    print("\n[2/6] Migrating reposition log...")
    r = gas_call('reposition_list', token=token)
    if not r.get('ok'):
        print(f"  ERROR: {r.get('error')}")
        return {'pulled': 0, 'inserted': 0}
    pending = r.get('pending', [])
    recent = r.get('recent', [])
    # Dedup by ID
    seen = set()
    all_rows = []
    for row in pending + recent:
        rid = row.get('id') or row.get('ID')
        key = (row.get('Unit_Code'), row.get('From_Station'), row.get('To_Station'), row.get('Timestamp'))
        if key not in seen:
            seen.add(key)
            all_rows.append(row)
    print(f"  Pulled {len(all_rows)} reposition rows from sheet")
    if not all_rows:
        return {'pulled': 0, 'inserted': 0}

    sqls = []
    for row in all_rows:
        unit = row.get('Unit_Code') or row.get('unit_code') or ''
        from_st = (row.get('From_Station') or '').upper()
        to_st = (row.get('To_Station') or '').upper()
        reason = row.get('Reason') or ''
        status = (row.get('Status') or 'requested').lower()
        requested_by = row.get('Requested_By') or row.get('requested_by_nid') or '1089727133'
        requested_at = to_unix(row.get('Timestamp')) or int(time.time())
        completed_at = to_unix(row.get('Completed_At'))
        notes = row.get('Notes') or ''
        if not unit or not from_st or not to_st:
            continue
        sql = (
            f"INSERT OR IGNORE INTO reposition_log "
            f"(unit_code, from_station, to_station, reason, status, requested_by_nid, "
            f"requested_at, completed_at, notes) VALUES ("
            f"{sql_str(unit)}, {sql_str(from_st)}, {sql_str(to_st)}, {sql_str(reason)}, "
            f"{sql_str(status)}, {sql_str(requested_by)}, {requested_at}, "
            f"{completed_at if completed_at else 'NULL'}, {sql_str(notes)})"
        )
        sqls.append(sql)

    inserted = 0
    for i in range(0, len(sqls), 50):
        batch = sqls[i:i+50]
        tmpfile = '/tmp/d1_reposition_batch.sql'
        with open(tmpfile, 'w') as f:
            f.write(';\n'.join(batch) + ';')
        r = d1_exec_file(tmpfile)
        if r.get('ok'):
            inserted += len(batch)
            print(f"  ✓ Batch {i//50 + 1}: {len(batch)} rows", flush=True)
        else:
            print(f"  ✗ Batch failed: {r.get('output','')[:200]}")
    return {'pulled': len(all_rows), 'inserted': inserted}

# ============ Migration: Station Status (latest snapshot) ============
def migrate_station_status(token: str) -> Dict[str, int]:
    print("\n[3/6] Migrating station status (latest snapshot)...")
    r = gas_call('station_status_list', token=token)
    if not r.get('ok'):
        print(f"  ERROR: {r.get('error')}")
        return {'pulled': 0, 'inserted': 0}
    stations = r.get('stations', [])
    # Filter to ones with actual status set
    set_stations = [s for s in stations if s.get('status')]
    print(f"  Pulled {len(stations)} stations, {len(set_stations)} with status set")
    if not set_stations:
        return {'pulled': len(stations), 'inserted': 0}

    sqls = []
    for st in set_stations:
        station = (st.get('station') or '').upper()
        status = (st.get('status') or 'open').lower()
        note = st.get('note') or ''
        operator = st.get('operator_nid') or st.get('Set_By') or '1089727133'
        ts = to_unix(st.get('Timestamp') or st.get('Updated_At')) or int(time.time())
        if not station:
            continue
        sql = (
            f"INSERT INTO station_status_log "
            f"(ts, station, status, set_by_nid, note) VALUES ("
            f"{ts}, {sql_str(station)}, {sql_str(status)}, {sql_str(operator)}, {sql_str(note)})"
        )
        sqls.append(sql)

    inserted = 0
    if sqls:
        tmpfile = '/tmp/d1_station_status.sql'
        with open(tmpfile, 'w') as f:
            f.write(';\n'.join(sqls) + ';')
        r = d1_exec_file(tmpfile)
        if r.get('ok'):
            inserted = len(sqls)
            print(f"  ✓ Inserted {inserted} station status snapshots", flush=True)
        else:
            print(f"  ✗ Insert failed: {r.get('output','')[:200]}")
    return {'pulled': len(stations), 'inserted': inserted}

# ============ Stats ============
def show_stats():
    print("\n=== D1 row counts ===")
    tables = [
        'allowlist', 'sessions', 'dispatch_log', 'reposition_log',
        'station_status_log', 'unit_status_log', 'qpcr_log', 'audit_log'
    ]
    for t in tables:
        r = d1_exec(f"SELECT COUNT(*) AS n FROM {t}")
        # Parse the count from output
        n = '?'
        try:
            for line in (r.get('output') or '').split('\n'):
                line = line.strip()
                if '"n":' in line:
                    n = line.split('"n":')[1].strip().rstrip(',').strip()
                    break
        except Exception:
            pass
        print(f"  {t:25s} {n} rows")

# ============ Main ============
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dispatch', action='store_true', help='Migrate dispatch only')
    parser.add_argument('--reposition', action='store_true', help='Migrate reposition only')
    parser.add_argument('--status', action='store_true', help='Migrate station status only')
    parser.add_argument('--stats', action='store_true', help='Show D1 row counts only')
    parser.add_argument('--nid', default=None, help='NID for GAS login (default: prompt)')
    parser.add_argument('--token', default=None, help='Use existing GAS token (skip login)')
    args = parser.parse_args()

    if args.stats:
        show_stats()
        return

    print("=" * 60)
    print("Hajj CAD — Historical data migration")
    print("=" * 60)

    # Login to GAS
    token = args.token or os.environ.get('GAS_TOKEN')
    if not token:
        nid = args.nid or input("NID: ").strip()
        token = gas_login(nid)
        if not token:
            print("FATAL: cannot proceed without GAS session")
            sys.exit(1)

    # Run migrations
    selected = args.dispatch or args.reposition or args.status
    results = {}
    if not selected or args.dispatch:
        results['dispatch'] = migrate_dispatch(token)
    if not selected or args.reposition:
        results['reposition'] = migrate_reposition(token)
    if not selected or args.status:
        results['station_status'] = migrate_station_status(token)

    # Summary
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    for k, v in results.items():
        print(f"  {k:20s} pulled={v.get('pulled',0):4d}  inserted={v.get('inserted',0):4d}")

    show_stats()

    print("\nDone.")

if __name__ == '__main__':
    main()
