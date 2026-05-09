# Phase A · Migration to Unified Mob Sheet

**Goal:** Cut over from the old bound backend sheet to the unified `Mobilization_Plan - Backend` Google Sheet. After this, every login, dispatch read, active panel, etc. talks to the Mob Sheet.

**Time:** ~15 minutes total. ~5 of that is yours; the rest is Apps Script doing its thing.

**Prerequisite:** The Mob Sheet exists and you can edit it. URL: https://docs.google.com/spreadsheets/d/16nlZuencav9uB9o9Kscgmb5UvVGeKcu4e3YxqdKohiw

---

## Step 1 — Verify reference tabs exist in Mob Sheet (2 min)

Open the Mob Sheet. Look at the bottom tab bar.

**Required tabs (must exist; created by xlsx → Sheets conversion):**

- `Allowlist` — auth roster
- `Stations` — station list
- `Units` — unit list
- `Schedule` — per-NID per-day shifts (optional but used by /me)

**If `Allowlist` doesn't exist** (most likely it doesn't — it lived in the old backend sheet):

1. Click `+` at bottom to add a new sheet
2. Rename it to `Allowlist` (exact case, with capital A)
3. In row 1, paste this header row (one cell per column):

```
NID	Name	Name_AR	Role	Cluster	Station	Zone	Unit	Callsign	Mobile	Email	Active	Accommodation	Team_Lead	Team_Lead_Mobile	Notes
```

4. Format row 1 as bold (optional, for readability)

**If `Stations` doesn't exist or is empty:** create it with header row:

```
Station_Code	Station_Name	Zone	Cluster	Operational_Status	Notes
```

Add 9 station rows (ARF1, ARF2, ARF3, MUZ1, MUZ2, MUZ3, MIN1, MIN2, MIN3) plus DEPOT.

**If `Units` doesn't exist or is empty:** create it with:

```
Unit_Code	Unit_Type	Home_Station	Cluster	Notes
```

(Most likely it already exists from the xlsx — just confirm.)

**Don't worry about creating Sub_Locations, Sessions, Auth_Log, Dispatch_Log etc.** — Step 3 creates all of those automatically.

---

## Step 2 — Update the backend Apps Script (5 min)

1. Open https://script.google.com → your backend project (the one with `setupSheets`, `Allowlist`, etc. — NOT DCH'\''s PCR script)
2. Click `Code.gs` in the left sidebar
3. `⌘A` → Delete everything
4. Open https://raw.githubusercontent.com/ahmedalshudukhi/hajj-ops/main/backend/Code.gs in another tab
5. `⌘A → ⌘C` (raw view)
6. Back in Apps Script editor → `⌘V` (paste)
7. Confirm header at top says `v3: Unified Mob Sheet`. File should be ~885 lines.
8. `⌘S` to save

---

## Step 3 — Run the one-time setup (3 min)

Still in Apps Script editor:

1. At the top, find the **function dropdown** (next to ▶ Run button) → change it to `setupMobBackend`
2. Click **▶ Run**
3. **Authorization required** dialog appears (the script needs new scope to read/write Mob Sheet) → click **Review permissions**
4. Pick your Google account
5. **"Google hasn'\''t verified this app"** → click **Advanced** (small text bottom-left) → **Go to [project name] (unsafe)**
6. Permissions list including **"See, edit, create, and delete all your Google Sheets spreadsheets"** → click **Allow**
7. Function runs (~5 sec). Check the **Execution log** at bottom — should say something like:

```
=== Setup complete ===
Operational tabs created: Sessions, Auth_Log, Dispatch_Log, Dispatch_Events, Q_PCR, Reposition_Log, Reposition_Pending, Station_Status_Log, Admin_Audit_Log
Already existed: (none)
✓ All required reference tabs present
✓ Reposition auto-approve trigger ensured (every 1 min)
```

If you see `⚠ MISSING reference tabs: Allowlist, ...` go back to Step 1 and create the missing tab, then re-run. (Re-running is safe.)

If you see an error about scopes: see "If step 3 fails" at the bottom.

**Verify in the Mob Sheet:** new tabs appear at the bottom (Sessions, Auth_Log, Dispatch_Log, Dispatch_Events, Q_PCR, Reposition_Log, Reposition_Pending, Station_Status_Log, Admin_Audit_Log). Each should have a single bold dark header row.

---

## Step 4 — Redeploy web app (1 min)

Still in Apps Script editor:

1. **Deploy → Manage deployments → ✏️ pencil → Version: New version → Deploy**
2. Wait ~5 seconds
3. URL stays the same. You don'\''t need to update `assets/config.js`.

---

## Step 5 — Add yourself to the new Allowlist (2 min)

In the Mob Sheet, open the `Allowlist` tab. Add yourself as the first test row:

| NID | Name | Name_AR | Role | Cluster | Station | Zone | Unit | Callsign | Mobile | Email | Active | Accommodation | Team_Lead | Team_Lead_Mobile | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1xxxxxxxxx | Ahmed Alshudukhi | أحمد الشدخي | admin |  |  |  |  |  | 05xxxxxxxx | alshudukhi.a@gmail.com | TRUE |  |  |  |  |

(Use your real NID + real mobile so the last 4 digits work.)

If you want a second test user, add Hayil or someone else as `leadership` role on the next row.

**Important:** in the `Active` column, type literally `TRUE` (uppercase) or check the box if Sheets shows it as a checkbox.

---

## Step 6 — Smoke test (2 min)

1. Open https://hajj.shuki.tech (or whatever your domain is now)
2. Sign in with the NID + last-4 mobile you just put in Allowlist
3. Should land on `/lobby` (since you'\''re admin)
4. Open `/active` — top-right says "Live · last sync HH:MM" with green pulsing dot. Numbers all zero (no test data).
5. Open `/dispatch` — empty list, but page loads. Try creating a fake incident → it appears.
6. Check the Mob Sheet'\''s `Dispatch_Log` tab → your test row appears there.
7. Check `Sessions` tab → your active session row.

If all 6 work: migration succeeded. ✅

---

## What changed for you operationally

**Before:** Allowlist data lived in the old bound backend sheet. You edited it there manually.

**After:** Allowlist lives in the Mob Sheet. You edit it there. **Bulk staff onboarding (May 14-15) goes directly into Mob Sheet'\''s Allowlist tab.**

**Backwards compat:** the old bound backend sheet still exists but is no longer read or written by the script. Nothing in it is needed. You can leave it alone — or rename it to `_archive_2026-05-09` and forget about it.

**The PCR_Log sheet** (DCH'\''s, ID `1BnFW2D...`) is unchanged. Still owned by you. Active Insights still reads from it.

---

## If Step 3 fails

**Symptom:** "You do not have permission to call SpreadsheetApp.openById"

**Fix:** Same as the issue you hit on May 7 with DCH'\''s script. Add a tiny test function above setupMobBackend:

```javascript
function authorizeMobSheet() {
  const ss = SpreadsheetApp.openById('16nlZuencav9uB9o9Kscgmb5UvVGeKcu4e3YxqdKohiw');
  Logger.log('Connected to: ' + ss.getName());
}
```

Save → run `authorizeMobSheet` → click through the permission dialog → then re-run `setupMobBackend`.

---

## What we ship next (Phase A continues)

After this migration is verified, the next builds queue up:

| # | Item |
|---|---|
| 2 | Triage rework — Red/Yellow/Green/Black + cardiac arrest tickbox in dispatch + PCR |
| 5+16 | PCR ↔ incident auto-linking (incident_id flows from /dispatch into DCH'\''s form via URL params) |
| 1 | Optimistic UI — fixes the 5-second click lag |
| 12 | 72h sessions (already in v3 backend — frontend session timer needs updating) |
| 15 | Date-aware tempo schedule (refresh rates auto-adjust by Hajj phase) |
| 3+4 | Q-PCR redesign — 2-form split, Nusuk patient ID, top-30 complaints |
| 13 | /admin page — manage Allowlist, view audit log, manual sync trigger |
| 14 | Bulk credential one-pager (EN+AR docx for distribution) |

Each ships as a separate commit. You re-deploy frontend (auto via Cloudflare) and backend (manual paste) as we go.
