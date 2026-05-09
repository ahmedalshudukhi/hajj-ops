# HMG Field Operations Platform — Plan (Working Draft)

**Status:** Draft v0.1 · Working document · Updated 2026-05-07
**Owner:** Ahmed Alshudukhi
**Scope:** Roadmap from Hajj 2026 dashboard → HMG-wide field operations platform

---

## 1. The scope shift

**What we built:** Hajj 2026 dashboard. 276 staff, 7 days, single event, single tenant. Spreadsheet-backed. Apps Script glue. Cloudflare static hosting. Built fast to ship.

**Where it goes:** HMG-wide field operations platform. Multi-event, multi-year, multi-site. AMS daily ops, future Hajj years, GACA terminals, RX flight ops, AlBustan, Andorra, eventually any HMG service touching field/event medicine. Hundreds of users, hundreds of thousands of records, clinical-grade audit trail, integrated with HMG's existing systems.

These are different products. The Hajj prototype gets us the workflows, the UX patterns, the operational learning. None of the storage, auth, or backend layer survives unchanged into the platform version.

---

## 2. Principles for "world class"

| Trait | Why |
|---|---|
| Real auth, real audit | Every clinical action attributable to a person, every state change logged forever. NID + last-4 isn't a password, it's a placeholder. |
| Mobile-first, offline-capable | Paramedics work in basements, garages, ambulances. Dispatch can't fail when the connection drops. |
| FHIR-aligned clinical data | Encounter, Patient, Observation, Procedure, Medication. Not arbitrary JSON in a sheet. Lets us integrate with any EMR later, including HMG's. |
| Multi-tenant from the model up | One platform, isolated data per service line. Same architecture serves Hajj 2026, AME, RX iqama, AlBustan — without forking. |
| Realtime by default | Push, not 5-second polling. State changes propagate to every connected device in <1s. |
| Saudi-native compliance | NHIC standard, NPHIES claims when applicable, audit logs sufficient for MoH/SCFHS scrutiny, data residency in-Kingdom if required. |
| Operational analytics built in | Response time distributions, station load, augmentation effectiveness, encounter trends. KPIs a CMO wants to see, not bolt-on. |
| Vendor-flexible | No Google Sheets lock-in. Reproducible from source, deployable anywhere if HMG IT mandates Azure/AWS/on-prem. |

---

## 3. Architecture target (Stage 2)

```
CLIENTS
  Web (mgmt) · PWA (field) · Native (later) · Big-screen kiosk
                          ↓
                  HTTPS · WSS · auth via SSO/OAuth
                          ↓
                  EDGE GATEWAY
                  Cloudflare Workers (Hono)
                  • Auth · Rate limit · Tenant resolution · Logging
                          ↓
              REST/RPC          WebSocket (live)
                          ↓
                  CORE SERVICES
                  Identity · Roster · Dispatch · Clinical · Notifications · Reporting
                          ↓
              Postgres   ·   R2 (files)   ·   Queue   ·   ML (optional)

EXTERNAL (Stage 3+)
  ↕ HMG EMR (FHIR R4)
  ↕ NPHIES (claims)
  ↕ MoH PHR (Sehhaty)
  ↕ SRCA (live handoff)
  ↕ HMG SSO (Azure AD)
  ↕ HMG Smartsheet (project tracking — kept as is)
```

### Concrete tech (defendable, not the only options)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Astro + React/Svelte islands | SEO, fast load, simple build, escape valve to SPA |
| Mobile | PWA → Capacitor wrapper | One codebase, offline storage via IndexedDB, push, App Store later |
| Edge | Cloudflare Workers + Hono | Already on CF, edge runtime, no cold start |
| API | REST + WebSocket; tRPC if all-TS | Boring, integrable, well-understood |
| Database | Postgres on Neon (or Supabase) | Real RDBMS, FHIR maps cleanly, mature tooling. CF D1 (SQLite) limits clinical workloads. |
| Object storage | Cloudflare R2 | S3-compatible, no egress fees |
| Realtime | Cloudflare Durable Objects OR Pusher | DO is in-stack, Pusher is easier to start |
| Auth | Clerk OR Auth0 OR Lucia + HMG SAML/OIDC | Clerk fastest; Auth0 if HMG IT has standards |
| Background jobs | Cloudflare Queues + cron | Email, daily reports, exports |
| Search | Postgres FTS first; Vectorize/Typesense later | Don't over-engineer |
| Observability | Sentry + CF Analytics + structured logs to R2/BigQuery | Errors, perf, audit |
| CI/CD | GitHub Actions + branch deploys | Already there |
| IaC | Terraform OR Wrangler config | Reproducibility |

---

## 4. Roadmap

### Stage 1 — Hajj 2026 (now → 9 June 2026)
**Goal:** Operate. Don't break what works. Capture learnings.

- HA fixes (DNS bypass, redundant internet, paper backup)
- Add Sentry for error tracking
- Add Cloudflare Workers Analytics dashboard
- Daily snapshot of Sheets to GitHub repo (`data-snapshots/2026-05-30.json`)
- Operate, log everything, write down every painful moment
- **Do NOT replatform during Hajj.** Stability > improvement.

**Deliverable:** Hajj operates. Post-event retrospective doc with quantified pain points.

### Stage 2 — Foundation (10 June → 30 Sep 2026)
**Goal:** Replatform from Sheets/Apps Script to proper architecture. Same UX, real backend.

- New repo: `hmg-medops` (private). Old `hajj-ops` becomes a tagged release.
- Postgres schema: tenants, users, roles, roster, schedule, incidents, events, encounters, audit_log
- API service on CF Workers (Hono) — REST for CRUD, WS for live
- Auth: ship with email-password + TOTP; SSO deferred to Stage 3 unless HMG IT engages early
- Migrate `/me`, `/dispatch`, `/active`, `/lobby` to call new API. Frontend mostly unchanged.
- Migrate Hajj 2026 data into the schema as a "frozen tenant"
- New tenants: `ams-daily`, `hajj-2027`
- Reporting layer (basic): canned reports, CSV exports, scheduled emails
- Compliance baseline: audit log, retention policy, backup/restore procedure
- Move domain to `medops.hmg.[domain]` — out of personal space

**Deliverable:** Working platform at HMG domain, AMS team using it for daily ops. Hajj 2026 archived as a tenant.

### Stage 3 — Productize (1 Oct → 31 Dec 2026)
**Goal:** Real product, real users, integration starting.

- PWA: install banner, offline mode for `/me` and `/dispatch` queue, push notifications
- Encounter (Q-PCR replacement): FHIR-aligned data model, configurable form templates per tenant
- HMG SSO integration (Azure AD)
- Operational reports configurable in-app; scheduled email digests for leadership
- Multi-language: full Arabic UI, RTL polish
- Audit dashboard (admin-only)
- Tenants for AME Services, RX Iqama, possibly RX Class 3
- Branding aligned with HMG visual identity

**Deliverable:** Platform usable by HMG operations staff for daily ops, not just emergencies.

### Stage 4 — Scale & integrate (Q1 2027+)
**Goal:** Embedded in HMG IT estate.

- HMG EMR integration (FHIR R4 read/write)
- NPHIES claim flow if billable
- SRCA live handoff (when policy permits)
- Native mobile app (Capacitor wraps PWA)
- Operational forecasting: ML model predicts response time given station/time/movement
- Dedicated HMG IT operational ownership; Ahmed transitions builder → architect

**Deliverable:** Platform is one of HMG's named clinical systems.

---

## 5. Decisions to make now

These shape Stage 2. Cheaper to answer now than later.

1. **Brand & ownership.** Ahmed-led initiative, or HMG-owned project with a named sponsor (CMO, IT director)?
2. **Hosting.** Stay Cloudflare across the board, or HMG IT mandates Azure / AWS / on-prem?
3. **Database.** Neon Postgres (cheap, serverless, fine for years) vs HMG-internal SQL Server (DBA team ownership)?
4. **Auth.** Quick win Clerk/Auth0; long term Azure AD SSO via OIDC. What's HMG's identity provider?
5. **Compliance scope.** Operational only (low bar) or clinical PHI (high bar — NHIC alignment, audit grade, retention rules, breach notification)?
6. **Resource model.** Solo iterating, or HMG dev/IT resources to engage?
7. **Budget envelope.** Free tier → ~$50/mo → ~$500/mo → enterprise contracts. What range?
8. **Naming.** "HMG MedOps" / "HMG Field Operations" / "HMG Ops Platform" / something else?
9. **First post-Hajj tenant.** AMS daily ops (broadest test) / AME Services (highest-value clinical workflow) / Hajj 2027 (most familiar)?
10. **Risk on Hajj 2026.** Ship as-is and observe, or harden anything specific first?

---

## 6. This week (independent of decisions)

1. Fix the homelab DNS issue (10 min)
2. Add Sentry to current site (1 hour)
3. Set up daily snapshot of all sheets to GitHub (30 min — GitHub Action)
4. Decide on a name + grab domain (`medops.hmg.com.sa` or similar)
5. Pick 2 colleagues from HMG IT to brief on this plan when ready

---

## 7. Open questions

These need exploration over the next 6 weeks but don't block Stage 1:

- Does HMG IT have a preferred cloud provider? Azure / AWS / GCP / on-prem?
- Does HMG have an existing identity system we'd integrate with (Azure AD likely)?
- What's HMG's EMR? (Determines Stage 4 integration shape — Cerner/Epic/InterSystems/homegrown?)
- Is there a HMG IT security review process for new internal tools? When does it engage?
- Are there competing internal initiatives we should align with (avoid building parallel solutions)?
- Can we get a dedicated HMG subdomain for the platform, or do we host on a separate domain?
- Data residency: must clinical data stay in-Kingdom? (Affects Cloudflare/Neon decisions — both have regional options)
- NHIC certification: required, or only for billable clinical encounters?

---

## Appendix A — Why not just make the Apps Script bigger

Apps Script is fine for prototypes. It is NOT fine for an HMG-wide system because:

1. **Execution limits.** 6-min per request, 90-sec URL fetch, 30-sec response timeout. Real workloads break these.
2. **Quota limits.** 100k URL fetches/day, 20k email recipients/day, 6h/day total runtime. A multi-tenant system burns this fast.
3. **No real concurrency control.** Two simultaneous writes to the same Sheet row can corrupt data. Sheets locking is per-spreadsheet not per-row.
4. **No real schema.** Sheet "columns" aren't typed, can't enforce constraints, can't index for queries.
5. **No transactions.** Can't atomically update 3 sheets in one operation.
6. **Auth is hand-rolled.** No SSO, no MFA framework, no session management primitives.
7. **Not auditable to clinical standards.** Apps Script logs are kept ~30 days, no immutable append-only guarantees.
8. **Vendor lock-in.** All your data in Google Sheets. No portability.
9. **Compliance dead-end.** No realistic path to NHIC certification, NPHIES integration, or MoH PHR.
10. **Performance ceiling.** Reading a 50K-row sheet via Apps Script takes seconds, not milliseconds.

For Hajj 2026 (276 staff, 7 days, low write volume) it's adequate. For HMG-wide (thousands of users, year-round) it isn't.

---

## Appendix B — What survives unchanged from the prototype

A lot of work is reusable:

- **All HTML/CSS** for `/me`, `/dispatch`, `/active`, `/lobby` — frontend is decoupled from backend, swap the API URL and we're 80% there
- **UX patterns** — the dispatch card flow, the active insights panels, the role-based nav, the lobby tile pattern
- **Domain knowledge** — operational schemas (Mobilization, Augmentations, Hourly Grid), incident lifecycle (en-route → on-scene → patient-contact → decision → transfer)
- **Q-PCR field structure** — DCH's form has the right fields for a clinical encounter, just needs a real backing data model
- **Auth UX** — NID + last-4 stays as the field-paramedic flow; office staff get SSO additionally
- **The whole Hajj 2026 dataset** — migrated into Stage 2 as a frozen historical tenant, queryable for retrospective analysis

What gets thrown away:

- Apps Script backend code
- Direct Google Sheets reads/writes
- Custom JSON-in-a-cell encoding

---

*End of Working Draft v0.1.*
