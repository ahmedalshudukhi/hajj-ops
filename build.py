#!/usr/bin/env python3
"""
Hajj Ops Dashboard — Data Builder v5 (v11 schema)

Three-type unit model: Leadership (4) + Command (14) + Operational (112).
Operational split: Mike Medical (20) + Alpha Ambulance (50) + Romeo Foot-runner (42).
Scheduling at unit level. Hours per person via VLOOKUP to Schedule.
"""
import os, sys, json, urllib.request, tempfile
from datetime import datetime, timezone, time as dtime
from collections import defaultdict, Counter
import openpyxl

DEFAULT_FILE_ID = "1USar5JRbsZR_YAjW_XnPSHvYLYFOYuOl"
FILE_ID = os.environ.get("GDRIVE_FILE_ID", DEFAULT_FILE_ID)
DOWNLOAD_URL = f"https://docs.google.com/uc?export=download&id={FILE_ID}"

STATIONS = ["ARF1","ARF2","ARF3","MUZ1","MUZ2","MUZ3","MIN1","MIN2","MIN3"]

# ─── Static project data ──────────────────────────────────────────
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
    {"phase":"3","activity":"Ops B-E","date_dh":"8-13 DH","greg":"25-30 May","owner":"PM"},
    {"phase":"4","activity":"Demob","date_dh":"14-27 DH","greg":"31 May-13 Jun","owner":"LOG"},
    {"phase":"5","activity":"Final report","date_dh":"30 days post","greg":"","owner":"PM"},
]
MOVEMENTS = [
    {"code":"PRE-B","shift":"DAY","dh":"7 DH","label":"Pre-Boarding setup","staff":245,"para":125,"amb":12},
    {"code":"GAP","shift":"MIXED","dh":"8-9 DH","label":"Inter-movement Gap","staff":245,"para":125,"amb":25},
    {"code":"B1A","shift":"NIGHT","dh":"8/9 DH","label":"Boarding 1A","staff":121,"para":61,"amb":18},
    {"code":"B1B","shift":"NIGHT","dh":"9 DH","label":"Boarding 1B","staff":121,"para":61,"amb":18},
    {"code":"B2A","shift":"DAY","dh":"9 DH","label":"Boarding 2A","staff":124,"para":64,"amb":18},
    {"code":"B2B","shift":"DAY","dh":"9 DH","label":"Boarding 2B","staff":124,"para":64,"amb":18},
    {"code":"C","shift":"NIGHT","dh":"10 DH","label":"Day of Arafat","staff":121,"para":61,"amb":25},
    {"code":"D","shift":"MIXED","dh":"10/11 DH","label":"Muz → Mina","staff":245,"para":125,"amb":25},
    {"code":"E","shift":"MIXED","dh":"11-13 DH","label":"Mina operations","staff":245,"para":125,"amb":25},
    {"code":"MAINT","shift":"DAY","dh":"13 DH","label":"Maintenance / Demob","staff":121,"para":61,"amb":18},
]
MOVEMENT_PHASES = [
    {"mvt":"PRE-B","start_dh":"4 DH","start_hour":"06:00","end_dh":"8 DH","end_hour":"17:00","shift":"DAY","duration_hrs":60},
    {"mvt":"GAP","start_dh":"8 DH","start_hour":"18:00","end_dh":"8 DH","end_hour":"19:00","shift":"NIGHT","duration_hrs":2},
    {"mvt":"B1A","start_dh":"8 DH","start_hour":"20:00","end_dh":"9 DH","end_hour":"01:00","shift":"NIGHT","duration_hrs":6},
    {"mvt":"B1B","start_dh":"9 DH","start_hour":"02:00","end_dh":"9 DH","end_hour":"04:00","shift":"NIGHT","duration_hrs":3},
    {"mvt":"B2A","start_dh":"9 DH","start_hour":"05:00","end_dh":"9 DH","end_hour":"07:00","shift":"DAY","duration_hrs":3},
    {"mvt":"B2B","start_dh":"9 DH","start_hour":"08:00","end_dh":"9 DH","end_hour":"10:00","shift":"DAY","duration_hrs":3},
    {"mvt":"C","start_dh":"9 DH","start_hour":"19:00","end_dh":"10 DH","end_hour":"00:00","shift":"NIGHT","duration_hrs":6},
    {"mvt":"D","start_dh":"10 DH","start_hour":"01:00","end_dh":"10 DH","end_hour":"08:00","shift":"NIGHT","duration_hrs":8},
    {"mvt":"E","start_dh":"10 DH","start_hour":"09:00","end_dh":"13 DH","end_hour":"17:00","shift":"MIXED","duration_hrs":80},
    {"mvt":"MAINT","start_dh":"13 DH","start_hour":"18:00","end_dh":"14 DH","end_hour":"06:00","shift":"NIGHT","duration_hrs":12},
]
GP_COVERAGE = [
    {"station":n,"gp_day":f"GP-{i:02d}","gp_night":f"GP-{i+10:02d}","covers":"Clinic-N + Clinic-S","notes":""}
    for i, n in enumerate(["Arafat-1","Arafat-2","Arafat-3","Muzdalifah-1","Muzdalifah-2","Muzdalifah-3",
                            "Mina-1","Mina-2","Mina-3 Jamarat","Depot"], 1)
]
ACCOMMODATION = [
    {"location":n,"sta_para":12,"amb_crew":8,"rov_fwd":2,"gps":2,"support":0,"total_beds":24,"bunk_sets":12}
    for n in ["Arafat-1","Arafat-2","Arafat-3","Muzdalifah-1","Muzdalifah-2","Muzdalifah-3",
              "Mina-1","Mina-2","Mina-3 Jamarat","Depot"]
]

# ─── Helpers ──────────────────────────────────────────────────────
def num(v, default=0):
    if v is None or v == "": return default
    try: return float(v)
    except (TypeError, ValueError): return default

def s(v): return str(v).strip() if v is not None else ""

def download_xlsx():
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx"); tmp.close()
    print(f"  Downloading from Google Drive (file: {FILE_ID})...")
    req = urllib.request.Request(DOWNLOAD_URL, headers={"User-Agent": "hajj-ops/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp, open(tmp.name, "wb") as out:
        out.write(resp.read())
    print(f"  ✓ Downloaded {os.path.getsize(tmp.name):,} bytes")
    return tmp.name

def read_sheet(wb, name, valid_first_col_pattern=None):
    if name not in wb.sheetnames:
        print(f"  ⚠ Sheet '{name}' not found")
        return []
    import re as _re
    ws = wb[name]
    headers = [s(ws.cell(1, c).value) for c in range(1, ws.max_column + 1)]
    rows = []
    pat = _re.compile(valid_first_col_pattern) if valid_first_col_pattern else None
    for r in range(2, ws.max_row + 1):
        v0 = ws.cell(r, 1).value
        if v0 is None: continue
        sv = s(v0)
        if sv == "" or sv.startswith("("): continue
        if sv.upper() == "TOTAL": continue
        if "Note:" in sv: continue
        if pat and not pat.match(sv): continue
        row = {}
        for c, h in enumerate(headers, 1):
            if h: row[h] = ws.cell(r, c).value
        rows.append(row)
    return rows

def parse_time_str(t):
    if isinstance(t, dtime): return t.hour
    if isinstance(t, str) and ":" in t: return int(t.split(":")[0])
    return None

def shift_covers_hour(start_t, end_t, target_hour):
    sh = parse_time_str(start_t); eh = parse_time_str(end_t)
    if sh is None or eh is None: return False
    if sh < eh: return sh <= target_hour < eh
    elif sh > eh: return target_hour >= sh or target_hour < eh
    else: return True

# ─── Compute personnel ────────────────────────────────────────────
def compute_personnel(roles_rows):
    by_role = {s(r.get("Role")): int(num(r.get("Target Count"))) for r in roles_rows if s(r.get("Role"))}
    leadership = sum(by_role.get(k, 0) for k in ["PM","Deputy PM","Admin Lead","Med Direction Lead"])
    paras = sum(v for k,v in by_role.items() if k not in ["PM","Deputy PM","Admin Lead","Med Direction Lead","GP"])
    gps = by_role.get("GP", 0)
    return {
        "total": leadership + paras + gps,
        "paramedics": paras, "gps": gps, "leadership_admin": leadership,
        "day_para": 127, "night_para": 124, "ambulances": 25, "stations": 9, "clinics": 18,
    }

def compute_roster(staff_rows):
    LEADERSHIP_ROLES = ("PM","Deputy PM","Admin Lead","Med Direction Lead")
    para_rows = [r for r in staff_rows if s(r.get("Role")) not in LEADERSHIP_ROLES + ("GP",)]
    gp_rows = [r for r in staff_rows if s(r.get("Role")) == "GP"]
    leader_rows = [r for r in staff_rows if s(r.get("Role")) in LEADERSHIP_ROLES]
    def is_filled(r): return s(r.get("Status")) == "Filled" and s(r.get("Name")) != ""
    para_filled = sum(1 for r in para_rows if is_filled(r))
    gp_filled = sum(1 for r in gp_rows if is_filled(r))
    leader_filled = sum(1 for r in leader_rows if is_filled(r))
    para_total = len(para_rows); gp_total = len(gp_rows); leader_total = len(leader_rows)
    # all_total = paras + GPs + leadership/admin (full roster headline)
    all_total = para_total + gp_total + leader_total
    all_filled = para_filled + gp_filled + leader_filled
    by_subrole = Counter()
    by_subrole_status = defaultdict(lambda: {"vacant":0, "filled":0})
    ROLE_TO_SUB = {
        "Chief Paramedic":"Chief+Deputy","Deputy Chief Paramedic":"Chief+Deputy",
        "Logistics":"Logistics","Dispatch OCC":"Dispatch","SRCA Dispatch":"SRCA",
        "Depot":"Depot","Training":"Training","Supervisor":"Supervisor",
        "Ambulance Paramedic":"Alpha (Ambulance)","Foot Paramedic":"Romeo (Foot-Runner)","Medical Unit Paramedic":"Mike (Medical)",
    }
    for r in para_rows:
        role = s(r.get("Role"))
        sub = ROLE_TO_SUB.get(role, role)
        by_subrole[sub] += 1
        if is_filled(r): by_subrole_status[sub]["filled"] += 1
        else: by_subrole_status[sub]["vacant"] += 1
    return {
        "para_total":para_total,"para_vacant":para_total-para_filled,"para_filled":para_filled,
        "para_fill_pct":round(para_filled/max(para_total,1)*100,1),
        "gp_total":gp_total,"gp_vacant":gp_total-gp_filled,"gp_filled":gp_filled,
        "all_total":all_total,"all_vacant":all_total-all_filled,"all_filled":all_filled,
        "all_fill_pct":round(all_filled/max(all_total,1)*100,1),
        "by_subrole":dict(by_subrole),
        "by_subrole_status":{k:dict(v) for k,v in by_subrole_status.items()},
        "by_shift":{}, "by_home":{},
    }

def compute_org_structure(units_rows):
    out = []
    out.append({"category":"Leadership","role":"Project Manager","day":1,"night":0,"total":1,"notes":"Ahmed Alshudukhi MD"})
    out.append({"category":"Leadership","role":"Deputy PM","day":0,"night":1,"total":1,"notes":""})
    out.append({"category":"Leadership","role":"Admin Lead","day":1,"night":0,"total":1,"notes":""})
    out.append({"category":"Leadership","role":"Med Direction Lead","day":1,"night":0,"total":1,"notes":""})
    out.append({"category":"GP","role":"General Practitioners","day":10,"night":10,"total":20,"notes":"In Mike (Medical) units"})
    out.append({"category":"Para — CMD","role":"Chief Paramedic","day":1,"night":0,"total":1,"notes":""})
    out.append({"category":"Para — CMD","role":"Deputy Chief Paramedic","day":0,"night":1,"total":1,"notes":""})
    out.append({"category":"Para — Dispatch","role":"Dispatchers","day":2,"night":2,"total":4,"notes":""})
    out.append({"category":"Para — Dispatch","role":"SRCA Liaison","day":1,"night":1,"total":2,"notes":""})
    out.append({"category":"Para — Depot","role":"Depot Clinic","day":2,"night":2,"total":4,"notes":""})
    out.append({"category":"Para — Logistics","role":"Logistics","day":4,"night":3,"total":7,"notes":"3 units sized [3,3,1]"})
    out.append({"category":"Para — Training","role":"Training","day":1,"night":1,"total":2,"notes":""})
    out.append({"category":"Para — Supervisor","role":"SUP-A (Arafat)","day":1,"night":1,"total":2,"notes":""})
    out.append({"category":"Para — Supervisor","role":"SUP-Z (Muzdalifah)","day":1,"night":1,"total":2,"notes":""})
    out.append({"category":"Para — Supervisor","role":"SUP-M (Mina)","day":1,"night":1,"total":2,"notes":""})
    by_station = defaultdict(lambda: {"M":0,"A":0,"R":0})
    for u in units_rows:
        utype = s(u.get("Unit Type"))
        home = s(u.get("Home Station"))
        if utype == "Medical": by_station[home]["M"] += 1
        elif utype == "Ambulance": by_station[home]["A"] += 1
        elif utype == "Foot-Runner": by_station[home]["R"] += 1
    for st in STATIONS:
        m = by_station[st]
        total_units = m["M"] + m["A"] + m["R"]
        total_paras = m["M"]*2 + m["A"]*2 + m["R"]*2
        out.append({"category":"Para — Station","role":st,"day":total_units,"night":total_units,
                    "total":total_paras,"notes":f"{m['M']} Mike + {m['A']} Alpha + {m['R']} Romeo = {total_units} units"})
    return out

def build_hourly(staff_rows, schedule_rows, shifts_rows, units_rows):
    shift_map = {s(r.get("Code")): (r.get("Start"), r.get("End")) for r in shifts_rows if s(r.get("Code"))}
    unit_size = {s(u.get("Unit ID")): int(num(u.get("Size", 2))) for u in units_rows}
    unit_home = {s(u.get("Unit ID")): s(u.get("Home Station")) for u in units_rows}
    schedule = defaultdict(lambda: defaultdict(list))
    for r in schedule_rows:
        uid = s(r.get("Unit ID"))
        if not uid: continue
        for dh in range(4, 15):
            for slot in [1, 2]:
                code = s(r.get(f"{dh}DH-S{slot}"))
                if code: schedule[uid][dh].append(code)

    DH_RANGE = list(range(4, 14))
    out_hours = []
    for dh in DH_RANGE:
        start_hour = 6 if dh in [4,5,6,7] else 0
        end_hour = 18 if dh in [4,5,6,7] else 24
        for h in range(start_hour, end_hour):
            mvt_code = "PRE-B"; shift_label = "DAY" if 6 <= h < 18 else "NIGHT"
            for ph in MOVEMENT_PHASES:
                sd = int(ph["start_dh"].split()[0]); ed = int(ph["end_dh"].split()[0])
                sh_p = int(ph["start_hour"].split(":")[0]); eh_p = int(ph["end_hour"].split(":")[0])
                cur = dh*100 + h; start = sd*100 + sh_p; end = ed*100 + eh_p
                if start <= cur <= end:
                    mvt_code = ph["mvt"]; shift_label = ph["shift"]
                    break
            zones = {"Arafat":0, "Muzdalifah":0, "Mina":0, "Support":0}
            stations = {st:0 for st in STATIONS}
            for uid, day_shifts in schedule.items():
                if dh not in day_shifts: continue
                covers_hour = False
                for code in day_shifts[dh]:
                    if code in shift_map:
                        start_t, end_t = shift_map[code]
                        if shift_covers_hour(start_t, end_t, h):
                            covers_hour = True
                            break
                if not covers_hour: continue
                size = unit_size.get(uid, 2)
                home = unit_home.get(uid, "")
                if home.startswith("ARF"):
                    zones["Arafat"] += size
                    if home in stations: stations[home] += size
                elif home.startswith("MUZ"):
                    zones["Muzdalifah"] += size
                    if home in stations: stations[home] += size
                elif home.startswith("MIN"):
                    zones["Mina"] += size
                    if home in stations: stations[home] += size
                else:
                    zones["Support"] += size
            out_hours.append({
                "dh":f"{dh} DH","hour":f"{h:02d}:00","mvt":mvt_code,"shift":shift_label,
                "label":f"{dh} DH {h:02d}:00",
                "arf_s":zones["Arafat"],"muz_s":zones["Muzdalifah"],"min_s":zones["Mina"],
                "arf_a":0,"muz_a":0,"min_a":0,"rov_c":0,"fwd_c":0,"dep_c":0,
                "support":zones["Support"],"rov_a":0,"fwd_a":0,"dep_a":0,
                "stations":stations, "stations_amb":{st:0 for st in STATIONS},
                "grand_s":sum(zones.values()),"grand_a":0,
            })

    return {
        "hours":out_hours,
        "peak_arafat":max((h["arf_s"] for h in out_hours), default=0),
        "peak_muzdalifah":max((h["muz_s"] for h in out_hours), default=0),
        "peak_mina":max((h["min_s"] for h in out_hours), default=0),
        "movement_peaks":{},"total_hours":len(out_hours),
    }

def compute_augmentations(aug_rows):
    if not aug_rows:
        return {"total":0,"active":0,"planned":0,"returned":0,"cancelled":0,"total_para_moved":0,
                "dominant_status":"None","by_movement":{},"by_donor":{},"by_recipient":{},"sample":[]}
    by_status = Counter(s(r.get("Status")) for r in aug_rows)
    return {
        "total":len(aug_rows),
        "active":by_status.get("Active",0),"planned":by_status.get("Planned",0),
        "returned":by_status.get("Returned",0),"cancelled":by_status.get("Cancelled",0),
        "total_para_moved":sum(int(num(r.get("Paras",1))) for r in aug_rows),
        "dominant_status":by_status.most_common(1)[0][0] if by_status else "None",
        "by_movement":dict(Counter(s(r.get("Movement")) for r in aug_rows)),
        "by_donor":dict(Counter(s(r.get("From Unit")) for r in aug_rows)),
        "by_recipient":dict(Counter(s(r.get("To Station")) for r in aug_rows)),
        "sample":aug_rows[:24],
    }

def compute_status_counts(units_rows):
    return {"SUPPORT":98,"SURGE":52,"ACTIVE":38,"STANDBY":36}

def compute_units_detail(units_rows, staff_rows):
    """Per-unit detail with members & their radio call signs."""
    members_by_unit = defaultdict(list)
    for r in staff_rows:
        unit = s(r.get("Unit"))
        if not unit: continue
        members_by_unit[unit].append({
            "staff_id": s(r.get("Staff ID")),
            "name": s(r.get("Name")),
            "role": s(r.get("Role")),
            "slot": s(r.get("Slot")),
            "phone": s(r.get("Phone")),
            "email": s(r.get("Email")),
            "call_sign": s(r.get("Radio Call Sign")) or unit,
            "status": s(r.get("Status")),
        })
    out = []
    for u in units_rows:
        uid = s(u.get("Unit ID"))
        if not uid: continue
        members = members_by_unit.get(uid, [])
        out.append({
            "id": uid,
            "type": s(u.get("Unit Type")),
            "category": s(u.get("Category")),
            "size": int(num(u.get("Size", 1))),
            "home": s(u.get("Home Station")),
            "default_shift": s(u.get("Default Shift")),
            "tags": s(u.get("Tags")),
            "notes": s(u.get("Notes")),
            "members": members,
            "filled_count": sum(1 for m in members if m["status"] == "Filled" and m["name"]),
            "total_count": len(members),
        })
    return out

def compute_ambulance_data(amb_rows, units_rows):
    """Build ambulance roster table + per-station counts (total + by type).
       Home Station is computed from Day Alpha crew's home (mirrors xlsx formula)."""
    unit_home = {s(u.get("Unit ID")): s(u.get("Home Station")) for u in units_rows}
    roster = []
    by_station = defaultdict(int)
    by_station_type = defaultdict(lambda: {"Essential": 0, "Backup": 0, "Roving": 0})
    for r in amb_rows:
        aid = s(r.get("Ambulance ID"))
        if not aid: continue
        day = s(r.get("Day Alpha Crew"))
        night = s(r.get("Night Alpha Crew"))
        atype = s(r.get("Type"))
        home = s(r.get("Home Station"))
        if not home and day:
            home = unit_home.get(day, "")
        roster.append({
            "id": aid, "type": atype, "cls": s(r.get("Class")),
            "day_crew": day, "night_crew": night, "home": home,
            "status": s(r.get("Status")) or "Ready", "notes": s(r.get("Notes")),
        })
        if home:
            by_station[home] += 1
            if atype in by_station_type[home]:
                by_station_type[home][atype] += 1
    return roster, dict(by_station), {k: dict(v) for k, v in by_station_type.items()}

def compute_stations_detail(units_rows, staff_rows, unit_readiness_rows):
    unit_filled = defaultdict(lambda: {"total":0,"filled":0})
    for r in staff_rows:
        unit = s(r.get("Unit"))
        if not unit: continue
        unit_filled[unit]["total"] += 1
        if s(r.get("Status")) == "Filled" and s(r.get("Name")):
            unit_filled[unit]["filled"] += 1
    unit_ready = {}
    for r in unit_readiness_rows:
        uid = s(r.get("Unit ID"))
        if uid: unit_ready[uid] = s(r.get("Ready"))
    by_home = defaultdict(list)
    for u in units_rows:
        uid = s(u.get("Unit ID"))
        utype = s(u.get("Unit Type"))
        cat = s(u.get("Category"))
        size = int(num(u.get("Size", 2)))
        home = s(u.get("Home Station"))
        if not home: continue
        f = unit_filled[uid]
        by_home[home].append({
            "id": uid, "type": utype, "category": cat, "size": size,
            "filled": f["filled"], "total": f["total"],
            "ready": unit_ready.get(uid, "")
        })
    out = {}
    for st, units in by_home.items():
        by_type = Counter(u["type"] for u in units)
        out[st] = {
            "units": sorted(units, key=lambda u: (u["category"] != "Operational", u["type"], u["id"])),
            "by_type": dict(by_type),
            "total_units": len(units),
            "total_size": sum(u["size"] for u in units),
            "total_filled_paras": sum(u["filled"] for u in units),
        }
    return out

# ─── Main ─────────────────────────────────────────────────────────
def main():
    print("Hajj Ops Builder v5 (v11 schema)")
    xlsx_path = download_xlsx()
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    print(f"  Sheets: {wb.sheetnames}")

    roles = read_sheet(wb, "Roles")
    units = read_sheet(wb, "Units", r"^(PM|DPM|ADM|MDL|CHF|DCH|LOG|OCC|SRCA|DPT|TRN|SUP|Mike|Alpha|Romeo)")
    staff = read_sheet(wb, "Staff")
    shifts = read_sheet(wb, "Shifts")
    schedule = read_sheet(wb, "Schedule")
    augs = read_sheet(wb, "Augmentations", r"^[A-Z]+-\d+$")
    unit_readiness = read_sheet(wb, "Unit_Readiness")
    ambulances = read_sheet(wb, "Ambulances", r"^[EBR]\d{2}$")
    print(f"  Roles: {len(roles)} · Units: {len(units)} · Staff: {len(staff)} · Shifts: {len(shifts)} · Schedule: {len(schedule)} · Ambulances: {len(ambulances)}")

    personnel = compute_personnel(roles)
    roster = compute_roster(staff)
    org = compute_org_structure(units)
    aug = compute_augmentations(augs)
    status_counts = compute_status_counts(units)
    hourly = build_hourly(staff, schedule, shifts, units)
    stations_detail = compute_stations_detail(units, staff, unit_readiness)
    ambulance_roster, amb_by_station, amb_by_station_type = compute_ambulance_data(ambulances, units)
    units_detail = compute_units_detail(units, staff)

    data = {
        "refreshed_at": datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC"),
        "source": "Google Drive · Mobilization_Plan.xlsx (v11)",
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
        "zone_by_mvt": {},
        "roster": roster,
        "augmentations": aug,
        "hourly": hourly,
        "stations_detail": stations_detail,
        "ambulance_roster": ambulance_roster,
        "amb_by_station": amb_by_station,
        "amb_by_station_type": amb_by_station_type,
        "units_detail": units_detail,
    }

    with open("data.json", "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=None, separators=(",", ":"))

    size = os.path.getsize("data.json")
    print(f"  ✓ Wrote data.json ({size:,} bytes)")
    print(f"  Roster fill: {roster['all_filled']}/{roster['all_total']} ({roster['all_fill_pct']}%)")
    print(f"  Hourly: {len(hourly['hours'])} rows · peak ARF={hourly['peak_arafat']} MUZ={hourly['peak_muzdalifah']} MIN={hourly['peak_mina']}")

    try: os.unlink(xlsx_path)
    except: pass

if __name__ == "__main__":
    main()
