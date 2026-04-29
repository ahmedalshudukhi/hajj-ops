# Hajj 1447 — Operations Dashboard

Live operations dashboard for SAR MMMP-SL Hajj 2026 medical mobilization.

- **Data source:** Google Drive · `Mobilization_Plan.xlsx`
- **Build pipeline:** GitHub Actions → `build.py` → `data.json`
- **Hosting:** Cloudflare Pages
- **Auth:** Cloudflare Access (email OTP)
- **Refresh:** every 30 minutes

---

## Architecture

```
[Team edits Mobilization_Plan.xlsx in Google Drive]
        ↓
[GitHub Actions cron every 30 min]
        ↓
[build.py downloads xlsx, parses 13 tabs, writes data.json]
        ↓
[git commit + push to repo]
        ↓
[Cloudflare Pages auto-deploys on push]
        ↓
[hajj.shuki.tech — gated by Cloudflare Access]
```

The Google Sheet is publicly viewable (read-only) so the build pipeline can fetch it without auth. Editing requires explicit team-member share with editor role.

---

## Files

- `index.html` — single-page mega-dashboard (all rendering, charts, filters)
- `data.json` — last-built snapshot of all aggregates from Google Drive xlsx
- `build.py` — pipeline: download xlsx → compute aggregates → write data.json
- `requirements.txt` — Python deps (just openpyxl)
- `.github/workflows/refresh.yml` — cron job

---

## Deployment

### 1. Push to GitHub (private repo recommended)

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

### 3. Cloudflare Pages

1. Cloudflare Dashboard → Pages → "Connect to Git"
2. Pick the `hajj-ops` repo → main branch
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `/`
4. Deploy

### 4. Custom domain

Pages → your project → Custom Domains → Add `hajj.shuki.tech`. CNAME auto-configures since shuki.tech is on Cloudflare.

### 5. Cloudflare Access

Zero Trust → Access → Applications → "Add an application" → Self-hosted

- Name: `Hajj Ops Dashboard`
- Domain: `hajj.shuki.tech`
- Identity providers: One-time PIN (email OTP)
- Policies → "Add policy":
  - Name: `Team`
  - Action: Allow
  - Include: Emails → `ahmed.alshudukhi@drsulaimanalhabib.com` + every team member email

Save. Visiting `hajj.shuki.tech` now requires email verification.

---

## Local development

```bash
pip install -r requirements.txt
python build.py
python -m http.server 8000
# Open http://localhost:8000
```

---

## Changing the Drive file

If you replace `Mobilization_Plan.xlsx` with a new version (different file ID):

1. Update `DEFAULT_FILE_ID` in `build.py`
2. Commit, push — workflow auto-runs

OR set the `GDRIVE_FILE_ID` env var in the GitHub Action without code change:

```yaml
- name: Build
  env:
    GDRIVE_FILE_ID: NEW_ID_HERE
  run: python build.py
```

---

## Cron frequency

Default: every 30 min (`*/30 * * * *` = 1,440 builds/month).

GitHub free tier gives 2,000 Actions minutes/month. Each run takes ~30s, so 1,440 × 0.5 = 720 min/month — well under quota.

During Hajj week (May 25–30 2026) you may want to bump this to every 5 min (`*/5 * * * *`). Edit `.github/workflows/refresh.yml`.

---

## Troubleshooting

**Dashboard shows "DATA UNAVAILABLE":** `data.json` failed to load. Check the latest GitHub Actions run for errors.

**Numbers all zero:** Drive download failed silently. Verify the Sheet is still set to "Anyone with the link / Viewer".

**Stale data:** The build runs every 30 min. Hard-refresh the browser (Cmd+Shift+R) to bypass Cloudflare cache. Or trigger workflow manually from Actions tab.

**Hourly chart empty:** A movement filter returned no rows. Reset to "All Operations".
