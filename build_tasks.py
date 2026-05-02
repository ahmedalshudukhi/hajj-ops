#!/usr/bin/env python3
"""
build_tasks.py — Fetch Master_Tasks from Smartsheet API, write tasks.json.

Reads SMARTSHEET_TOKEN from env (GitHub Actions secret in CI).
Falls back to a baked-in snapshot if no token (so dashboard never breaks).
"""
import os, json, sys
from datetime import datetime, timezone
import urllib.request, urllib.error

SHEET_ID = 1896776712802180
TOKEN = os.environ.get("SMARTSHEET_TOKEN", "")

# Column ID map (locked schema — see Smartsheet sheet 1896776712802180)
COL = {
    "num":          3535270978031492,
    "phase":        8038870605401988,
    "task":         720521210924932,
    "category":     5224120838295428,
    "priority":     1926899644534660,
    "owner":        2972321024610180,
    "support":      7475920651980676,
    "start":        1846421117767556,
    "due":          6350020745138052,
    "status":       4098220931452804,
    "sar_visible":  1232963003256708,
    "notes":        8601820558823300,
}

def fetch_via_api():
    if not TOKEN: return None
    url = f"https://api.smartsheet.com/2.0/sheets/{SHEET_ID}?include=objectValue"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  API fetch failed: {e}", file=sys.stderr)
        return None

def cell_value(row, col_id):
    for c in row.get("cells", []):
        if c.get("columnId") == col_id:
            return c.get("displayValue") if c.get("displayValue") is not None else c.get("value")
    return None

def parse_tasks_from_api(api_data):
    tasks = []
    for row in api_data.get("rows", []):
        num = cell_value(row, COL["num"])
        try: num = int(float(num)) if num not in (None, "") else None
        except: num = None
        task_text = cell_value(row, COL["task"]) or ""
        phase = cell_value(row, COL["phase"]) or ""
        is_header = (num is None and task_text.upper() == task_text.strip() and phase != "" and len(task_text) > 5)
        tasks.append({
            "num": num, "phase": phase, "task": task_text,
            "category": cell_value(row, COL["category"]),
            "priority": cell_value(row, COL["priority"]),
            "owner": cell_value(row, COL["owner"]),
            "support": cell_value(row, COL["support"]),
            "start": cell_value(row, COL["start"]),
            "due": cell_value(row, COL["due"]),
            "status": cell_value(row, COL["status"]),
            "sar_visible": bool(cell_value(row, COL["sar_visible"])),
            "notes": cell_value(row, COL["notes"]),
            "is_header": is_header,
        })
    return tasks

FALLBACK_TASKS = [
    {"num":None,"phase":"Phase 0","task":"Governance and Contractual","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":43,"phase":"Phase 0","task":"Finalize contract/SoW with SAR","category":"Contract","priority":"P1","owner":"Dr. Alaa","support":"Ahmed Alshudukhi","start":"2026-04-12","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Ensure all scope items contractually covered","is_header":False},
    {"num":44,"phase":"Phase 0","task":"Payments planning & cost center setup","category":"Finance","priority":"P1","owner":"Dr. Alaa","support":"Ahmed Alshudukhi","start":"2026-04-15","due":None,"status":"Later","sar_visible":False,"notes":"Postponed to later \u2014 to revisit post-deployment","is_header":False},
    {"num":45,"phase":"Phase 0","task":"MoH MoM \u2014 licenses for medical clinics and ambulances","category":"Permits","priority":"P1","owner":"Nasser Aloraimah","support":"Dr. Alaa","start":"2026-04-20","due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Regulatory clearance for Hajj zones","is_header":False},
    {"num":46,"phase":"Phase 0","task":"MoH & SRCA interface \u2014 escalation protocols","category":"Regulatory","priority":"P1","owner":"Ahmed Alshudukhi","support":"Ahmed Alshudukhi","start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Formal coordination agreements","is_header":False},
    {"num":47,"phase":"Phase 0","task":"Security forces & station ops agreement","category":"Governance","priority":"P1","owner":"Ahmed Alshudukhi","support":"Ahmed Alshudukhi","start":"2026-04-25","due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Security coverage for 9 stations","is_header":False},
    {"num":49,"phase":"Phase 0","task":"SAR performance KPIs & reporting obligations","category":"Contract","priority":"P1","owner":"Dr. Alaa","support":"Ahmed Alshudukhi","start":"2026-04-25","due":"2026-05-10","status":"Open","sar_visible":True,"notes":"Agree deliverables, reporting frequency, format","is_header":False},
    {"num":50,"phase":"Phase 0","task":"Cost center setup","category":"Finance","priority":"P1","owner":"Nasser Aloraimah","support":None,"start":None,"due":"2026-05-14","status":"In Process","sar_visible":False,"notes":"HMG internal financial setup","is_header":False},
    {"num":51,"phase":"Phase 0","task":"Medical waste plan & contract","category":"Contract","priority":"P1","owner":"Nasser Aloraimah","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Medical/biohazard disposal contract \u2014 distinct from operational waste plan","is_header":False},
    {"num":52,"phase":"Phase 0","task":"Master document & Deployment Plan","category":"Governance","priority":"P1","owner":"Ahmed Alshudukhi","support":None,"start":None,"due":"2026-05-14","status":"In Process","sar_visible":False,"notes":"HMG bible \u2014 deployment plan v3+","is_header":False},
    {"num":53,"phase":"Phase 0","task":"Master_Tasks updates & oversight","category":"Governance","priority":"P1","owner":"Dr. Alaa","support":None,"start":None,"due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Ongoing oversight \u2014 keep this tracker accurate","is_header":False},
    {"num":None,"phase":"Phase 1","task":"PERMITS & ADMINISTRATION","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":1,"phase":"Phase 1","task":"Makkah entry permits \u2014 Muqeem","category":"Permits","priority":None,"owner":"Nasser Aloraimah","support":"Dr. Alaa","start":"2026-04-12","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":2,"phase":"Phase 1","task":"Mashaer entry & Makkah permits \u2014 SADIA","category":"Permits","priority":None,"owner":"Nasser Aloraimah","support":"Dr. Alaa","start":"2026-04-12","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":3,"phase":"Phase 1","task":"MMMP access card issuance (SAR coordinator)","category":"Permits","priority":None,"owner":"Nasser Aloraimah","support":"Dr. Alaa","start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":4,"phase":"Phase 1","task":"Ambulance permits (25 vehicles)","category":"Permits","priority":None,"owner":"Nasser Aloraimah","support":"Dr. Alaa","start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":None,"phase":"Phase 2","task":"LOGISTICS & FACILITIES","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":6,"phase":"Phase 2","task":"Accommodation setup \u2014 10 locations (275 beds)","category":"Facilities","priority":None,"owner":"Talal","support":None,"start":"2026-04-20","due":"2026-05-07","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":7,"phase":"Phase 2","task":"Clinic buildup \u2014 9 platform stations + depot","category":"Facilities","priority":None,"owner":"Talal","support":None,"start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":8,"phase":"Phase 2","task":"Catering plan (276 staff \u00d7 15 days)","category":"Logistics","priority":None,"owner":"Talal","support":None,"start":"2026-04-20","due":"2026-05-07","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":9,"phase":"Phase 2","task":"Waste management plan","category":"Logistics","priority":None,"owner":"Talal","support":None,"start":"2026-04-25","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":10,"phase":"Phase 2","task":"Signage design & ambulance branding","category":"Facilities","priority":None,"owner":"Nasser Aloraimah","support":None,"start":"2026-04-25","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":54,"phase":"Phase 2","task":"Branding (HMG/SAR co-brand)","category":"Facilities","priority":"P2","owner":"Nasser Aloraimah","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Co-branding identity \u2014 distinct from operational signage","is_header":False},
    {"num":None,"phase":"Phase 3","task":"EQUIPMENT & PROCUREMENT","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
]
FALLBACK_TASKS += [
    {"num":11,"phase":"Phase 3","task":"Medical supplies \u2014 full inventory list","category":"Procurement","priority":None,"owner":"Bukhari & Hayil","support":"Dr. Nawaf & Dr. Khalid","start":"2026-04-15","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":12,"phase":"Phase 3","task":"Ambulance vehicles \u2014 25 operational ALS units","category":"Procurement","priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":"2026-04-12","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":13,"phase":"Phase 3","task":"Communication system (radios/handhelds)","category":"Procurement","priority":None,"owner":"Bukhari & Hayil","support":None,"start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":14,"phase":"Phase 3","task":"Staff uniforms & HMG/SAR branding","category":"Procurement","priority":None,"owner":"Bukhari & Hayil","support":None,"start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":None,"is_header":False},
    {"num":55,"phase":"Phase 3","task":"Kit readiness \u2014 Alpha/Romeo/Mike","category":"Readiness","priority":"P1","owner":"Dr. Khalid","support":None,"start":None,"due":"2026-05-04","status":"Open","sar_visible":False,"notes":"URGENT \u2014 unit-type-specific kit lists. Defines what each unit carries. Drives procurement (#11/#57).","is_header":False},
    {"num":56,"phase":"Phase 3","task":"EMS bags","category":"Procurement","priority":"P2","owner":"Bukhari & Hayil","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Field bags per Romeo/Alpha specification (driven by #55)","is_header":False},
    {"num":57,"phase":"Phase 3","task":"Order equipment & kits","category":"Procurement","priority":"P1","owner":"Bukhari & Hayil","support":None,"start":None,"due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Place orders for medical supplies, kits per inventory list (#11) and kit readiness (#55)","is_header":False},
    {"num":58,"phase":"Phase 3","task":"Ambulance stickers","category":"Procurement","priority":"P2","owner":"Nasser Aloraimah","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Brand identity application on 25 ambulances","is_header":False},
    {"num":None,"phase":"Phase 4","task":"STAFFING & RECRUITMENT","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":15,"phase":"Phase 4","task":"GP recruitment \u2014 20 physicians (10D/10N)","category":"Staffing","priority":None,"owner":"Dr. Nawaf","support":"Dr. Khalid","start":"2026-04-15","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"1 GP/station/shift + 2 backup","is_header":False},
    {"num":None,"phase":"Phase 4","task":"Leadership Paramedics and support","category":"Staffing","priority":None,"owner":"Bukhari & Hayil","support":None,"start":"2026-04-12","due":"2026-05-07","status":"Done","sar_visible":True,"notes":None,"is_header":False},
    {"num":16,"phase":"Phase 4","task":"Station paramedic recruitment \u2014 125","category":"Staffing","priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":"2026-04-12","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Confirm names, contracts, availability","is_header":False},
    {"num":17,"phase":"Phase 4","task":"Ambulance crew assignment \u2014 100 (25\u00d74)","category":"Staffing","priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":"2026-04-20","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Crew pairings, shift assignments per vehicle","is_header":False},
    {"num":18,"phase":"Phase 4","task":"SRCA liaison officers \u2014 2 (day/night)","category":"Staffing","priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":"2026-04-25","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"CVs submitted to SAR/SRCA","is_header":False},
    {"num":19,"phase":"Phase 4","task":"OCC dispatchers","category":"Staffing","priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":"2026-04-25","due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"CVs to be submitted","is_header":False},
    {"num":None,"phase":"Phase 5","task":"PLANS & DOCUMENTATION","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":20,"phase":"Phase 5","task":"Mobilization master plan \u2014 final","category":"Planning","priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":"2026-04-12","due":"2026-05-14","status":"Done","sar_visible":True,"notes":"MMMP workbook v8","is_header":False},
    {"num":21,"phase":"Phase 5","task":"Transportation, catering & accommodation plan","category":"Planning","priority":None,"owner":"Nasser Aloraimah","support":"Ahmed Alshudukhi","start":"2026-04-25","due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Vehicle routing, staging, movement logistics","is_header":False},
    {"num":24,"phase":"Phase 5","task":"Staff attendance methodology","category":"Planning","priority":None,"owner":"Nasser Aloraimah","support":"Ahmed Alshudukhi","start":"2026-05-01","due":"2026-05-14","status":"Open","sar_visible":True,"notes":"Check-in/out, lessons learned","is_header":False},
    {"num":None,"phase":"Phase 5","task":"Operational Protocols","category":None,"priority":None,"owner":"Bukhari & Hayil","support":"Ahmed Alshudukhi","start":None,"due":"2026-05-14","status":"In Process","sar_visible":True,"notes":"Includes comms protocol + daily report + escalation chain","is_header":False},
    {"num":59,"phase":"Phase 5","task":"Drills (clinical + ops)","category":"Planning","priority":"P1","owner":"Bukhari & Hayil","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":True,"notes":"MCI \u00b7 heat illness \u00b7 cardiac \u00b7 transfer-protocol drills with Khalid + Nawaf clinical lead","is_header":False},
    {"num":60,"phase":"Phase 5","task":"PCR design & implementation","category":"Planning","priority":"P1","owner":"Bukhari & Hayil","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":False,"notes":"HMG PCR documentation system \u2014 design by Bukhari & Hayil, approval by Dr. Khalid","is_header":False},
    {"num":None,"phase":"Phase 6","task":"TESTING & READINESS","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":27,"phase":"Phase 6","task":"MMMP main test case (SAR joint exercise)","category":"Testing","priority":None,"owner":"Dr. Khalid & Dr. Nawaf","support":"Ahmed Alshudukhi","start":"2026-05-10","due":"2026-05-14","status":"Done","sar_visible":True,"notes":"Full-scale simulation with SAR","is_header":False},
    {"num":28,"phase":"Phase 6","task":"MoH test cases / inspections","category":"Testing","priority":None,"owner":"Dr. Khalid & Dr. Nawaf","support":"Ahmed Alshudukhi","start":"2026-05-10","due":"2026-05-14","status":"Open","sar_visible":True,"notes":"MoH compliance inspection readiness","is_header":False},
    {"num":29,"phase":"Phase 6","task":"Staff training \u2014 4-day intensive (DH 4\u20137)","category":"Training","priority":None,"owner":"Dr. Khalid & Dr. Nawaf","support":"Ahmed Alshudukhi","start":"2026-05-14","due":"2026-05-27","status":"Open","sar_visible":True,"notes":"Protocols, comms, movement drills, famil","is_header":False},
    {"num":30,"phase":"Phase 6","task":"OCC setup & systems test (Day + Night)","category":"Testing","priority":None,"owner":"Ahmed Alshudukhi","support":"Bukhari & Hayil","start":"2026-05-14","due":"2026-05-20","status":"Open","sar_visible":False,"notes":"Dispatch, tracking, reporting live test","is_header":False},
    {"num":31,"phase":"Phase 6","task":"Medical Protocols","category":"Readiness","priority":None,"owner":"Dr. Khalid","support":"Ahmed Alshudukhi","start":"2026-05-14","due":"2026-05-14","status":"Done","sar_visible":True,"notes":"Walk-through, sign-off, photo baseline","is_header":False},
    {"num":61,"phase":"Phase 6","task":"OCC systems (build/install)","category":"Readiness","priority":"P1","owner":"Ahmed Alshudukhi","support":None,"start":None,"due":"2026-05-14","status":"Open","sar_visible":False,"notes":"Build/install OCC technical infrastructure (radio, dispatch, monitors). Test follows in #30.","is_header":False},
    {"num":None,"phase":"Phase 7","task":"OPERATIONS (DH 8\u201313)","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":32,"phase":"Phase 7","task":"OPS \u2014 Tarwiyah (DH 8, 25 May)","category":"Operations","priority":None,"owner":None,"support":None,"start":"2026-05-25","due":"2026-05-25","status":"Open","sar_visible":True,"notes":"B1A 20:00","is_header":False},
    {"num":33,"phase":"Phase 7","task":"OPS \u2014 Arafat CRITICAL (DH 9, 26 May)","category":"Operations","priority":None,"owner":None,"support":None,"start":"2026-05-26","due":"2026-05-26","status":"Open","sar_visible":True,"notes":"Mvt C \u2014 Nafra \u2014 294K pilgrims","is_header":False},
    {"num":34,"phase":"Phase 7","task":"OPS \u2014 Eid / D\u2192E (DH 10, 27 May)","category":"Operations","priority":None,"owner":None,"support":None,"start":"2026-05-27","due":"2026-05-27","status":"Open","sar_visible":True,"notes":"Muz\u2192Mina, Jamarat begins","is_header":False},
    {"num":35,"phase":"Phase 7","task":"OPS \u2014 Jamarat (DH 11\u201313, 28\u201330 May)","category":"Operations","priority":None,"owner":None,"support":None,"start":"2026-05-28","due":"2026-05-30","status":"Open","sar_visible":True,"notes":"Mvt E \u2014 heavy Mina","is_header":False},
    {"num":36,"phase":"Phase 7","task":"Daily ops reporting to SAR","category":"Reporting","priority":None,"owner":None,"support":None,"start":"2026-05-25","due":"2026-05-30","status":"Open","sar_visible":True,"notes":"Per template within agreed window","is_header":False},
    {"num":None,"phase":"Phase 8","task":"DEMOBILIZATION","category":None,"priority":None,"owner":None,"support":None,"start":None,"due":None,"status":None,"sar_visible":True,"notes":None,"is_header":True},
    {"num":37,"phase":"Phase 8","task":"Equipment recovery & inventory","category":"Demob","priority":None,"owner":None,"support":None,"start":"2026-05-31","due":"2026-06-02","status":"Later","sar_visible":True,"notes":"Medical supplies, comms, vehicles","is_header":False},
    {"num":38,"phase":"Phase 8","task":"Facility dismantling & cleanup","category":"Demob","priority":None,"owner":None,"support":None,"start":"2026-05-31","due":"2026-06-02","status":"Later","sar_visible":True,"notes":"Reverse of buildup \u2014 all 10 locations","is_header":False},
    {"num":39,"phase":"Phase 8","task":"Site handback \u2014 all locations to SAR","category":"Demob","priority":None,"owner":None,"support":None,"start":"2026-05-31","due":"2026-06-02","status":"Later","sar_visible":True,"notes":"Condition report, photos","is_header":False},
    {"num":40,"phase":"Phase 8","task":"Access card collection & return to SAR","category":"Demob","priority":None,"owner":None,"support":None,"start":"2026-05-31","due":"2026-06-02","status":"Later","sar_visible":True,"notes":"All 276 cards accounted for","is_header":False},
    {"num":41,"phase":"Phase 8","task":"Staff demobilization & transport","category":"Demob","priority":None,"owner":None,"support":None,"start":"2026-05-31","due":"2026-06-02","status":"Later","sar_visible":True,"notes":"Phased departure, transport","is_header":False},
    {"num":42,"phase":"Phase 8","task":"Hajj final report & deliverables","category":"Reporting","priority":None,"owner":None,"support":None,"start":"2026-06-01","due":"2026-06-15","status":"Later","sar_visible":True,"notes":"KPIs, incidents, lessons, financials","is_header":False},
]

def main():
    api_data = fetch_via_api()
    if api_data:
        tasks = parse_tasks_from_api(api_data)
        source = "Smartsheet API \u00b7 live"
        print(f"  \u2713 Fetched {len(tasks)} rows from Smartsheet API")
    else:
        tasks = FALLBACK_TASKS
        source = "Smartsheet \u00b7 baked snapshot (no API token)"
        print(f"  Using fallback snapshot: {len(tasks)} rows")
    out = {
        "refreshed_at": datetime.now(timezone.utc).strftime("%d %b %Y \u00b7 %H:%M UTC"),
        "source": source, "sheet_id": SHEET_ID, "tasks": tasks,
    }
    with open("tasks.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=None, separators=(",", ":"))
    size = os.path.getsize("tasks.json")
    print(f"  \u2713 Wrote tasks.json ({size:,} bytes \u00b7 {len(tasks)} rows \u00b7 {sum(1 for t in tasks if t.get('sar_visible'))} SAR-visible)")

if __name__ == "__main__":
    main()
