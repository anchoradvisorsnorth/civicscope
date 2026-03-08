# Keith Plummer — Infrastructure Briefing
# Paste this into the AAN/MTP Claude project at the start of a session

## Who You Are Talking To
Keith Plummer. He is an employee of JBK Development (not owner). He also runs
Anchor Advisors North (AAN) as a personal brand and product umbrella. He is the founder of CivicScope.

---

## The AAN Product Ecosystem

### Three products, one Google Workspace (anchoradvisorsnorth.com)

| Product | Domain | Purpose | Status |
|---|---|---|---|
| AAN | anchoradvisorsnorth.com | Personal brand / umbrella | Live |
| CivicScope | civicscope.io | Municipal feasibility tool | Live — active dev |
| MTP | michianatrustplanning.com | Revocable trust workbook | Domain live, product TBD |

### Google Workspace
- Primary: keith@anchoradvisorsnorth.com
- All domains verified and Gmail activated: anchoradvisorsnorth.com, civicscope.io, michianatrustplanning.com
- Email aliases to set up (not yet done): info@michianatrustplanning.com → routes to AAN inbox
- info@civicscope.io — LIVE and sending via Resend

---

## Infrastructure Stack (applies to all products)

| Layer | Tool | Notes |
|---|---|---|
| Domains | Namecheap | All three domains registered here |
| Hosting | Vercel | Two separate projects (see below) |
| Code | GitHub | anchoradvisorsnorth org |
| Database | Supabase | Single shared project — anchoradvisorsnorth's Project (AWS us-east-1) |
| Email (transactional) | Resend | civicscope.io domain — VERIFIED AND LIVE |
| Email (workspace) | Google Workspace | AAN primary, others as aliases |

### Supabase Project
- Project name: anchoradvisorsnorth's Project
- URL: https://tyvtmqzaydrbjwzvjoei.supabase.co
- All CivicScope products (Free, Pro, GC White Label) share this one project
- MTP and AAN do NOT use Supabase
- Tables: sessions, tool_runs, leads, tenants (see schemas below)

### Vercel Projects
| Project | Repo | Domain | What it serves |
|---|---|---|---|
| aanclaude | anchoradvisorsnorth/aanclaude | anchoradvisorsnorth.com | AAN website only |
| civicscope | anchoradvisorsnorth/civicscope | civicscope.io + app.civicscope.io | CivicScope Free + Pro + GC White Label + APIs |

### Deploy Workflow (Windows, no git installed)
Keith uses PowerShell scripts to push files directly to GitHub via API.
Scripts live in Downloads\civicscope\ folder alongside the HTML/JS files.
- `PUSH_CIVICSCOPE.bat` — runs push_civicscope.ps1, deploys all CivicScope files
- Vercel auto-redeploys on GitHub push (~60 seconds)
- The .bat launcher handles ExecutionPolicy automatically

### Files pushed by PUSH_CIVICSCOPE.bat
```
CONTEXT_BRIEFING.md                     — Project context (this file)
vercel.json                             — Routing rules (rewrites + redirects)
index.html                              — Landing page
civicscope.css                          — Shared styles
civicscope/index.html                   — Free tool (v1.4.0)
civicscope-pro/index.html               — Pro tool (v2.2.0)
civicscope-gc/index.html                — GC White Label external (v1.2.0-gc)
civicscope-gc/estimator/index.html      — GC White Label internal estimator (v1.0.0-gc-int)
api/email.js                            — Resend transactional email (Free + Pro + GC)
api/gc-config.js                        — Tenant config fetch (GC)
api/gc-log.js                           — GC session + run logging
```
Note: api/claude.js and api/log.js are NOT in the push script (deployed separately, rarely change).

### vercel.json (current)
```json
{
  "rewrites": [
    { "source": "/gc/acme-internal", "destination": "/civicscope-gc/estimator/index.html" },
    { "source": "/gc/:slug", "destination": "/civicscope-gc/index.html" }
  ]
}
```
IMPORTANT routing notes:
- Internal tool rewrites use LITERAL paths (e.g. `/gc/acme-internal`) not wildcards.
  Vercel's `:param` syntax cannot match hyphenated suffixes reliably.
- When onboarding a new GC tenant with an internal tool, add a new literal line above the `:slug` wildcard.
- The `:slug` wildcard handles all external (client-facing) tools and must come LAST.

### Sandbox
Keith has a local sandbox for testing before deploy:
- `START_SANDBOX.bat` — double-click, launches Python server at localhost:8888
- `START_SANDBOX_SEND.bat` — same but real emails fire
- Serves Free/Pro locally, proxies /api/* to live Vercel
- Python 3.12.10 installed, found via `py` launcher
- ZIP autofill does NOT work in sandbox (external API blocked locally)
- Hard refresh (Ctrl+Shift+R) after every file replacement

---

## CivicScope — Detail

### What it is
Municipal project feasibility screening tool. Town managers enter project details,
get a cost range + narrative in 30 seconds. No architect, no engineer, no commitment.

### Customer models by product tier
- **Free / Pro:** End user is town manager/council member. Operator is JBK Development (only operator, intentional long-term). JBK CTA appears in tool, JBK receives leads.
- **GC White Label:** End user is a property owner or developer being oriented on project cost by a GC's BD team before formal estimating. Operator is the GC (multi-tenant). Email gate captures lead.

### Three product tiers
1. **Free** — app.civicscope.io/civicscope — no login, lead capture gate
2. **Pro** — app.civicscope.io/civicscope-pro — richer output, same gate, login coming
3. **GC White Label** — two URLs per tenant:
   - **External** (client-facing): app.civicscope.io/gc/[slug]
   - **Internal** (estimating team): app.civicscope.io/gc/[slug]-internal

### Live URLs
- Landing: https://www.civicscope.io
- Free: https://app.civicscope.io/civicscope
- Pro: https://app.civicscope.io/civicscope-pro
- GC External (ACME demo): https://app.civicscope.io/gc/acme
- GC Internal (ACME demo): https://app.civicscope.io/gc/acme-internal

### Current versions
- Free: v1.4.0
- Pro: v2.2.0
- GC White Label External: v1.2.0-gc
- GC White Label Internal: v1.0.0-gc-int

### File structure (civicscope repo)
```
vercel.json                          — Routing
index.html                           — Landing page
civicscope.css                       — Shared styles
civicscope/index.html                — Free tool
civicscope-pro/index.html            — Pro tool
civicscope-gc/index.html             — GC White Label external (client-facing)
civicscope-gc/estimator/index.html   — GC White Label internal (estimating team)
api/claude.js                        — Anthropic API proxy (shared by all tiers)
api/log.js                           — Supabase data capture (Free + Pro)
api/email.js                         — Resend transactional email (Free + Pro + GC)
api/gc-config.js                     — Tenant config fetch (GC only)
api/gc-log.js                        — Session + run logging (GC only)
```

### Vercel Environment Variables (civicscope project)
- ANTHROPIC_API_KEY
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- RESEND_API_KEY

### Tech stack
- Anthropic: claude-sonnet-4-20250514
- Supabase: sessions, tool_runs, leads, tenants tables
- Resend: sends from info@civicscope.io

### API pattern — IMPORTANT
All api/*.js files use raw fetch to call Supabase REST API directly.
Do NOT use the @supabase/supabase-js client library — it is not installed and will cause FUNCTION_INVOCATION_FAILED.
Pattern from api/log.js:
```javascript
const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Prefer': 'return=representation'
  },
  body: JSON.stringify(body)
});
```

### Supabase table schemas

**sessions** (54 rows as of 3/8/26)
- id, created_at, ip_hash, user_agent, referrer

**tool_runs** (21 columns)
- id, session_id, created_at, zip, state, municipality, project_type, build_type,
  scope_description, topography, utilities (array), cost_low, cost_high,
  cost_midpoint (integer), confidence, confidence_reason, narrative,
  assumptions (array), project_label, run_duration_ms, product
- `product` field: 'free', 'pro', 'gc-[slug]' (external), 'gc-int-[slug]' (internal)

**leads** (3 rows as of 3/8/26)
- id, session_id, tool_run_id, created_at, first_name, last_name, email, role,
  municipality, followup_answers (jsonb), contacted (boolean), notes

**tenants** (GC White Label — created 3/8/26)
- id (uuid), slug (unique), gc_name, logo_url, primary_color, hero_headline,
  hero_subhead, cta_headline, cta_body, cta_button_label, cta_url,
  contact_email, from_email, project_types (jsonb), region,
  gate_enabled (boolean), active (boolean), created_at
- contact_email and from_email are NEVER sent to the browser (stripped in gc-config.js)
- notify_email — where GC lead notifications go (BCC Keith if set; Keith only if null)
- brand_statement (text) — 1–2 sentence GC positioning for "Why [GC]" section on screen + in email
- brand_values (jsonb array) — 3–5 short strings e.g. ["30 years regional work", "Fixed-price delivery"]

### ACME tenant (demo/seed row)
- slug: acme
- gc_name: ACME General Contractor
- primary_color: #d4232a (red)
- project_types: ["Municipal / Public", "Commercial", "Industrial"]
- region: Midwest (Indiana / Michigan)
- gate_enabled: false
- active: true
- logo_url, cta_url, contact_email: placeholder values — update for real GC onboarding
- notify_email: needs to be set (leads go to Keith only until populated)
- brand_statement: needs to be set ("Why ACME" section hidden until populated)
- brand_values: needs to be set ("Why ACME" section hidden until populated)

### GC White Label — how it works (External / Client-facing)
1. Page loads, reads slug from URL path (`/gc/acme` → slug = `acme`)
2. Fetches `/api/gc-config?slug=acme` → gets tenant config from Supabase tenants table
3. Applies brand color, gc_name, project_types, CTA copy from config
4. User fills form (Name/Org, Project Type, ZIP, description)
5. Estimate runs via `/api/claude.js` — prompt includes TODAY's date to prevent past-date projections
6. Results: cost hero → narrative → assumptions → "Why [GC]" → "What Happens Next" process steps
7. Email gate: first name, last name, email → report to user + lead notification to notify_email
8. CTA card appears after submission
9. Logged via `/api/gc-log` with product = `gc-[slug]`

### GC White Label — how it works (Internal / Estimating Team)
1. URL is `/gc/[slug]-internal` → Vercel literal rewrite → `civicscope-gc/estimator/index.html`
2. Page reads slug from URL path, strips `-internal` suffix to fetch tenant config
3. Inputs: Client, Project Type, SF (required), Construction Type (required), Stories, Occupancy,
   Site Condition, Utilities, Foundation, Structural System, Notes
4. Results: cost row (Low/High/Midpoint/Confidence) + Analysis + Assumptions (two-col) + Open Questions
5. Open Questions: ordered by dollar impact, answer input below each question, turns green when filled
6. "Re-run with Answers" passes confirmed answers as context to next Claude call
7. Run counter in status bar; Edit Inputs / New Project actions available
8. Logged with product = `gc-int-[slug]`

### Branding rules
- Free/Pro: JBK Development ONLY in CTA/lead block. All chrome is CivicScope branded.
- GC External: GC name in header, "Powered by CivicScope" top right. GC CTA after email gate.
- GC Internal: Navy header with "internal" badge + red accent bar. Not client-visible.
- Emails from info@civicscope.io. GC emails lead with GC name; CivicScope in footer only.

### Email flow — Free/Pro (LIVE)
1. User runs estimate
2. User fills gate form (name, email, role)
3. /api/email fires two calls:
   - send_report → CS-branded HTML email to user with cost, narrative, assumptions, briefing, JBK CTA
   - notify_lead → lead notification to keith@jbkdevelopment.com
4. Keith BCC'd on user report
5. Lead logged to Supabase

### Email flow — GC White Label External (LIVE as of v1.2.0-gc)
1. Results display, then email gate appears
2. /api/email fires two calls:
   - send_report (product: 'gc-[slug]') → GC-branded email: cost, narrative, assumptions,
     Why GC section, process steps, GC CTA. CivicScope in footer only.
   - notify_lead (product: 'gc-[slug]') → to notify_email (BCC Keith). Keith only if null.
3. CTA card renders after submission

### api/email.js routing logic
- `product.startsWith('gc-')` → GC templates (buildGCReportEmail, buildGCLeadNotificationEmail)
- `product === 'free'` or `'pro'` → original CS templates (unchanged)

### api/email.js payload structures
```javascript
// send_report (GC):
{ action: 'send_report', data: {
  recipientEmail, recipientName, municipality, projectType,
  costLow, costHigh, costMidpoint, confidence, narrative, assumptions[],
  processSteps[],  // [{title, description, timeline}]
  whyGC: { statement, values[] },  // null if not configured
  gcName, product  // 'gc-[slug]'
}}

// notify_lead (GC):
{ action: 'notify_lead', data: {
  firstName, lastName, email, municipality, projectType,
  costLow, costHigh, confidence, gcName, gcNotifyEmail, product, sessionId
}}

// send_report (Free/Pro — unchanged):
{ action: 'send_report', data: {
  recipientEmail, recipientName, municipality, projectType,
  costLow, costHigh, costMidpoint, confidence, narrative,
  assumptions[], briefingHtml, product  // 'free' or 'pro'
}}

// notify_lead (Free/Pro — unchanged):
{ action: 'notify_lead', data: {
  firstName, lastName, email, role, municipality, projectType,
  costLow, costHigh, confidence, product, sessionId, runId
}}
```

### Pending work (CivicScope)
- **Monitoring dashboard** — NEXT: track runs, leads, errors, API costs
- Supabase: add notify_email, brand_statement, brand_values columns to tenants table
- Real GC onboarding — replace ACME placeholder (logo, CTA URL, brand content, notify_email)
- Pro login — Supabase Auth, magic link
- PDF report download
- Admin dashboard — Retool or Metabase → Supabase
- GC project history upload — anonymized pool → prompt injection (Phase 2)

---

## AAN Website (anchoradvisorsnorth.com)

Hosted on Vercel (aanclaude project), repo: anchoradvisorsnorth/aanclaude.
Fully separated from CivicScope.

### Pending work (AAN)
- Consultation request form — wire to send email from info@anchoradvisorsnorth.com

---

## MTP — Michiana Trust Planning (michianatrustplanning.com)

### What it is
Revocable trust workbook — educational product for families. Sold as a downloadable PDF workbook.

### Infrastructure decision (pending)
- **Gumroad** for paid workbook sales
- **MailerLite** for free lead magnets / email list
- Supabase NOT needed for MTP
- Domain live, site in development

### Pending work (MTP)
- Set up Gumroad, upload workbook PDF
- Set up MailerLite, create free lead magnet flow
- Wire buy button → Gumroad
- Wire email capture → MailerLite

---

## Important Context

### Keith's email accounts
- keith@anchoradvisorsnorth.com — primary Google Workspace, everything routes here
- keith@jbkdevelopment.com — JBK work email, used for CivicScope lead notifications

### What NOT to do
- Don't mix CivicScope and AAN infrastructure — they are intentionally separate
- Don't add a paywall to Free or Pro yet — JBK is testing the market
- Don't build multi-tenancy into Free/Pro — JBK is the only operator
- Don't reference RSMeans, Gordian, or any proprietary cost database by name in prompts
- Don't use @supabase/supabase-js — use raw fetch to Supabase REST API (see API pattern above)

### Sandbox reminder
Always test in sandbox before deploying. Restart sandbox after replacing files.
Hard refresh browser (Ctrl+Shift+R) after restart to clear cache.
ZIP autofill doesn't work locally — type municipality manually, enter ZIP, state won't auto-fill.
