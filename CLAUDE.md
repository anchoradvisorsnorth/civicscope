# CLAUDE.md — CivicScope Working Memory

## Who I'm Working With
- **Keith Plummer** — keith@anchoradvisorsnorth.com
- Wears multiple hats: JBK Development (day job), CivicScope (product), AAN/MTP (side project)
- Microsoft shop, PowerShell-oriented, deploys via bat/ps1 → GitHub API → Vercel

## Key Terms
- **JBK** = JBK Development (sister to RYC & T&C)
- **RYC** = R Yoder Construction (parent company of JBK) — mid-size commercial GC
- **T&C** = Town & Country Homes
- **Joe** = Director of Field Operations at RYC (manages crew scheduling)
- **Frannie** = RYC front office (was manually updating employee portal — unreliable)
- **BOT** = Build-Operate-Transfer (municipal dev model)
- **P3** = Public-Private Partnership
- **AAN** = Anchor Advisors North (umbrella brand)
- **MTP** = My Trust Plan (lead gen for RLTs)
- **RLT** = Revocable Living Trust
- **Wellfield** = Wellfield Botanic Gardens (JBK project, Elkhart IN)

## CivicScope Product Suite (4 versions + QA + RYC Tools)
All CivicScope AI tools call same `api/claude.js` proxy → Anthropic claude-sonnet-4-20250514

| Version | URL | Audience |
|---------|-----|----------|
| Free | app.civicscope.io/civicscope | Municipal employees |
| Pro | app.civicscope.io/civicscope-pro | Municipal (SaaS potential) |
| GC White-Label | app.civicscope.io/gc/:slug | GC's prospective clients |
| GC Internal | app.civicscope.io/gc/:slug-internal | GC estimating teams |
| QA Tool | app.civicscope.io/qa | Headless validation (Keith only) |
| Admin | app.civicscope.io/admin | Dashboard (Keith only) |
| **RYC Scheduler** | **app.civicscope.io/ryc/schedule** | **RYC field crew scheduling** |

## RYC Scheduler (v1 — deployed March 2026)

### What It Solves
Old process: Joe updates Excel → tells Frannie → Frannie updates employee portal → crew checks portal. Broke because Frannie didn't update; Joe had to call guys directly. New process: Joe updates scheduler directly → hits Publish → crew gets email automatically.

### URLs
- **Manager view**: https://app.civicscope.io/ryc/schedule (password: `ryc2026`)
- **Read-only view**: https://app.civicscope.io/ryc/schedule?view=readonly (no password, linked from emails)
- **Week-specific**: ?view=readonly&week=YYYY-MM-DD

### Architecture
- Single-page HTML app with password gate (sessionStorage)
- Data stored in browser localStorage (prototype — Supabase persistence is a future enhancement)
- Email via `api/schedule-notify.js` → Resend (uses existing RESEND_API_KEY env var)
- Sends from: `R. Yoder Construction <info@civicscope.io>`, reply-to: keith@anchoradvisorsnorth.com

### Email Flows
1. **Weekly publish**: Joe fills schedule → hits "Publish Week" → ALL employees + notification-only recipients get email with full schedule table + link to read-only view
2. **Mid-week change**: Joe edits after publish → hits "Publish Week" again → ONLY affected employees get email showing what changed (old → new) + link to read-only view

### Features
- Employee management: first/last name, auto-generated email @ryoderconstruction.com, manual override
- Three manage tabs: Employees, Projects, Notification List (notify-only recipients)
- Role badges: SR SS, SS, SSIT, FC, FM (color coded)
- Special assignments: VAC (amber), Training (purple), Shop (green)
- Recipient preview before sending

### Files in Repo
- `ryc-schedule/index.html` — Full scheduler app
- `api/schedule-notify.js` — Resend email endpoint for schedule notifications
- `vercel.json` — Has `/ryc/schedule` rewrite pointing to `ryc-schedule/index.html`

### Local Files (Keith's machine)
- `RYC/scheduler/index.html` — Source file
- `RYC/scheduler/api/schedule-notify.js` — Source API file
- `RYC/scheduler/PUSH_RYC_SCHEDULE.bat` — Isolated deploy (does NOT touch CivicScope product files)
- `RYC/scheduler/push_ryc_schedule.ps1` — PowerShell deploy script
- `RYC/scheduler/DEPLOY_NOTES.md` — Deploy reference

### Deploy
- **PUSH_RYC_SCHEDULE.bat** — Separate from PUSH_CIVICSCOPE.bat, zero risk to civicscope.io
- Pushes only: ryc-schedule/index.html + api/schedule-notify.js
- Known issue: PS1 regex for auto-injecting vercel.json route failed on first run — was fixed manually on GitHub. Regex needs fixing for future deploys.

### RYC vs Acme — IMPORTANT
- **Acme** = demo GC tenant in CivicScope GC white-label (stays as demo)
- **RYC** = will be the FIRST REAL GC tenant in CivicScope GC white-label (onboarding deferred to backlog)
- The RYC Scheduler is a standalone tool, separate from the GC white-label product

## Infrastructure
- **Hosting**: Vercel (auto-deploy from GitHub)
- **Repo**: anchoradvisorsnorth/civicscope (GitHub)
- **DB**: Supabase (sessions, tool_runs, leads, tenants) — raw fetch, NOT @supabase/supabase-js
- **Email**: Resend (info@civicscope.io)
- **Deploy**: Cowork edits files → PUSH_CIVICSCOPE.bat → GitHub Trees API → Vercel (~60s)
- **RYC Deploy**: PUSH_RYC_SCHEDULE.bat → isolated push of scheduler files only
- **Sandbox**: START_SANDBOX.bat → Python server at localhost:8888 (legacy — pre-Cowork workflow, keep for risky changes)
- **Model**: claude-sonnet-4-20250514

## Dev Workflow (as of March 2026)
Cowork mode replaced project chat + sandbox as the primary workflow.
- **Cowork** reads/edits local files directly in the civicscope folder
- **Keith** runs PUSH_CIVICSCOPE.bat to deploy CivicScope, PUSH_RYC_SCHEDULE.bat to deploy RYC scheduler
- **QA tool** at /qa validates on production (no sandbox needed for routine changes)
- **Sandbox** retained for edge cases — testing risky changes before they hit prod

## Current Versions
- Free: v1.5.0
- Pro: v2.3.0
- GC White-Label External: v1.3.0-gc
- GC White-Label Internal: v1.1.0-gc-int
- QA Tool: v1.0.0-qa
- Admin: v1.0.0-admin
- RYC Scheduler: v1.0.0

Note: Versions are hardcoded in each HTML file footer AND in civicscope-admin/index.html product cards. Bump both on every release.

## Vercel Env Vars
ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY

## Recent Changes (March 2026)
- **RYC Scheduler v1**: Built and deployed crew scheduling tool for RYC at /ryc/schedule
  - Password-gated manager view, open read-only view for crew
  - Email notifications via Resend: weekly publish (all) + mid-week changes (affected only)
  - Isolated deploy pipeline (PUSH_RYC_SCHEDULE.bat)
  - Data in localStorage (prototype) — Supabase persistence planned
- **Prompt Normalization**: Standardized cost estimation rules across all 4 versions
  - All versions now include: contractor overhead, GC, permitting, engineering/design allowance (3-5%)
  - All exclude: land acquisition
  - Removed Free-only "renovation 60-80% rule" (only GC Internal has renovation as dropdown)
  - Standardized confidence language: "Vague or incomplete descriptions → Low confidence with wider ranges"
  - Added proprietary database prohibition to Free version (others already had it)
- **QA Tool**: Headless validation framework at /qa — runs test scenarios against all 4 prompts, compares results
- **Temperature**: Set temperature: 0.3 on all 4 versions + QA tool for run-to-run consistency
- **max_tokens alignment**: Free bumped from 1000 → 1200 (all versions now 1200)
- **Confidence scale**: Standardized all 4 versions to High/Medium/Low (Free/Pro had "Moderate" → changed to "Medium")
- **QA Tool v2**: Manual entry mode, GC Internal separated from spread analysis, persistent Supabase logging (qa_runs table)

## API Pattern — IMPORTANT
All api/*.js files use raw fetch to Supabase REST API. Do NOT use @supabase/supabase-js.
api/claude.js is a pure passthrough to Anthropic — prompts are built client-side.
api/schedule-notify.js uses raw fetch to Resend API (same pattern).

## Routing (vercel.json)
- Literal rewrites for internal tools (e.g., /gc/acme-internal) ABOVE wildcard :slug
- `/ryc/schedule` → `ryc-schedule/index.html`
- :slug wildcard LAST
- /admin, /qa are literal rewrites

## Backlog
- **RYC GC Tenant Onboarding**: Set up RYC as first real tenant in CivicScope GC white-label (slug, branding, notify_email, etc.)
- **Scheduler Supabase Persistence**: Move scheduler data from localStorage to Supabase table so data syncs across browsers
- **Fix PS1 vercel.json Regex**: push_ryc_schedule.ps1 auto-injection of route failed — regex doesn't match actual vercel.json format
- **RYC has Procore** ($100k/year) but barely uses it. Does NOT have Workforce Planning module — only Equipment under Resource Management.

## Preferences
- Concise, direct communication
- Prefers structured testing/validation
- Values pricing consistency across product versions

## Deep Reference
See memory/ directory for: glossary, project details, company structure, Supabase schemas, email flows
