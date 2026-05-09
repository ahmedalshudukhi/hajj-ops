#!/usr/bin/env python3
"""
migrate.py — Hajj CAD D1 migration orchestrator.

Run after `wrangler login`. Idempotent — safe to re-run.

USAGE:
  python3 migrate.py                  # full migration: create D1 + schema + seed + allowlist
  python3 migrate.py --no-allowlist   # everything EXCEPT allowlist (unattended-friendly)
  python3 migrate.py --allowlist-only # only seed allowlist (assumes D1+schema already there)

Stdlib only.
"""

import sys, os, json, subprocess, urllib.request, urllib.parse, getpass, re, argparse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIG_DIR = Path(__file__).resolve().parent
DB_NAME = 'hajj_cad'
BACKEND_URL = 'https://script.google.com/macros/s/AKfycbxm3tEWy8RiJXjxGV_yPLG6j4iXv_HiPVYzJ28B-evL9OcM4pzap9GglUMkAvvht4Y/exec'

def step(n, title):
    print()
    print('=' * 64)
    print(f'[{n}] {title}')
    print('=' * 64)

def run(cmd, check=True, capture=True):
    print(f'$ {cmd}')
    r = subprocess.run(cmd, shell=True, check=False, capture_output=capture, text=True)
    if r.stdout:
        print(r.stdout.rstrip())
    if r.stderr and r.returncode != 0:
        print(r.stderr.rstrip())
    if check and r.returncode != 0:
        print(f'Command failed (exit {r.returncode})')
        sys.exit(r.returncode)
    return r

def fail(msg):
    print(f'ERROR: {msg}')
    sys.exit(1)

def check_wrangler_auth():
    step(0, 'Verify wrangler authentication')
    r = run('wrangler whoami 2>&1', check=False)
    out = (r.stdout or '') + (r.stderr or '')
    if 'You are not authenticated' in out or 'not logged in' in out.lower() or r.returncode != 0:
        print()
        print('Not logged into Cloudflare.')
        print('Run this in your terminal first (one-time, ~30 seconds):')
        print()
        print('    wrangler login')
        print()
        print('Then re-run this script.')
        sys.exit(1)
    print('OK wrangler authed')

def get_or_create_d1():
    step(1, f'D1 database: {DB_NAME}')
    r = run(f'wrangler d1 list --json 2>/dev/null', check=False)
    db_id = None
    try:
        if r.stdout.strip().startswith('['):
            dbs = json.loads(r.stdout)
            for d in dbs:
                if d.get('name') == DB_NAME:
                    db_id = d.get('uuid') or d.get('database_id') or d.get('id')
                    if db_id:
                        print(f'OK Found existing: {db_id}')
                        return db_id
    except Exception:
        pass
    if not db_id:
        r2 = run(f'wrangler d1 list 2>&1', check=False)
        m = re.search(rf'\b([a-f0-9]{{8}}-[a-f0-9]{{4}}-[a-f0-9]{{4}}-[a-f0-9]{{4}}-[a-f0-9]{{12}})\b\s*\|\s*{re.escape(DB_NAME)}\b', r2.stdout)
        if not m:
            m = re.search(rf'{re.escape(DB_NAME)}\s*\|\s*([a-f0-9]{{8}}-[a-f0-9]{{4}}-[a-f0-9]{{4}}-[a-f0-9]{{4}}-[a-f0-9]{{12}})\b', r2.stdout)
        if m:
            db_id = m.group(1)
            print(f'OK Found existing (parsed): {db_id}')
            return db_id
    print('  Not found, creating...')
    r = run(f'wrangler d1 create {DB_NAME}')
    m = re.search(r'database_id\s*=\s*"([a-f0-9-]+)"', r.stdout)
    if not m:
        m = re.search(r'\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b', r.stdout)
    if not m:
        fail(f"Couldn't parse database_id from create output:\n{r.stdout}")
    db_id = m.group(1)
    print(f'OK Created: {db_id}')
    return db_id

def update_wrangler_toml(db_id):
    step(2, 'Update wrangler.toml with database_id')
    src = MIG_DIR / 'wrangler.toml'
    text = src.read_text()
    if 'PLACEHOLDER_FILL_AFTER_CREATE' in text:
        text = text.replace('PLACEHOLDER_FILL_AFTER_CREATE', db_id)
    else:
        text = re.sub(r'database_id\s*=\s*"[^"]*"', f'database_id = "{db_id}"', text)
    src.write_text(text)
    (REPO_ROOT / 'wrangler.toml').write_text(text)
    print(f'OK wrangler.toml updated (migration/ + repo root)')

def apply_sql(filename, label=None):
    step(3, f'Apply {label or filename} to {DB_NAME}')
    p = MIG_DIR / filename
    if not p.exists():
        fail(f'{p} missing')
    run(f'wrangler d1 execute {DB_NAME} --remote --file="{p}"')
    print(f'OK {filename} applied')

def gas_call(action, **params):
    params['action'] = action
    params['ua'] = 'migrate.py/1.0'
    url = BACKEND_URL + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())

def login_to_apps_script(nid, last4):
    print('  Logging into Apps Script (3-5s)...')
    data = gas_call('auth', nid=nid, last4=last4)
    if not data.get('ok'):
        fail(f'Login failed: {data}')
    print(f'OK Logged in as {data["user"].get("name", "?")} ({data["user"].get("role", "?")})')
    return data['token']

def fetch_allowlist(token):
    print('  Fetching Allowlist via admin_allowlist_view (5-15s)...')
    data = gas_call('admin_allowlist_view', token=token)
    if not data.get('ok'):
        fail(f'Fetch failed: {data}')
    return data

def normalize_rows(payload):
    for k in ('rows', 'allowlist', 'data', 'items', 'list'):
        v = payload.get(k)
        if isinstance(v, list):
            return v
    for v in payload.values():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            return v
    fail(f'Could not find allowlist rows. Response keys: {list(payload.keys())}')

def field(row, *candidates):
    lower = {k.lower(): k for k in row.keys()}
    for c in candidates:
        if c.lower() in lower:
            v = row[lower[c.lower()]]
            if v is not None and str(v).strip() != '':
                return v
    return None

def generate_allowlist_seed(rows):
    print(f'  Got {len(rows)} rows from Apps Script')
    if not rows:
        fail('Empty allowlist')
    print(f'  Sample row keys: {list(rows[0].keys())}')
    print(f'  First row preview: {json.dumps(rows[0], ensure_ascii=False)[:200]}')
    print()
    confirm = input('  Look correct? Continue with seed? [y/N]: ').strip().lower()
    if confirm not in ('y', 'yes'):
        fail('Aborted by user')

    def q(s):
        if s is None or s == '': return 'NULL'
        return "'" + str(s).replace("'", "''") + "'"

    sql = ['-- seed_allowlist.sql — generated by migrate.py', '-- DO NOT COMMIT (PII)', '']
    sql.append('BEGIN TRANSACTION;')
    inserted = 0
    skipped = []

    for row in rows:
        nid = field(row, 'nid', 'national_id', 'nationalId', 'NID', 'iqama')
        name = field(row, 'name', 'full_name', 'fullName', 'Name', 'staff_name')
        role = field(row, 'role', 'Role', 'job_role', 'position')
        cluster = field(row, 'cluster', 'Cluster', 'zone')
        station = field(row, 'station', 'home_station', 'home', 'Station', 'station_code')
        unit = field(row, 'unit', 'unit_code', 'Unit', 'unit_id', 'call_sign')
        last4 = field(row, 'last4', 'mobile_last4', 'last4_mobile', 'pin', 'Last4', 'mobile')
        active = field(row, 'active', 'enabled', 'Active', 'status')

        if not nid or not name or not last4:
            skipped.append({'nid': nid, 'name': name, 'reason': 'missing nid/name/last4'})
            continue

        nid_s = re.sub(r'\D', '', str(nid))
        last4_s = re.sub(r'\D', '', str(last4))
        if len(last4_s) >= 4:
            last4_s = last4_s[-4:]

        if not re.match(r'^\d{10}$', nid_s):
            skipped.append({'nid': nid, 'name': name, 'reason': f'invalid NID: {nid_s}'})
            continue
        if not re.match(r'^\d{4}$', last4_s):
            skipped.append({'nid': nid, 'name': name, 'reason': f'invalid last4: {last4_s}'})
            continue

        active_int = 1
        if active is not None:
            s = str(active).strip().lower()
            if s in ('false', '0', 'no', 'inactive', 'disabled'):
                active_int = 0

        role_s = (role or 'paramedic').strip().lower().replace(' ', '_')

        sql.append(
            f'INSERT OR REPLACE INTO allowlist '
            f'(nid, name, role, cluster, station, unit_code, mobile_last4, active) VALUES '
            f'({q(nid_s)}, {q(name)}, {q(role_s)}, {q(cluster)}, {q(station)}, {q(unit)}, {q(last4_s)}, {active_int});'
        )
        inserted += 1

    sql.append('COMMIT;')
    out = MIG_DIR / 'seed_allowlist.sql'
    out.write_text('\n'.join(sql))
    print(f'  OK Generated {out.name}: {inserted} INSERTs, {len(skipped)} skipped')
    if skipped:
        print('  Skipped sample (first 5):')
        for s in skipped[:5]:
            print(f'    - {s}')
    return inserted

def deploy_worker():
    step(6, 'Stage _worker.js for repo root (with backup)')
    src = MIG_DIR / '_worker.js'
    dst = REPO_ROOT / '_worker.js'
    backup = REPO_ROOT / '_worker.js.backup'
    if dst.exists() and not backup.exists():
        backup.write_text(dst.read_text())
        print('  Backed up old to _worker.js.backup')
    dst.write_text(src.read_text())
    print('OK _worker.js staged at repo root')

def git_status():
    step(7, 'Git status')
    run(f'cd "{REPO_ROOT}" && git status --short', check=False)

def print_next_steps():
    print()
    print('=' * 64)
    print('NEXT STEPS')
    print('=' * 64)
    print()
    print('Review and push:')
    print(f'  cd {REPO_ROOT}')
    print(f'  git diff _worker.js wrangler.toml')
    print(f'  git add _worker.js wrangler.toml')
    print(f'  git commit -m "feat(d1): D1 backend cutover (auth + health)"')
    print(f'  git push origin main')
    print()
    print('Cloudflare Pages auto-deploys in ~60s. Then test:')
    print('  curl https://hajj.shuki.tech/api/health')
    print()

def main():
    ap = argparse.ArgumentParser(description='Hajj CAD D1 migration')
    ap.add_argument('--no-allowlist', action='store_true', help='Skip Apps Script allowlist pull')
    ap.add_argument('--allowlist-only', action='store_true', help='Only seed allowlist')
    args = ap.parse_args()

    print('Hajj CAD — D1 Migration')
    print(f'Repo:  {REPO_ROOT}')
    print(f'Mig:   {MIG_DIR}')
    print()

    check_wrangler_auth()

    if args.allowlist_only:
        print('[allowlist-only mode] Skipping create/schema/static seed')
    else:
        db_id = get_or_create_d1()
        update_wrangler_toml(db_id)
        apply_sql('schema.sql', '13-table schema')
        apply_sql('seed_static.sql', '9 stations + 25 ambulances')

    if args.no_allowlist:
        print()
        print('Skipping allowlist seed (--no-allowlist).')
        print('Run later: python3 migration/migrate.py --allowlist-only')
        deploy_worker()
        git_status()
        print()
        print('=' * 64)
        print('STRUCTURAL MIGRATION DONE (no allowlist yet)')
        print('=' * 64)
        print_next_steps()
        return

    step(4, 'Pull Allowlist from Apps Script (needs your admin login)')
    print('Credentials entered LOCALLY into this terminal.')
    print('Sent ONLY to existing Apps Script for one admin_allowlist_view call.')
    print()
    nid = input('Your NID (10 digits): ').strip()
    try:
        last4 = getpass.getpass('Mobile last 4 digits (hidden): ').strip()
    except Exception:
        last4 = input('Mobile last 4 digits: ').strip()

    if not re.match(r'^\d{10}$', nid):
        fail(f'NID must be exactly 10 digits, got: {nid!r}')
    if not re.match(r'^\d{4}$', last4):
        fail(f'last4 must be exactly 4 digits, got: {last4!r}')

    token = login_to_apps_script(nid, last4)
    payload = fetch_allowlist(token)
    rows = normalize_rows(payload)
    inserted = generate_allowlist_seed(rows)
    if inserted > 0:
        apply_sql('seed_allowlist.sql', f'{inserted} allowlist rows')

    if not args.allowlist_only:
        deploy_worker()
        git_status()
    print_next_steps()

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print()
        print('Aborted')
        sys.exit(130)
    except Exception as e:
        print(f'Unhandled error: {e}')
        import traceback
        traceback.print_exc()
        sys.exit(1)
