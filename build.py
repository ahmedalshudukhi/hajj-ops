#!/usr/bin/env python3
"""
Hajj Ops Dashboard — Data Builder v4 (v10 schema)

Reads the new unit-based Mobilization_Plan.xlsx schema (8 sheets):
  Config · Roles · Stations · Shifts · Units · Staff · Augmentations · Staffing_View

Project-plan-static data (calendar, timeline, movement definitions, accommodation,
GP coverage, org structure) is hardcoded — these don't change during ops and
shouldn't live in the live source.

Live data (roster fill, augmentations, hourly staffing) is computed from sheets.
Hourly staffing is computed from each staff's shift cell assignments.
"""
import os, sys, json, urllib.request, tempfile
from datetime import datetime, timezone, time as dtime
from collections import defaultdict, Counter
import openpyxl

DEFAULT_FILE_ID = "1USar5JRbsZR_YAjW_XnPSHvYLYFOYuOl"
FILE_ID = os.environ.get("GDRIVE_FILE_ID", DEFAULT_FILE_ID)
DOWNLOAD_URL = f"https://docs.google.com/uc?export=download&id={FILE_ID}"

# ─── Project-plan-static (hardcoded) ──────────────────────────────
STATIONS = ["ARF1","ARF2","ARF3","MUZ1","MUZ2","MUZ3","MIN1","MIN2","MIN3"]
ZONES = {"ARF": "Arafat", "MUZ": "Muzdalifah", "MIN": "Mina"}

CALENDAR = [
    {"dh":1,"greg":"Mon 18 May 2026","day":"Mon","phase":"Site Prep","events":"Sites ready"},
    {"dh":2,"greg":"Tue 19 May 2026","day":"Tue","phase":"Site Prep","events":""},
    {"dh":3,"greg":"Wed 20 May 2026","day":"Wed","phase":"Site Prep","events":""},
    {"dh":4,"greg":"Thu 21 May 2026","day":"Thu","phase":"Training","events":"Staff mobilization"},
    {"dh":5,"greg":"Fri 22 May 2026","day":"Fri","phase":"Training","events":""},
    {"dh":6,"greg":"Sat 23 May 2026","day":"Sat","phase":"Training","events":""},
    {"dh":7,"greg":"Sun 24 May 2026","day":"Sun","phase":"Training","events":"Drills"},
    {"dh":8,"greg":"Mon 25 May 2026","day":"Mon","phase":"Ops Day 1","events":"Tarwiyah · B1A 20:00"},
    {"dh":9,"greg":"Tue 26 May 2026","day":"Tue","phase":"Ops Day 2","events":"ARAFAT · C CRITICAL"},
    {"dh":10,"greg":"Wed 27 May 2026","day":"Wed","phase":"Ops Day 3","events":"EID · D→E"},
    {"dh":11,"greg":"Thu 28 May 2026","day":"Thu","phase":"Ops Day 4","events":"E"},
    {"dh":12,"greg":"Fri 29 May 2026","day":"Fri","phase":"Ops Day 5","events":"E"},
    {"dh":13,"greg":"Sat 30 May 2026","day":"Sat","phase":"Ops Day 6","events":"E ends 18:00"},
    {"dh":14,"greg":"Sun 31 May 2026","day":"Sun","phase":"Demob","events":"Demob"},
    {"dh":15,"greg":"Mon 1 Jun 2026","day":"Mon","phase":"Demob","events":"Demob"},
]

TIMELINE = [
    {"phase":"0","activity":"Master plan to SAR","date_dh":"~10 DQ","greg":"~27 Apr","owner":"PM"},
    {"phase":"0","activity":"Equipment procured","date_dh":"~20 DQ","greg":"~7 May","owner":"LOG"},
    {"phase":"1","activity":"SAR handover","date_dh":"~25 DQ","greg":"~12 May","owner":"PM"},
    {"phase":"1","activity":"Sites ready","date_dh":"1 DH","greg":"18 May","owner":"LOG"},
    {"phase":"2","activity":"Staff mobilization","date_dh":"4 DH","greg":"21 May","owner":"LOG"},
    {"phase":"2","activity":"Drills","date_dh":"5-6 DH","greg":"22-23 May","owner":"TRN"},
    {"phase":"2","activity":"TRN→SRU","date_dh":"8 DH","greg":"25 May","owner":"SRU"},
    {"phase":"3","activity":"Ops B-E","date_dh":"8-13 DH","greg":"25-30 May","owner":"PM"},
    {"phase":"4","activity":"Demob","date_dh":"14-27 DH","greg":"31 May-13 Jun","owner":"LOG"},
    {"phase":"5","activity":"Final report","date_dh":"30 days post","greg":"","owner":"PM"},
]

MOVEMENTS = [
    {"code":"PRE-B","shift":"DAY","dh":"7 DH","label":"Pre-Boarding setup","staff":245,"para":125,"amb":0},
    {"code":"GAP","shift":"MIXED","dh":"8-9 DH","label":"Inter-movement Gap","staff":245,"para":125,"amb":36},
    {"code":"B1A","shift":"NIGHT","dh":"8/9 DH","label":"Boarding 1A","staff":121,"para":61,"amb":18},
    {"code":"B1B","shift":"NIGHT","dh":"9 DH","label":"Boarding 1B","staff":121,"para":61,"amb":18},
    {"code":"B2A","shift":"DAY","dh":"9 DH","label":"Boarding 2A","staff":124,"para":64,"amb":18},
    {"code":"B2B","shift":"DAY","dh":"9 DH","label":"Boarding 2B","staff":124,"para":64,"amb":18},
    {"code":"C","shift":"NIGHT","dh":"10 DH","label":"Day of Arafat","staff":121,"para":61,"amb":18},
    {"code":"D","shift":"MIXED","dh":"10/11 DH","label":"Muz → Mina","staff":245,"para":125,"amb":36},
    {"code":"E","shift":"MIXED","dh":"11-13 DH","label":"Mina operations","staff":245,"para":125,"amb":36},
    {"code":"MAINT","shift":"DAY","dh":"13 DH","label":"Maintenance / Demob","staff":121,"para":61,"amb":18},
]

MOVEMENT_PHASES = [
    {"mvt":"PRE-B","start_dh":"4 DH","start_hour":"06:00","end_dh":"8 DH","end_hour":"17:00","shift":"DAY","duration_hrs":60},
    {"mvt":"GAP","start_dh":"8 DH","start_hour":"18:00","end_dh":"8 DH","end_hour":"19:00","shift":"NIGHT","duration_hrs":2},
    {"mvt":"B1A","start_dh":"8 DH","start_hour":"20:00","end_dh":"9 DH","end_hour":"01:00","shift":"NIGHT","duration_hrs":6},
    {"mvt":"B1B","start_dh":"9 DH","start_hour":"02:00","end_dh":"9 DH","end_hour":"04:00","shift":"NIGHT","duration_hrs":3},
    {"mvt":"B2A","start_dh":"9 DH","start_hour":"05:00","end_dh":"9 DH","end_hour":"07:00","shift":"DAY","duration_hrs":3},
    {"mvt":"B2B","start_dh":"9 DH","start_hour":"08:00","end_dh":"9 DH","end_hour":"10:00","shift":"DAY","duration_hrs":3},
    {"mvt":"GAP","start_dh":"9 DH","start_hour":"11:00","end_dh":"9 DH","end_hour":"18:00","shift":"DAY","duration_hrs":8},
    {"mvt":"C","start_dh":"9 DH","start_hour":"19:00","end_dh":"10 DH","end_hour":"00:00","shift":"NIGHT","duration_hrs":6},
    {"mvt":"D","start_dh":"10 DH","start_hour":"01:00","end_dh":"10 DH","end_hour":"08:00","shift":"NIGHT","duration_hrs":8},
    {"mvt":"E","start_dh":"10 DH","start_hour":"09:00","end_dh":"11 DH","end_hour":"01:00","shift":"DAY","duration_hrs":17},
    {"mvt":"MAINT","start_dh":"11 DH","start_hour":"02:00","end_dh":"11 DH","end_hour":"03:00","shift":"NIGHT","duration_hrs":2},
    {"mvt":"E","start_dh":"11 DH","start_hour":"04:00","end_dh":"12 DH","end_hour":"01:00","shift":"NIGHT","duration_hrs":22},
    {"mvt":"MAINT","start_dh":"12 DH","start_hour":"02:00","end_dh":"12 DH","end_hour":"03:00","shift":"NIGHT","duration_hrs":2},
    {"mvt":"E","start_dh":"12 DH","start_hour":"04:00","end_dh":"13 DH","end_hour":"01:00","shift":"NIGHT","duration_hrs":22},
    {"mvt":"MAINT","start_dh":"13 DH","start_hour":"02:00","end_dh":"13 DH","end_hour":"03:00","shift":"NIGHT","duration_hrs":2},
    {"mvt":"E","start_dh":"13 DH","start_hour":"04:00","end_dh":"13 DH","end_hour":"17:00","shift":"NIGHT","duration_hrs":13},
]

GP_COVERAGE = [
    {"station":"Arafat-1","gp_day":"GP-01","gp_night":"GP-10","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Arafat-2","gp_day":"GP-02","gp_night":"GP-11","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Arafat-3","gp_day":"GP-03","gp_night":"GP-12","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Muzdalifah-1","gp_day":"GP-04","gp_night":"GP-13","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Muzdalifah-2","gp_day":"GP-05","gp_night":"GP-14","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Muzdalifah-3","gp_day":"GP-06","gp_night":"GP-15","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Mina-1","gp_day":"GP-07","gp_night":"GP-16","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Mina-2","gp_day":"GP-08","gp_night":"GP-17","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Mina-3 Jamarat","gp_day":"GP-09","gp_night":"GP-18","covers":"Clinic-N + Clinic-S","notes":"Rotates between both platform clinics"},
    {"station":"Depot","gp_day":"GP-10","gp_night":"GP-19","covers":"Depot clinic","notes":"Backup pool"},
]

ACCOMMODATION = [
    {"location":"Arafat-1","sta_para":12,"amb_crew":8,"rov_fwd":2,"gps":2,"support":0,"total_beds":24,"bunk_sets":12},
    {"location":"Arafat-2","sta_para":12,"amb_crew":8,"rov_fwd":2,"gps":2,"support":0,"total_beds":24,"bunk_sets":12},
    {"location":"Arafat-3","sta_para":16,"amb_crew":8,"rov_fwd":4,"gps":2,"support":0,"total_beds":30,"bunk_sets":15},
    {"location":"Muzdalifah-1","sta_para":12,"amb_crew":8,"rov_fwd":2,"gps":2,"support":0,"total_beds":24,"bunk_sets":12},
    {"location":"Muzdalifah-2","sta_para":12,"amb_crew":8,"rov_fwd":2,"gps":2,"support":0,"total_beds":24,"bunk_sets":12},
    {"location":"Muzdalifah-3","sta_para":16,"amb_crew":8,"rov_fwd":4,"gps":2,"support":0,"total_beds":30,"bunk_sets":15},
    {"location":"Mina-1","sta_para":15,"amb_crew":8,"rov_fwd":3,"gps":2,"support":0,"total_beds":28,"bunk_sets":14},
    {"location":"Mina-2","sta_para":15,"amb_crew":8,"rov_fwd":3,"gps":2,"support":0,"total_beds":28,"bunk_sets":14},
    {"location":"Mina-3 Jamarat","sta_para":15,"amb_crew":8,"rov_fwd":3,"gps":2,"support":0,"total_beds":28,"bunk_sets":14},
    {"location":"Depot","sta_para":4,"amb_crew":2,"rov_fwd":1,"gps":2,"support":26,"total_beds":35,"bunk_sets":18},
]

# ─── Helpers ──────────────────────────────────────────────────────
def num(v, default=0):
    if v is None or v == "": return default
    try: return float(v)
    except (TypeError, ValueError): return default

def s(v):
    return str(v).strip() if v is not None else ""

def download_xlsx():
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
    tmp.close()
    print(f"  Downloading from Google Drive (file: {FILE_ID})...")
    req = urllib.request.Request(DOWNLOAD_URL, headers={"User-Agent": "hajj-ops-dashboard/4.0"})
    with urllib.request.urlopen(req, timeout=30) as resp, open(tmp.name, "wb") as out:
        out.write(resp.read())
    size = os.path.getsize(tmp.name)
    print(f"  ✓ Downloaded {size:,} bytes")
    return tmp.name

def read_sheet_dicts(wb, name, valid_first_col_pattern=None):
    """Read a sheet as list of dicts using row 1 as headers.
    Skip rows where the first column is empty, parenthetical, or fails pattern check."""
    if name not in wb.sheetnames:
        print(f"  ⚠ Sheet '{name}' not found")
        return []
    ws = wb[name]
    headers = [s(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)]
    rows = []
    import re as _re
    pat = _re.compile(valid_first_col_pattern) if valid_first_col_pattern else None
    for r in range(2, ws.max_row + 1):
        v0 = ws.cell(r, 1).value
        if v0 is None: continue
        sv = s(v0)
        if sv == "" or sv.startswith("("): continue
        if sv.upper() == "TOTAL": continue
        if "Note:" in sv or "suggestions" in sv.lower() or "append" in sv.lower(): continue
        if pat and not pat.match(sv): continue
        row = {}
        for c, h in enumerate(headers, 1):
            if h:
                row[h] = ws.cell(r, c).value
        rows.append(row)
    return rows

# ─── Compute personnel from Roles ─────────────────────────────────
def compute_personnel(roles_rows, units_count):
    by_role = {}
    for r in roles_rows:
        role = s(r.get("Role"))
        if role and role.upper() != "TOTAL":
            by_role[role] = int(num(r.get("Target Count")))
    leadership = sum(by_role.get(k, 0) for k in ["PM","Deputy PM","Admin Lead","Med Direction Lead"])
    paras = sum(v for k,v in by_role.items() if k not in ["PM","Deputy PM","Admin Lead","Med Direction Lead","GP"])
    gps = by_role.get("GP", 0)
    return {
        "total": leadership + paras + gps,
        "paramedics": paras,
        "gps": gps,
        "leadership_admin": leadership,
        "day_para": 127,    # planning convention: peak day shift
        "night_para": 124,  # planning convention: peak night shift
        "ambulances": 25,
        "stations": 9,
        "clinics": 18,
    }

# ─── Compute roster aggregates from Staff ─────────────────────────
def compute_roster(staff_rows):
    para_rows = [r for r in staff_rows if r.get("Role") not in ("PM","Deputy PM","Admin Lead","Med Direction Lead","GP")]
    gp_rows = [r for r in staff_rows if r.get("Role") == "GP"]

    def is_filled(r):
        return s(r.get("Status")) == "Filled" and s(r.get("Name")) != ""

    para_filled = sum(1 for r in para_rows if is_filled(r))
    gp_filled = sum(1 for r in gp_rows if is_filled(r))
    para_total = len(para_rows)
    gp_total = len(gp_rows)
    all_total = para_total + gp_total
    all_filled = para_filled + gp_filled

    by_subrole = Counter()
    by_subrole_status = defaultdict(lambda: {"vacant": 0, "filled": 0})
    by_home = Counter()

    ROLE_TO_SUB = {
        "Chief Paramedic":"Chief+Deputy", "Deputy Chief Paramedic":"Chief+Deputy",
        "Logistics":"Logistics", "Dispatch OCC":"Dispatch", "SRCA Dispatch":"SRCA Coordination",
        "Depot":"Depot", "Training":"Training", "Supervisor":"Supervisor",
        "Unit Paramedic":"Unit",
    }

    for r in para_rows:
        role = s(r.get("Role"))
        sub = ROLE_TO_SUB.get(role, role)
        by_subrole[sub] += 1
        if is_filled(r):
            by_subrole_status[sub]["filled"] += 1
        else:
            by_subrole_status[sub]["vacant"] += 1
        home = s(r.get("Home Station")) or "Mobile"
        by_home[home] += 1

    return {
        "para_total": para_total,
        "para_vacant": para_total - para_filled,
        "para_filled": para_filled,
        "para_fill_pct": round(para_filled / max(para_total,1) * 100, 1),
        "gp_total": gp_total,
        "gp_vacant": gp_total - gp_filled,
        "gp_filled": gp_filled,
        "all_total": all_total,
        "all_vacant": all_total - all_filled,
        "all_filled": all_filled,
        "all_fill_pct": round(all_filled / max(all_total,1) * 100, 1),
        "by_subrole": dict(by_subrole),
        "by_subrole_status": {k: dict(v) for k,v in by_subrole_status.items()},
        "by_shift": {},  # populated once shift codes filled
        "by_home": dict(by_home),
    }

# ─── Compute org structure from Roles + Stations ──────────────────
def compute_org_structure(roles_rows, units_rows):
    # Build the structured list expected by the dashboard
    out = []
    out.append({"category":"Leadership","role":"Project Manager","day":1,"night":0,"total":1,"notes":"Ahmed Alshudukhi MD"})
    out.append({"category":"Leadership","role":"Medical Dir / OCC Mgr","day":1,"night":0,"total":1,"notes":"Day OCC"})
    out.append({"category":"Leadership","role":"Deputy PM / OCC Mgr","day":0,"night":1,"total":1,"notes":"Night OCC, Saudi National"})
    out.append({"category":"Leadership","role":"Admin Lead","day":1,"night":0,"total":1,"notes":""})
    out.append({"category":"GP","role":"General Practitioners","day":10,"night":10,"total":20,"notes":"1/station/shift + 2 backup"})
    out.append({"category":"Para — CMD","role":"Chief Paramedic","day":1,"night":0,"total":1,"notes":""})
    out.append({"category":"Para — CMD","role":"Deputy Chief Paramedic","day":0,"night":1,"total":1,"notes":""})
    out.append({"category":"Para — Dispatch","role":"Dispatchers","day":2,"night":2,"total":4,"notes":""})
    out.append({"category":"Para — Dispatch","role":"SRCA Liaison","day":1,"night":1,"total":2,"notes":"Saudi Red Crescent coordination"})
    out.append({"category":"Para — Depot","role":"Depot Clinic","day":2,"night":2,"total":4,"notes":"OCC staff clinic"})
    out.append({"category":"Para — Logistics","role":"Logistics","day":4,"night":3,"total":7,"notes":"Supply + transport"})
    out.append({"category":"Para — Training","role":"Training","day":1,"night":1,"total":2,"notes":"Convert to regular paras post-Hajj"})
    out.append({"category":"Para — Supervisor","role":"SV-A (Arafat)","day":1,"night":1,"total":2,"notes":""})
    out.append({"category":"Para — Supervisor","role":"SV-Z (Muzdalifah)","day":1,"night":1,"total":2,"notes":""})
    out.append({"category":"Para — Supervisor","role":"SV-M (Mina)","day":1,"night":1,"total":2,"notes":""})
    # Unit paras per station
    by_station = Counter(s(u.get("Home Station")) for u in units_rows)
    for st in STATIONS:
        n = by_station.get(st, 0)
        zone = "Para — Station"
        out.append({"category":zone,"role":st,"day":n,"night":n,"total":n*2,"notes":f"{n} units × 2 paras"})
    return out

# ─── Hourly: compute from staff shift codes ───────────────────────
def parse_time_str(t):
    """Parse '07:00' or time obj to (hour, minute)."""
    if isinstance(t, dtime):
        return t.hour, t.minute
    if isinstance(t, str) and ":" in t:
        h, m = t.split(":")
        return int(h), int(m)
    return None, None

def shift_covers_hour(shift_start, shift_end, target_hour):
    """Does a shift starting at shift_start and ending at shift_end cover hour `target_hour` (0-23)?"""
    sh, _ = parse_time_str(shift_start)
    eh, _ = parse_time_str(shift_end)
    if sh is None or eh is None:
        return False
    if sh < eh:  # same-day shift, e.g., D7 (07-19)
        return sh <= target_hour < eh
    elif sh > eh:  # overnight shift, e.g., N19 (19-07 next day)
        return target_hour >= sh or target_hour < eh
    else:  # 24h shift
        return True

def build_hourly(staff_rows, shifts_rows, units_rows):
    """For each (DH day, hour) generate counts of staff present per zone/station."""
    shift_map = {}  # code -> (start, end, type)
    for r in shifts_rows:
        code = s(r.get("Code"))
        if code:
            shift_map[code] = (r.get("Start"), r.get("End"), s(r.get("Type")))

    # Map staff to home station
    staff_home = {s(r.get("Staff ID")): s(r.get("Home Station")) for r in staff_rows}
    # Map unit -> home station
    unit_home = {s(u.get("Unit ID")): s(u.get("Home Station")) for u in units_rows}

    # Hour grid: 4 DH 06:00 → 13 DH 17:00
    DH_RANGE = list(range(4, 14))  # 4..13 (10 days)
    hours = []
    for dh in DH_RANGE:
        start_hour = 6 if dh in [4,5,6,7] else 0  # day 4-7 only show 06-17, ops days show 0-23
        end_hour = 18 if dh in [4,5,6,7] else 24
        for h in range(start_hour, end_hour):
            hours.append({"dh": dh, "hour": h})

    # For each hour, count staff present
    out_hours = []
    for entry in hours:
        dh, h = entry["dh"], entry["hour"]
        # Find which movement is active at this DH+hour from MOVEMENT_PHASES
        mvt_code = "PRE-B"  # default for pre-ops days
        shift_label = "DAY" if 6 <= h < 18 else "NIGHT"
        for ph in MOVEMENT_PHASES:
            sd = int(ph["start_dh"].split()[0])
            ed = int(ph["end_dh"].split()[0])
            sh = int(ph["start_hour"].split(":")[0])
            eh = int(ph["end_hour"].split(":")[0])
            # Construct comparable timestamps
            cur = dh * 100 + h
            start = sd * 100 + sh
            end = ed * 100 + eh
            if start <= cur <= end:
                mvt_code = ph["mvt"]
                shift_label = ph["shift"]
                break

        # Count staff with assigned shift covering this hour on this day
        zones = {"Arafat":0, "Muzdalifah":0, "Mina":0, "Support":0}
        stations = {st:0 for st in STATIONS}
        stations_amb = {st:0 for st in STATIONS}
        for r in staff_rows:
            s1 = s(r.get(f"{dh}DH-S1"))
            s2 = s(r.get(f"{dh}DH-S2"))
            shifts_present = []
            for code in (s1, s2):
                if code and code in shift_map:
                    start_t, end_t, _typ = shift_map[code]
                    if shift_covers_hour(start_t, end_t, h):
                        shifts_present.append(code)
            if not shifts_present:
                continue
            home = s(r.get("Home Station"))
            if home.startswith("ARF"):
                zones["Arafat"] += 1
                if home in stations: stations[home] += 1
            elif home.startswith("MUZ"):
                zones["Muzdalifah"] += 1
                if home in stations: stations[home] += 1
            elif home.startswith("MIN"):
                zones["Mina"] += 1
                if home in stations: stations[home] += 1
            else:
                zones["Support"] += 1

        out_hours.append({
            "dh": f"{dh} DH",
            "hour": f"{h:02d}:00",
            "mvt": mvt_code,
            "shift": shift_label,
            "label": f"{dh} DH {h:02d}:00",
            "arf_s": zones["Arafat"], "muz_s": zones["Muzdalifah"], "min_s": zones["Mina"],
            "arf_a": 0, "muz_a": 0, "min_a": 0,
            "rov_c": 0, "fwd_c": 0, "dep_c": 0,
            "support": zones["Support"],
            "rov_a": 0, "fwd_a": 0, "dep_a": 0,
            "stations": stations,
            "stations_amb": stations_amb,
            "grand_s": sum(zones.values()),
            "grand_a": 0,
        })

    # Compute peaks
    peak_arf = max((h["arf_s"] for h in out_hours), default=0)
    peak_muz = max((h["muz_s"] for h in out_hours), default=0)
    peak_min = max((h["min_s"] for h in out_hours), default=0)

    return {
        "hours": out_hours,
        "peak_arafat": peak_arf,
        "peak_muzdalifah": peak_muz,
        "peak_mina": peak_min,
        "movement_peaks": {},
        "total_hours": len(out_hours),
    }

# ─── Augmentations ────────────────────────────────────────────────
def compute_augmentations(aug_rows):
    if not aug_rows:
        return {
            "total":0, "active":0, "planned":0, "returned":0, "cancelled":0,
            "total_para_moved":0, "dominant_status":"None",
            "by_movement":{}, "by_donor":{}, "by_recipient":{}, "sample":[]
        }
    by_status = Counter(s(r.get("Status")) for r in aug_rows)
    by_mvt = Counter(s(r.get("Movement")) for r in aug_rows)
    by_donor = Counter(s(r.get("From Unit")) for r in aug_rows)
    by_recipient = Counter(s(r.get("To Station")) for r in aug_rows)
    return {
        "total": len(aug_rows),
        "active": by_status.get("Active",0),
        "planned": by_status.get("Planned",0),
        "returned": by_status.get("Returned",0),
        "cancelled": by_status.get("Cancelled",0),
        "total_para_moved": sum(int(num(r.get("Paras",1))) for r in aug_rows),
        "dominant_status": by_status.most_common(1)[0][0] if by_status else "None",
        "by_movement": dict(by_mvt),
        "by_donor": dict(by_donor),
        "by_recipient": dict(by_recipient),
        "sample": aug_rows[:24],
    }

# ─── Status counts (Units tags) ───────────────────────────────────
def compute_status_counts(units_rows):
    counts = {"SUPPORT": 0, "SURGE": 0, "ACTIVE": 0, "STANDBY": 0}
    for u in units_rows:
        tags = s(u.get("Tags")).upper()
        for k in counts:
            if k in tags:
                counts[k] += 1
    if sum(counts.values()) == 0:
        # default seed when tags not yet filled
        return {"SUPPORT": 98, "SURGE": 52, "ACTIVE": 38, "STANDBY": 36}
    return counts

# ─── Main ─────────────────────────────────────────────────────────
def main():
    print("Hajj Ops Builder v4 (v10 schema)")
    xlsx_path = download_xlsx()
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    print(f"  Sheets: {wb.sheetnames}")

    config = read_sheet_dicts(wb, "Config")
    roles = read_sheet_dicts(wb, "Roles")
    stations = read_sheet_dicts(wb, "Stations", r"^(ARF|MUZ|MIN)\d$")
    shifts = read_sheet_dicts(wb, "Shifts")
    units = read_sheet_dicts(wb, "Units", r"^(Alpha|Bravo|Charlie|Delta|Echo|Foxtrot|Golf|Hotel|India|Juliet|Kilo|Lima|Mike|November)-\d{2}$")
    staff = read_sheet_dicts(wb, "Staff")
    augs = read_sheet_dicts(wb, "Augmentations", r"^[A-Z]+-\d+$")

    print(f"  Roles: {len(roles)} · Units: {len(units)} · Staff: {len(staff)} · Shifts: {len(shifts)}")

    personnel = compute_personnel(roles, len(units))
    roster = compute_roster(staff)
    org = compute_org_structure(roles, units)
    aug = compute_augmentations(augs)
    status_counts = compute_status_counts(units)
    hourly = build_hourly(staff, shifts, units)

    data = {
        "refreshed_at": datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC"),
        "source": "Google Drive · Mobilization_Plan.xlsx (v10)",
        "personnel": personnel,
        "totals": {"allocated_staff_shifts": 0, "movements": len(MOVEMENTS)},
        "calendar": CALENDAR,
        "timeline": TIMELINE,
        "gp_coverage": GP_COVERAGE,
        "accommodation": ACCOMMODATION,
        "org_structure": org,
        "movements": MOVEMENTS,
        "movement_phases": MOVEMENT_PHASES,
        "status_counts": status_counts,
        "zone_by_mvt": {},  # Built once augmentations exist
        "roster": roster,
        "augmentations": aug,
        "hourly": hourly,
    }

    with open("data.json", "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=None, separators=(",", ":"))

    size = os.path.getsize("data.json")
    print(f"  ✓ Wrote data.json ({size:,} bytes)")
    print(f"  Roster fill: {roster['all_filled']}/{roster['all_total']} ({roster['all_fill_pct']}%)")
    print(f"  Hourly grid: {len(hourly['hours'])} rows · peak ARF={hourly['peak_arafat']} MUZ={hourly['peak_muzdalifah']} MIN={hourly['peak_mina']}")

    try: os.unlink(xlsx_path)
    except: pass

if __name__ == "__main__":
    main()
