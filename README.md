# Hajj Ops Dashboard — Deployment Guide

A live operations dashboard for the SAR Hajj 2026 MMMP-SL project. Reads from Smartsheet, displays at `hajj.shuki.tech`, auto-refreshes every 15 minutes.

---

## Architecture

```
Smartsheet (Hajj 2026 / SAR)
     │
     │  smartsheet-python-sdk (read-only)
     ▼
GitHub Actions cron (every 15 min)
     │
     │  runs build.py → regenerates data.json
     ▼
GitHub repo (main branch)
     │
     │  push triggers Cloudflare Pages auto-deploy
     ▼
Cloudflare Pages → hajj.shuki.tech
     │
     │  Cloudflare Access (email OTP auth)
     ▼
Your team
```

**Why this stack:** Smartsheet stays as the source of truth (your team edits there). The dashboard is read-only — pure visualization. Data refreshes via cron, not on every page load, so the dashboard is fast and Smartsheet's API rate limits are never a concern.

---

## Files in this repo

| File | Purpose |
|------|---------|
| `index.html`                    | The dashboard. Loads `data.json` at runtime. |
| `data.json`                     | Generated data file. Refreshed by `build.py`. |
| `build.py`                      | Pulls Smartsheet → writes `data.json`. |
| `requirements.txt`              | Python deps (smartsheet-python-sdk). |
| `.github/workflows/refresh.yml` | Cron job: runs `build.py` every 15 min, commits data changes. |
| `README.md`                     | This file. |

---

## One-time setup (~15 min)

### 1. Get a Smartsheet API token

1. Go to https://app.smartsheet.com/b/personalsettings (Personal Settings)
2. Click **API Access** in the sidebar
3. Click **Generate new access token**
4. Name it `hajj-ops-dashboard`, copy the token (shown once only)

> **Permissions:** This token has read-write access to all sheets you can access. The dashboard only reads, but Smartsheet doesn't offer read-only tokens. Keep it secret.

### 2. Push this repo to GitHub

```bash
cd hajj-ops
git init
git add .
git commit -m "Initial dashboard"
gh repo create hajj-ops-dashboard --private --source=. --push
```

Or use GitHub web: create a new private repo, drag-drop these files.

### 3. Add the API token as a GitHub secret

1. Repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `SMARTSHEET_TOKEN`
4. Value: paste the token from step 1
5. Save

### 4. Test the build manually

In repo → **Actions** → "Refresh dashboard data" → **Run workflow**.
After ~30 seconds, check that `data.json` was committed. If not, see Troubleshooting below.

### 5. Connect Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. Authorize Cloudflare to access your GitHub
3. Select the `hajj-ops-dashboard` repo → **Begin setup**
4. Project name: `hajj-ops` (or anything)
5. Production branch: `main`
6. Framework preset: **None**
7. Build command: leave empty
8. Build output directory: `/`
9. **Save and Deploy**

After ~1 minute, you'll get a URL like `hajj-ops.pages.dev`. Test that it works.

### 6. Add the custom domain `hajj.shuki.tech`

1. In your Pages project → **Custom domains** → **Set up a custom domain**
2. Enter `hajj.shuki.tech`
3. If `shuki.tech` is on Cloudflare DNS, the CNAME record auto-creates. Confirm.
4. Wait 1-2 min for SSL to provision. Done.

> If `shuki.tech` is NOT on Cloudflare DNS, you'll need to add a CNAME record at your DNS provider:
> `hajj.shuki.tech` → `hajj-ops.pages.dev`

### 7. Lock it down with Cloudflare Access (the auth step)

1. Cloudflare Dashboard → **Zero Trust** → if first time, accept the free plan signup
2. **Access** → **Applications** → **Add an application** → **Self-hosted**
3. Application name: `Hajj Ops`
4. Domain: `hajj.shuki.tech`
5. **Next** → **Add a policy**
6. Policy name: `Team`
7. Action: **Allow**
8. Configure rules → **Include** → **Emails** → list each team member's email:
   - `ahmed.alshudukhi@drsulaimanalhabib.com`
   - `bukhari@...`
   - `etc.`

   Or use **Emails ending in** to allow your whole company domain (e.g. `@drsulaimanalhabib.com`).

9. **Next** → keep defaults → **Add application**

Now when anyone visits `hajj.shuki.tech` they'll see a Cloudflare login screen, enter their email, get a 6-digit code emailed to them, and access for 24h. Then they're prompted again.

---

## Daily use

- **Team edits data in Smartsheet.** Update Status, Person 1/2, etc. as normal.
- **Dashboard auto-refreshes** every 15 minutes via the GitHub Actions cron.
- **Manual refresh:** Repo → Actions → "Refresh dashboard data" → "Run workflow"
- **No code changes ever needed** — the dashboard adapts to whatever's in your sheets.

---

## Local testing

```bash
# Install deps
pip install -r requirements.txt

# Set token
export SMARTSHEET_TOKEN="your_token_here"

# Refresh data
python build.py

# Serve locally
python -m http.server 8080
# Open http://localhost:8080
```

---

## Customization

### Change refresh frequency

Edit `.github/workflows/refresh.yml`:

```yaml
schedule:
  - cron: '*/5 * * * *'   # every 5 min during peak ops
  # - cron: '0 */1 * * *' # every hour
  # - cron: '0 6 * * *'   # daily at 06:00 UTC
```

### Change who has access

Cloudflare Zero Trust → Access → Applications → Hajj Ops → Policies → edit the email list.

### Adjust dashboard layout

`index.html` is one self-contained file. Edit and push — Cloudflare auto-deploys in ~30 sec.

### Add new movements / phases / sections

Edit `build.py` and `index.html`. The dashboard reads whatever shape `data.json` has.

---

## Troubleshooting

**GitHub Action fails with "401 Unauthorized"**
Token expired or wrong. Regenerate in Smartsheet, update the GitHub secret.

**Dashboard shows "DATA UNAVAILABLE"**
`data.json` failed to load. Check browser console. Most likely: `data.json` doesn't exist yet. Run the workflow once manually.

**Cloudflare Access asks for login but the email never arrives**
Check spam folder. If still missing: Zero Trust → Logs → Access → see if the request was logged. If not, the domain isn't pointing to Cloudflare correctly.

**Custom domain `hajj.shuki.tech` shows certificate error**
Wait 5-10 min after adding the domain. Cloudflare provisions SSL automatically but it takes a few minutes.

**The dashboard data doesn't update**
Check GitHub Actions tab — see if the cron is running. The workflow only commits if `data.json` actually changed (no commit = no rebuild). To force: manually trigger the workflow.

**Smartsheet rate limit errors**
The free tier allows 300 requests/minute. `build.py` makes ~8 requests per run. With cron every 15 min that's ~32 req/hour. Well under the limit. If you hit it, slow the cron.

---

## Costs

- **Cloudflare Pages:** Free up to 500 builds/month and unlimited bandwidth. We use ~96 builds/day = ~2,880/month with 15-min cron. **Need to slow to every 30 min for free tier**, OR upgrade to Pages Pro ($20/mo for unlimited builds). Easier: change cron to `*/30 * * * *` (every 30 min) = 1,440 builds/month, well under the limit.
- **Cloudflare Access:** Free up to 50 users.
- **GitHub Actions:** Free for public repos, 2,000 min/month for private. Each refresh takes ~30 sec, so 2,880 refreshes/month = 1,440 min. Right at the limit. Same fix: use 30-min cron.
- **Smartsheet API:** Already paid via your Enterprise plan.

**Recommendation:** Set cron to `*/30 * * * *` (every 30 min) for normal operations. Switch to `*/5 * * * *` only during the actual Hajj operations week (June 3-9, 2026) when real-time matters.

---

## Security notes

- Smartsheet token never appears in client code. It only lives in:
  1. Your local environment variable
  2. GitHub repo secrets (encrypted at rest)
- `data.json` is public-readable from the dashboard, but the dashboard URL is gated by Cloudflare Access, so unauthenticated users can't reach it.
- The repo can be private. Cloudflare Pages reads it via authorized integration, no public exposure.
- All staff PII (names, IDs from Staff_Assignment) ends up in `data.json` — this is why the auth gate matters. Keep it locked.

---

## Contact

Project owner: Ahmed Alshudukhi
Domain: shuki.tech
Built: April 2026
