# Hajj 1447 — Operations Dashboard

Live operations dashboard for SAR MMMP-SL Hajj 2026 medical mobilization.

- **Data source:** Google Drive · `Mobilization_Plan.xlsx` (v11.8)
- **Build pipeline:** GitHub Actions → `build.py` → `data.json`
- **Hosting:** Cloudflare Pages with Functions
- **Auth:** Cloudflare Access (email OTP)
- **Refresh:** every 30 minutes
- **Public API:** `/api/v1/*` (CORS-enabled, edge-cached)
- **PCR connection:** Google Apps Script integration

---

## Architecture

```
[Team edits Mobilization_Plan.xlsx in Google Drive]
        ↓
[GitHub Actions cron every 30 min]
        ↓
[build.py downloads xlsx, parses 18 tabs, writes data.json]
        ↓
[git commit + push to repo]
        ↓
[Cloudflare Pages auto-deploys + _worker.js boots]
        ↓
[hajj.shuki.tech — static dashboard + /api/v1/* + PCR proxy]
        ↓
[Optional: Google Apps Script reads PCR sheets → dashboard]
```

The Google Sheet is publicly viewable (read-only) so the build pipeline can fetch it without auth. Editing requires explicit team-member share with editor role.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page mega-dashboard — 18 tabs, charts, themes, mobile responsive |
| `_worker.js` | Cloudflare Pages Function — exposes `/api/v1/*` JSON endpoints + PCR proxy |
| `data.json` | Last-built snapshot of all aggregates from Google Drive xlsx |
| `tasks.json` | Smartsheet Master_Tasks export (built by `build_tasks.py`) |
| `build.py` | Pipeline: download xlsx → compute aggregates → write data.json |
| `build_tasks.py` | Pipeline: read Smartsheet → write tasks.json |
| `gas-template.gs` | Google Apps Script template for PCR/Census integration |
| `api-docs.html` | Public API documentation page |
| `requirements.txt` | Python deps (just openpyxl) |
| `.github/workflows/refresh.yml` | Cron job |

---

## Features (v11.8)

- **Single-channel SAR comms** — patient-safety-first design baked into the Live OCC view
- **Light + dark theme** — toggle in nav bar, persists in localStorage
- **Mobile responsive** — works on phones for field use (768px and 480px breakpoints)
- **Live OCC view** — real-time op snapshot with station fill bars and next-movement card
- **PCR & Census tab** — pulls patient encounters from your own Google Sheets via GAS
- **JSON API** (`/api/v1/*`) — public read API for any external integration
- **Settings modal** — configure GAS endpoint and refresh rate per-user
- **Print-optimized** — any tab prints cleanly for briefings
- **18 tabs** — Home, Live OCC, PCR, Calendar, Mobilization, Hourly, Day View, Schedule, Roster, Stations, Units, Ambulances, Augmentations, Org & Assets, Timeline, Staffing, Insights, Tasks

---

## Public API

Base URL: `https://hajj.shuki.tech/api/v1/`

| Endpoint | Returns |
|---|---|
| `GET /api/v1/health` | service status, version, build |
| `GET /api/v1/personnel` | staff totals, breakdown by role |
| `GET /api/v1/units` | all 138 operational units |
| `GET /api/v1/stations` | 9 clinical sites + OCC |
| `GET /api/v1/movements` | augmentation movements |
| `GET /api/v1/ambulances` | 25 ALS ambulances by station |
| `GET /api/v1/calendar` | hajj day calendar |
| `GET /api/v1/snapshot` | full data.json |
| `GET /api/v1/pcr/proxy?url=…&endpoint=…` | server-side proxy to GAS |

All responses CORS-enabled, edge-cached for 60s. Full docs at `/api-docs.html`.

---

## Connecting PCR & Patient Census (Google Apps Script)

The PCR & Census tab reads from your own Google Sheets via a GAS web app you deploy.

### One-time setup

1. **Open** [script.google.com](https://script.google.com) → New project
2. **Paste** the contents of `gas-template.gs` as `Code.gs`
3. **Update** `PCR_SHEET_ID` and `CENSUS_SHEET_ID` constants at the top
4. **Deploy** → New deployment → Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (or "Anyone with Google account" if you require auth)
5. **Copy** the Web App URL (looks like `https://script.google.com/macros/s/.../exec`)
6. **Open** the dashboard → click **⚙ settings** in nav bar
7. **Paste** the URL into "Google Apps Script endpoint" → **Save**
8. **Click** the **PCR & Census** tab — encounters and census now flow live

### Sheet structure expected

PCR sheet (first tab):

| Column | Field |
|---|---|
| A | Encounter ID |
| B | Timestamp |
| C | Station (ARF1/MUZ2/MIN3 etc) |
| D | Patient ID |
| E | Age |
| F | Gender |
| G | Chief Complaint |
| H | Acuity (Critical/Urgent/Standard/Minor) |
| I | Disposition |
| J | Treating Unit |
| K | Notes |

Census sheet (tab named "Census"):

| Column | Field |
|---|---|
| A | Station |
| B | Active patients |
| C | Total seen today |
| D | Last updated |

Auto-refreshes every 30s (configurable in Settings, 10–600s).

---

## Theming

Theme toggle (☀/◐) in nav bar switches between light and dark. Setting persists in localStorage per-browser. CSS variables drive everything — to add a new theme, set `[data-theme="custom"]` overrides in the stylesheet.

---

## Deployment

### 1. Push to GitHub

```bash
cd hajj-ops
git init
git add .
git commit -m "Initial dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/hajj-ops.git
git push -u origin main
```

### 2. Enable GitHub Actions (auto)

Workflow runs on schedule. Manually trigger first run via Actions tab → "Refresh dashboard data" → "Run workflow".

### 3. Cloudflare Pages with Functions

1. Cloudflare Dashboard → Pages → "Connect to Git"
2. Pick the `hajj-ops` repo → main branch
3. Build settings: Framework: **None**, Build command: blank, Output: `/`
4. Deploy — `_worker.js` is auto-detected and used as a Function

### 4. Custom domain

Pages → your project → Custom Domains → Add `hajj.shuki.tech`.

### 5. Cloudflare Access

Zero Trust → Access → Applications → "Add an application" → Self-hosted, gate `hajj.shuki.tech` behind email OTP. The `/api/v1/*` endpoints are served on the same domain so they inherit the Access policy — exclude API paths if you want public read access:

In Access policy → Path includes: only `/` and `/data.json`, exclude `/api/*` if you want public API.

---

## Local development

```bash
pip install -r requirements.txt
python build.py
python -m http.server 8000
# Open http://localhost:8000
```

To test the worker locally, use wrangler:

```bash
npm install -g wrangler
wrangler pages dev .
```

---

## Versioning

Current schema: **v11.8** (locked 5 May 2026)

| Version | Change |
|---|---|
| v11.6 | Initial 11-site model |
| v11.7 | SRCA dropped (10 sites), Supervisors 8→6 |
| **v11.8** | Romeo Solo-49 added, mandate paramedics = 250 exact, OCC accommodation phrasing finalized |

API contract changes will publish under `/api/v2/*` when needed.

---

## Troubleshooting

**Dashboard shows "DATA UNAVAILABLE":** `data.json` failed to load. Check the latest GitHub Actions run for errors.

**PCR tab shows "NOT CONFIGURED":** No GAS URL set in Settings. Open ⚙ settings and paste your deployed Web App URL.

**PCR tab shows "FAILED":** GAS endpoint reachable but returned an error. Check Apps Script execution log; common causes are wrong sheet IDs or "Anyone" access not set on deployment.

**Theme keeps reverting:** localStorage being cleared by browser settings. Try a different browser or check privacy settings.

**Mobile layout broken on iPad in landscape:** iPad in landscape uses desktop layout intentionally; rotate to portrait for mobile layout, or use the desktop view.

**Stale data:** Build runs every 30 min. Hard-refresh (Cmd+Shift+R) to bypass cache. Trigger workflow manually from Actions tab for immediate refresh.
