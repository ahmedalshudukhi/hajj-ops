#!/usr/bin/env python3
"""
Hajj Ops Dashboard — Data Builder v2

Pulls live data from all 8 Smartsheet sheets, regenerates data.json.
Run:  SMARTSHEET_TOKEN=xxx python build.py
"""
import os, json, sys
from datetime import datetime, timezone
from collections import defaultdict, Counter
import smartsheet

SHEETS = {
    "mobilization":   7526276247015300,
    "staff_assign":   7347119470890884,
    "augmentations":  1739266102087556,
    "hourly_grid":    6367282342088580,
    "calendar":       6829803075227524,
    "timeline":       4115482528403332,
    "gp_coverage":    7525708036263812,
    "master_tasks":   1896776712802180,
}

MOVEMENT_META = {
    "PRE-B": {"shift": "DAY",   "dh": "7 DH",     "label": "Pre-Boarding setup"},
    "GAP":   {"shift": "MIXED", "dh": "8-9 DH",   "label": "Inter-movement Gap"},
    "B1A":   {"shift": "NIGHT", "dh": "8/9 DH",   "label": "Boarding 1A — Mina/Muz alighting"},
    "B1B":   {"shift": "NIGHT", "dh": "9 DH",     "label": "Boarding 1B — Arafat alighting"},
    "B2A":   {"shift": "DAY",   "dh": "9 DH",     "label": "Boarding 2A — Day arrival"},
    "B2B":   {"shift": "DAY",   "dh": "9 DH",     "label": "Boarding 2B — Day arrival"},
    "C":     {"shift": "NIGHT", "dh": "10 DH",    "label": "Day of Arafat"},
    "D":     {"shift": "MIXED", "dh": "10/11 DH", "label": "Muzdalifah → Mina"},
    "E":     {"shift": "MIXED", "dh": "11-13 DH", "label": "Mina operations"},
    "MAINT": {"shift": "DAY",   "dh": "13 DH",    "label": "Maintenance / Demob"},
}
MOVEMENT_ORDER = ["PRE-B", "GAP", "B1A", "B1B", "B2A", "B2B", "C", "D", "E", "MAINT"]

PHASE_NAMES = {
    0: "Governance & Contractual",
    1: "Permits & Administration",
    2: "Logistics & Facilities",
    3: "Equipment & Procurement",
    4: "Staffing & Recruitment",
    5: "Plans & Documentation",
    6: "Testing & Readiness",
    7: "Operations (DH 8-13)",
    8: "Demobilization",
}


def cv(row, cmap, name, default=None):
    cid = cmap.get(name)
    if cid is None: return default
    for cell in row.cells:
        if cell.column_id == cid:
            return cell.display_value if cell.display_value is not None else cell.value
    return default


def num(v, default=0):
    if v is None or v == "": return default
    try: return float(v)
    except (TypeError, ValueError): return default


def fetch(client, sheet_id):
    sheet = client.Sheets.get_sheet(sheet_id)
    return sheet, {c.title: c.id for c in sheet.columns}


def fmt_date(d):
    if not d: return "—"
    try: return datetime.fromisoformat(str(d)[:10]).strftime("%d %b")
    except (ValueError, TypeError): return str(d)[:10]


def build_mobilization(client):
    sheet, cmap = fetch(client, SHEETS["mobilization"])
    by_mvt = defaultdict(lambda: {"staff": 0, "para": 0, "amb": 0})
    status_counts = Counter()
    zone_by_mvt = defaultdict(lambda: defaultdict(int))

    for r in sheet.rows:
        mvt = cv(r, cmap, "Movement", "")
        if not mvt: continue
        zone = cv(r, cmap, "Zone", "Unknown")
        status = cv(r, cmap, "Status", "Unknown")
        total = int(num(cv(r, cmap, "Total Staff")))
        para = int(num(cv(r, cmap, "Sta Para")))
        veh = int(num(cv(r, cmap, "Amb Vehicles")))
        by_mvt[mvt]["staff"] += total
        by_mvt[mvt]["para"] += para
        by_mvt[mvt]["amb"] += veh
        status_counts[status] += 1
        zone_by_mvt[mvt][zone] += total

    movements = []
    for code in MOVEMENT_ORDER:
        if code in by_mvt:
            d = by_mvt[code]
            movements.append({
                "code": code,
                "shift": MOVEMENT_META[code]["shift"],
                "dh": MOVEMENT_META[code]["dh"],
                "label": MOVEMENT_META[code]["label"],
                "staff": d["staff"], "para": d["para"], "amb": d["amb"],
            })

    zone_clean = {}
    for mvt in MOVEMENT_ORDER:
        if mvt in zone_by_mvt and mvt not in ("PRE-B", "GAP", "MAINT"):
            z = zone_by_mvt[mvt]
            zone_clean[mvt] = {
                "Arafat": z.get("Arafat", 0),
                "Muzdalifah": z.get("Muzdalifah", 0),
                "Mina": z.get("Mina", 0),
                "Support": z.get("Support", 0),
            }

    return {
        "movements": movements,
        "status_counts": dict(status_counts.most_common()),
        "zone_by_mvt": zone_clean,
        "totals": {
            "allocated_staff_shifts": sum(d["staff"] for d in by_mvt.values()),
            "mobilization_rows": len(sheet.rows),
            "movements": len(by_mvt),
            "stations": 9,
        },
    }


def build_roster(client):
    sheet, cmap = fetch(client, SHEETS["staff_assign"])
    vacant = filled = 0
    by_subrole = Counter()
    by_shift = Counter()
    for r in sheet.rows:
        status = cv(r, cmap, "Status", "")
        subrole = cv(r, cmap, "Sub-Role", "Other") or "Other"
        shift = cv(r, cmap, "Shift", "Unknown")
        if status == "Vacant": vacant += 1
        else: filled += 1
        if subrole.startswith("E-"): subrole = "E-Amb"
        elif subrole.startswith("B-"): subrole = "B-Amb"
        elif subrole.startswith("R-"): subrole = "Roving"
        elif subrole.startswith("F-"): subrole = "Forward"
        elif subrole.startswith("D-"): subrole = "Depot"
        by_subrole[subrole] += 1
        by_shift[shift] += 1
    total = vacant + filled
    return {
        "total": total, "vacant": vacant, "filled": filled,
        "fill_pct": round((filled / total) * 100, 1) if total else 0,
        "by_subrole": dict(by_subrole.most_common()),
        "by_shift": dict(by_shift.most_common()),
    }


def build_augmentations(client):
    sheet, cmap = fetch(client, SHEETS["augmentations"])
    status_count = Counter()
    by_mvt = Counter()
    by_donor = Counter()
    sample = []
    for r in sheet.rows:
        aug_id = cv(r, cmap, "Aug ID", "")
        status = cv(r, cmap, "Status", "Planned")
        mvt = cv(r, cmap, "Mvt", "")
        from_st = cv(r, cmap, "From", "")
        to_st = cv(r, cmap, "To", "")
        para = int(num(cv(r, cmap, "Para Moved")))
        status_count[status] += 1
        if mvt: by_mvt[mvt] += 1
        if from_st: by_donor[from_st] += para
        if len(sample) < 18 and from_st and to_st:
            sample.append({"id": aug_id, "mvt": mvt, "from": from_st, "to": to_st, "para": para, "status": status})
    by_mvt_ordered = {m: by_mvt[m] for m in ["B1A", "B1B", "B2A", "B2B", "C", "D", "E"] if m in by_mvt}
    return {
        "total": len(sheet.rows),
        "active": status_count.get("Active", 0),
        "planned": status_count.get("Planned", 0),
        "returned": status_count.get("Returned", 0),
        "cancelled": status_count.get("Cancelled", 0),
        "dominant_status": status_count.most_common(1)[0][0] if status_count else "Planned",
        "by_movement": by_mvt_ordered,
        "by_donor": dict(by_donor.most_common()),
        "sample": sample,
    }


def build_calendar(client):
    sheet, cmap = fetch(client, SHEETS["calendar"])
    days = []
    for r in sheet.rows:
        dh = cv(r, cmap, "DH")
        if dh is None: continue
        days.append({
            "dh": int(num(dh, 0)),
            "greg": cv(r, cmap, "Gregorian", ""),
            "day": cv(r, cmap, "Day", ""),
            "phase": cv(r, cmap, "Phase", ""),
            "events": cv(r, cmap, "Events", "") or "",
        })
    return sorted(days, key=lambda x: x["dh"])


def build_timeline(client):
    sheet, cmap = fetch(client, SHEETS["timeline"])
    items = []
    for r in sheet.rows:
        phase = cv(r, cmap, "Phase")
        if phase is None: continue
        items.append({
            "phase": str(phase),
            "activity": cv(r, cmap, "Activity", ""),
            "date_dh": cv(r, cmap, "Date DH", ""),
            "greg": cv(r, cmap, "Greg", ""),
            "owner": cv(r, cmap, "Owner", ""),
        })
    return items


def build_gp_coverage(client):
    sheet, cmap = fetch(client, SHEETS["gp_coverage"])
    items = []
    for r in sheet.rows:
        st = cv(r, cmap, "Station")
        if not st: continue
        items.append({
            "station": st,
            "gp_day": cv(r, cmap, "GP Day", ""),
            "gp_night": cv(r, cmap, "GP Night", ""),
            "covers": cv(r, cmap, "Covers", ""),
            "notes": cv(r, cmap, "Notes", ""),
        })
    return items


def build_hourly(client):
    sheet, cmap = fetch(client, SHEETS["hourly_grid"])
    hours = []
    for r in sheet.rows:
        dh = cv(r, cmap, "DH")
        hour = cv(r, cmap, "Hour")
        if dh is None or hour is None: continue
        hours.append({
            "dh": str(dh),
            "hour": str(hour),
            "mvt": cv(r, cmap, "Mvt", ""),
            "shift": cv(r, cmap, "Shift", ""),
            "staff": int(num(cv(r, cmap, "Grand Staff"))),
            "amb": int(num(cv(r, cmap, "Grand Amb"))),
            "label": f"{dh} {hour}",
        })

    if hours:
        peak_staff = max(h["staff"] for h in hours)
        peak_amb = max(h["amb"] for h in hours)
        peak_hour = next(h for h in hours if h["staff"] == peak_staff)
    else:
        peak_staff = peak_amb = 0
        peak_hour = {}

    return {
        "hours": hours,
        "peak_staff": peak_staff,
        "peak_amb": peak_amb,
        "peak_at": peak_hour.get("label", ""),
        "total_hours": len(hours),
    }


def build_tasks(client):
    sheet, cmap = fetch(client, SHEETS["master_tasks"])
    phase_counts = Counter()
    phase_p1 = Counter()
    phase_health = defaultdict(list)
    critical = []
    status_count = Counter()
    total = 0

    for r in sheet.rows:
        phase = cv(r, cmap, "Phase", "")
        priority = cv(r, cmap, "Priority", "")
        task = cv(r, cmap, "Task", "")
        owner = cv(r, cmap, "Owner", "") or ""
        due = cv(r, cmap, "Due", "")
        status = cv(r, cmap, "Status", "")
        health = cv(r, cmap, "Health", "Gray")
        num_col = cv(r, cmap, "#", "")

        if not priority and not num_col: continue
        total += 1
        if phase:
            phase_counts[phase] += 1
            if priority == "P1": phase_p1[phase] += 1
            if health and "INVALID" not in str(health):
                phase_health[phase].append(health)
            status_count[status] += 1
        if priority == "P1" and len(critical) < 12:
            critical.append({
                "num": int(num(num_col, 0)),
                "phase": phase,
                "task": str(task)[:80],
                "owner": str(owner)[:40],
                "due": fmt_date(due),
                "status": status or "Open",
            })

    phases = []
    for i in range(9):
        key = f"Phase {i}"
        healths = phase_health.get(key, [])
        if "Red" in healths: h = "Red"
        elif "Yellow" in healths: h = "Yellow"
        elif healths and all(x == "Green" for x in healths): h = "Green"
        elif healths: h = "Yellow"
        else: h = "Gray"
        phases.append({
            "num": i, "name": PHASE_NAMES[i],
            "count": phase_counts.get(key, 0),
            "p1": phase_p1.get(key, 0), "health": h,
        })

    return {"total": total, "by_status": dict(status_count), "phases": phases, "critical_tasks": critical}


def main():
    token = os.environ.get("SMARTSHEET_TOKEN")
    if not token:
        sys.exit("ERROR: SMARTSHEET_TOKEN env var not set")
    client = smartsheet.Smartsheet(token)
    client.errors_as_exceptions(True)

    print("→ Mobilization..."); mob = build_mobilization(client)
    print("→ Staff_Assignment..."); roster = build_roster(client)
    print("→ Augmentations..."); augs = build_augmentations(client)
    print("→ Calendar..."); cal = build_calendar(client)
    print("→ Timeline..."); tl = build_timeline(client)
    print("→ GP_Coverage..."); gp = build_gp_coverage(client)
    print("→ Hourly_Grid..."); hg = build_hourly(client)
    print("→ Master_Tasks..."); tasks = build_tasks(client)

    refreshed_at = datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC")
    data = {
        "refreshed_at": refreshed_at,
        "totals": mob["totals"],
        "roster": roster,
        "augmentations": augs,
        "tasks": {"total": tasks["total"], "by_status": tasks["by_status"]},
        "movements": mob["movements"],
        "status_counts": mob["status_counts"],
        "zone_by_mvt": mob["zone_by_mvt"],
        "phases": tasks["phases"],
        "critical_tasks": tasks["critical_tasks"],
        "calendar": cal,
        "timeline": tl,
        "gp_coverage": gp,
        "hourly": hg,
    }

    out = os.path.join(os.path.dirname(__file__) or ".", "data.json")
    with open(out, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"\n✓ Wrote {out}")
    print(f"  Refreshed:  {refreshed_at}")
    print(f"  Allocated:  {mob['totals']['allocated_staff_shifts']:,} staff-shifts")
    print(f"  Roster:     {roster['fill_pct']}% filled ({roster['filled']}/{roster['total']})")
    print(f"  Augs:       {augs['total']} ({augs['planned']} planned)")
    print(f"  Calendar:   {len(cal)} days")
    print(f"  Timeline:   {len(tl)} activities")
    print(f"  GP cover:   {len(gp)} stations")
    print(f"  Hourly:     {hg['total_hours']} hrs · peak {hg['peak_staff']} at {hg['peak_at']}")
    print(f"  Tasks:      {tasks['total']}")


if __name__ == "__main__":
    main()
