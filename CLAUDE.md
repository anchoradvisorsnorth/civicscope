# CLAUDE.md — Civicscope Module

> Root context: Cowork\CLAUDE.md

---

## What It Is
AI-powered municipal construction cost feasibility tool. Four product versions serving different audiences, all powered by the same Anthropic API proxy. Standalone SaaS — no JBK branding anywhere.

**Repo:** anchoradvisorsnorth/civicscope

> **Groundwork newsletter — PAUSED (as of 2026-06-11).** Weekly CivicScope-branded civic-development newsletter for greater Michiana. v1 was fully built and deployed at [groundwork.civicscope.io](https://groundwork.civicscope.io) (collectors → extractor → assembler → web archive; Edition #1 in `civic_issues`), but the project is **on hold** — its remaining work (Resend send wiring, VM cron, PDF fallback, Cost Lens) is NOT active. See **Groundwork architecture** section below. **NOTE:** Groundwork and the **Municipal Agenda Notifier** (the live Clark tool, below) are **separate products** — Groundwork grew out of the Elkhart/Clark agenda exercise but must not be merged with it.
**Hosting:** Vercel (auto-deploy from GitHub)
**DB:** Supabase — raw fetch only, NEVER @supabase/supabase-js
**Email:** Resend from info@civicscope.io
**AI:** All tools → api/claude.js → **claude-sonnet-4-6**, temp 0.3. **max_tokens: 2400** on Municipal/Schools/Infrastructure (raised from 1200 on 6/16 — Schools/Infra responses run ~1,150–1,300 tokens and truncated mid-JSON at 1200); GC/other tools still 1200. `api/claude.js` pins `maxDuration: 120` (Vercel Pro) so a long Schools run can't 504. (Model was `claude-sonnet-4-20250514` until it RETIRED ~June 15, 2026 → 404'd every tool; see Recent Changes June 16. **Never pin a dated/soon-retiring model — use the rolling alias.**)
**Deploy:** PUSH_CIVICSCOPE.bat → GitHub Trees API → Vercel (~60s)

---

## Product Suite & Current Versions

| Product | URL | Audience | Version |
|---------|-----|----------|---------|
| **Municipal (Free)** | app.civicscope.io/civicscope | Municipal employees + officials | **v2.2.0** |
| **Schools** | app.civicscope.io/schools | K-12 district leaders | v1.0.0-schools |
| **Infrastructure (NEW June 6)** | **app.civicscope.io/infrastructure** | **Public works / utility leaders** | **v1.0.0-infrastructure** |
| GC External | app.civicscope.io/gc/:slug | GC prospective clients | v1.6.0-gc |
| GC Internal | app.civicscope.io/gc/:slug-internal | GC estimating teams | v1.5.0-gc-int |
| QA Tool | app.civicscope.io/qa | Keith only | v1.0.0-qa |
| Admin | app.civicscope.io/admin | Keith only | v1.0.0-admin (+ QA test harness) |
| RYC Scheduler | app.civicscope.io/ryc/schedule | RYC crew | v1.0.0 |
| ~~Pro~~ | civicscope-pro | **SHELVED June 6** — depth folded into free tools; archived, unlinked | v2.10.0 |
| ~~Pro Landing /pro~~ | — | **KILLED June 6** — 301 → / | — |

**Version rule:** Bump in BOTH the product HTML footer AND civicscope-admin/index.html product cards.

**The 3-vertical free model (June 6, 2026):** All three live tools (Municipal / Schools / Infrastructure) carry the **full depth on-screen, ungated** — cost methodology, full timeline, buyer's advocate guide, and edit & re-run (ported from the old Pro tool). The lead gate ("Email yourself this report") only triggers the emailed report + lead notification; nothing is hidden behind it. Every former Pro upsell is replaced by an inline **"Contact CivicScope for guidance"** form → `contact_inquiry` action in `api/email.js` (emails Keith). **Accounts + saved history are the only items left on a future-Pro roadmap.**

### Segment Hub Pages (marketing landings)
Audience-segmented top-of-funnel landings on the **www** site (not the `app` tool subdomain), each routing into the relevant tool. **`for-government` is the gold-standard story template** — `for-schools` and `for-infrastructure` were rebuilt June 1 as clones of it (re-skinned per vertical). The hub `index.html` ties them together.

**Story arc (all three segment pages, shared):** dark hero (headline + editorial line-sketch + cost callout) → trust bar → Problem ("nowhere to start") + use-case card w/ illustration → Why Trust the Number (Google vs AI vs CivicScope) → How It Works (3 steps) → Who It's For (6 role cards) → Pricing/CTA → Founder → Final CTA → footer.

**Architecture note:** `for-government`, `for-schools`, `for-infrastructure` are **self-contained** (each inlines its full design system in a `<style>` block — they do NOT link `/civicscope.css`). The hub `index.html`, the segment-page *logo*, and the `civicscope-schools` tool DO use shared `/civicscope.css`. The shared logo lives in `.cs-wordmark-svg` (added June 1) — building glyph + stacked "Civic / SCOPE" wordmark, cream/orange (`#c2410c`); Pro uses the navy variant.

| Hub | URL | Version | State |
|-----|-----|---------|-------|
| Government | civicscope.io/for-government | `v2.0.0 \| 2026-03-28` *(stale comment — page is fully built; leftover from free-tool copy)* | Gold-standard story template. Dark hero w/ town-hall sketch + cost callout |
| Schools | civicscope.io/for-schools | for-schools v2.0.0 | **Full story rebuild (June 1)** mirroring government. Schoolhouse hero + cost callout; adds a schools-only **"Referendum-Free Path"** section (Build→Operate→Transfer diagram + IC § 5-23, names JBK); SEA 1 (2025) framing; 6 school roles; use-case = business manager / HVAC+roof. v1.1.0 backup at `work product/for-schools-v1.1.0-backup.html` |
| Infrastructure | civicscope.io/for-infrastructure | for-infrastructure v2.0.0 | **Full story rebuild (June 1)** mirroring government, as a pre-launch "coming soon." Water-tower/road/water-main hero sketch; use-case = public works director / Maple St. main. **Functional notify section** posts `notify_capture` → `api/email.js` emails Keith each signup (channel `infrastructure`). v1.0.0 backup at `work product/for-infrastructure-v1.0.0-backup.html` |
| Hub (front door) | civicscope.io/ (`index.html`) | hub v1.1.0 | Story incorporated June 1 ("Why CivicScope exists" narrative + "Start with the number" CTA). 3-tool chooser: **Government + Schools featured (Live), Infrastructure muted (Coming soon)** |

**Loose ends:** (1) `for-government` version comment is stale (`v2.0.0 | 2026-03-28`) — give it its own `for-government vX` line. (2) `civicscope-schools` tool still has no version comment — add one. (3) Optional: port the editorial illustration treatment into the `civicscope-schools` *tool* itself (landings have it; the tool doesn't).

---

## Prompt Standards (all versions)
- Include: contractor overhead, GC markup, permitting, engineering/design (3-5%)
- Exclude: land acquisition
- Confidence: High / Medium / Low — never "Moderate"
- Vague descriptions → Low confidence, wider ranges
- No proprietary database names (RSMeans, Gordian)

---

## API & Infrastructure
- All api/*.js use raw fetch to Supabase REST
- api/claude.js is a pure passthrough — prompts built client-side
- Vercel env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
- Email routing: Free/Pro → info@civicscope.io; GC → tenant notify_email + BCC Keith
- No JBK references anywhere — removed March 2026

## Supabase Tables
tool_runs schema: id, session_id, created_at, zip, state, municipality, project_type,
build_type, scope_description, topography, utilities[], cost_low, cost_high,
cost_midpoint, confidence, confidence_reason, narrative, assumptions[], project_label,
run_duration_ms, product (values: 'free', 'pro', 'gc-[slug]', 'gc-int-[slug]')

tenants schema: id, slug, gc_name, logo_url, primary_color, hero_headline, hero_subhead,
cta_headline, cta_body, cta_button_label, cta_url, contact_email, from_email,
project_types (jsonb), region, gate_enabled, active, created_at, notify_email,
brand_statement, brand_values (jsonb array)

---

## Routing (vercel.json)
- Literal rewrites ABOVE wildcard :slug
- /pro → **301 redirect to /** (Pro killed June 6 — in vercel.json `redirects`)
- /schools → civicscope-schools/index.html (the Schools tool)
- /infrastructure → civicscope-infrastructure/index.html (the Infrastructure tool, NEW June 6)
- /for-government, /for-schools, /for-infrastructure → respective segment hub pages
- /ryc/schedule → ryc-schedule/index.html
- /ryc/command → ryc-command/index.html (NEW 2026-07-07 — RYC Command Center v2, the FundView-style operating-cockpit rebuild of the RYC dashboard; parallel beta route, legacy /ryc/dashboard untouched until cutover. See RYC CLAUDE.md + memory project_ryc_command_center_overhaul.)
- /ryc/estimate → ryc-estimate/index.html (NEW 2026-06-28 — RYC Estimating Assist: plan-set → Claude Vision takeoff → estimate grounded in RYC Foundation history; gate ryc2026. Part of the GC estimating-intelligence product, RYC = tenant #1. Calibration in progress; next is the unit-cost library. See RYC CLAUDE.md + memory project_civicscope_gc_estimating_intelligence.)
- ~~/golf~~ — **RETIRED 2026-06-22.** Was a hidden personal page (not a CivicScope product): US Open friends' prize-money pool tracker (self-contained static HTML, client-side ESPN leaderboard). Pool won by MARK ($2.59M); US Open won by Wyndham Clark −4. Removed directly via GitHub API (deleted `golf/index.html`, dropped the `/golf` rewrite + push-manifest line; `/golf` now 404s); cloud routine `trig_0182e2RidVU4EHDd11g8nGAa` disabled (the scheduled PR-based retirement was superseded by the direct removal).
- /admin, /qa are literal rewrites
- :slug wildcard LAST

---

## Deploy Workflow
1. Edit files locally in Cowork\Civicscope\
2. Run PUSH_CIVICSCOPE.bat — pushes product HTML + api/*.js
   - ⚠ `push_civicscope.ps1` must stay **UTF-8 WITH BOM** — the .bat runs Windows PowerShell 5.1, which reads no-BOM as ANSI and shatters on the script's em-dashes (bit 2026-07-08: deploy died at a parse error + "Press any key"). If a tool re-saves it without BOM, re-add before deploying.
3. Run PUSH_RYC_SCHEDULE.bat separately for RYC scheduler only
4. CLAUDE.md pushed separately via GitHub Contents API PUT
5. Validate at app.civicscope.io/qa after deploy

## Key Points
- Sandbox (START_SANDBOX.bat → localhost:8888) — retain for risky changes only
- RYC Scheduler deploy is isolated — zero risk to civicscope.io
- Acme = demo tenant only, never modify
- RYC = first real GC tenant (onboarding deferred to backlog)

---

## Open Action Items

Forward-looking action queue. Source of truth for the CRM dashboard's "Across All Businesses → CivicScope" card. Curated at `/wrap`. Done items are removed, not strikethroughed — historical context lives in the `## Active Backlog` sections below.

- **CivicScope QC process (built 2026-06-17)** — response to the June 16 silent outage. Now in place: **(1)** rebuilt `/qa-check` skill (`skills/qa-check/SKILL.md`) — model-alias/`max_tokens`-headroom/`maxDuration`/push-manifest guards as section 1; **(2)** **two-stage post-deploy gate** in `push_civicscope.ps1`, both **fail the deploy** so "fixed" can't be reported on a broken ship: **(2a)** backend smoke `scripts/smoke-test.js` (real full estimate per vertical vs `/api/claude`, validates a cost range), **(2b)** browser E2E `scripts/e2e-check.js` (puppeteer-core + local Chrome; drives the REAL page via `?qa=<preset>&autorun=1`, asserts a cost renders in `#costRange` — catches client-side breaks the backend smoke can't see); **(3)** **daily VM smoke** (`cs-smoke-daily`, 8am ET) catches truncation/timeout from model drift the 10-min cheap probe misses; **(4)** `cs-health` (every 10 min) as the always-on catastrophic watch. The tools' JSON parse was hardened (strict → outermost-`{…}` fallback) so occasional model prose no longer 500s. **Gate scripts are local-only** (`Civicscope/scripts/`, not in the deploy manifest; the gate runs on Keith's PC). **Still TODO:** external dead-man's-switch (heartbeat service) so a *dead* cs-health pages Keith — pending Keith's healthchecks.io/UptimeRobot signup + ping URL; Anthropic auto-reload (console toggle); model-retirement calendar.
- **Enable Anthropic auto-reload** — credit balance hit $0 on 2026-06-16 (separate from the model outage) and took down every Anthropic consumer. Auto-reload still OFF in the console. Turn it on (threshold + top-up). *(Keith's console toggle — the one catastrophic mode no monitor can prevent, only alert on.)*
- **Activate the OpenAI fallback in `api/claude.js` (wired 2026-06-23, dormant).** After the June 23 Anthropic 529 "elevated error rate" outage, `api/claude.js` gained bounded **retry on 429/5xx/529** (live) + an **OpenAI-compatible fallback** that's OFF until `OPENAI_API_KEY` is set in CivicScope's Vercel. **To activate:** Keith provides a general-purpose OpenAI key (NOT Codex — it's a code model; fallback defaults to `gpt-4o`, override via `OPENAI_FALLBACK_MODEL`); Claude sets both env vars via the Vercel REST API (avoid the empty-string pipe gotcha) + redeploy. Can't be end-to-end tested without inducing an Anthropic failure — will self-validate on the next real 529. **New platform → add OpenAI to the tracker** (`opsStatus: watch` until proven).
- **External dead-man's-switch for cs-health (NEW 2026-06-17)** — cs-health is one VM cron; if it dies (VM/cron/script), there are no checks AND no alert — only the weekly AAN email surfaces it (too slow). Need an independent heartbeat (healthchecks.io free tier or UptimeRobot heartbeat) that pages Keith when the 10-min ping goes missing. **Blocked on Keith:** 2-min signup → create one check → set alert target (email/SMS) → paste the ping URL; then ~5 lines on the VM (curl the ping URL at the end of each successful cs-health run). Closes the last "I can't be the last to know" gap.
- **Fable review R1 — work the 19 leads (KEITH, ½ day)** — every lead ever captured sits at `contacted=false`, incl. four live .gov hand-raisers from Jun 22–30 (names/towns in the Fable review doc — deliberately NOT in this public-repo file). Triage all 19, reply to the warm ones, mark `contacted`. Then wire "N uncontacted leads" into the daily digest / Monday email so the loop can't silently stall again. Cheapest calibration of the 30-day plan.
- **Fable review R2 — 30-day school-BOT plan Week 1** — ~50-district target list (agenda/BoardDocs mining tech already proven), Triage Memo template, outreach sequence. The schools wedge has ZERO organic pull (4 runs ever, ~all internal) — founder-led outreach is the only test. Plan: `work product/CivicScope_School_BOT_Pivot_30Day_Plan.md`, graded B+ in the Fable review.
- **CAN-SPAM postal address — NOW CRITICAL PATH** — legally required before any school-BOT outreach begins (was hygiene, now a blocker). Needs the CivicScope/AAN business mailing address.
- **Fable review R4 — mobile overflow at 375px** — for-schools renders 540px wide (worst on the site — and it's the wedge page), infra tool 529, schools tool 458, for-gov/for-inf 436, hub 388. Municipal + GC clean. Landing culprit ≈ problem-section block (404px) + animation offsets. Fix for-schools before any superintendent outreach. Also: hub Infrastructure card missing its LIVE badge.
- **Fable review R6 — infra repeat-run variance** — two identical watermain runs 43s apart returned $1.05M–$1.55M vs $1.85M–$2.75M (±76% midpoint; municipal + schools were deterministic across repeats). Add a repeat-run stability probe to the QA harness; consider prompt grounding discipline.
- **JBK-mention decision** — 3 live surfaces (for-schools, schools tool, infra tool) still name JBK Development despite the 2026-07-06 stay-neutral decision. Sweep for true neutrality or own deliberately — current state is drift.
- ⏸️ **Groundwork (newsletter) — PAUSED / on hold (2026-06-11)** — entire backlog frozen (Resend send wiring, VM cron, PDF fallback for Mishawaka packets, Cost Lens integration, project-tracker dedup). Detail preserved in the **Groundwork — Architecture** section. Separate product from the Municipal Agenda Notifier — do not merge.
- **Facebook Ads pixel** — create a CivicScope-specific Meta Pixel in Business Manager (separate from MTP/AAN pixel). Implementation plan at `Civicscope/FB_AD_IMPLEMENTATION_PLAN.md`.
- **Move daily digest cron to VM** — Vercel Hobby cron is unreliable (missed April 9-10 digests). Move to VM cron as a `curl` trigger, same pattern as bookmarks pipeline.
- ⏸️ **GC public white-label — PARKED (Fable review 2026-07-08)** — one demo tenant (acme) in 4 months; the real GC product lives at /ryc/estimate and is proving itself there. Revisit RYC-as-public-tenant only if a paying second tenant materializes.
- **CivicScope restructure — loose ends (June 6)** — add version comments to the Schools + Infra tool footers; sweep the inert `.timeline-tease`/`.tease-*` dead CSS from the 3 tools; final end-to-end harness tire-kick of Schools + Infra (Municipal confirmed). The `Segment Hub Pages` table near the top still lists Infrastructure as "coming soon" — update that row when convenient.

---

## Groundwork — Architecture (built 2026-05-26)

Weekly newsletter at **groundwork.civicscope.io** covering civic development in greater Michiana. CivicScope-branded sub-product, separate subscriber list, reuses Resend Pro infra.

**Data flow:** sources → collectors → `civic_raw` → extractor → `civic_items` + `civic_projects` → assembler → `civic_issues` → web archive + (eventually) Resend send → `civic_issue_sends` + `civic_clicks`.

**Supabase tables** (CivicScope project — schema in [schema_civic.sql](schema_civic.sql), run 2026-05-26):
- `civic_sources` — fetch registry (8 seeded: South Bend, Mishawaka, Cass MI, Berrien MI, Goshen, WSBT, Watershed Voice, Inside IN [paused])
- `civic_raw` — fetched docs deduped by sha256 content_hash
- `civic_projects` — tracked entity across touchpoints; has `cost_lens_run_id` FK to `tool_runs`
- `civic_items` — structured dev actions extracted from raw
- `civic_subscribers` — Groundwork list (separate from CRM contacts), single-opt-in for v1
- `civic_issues` — weekly issue rows with `body_html` + `body_text`; aggregated stats columns
- `civic_issue_sends` — per-subscriber send row (Resend webhook updates delivered/opened/bounced)
- `civic_clicks` — server-side `/g/{issue}/{slug}/{send_id}` click logs (deferred; not wired yet)

**Collectors** ([Civicscope/collectors/](collectors/)) — all idempotent via content_hash, all writeable to civic_raw:
- `mishawaka.js`, `cass-county-mi.js` — CivicClerk `/v1/Events` + file text fetch
- `south-bend.js` — Tribe REST API (WordPress Events Calendar)
- `rss-feed.js` — generic RSS, dispatches by jurisdiction slug arg (berrien-county-mi, goshen, michiana=WSBT, three-rivers-mi=Watershed Voice)
- `lib/common.js` — shared Supabase client, hash, source-row helpers

**Extractor** ([collectors/extractor.js](collectors/extractor.js)) — two-pass on each `civic_raw`:
- Pass 1: Haiku 4.5 relevance score 0-100 (skip if <30)
- Pass 2: Sonnet 4.6 structured extraction → array of items (uses `output_config.format` JSON schema)
- Auto matches/creates `civic_projects` via fuzzy name match. Cost ~$0.20 for first batch of 33 rows (3 minutes).

**Draft assembler** ([collectors/assembler.js](collectors/assembler.js)) — deterministic bucketing + AI editorial polish:
- Buckets civic_items into Pipeline / Vote / Cost Lens candidates / Map (by jurisdiction) / Others
- Calls Sonnet 4.6 once for subject, preview_text, intro, and "One Big Thing" deep dive (rest is template-rendered)
- Outputs body_html + body_text; saves to civic_issues as draft

**Web archive** ([groundwork/](groundwork/)) — at `groundwork.civicscope.io` (Vercel subdomain, CNAME via Namecheap):
- `groundwork/index.html` — landing + recent editions list + signup form
- `groundwork/edition.html` — single edition view, fetches body_html from API
- `groundwork/unsubscribe.html` — one-click unsubscribe handler
- API: `api/groundwork-editions.js`, `api/groundwork-subscribe.js`, `api/groundwork-unsubscribe.js`
- Host routing: `middleware.js` (root path `/` via `@vercel/edge` rewrite — defeats CS root-index filesystem collision) + vercel.json `has`-matched rewrites for other paths
- Added [package.json](package.json) to give Vercel the `@vercel/edge` dependency (was missing — middleware silently failed without it).

**Cost Lens flywheel** (designed, not yet wired): each issue features one project that has a CivicScope estimate; `civic_issues.cost_lens_project_id` FK to `civic_projects`, which has FK to `tool_runs`. Reader clicks "see how this was estimated" → opens the CS run → drives top-of-funnel for the tool.

---

## Municipal Agenda Notifier (built 2026-05-31 · RETIRED 2026-06-22)

> **⚠️ RETIRED 2026-06-22** — sunset after the Councilman Clark pilot. VM cron commented (`# RETIRED 2026-06-22`, backup `~/crontab.bak.20260622`), runtime archived to `~/council-agenda.retired-20260622`, heartbeat registry `council-agenda` → `enabled:false` (paused). Repo source kept under `agenda-notifier/` with a RETIRED note + revival steps. Shared infra (FlareSolverr Docker, `agenda@civicscope.io` Resend sender) left in place. The CF-bypass + PDF technique remains reusable — see memory `reference_cloudflare_bypass_flaresolverr`.

CivicScope sub-product, **sibling to Groundwork**. Watches a Cloudflare-protected county site for the monthly council agenda; on a new posting, drafts a constituent-facing Facebook post and emails it to Keith to review → forward. First user: **Councilman Steven Clark** (Elkhart County Council). ~~LIVE on the VM.~~ Retired.

- **Source:** `Cowork\Civicscope\agenda-notifier\` (council_agenda.py + README). Runtime on VM at `/home/azureuser/council-agenda/`, daily cron 11:30 UTC (self-gates to ~7 days before each 3rd-Thursday meeting).
- **Engine:** FlareSolverr (Docker :8191) solves Cloudflare → `curl_cffi` (Chrome TLS impersonation) downloads the PDF → PyMuPDF text + page PNGs → Sonnet 4.6 drafts FB-safe caption → Resend (civicscope.io, from agenda@civicscope.io) emails keith@jbkdevelopment.com.
- **Relationship to Groundwork:** this Clark exercise is what **proved the CF-bypass + PDF approach possible — and is what Groundwork grew out of**, not the reverse. They are **separate products and stay separate** (do NOT fold the notifier into Groundwork; Groundwork is paused). The CF-bypass + PDF-text technique is reusable (it also answers the Groundwork "PDF fallback for Mishawaka packets" problem) — shared *method*, not a merged roadmap.
- **Status note:** paused 2026-06-08 under a mistaken "fold into Groundwork" rationale; **re-enabled 2026-06-11** for the June 18 meeting (`**bold**` markdown leak fixed same day via a deterministic `strip_markdown` post-process).
- Full technique in memory `reference_cloudflare_bypass_flaresolverr`; project state in `project_council_agenda_watcher`.

---

## Active Backlog — Campaign Launch (Priority)
1. ~~Fix report email timeline~~ — **DONE** (March 24) — `timeline` wasn't destructured/passed in email.js
2. ~~Fix broken layout below gate form~~ — **DONE** (March 24) — undefined CSS vars + missing `display:block` override
3. ~~Add post-form CTA~~ — **DONE** (March 24) — Pro upsell + info@civicscope.io contact line
4. ~~Instant notification on campaign runs~~ — **Rolled into daily digest** — no separate notification needed
5. ~~Daily digest email~~ — **DONE** (March 24) — `api/digest.js` + Vercel cron at 7am ET, `CRON_SECRET` env var set. Quiet day email added March 26 (sends "no activity" message instead of skipping).
6. ~~**Campaign email copy**~~ — **DONE** (March 26) — A/B test wired: Variant A (punchy/direct), Variant B (credibility-led). Plain text, from `keith@civicscope.io`, signed "Keith / CivicScope". Variant tagged on each send record via `notes` field. Test send action added (`action: test_send`).
7. ~~**Send first campaign batch**~~ — **DONE** (April 1) — all 151 commissioner emails sent. **First campaign-attributed tool run: April 2, 2026** — Wabash County commissioner clicked ref link, ran Municipal Office / Town Hall rehab ($45K–$85K, basement water damage). Three commissioners received the email (Tyler Niccum, Jeff Dawes, Cheryl Ross — all Variant A/B). Real project, not a test.
8. ~~**SEO overhaul**~~ — **DONE** (March 28) — Landing page v2.0.0: title, meta description, OG tags, canonical, JSON-LD SoftwareApplication. Free tool: noindex + canonical to civicscope.io. 5 new project-type SEO landing pages (fire station, public works garage, community center, splash pad, salt shed) with FAQPage schema, body copy, CTAs. Internal linking from landing page. og-image.svg/png deployed. vercel.json + push script updated. **GSC fix (March 29):** All canonical, og:url, og:image urls standardized to `www.civicscope.io` (was non-www, conflicting with Vercel 307 redirect). `/index.html` → `/` 301 redirect added to vercel.json. All 10 HTML files + nav links updated. Deployed.
9. **Facebook Ads pixel** — Need to create a CivicScope-specific Meta Pixel in Business Manager (separate from MTP/AAN pixel). Implementation plan ready at `Civicscope/FB_AD_IMPLEMENTATION_PLAN.md`.
10. ~~**Municipal contact build**~~ — **DONE** (April 4) — Full distribution list built for CivicScope outreach beyond commissioners. 276 active contacts tagged `cs-campaign-municipal` across 49 IN+MI counties. 161 with verified email (58%). 345 new company records (cities, towns, villages, departments). 65 stale contacts flagged and removed from campaign. Import scripts at `CRM\scripts\pilot-import\` and `CRM\scripts\full-import\`. Enrichment notes at `CRM\scripts\email-enrichment\`.
11. ~~**CRM CS module restructured**~~ — **DONE** (April 5) — Full restructure: 4-item sidebar (Dashboard, Campaigns, Templates, Leads). Campaign entity model with multi-touch support (`cs_campaigns` table, `campaign_id` + `touch_number` on sends). Named campaigns ("IN Commissioners", "Northern Indiana + SW Michigan Municipal"). Template picker on Send Batch with A/B selection. Engagement-first sort. Seed Audience with role auto-detection. Add/remove contacts per campaign. Delete campaign. CS pill persists on refresh. CRM v1.11.0. Full spec: `Civicscope/CS_MODULE_RESTRUCTURE.md`.
> **Campaign status verified against the DB on May 21, 2026.** Sends live in **CRM Supabase** (`cs_campaign_sends`); tool runs + leads live in **CivicScope Supabase** (`tool_runs.ref` for attribution). Reconciled snapshot below — items 12–15 reflect actual send counts, not the stale "pending" figures that drifted out of sync.

**Snapshot (May 21, 2026) — 1,175 sends total, ~1,096 delivered / 68 pending / 11 bounced:**
- **IN Commissioners (453):** T1 151 sent ✅ · T2 151 sent ✅ · T3 100 sent / 51 pending ⏳
- **N. IN + SW MI Municipal (334):** T1 160 sent / 7 bounced ✅ · T2 146 sent / 17 pending / 4 bounced ⏳ (T2 batch sent May 21)
- **IEDA Partners (388):** T1 388 sent ✅ (fully complete)
- **Conversion:** 49 tool runs all-time (28 since Apr 1, 13 since May 1), **13 leads**. Only **5 genuine campaign-attributed runs** (`wabash-county`, `randolph-county`, `brown-county`, `ieda-warren-county-ledo`, `ieda-hyphen-strategies`) ≈ 0.5% click-to-run. May organic runs are out-of-state (KY ×4, CA ×2, MD, TN, FL) — SEO traffic, not the IN/MI email campaigns.

12. **Municipal campaign — Touch 2 in progress** — "Northern Indiana + SW Michigan Municipal" (168 seeded). **T1 complete** (160 sent, 7 bounced). **T2 in progress: 146 sent, 17 pending** (latest batch May 21), 4 bounced. Templates: "Credibility Angle" (A) + "Permission Angle" (B). Finish the 17 pending T2 sends. One auto-reply on T1 (Holly Taylor, Valparaiso — inbox delivery confirmed; `[Suspicious URL]` flag is Valpo's gateway, not Gmail).
13. **Commissioner campaign — Touch 3 in progress** — "IN Commissioners" (151 contacts). **T1 + T2 both complete** (151 sent each). **T3 in progress: 100 sent, 51 pending** — finish the remaining 51. T2 used single template "Number Before the Vote" (no A/B).
14. **CS Campaign: Future touches** — Commissioner T3 + Municipal T2 copy are written and sending (see above). Remaining: finish in-flight touches (51 commish T3 + 17 muni T2), then plan Municipal T3 and IEDA T2. **Before sending more volume:** judge against the new funnel data (item 16) — ~0.5% visible attribution across 1,096 delivered was measured with a broken meter, so let the funnel report a real read first.

16. **Funnel instrumentation — BUILT & DEPLOYED (May 21, 2026)** — closed the "we're blind to the funnel" gap. Was: only `sent`/`bounced` tracked, and `?ref=` query links were getting stripped by .gov email gateways (found ~5 IN/MI runs in send windows with no ref). Now:
    - **Clean links:** campaign emails link to `app.civicscope.io/try/{slug}` (not `?ref=`). `Civicscope/api/try.js` 302-redirects to `/civicscope?ref={slug}` and logs the click to `cs_clicks` (CivicScope Supabase). Gateways pass the clean path; ref is set server-side on a redirect they never see. **This fix is live now — every send from here on uses it.** `/try/:slug` rewrite added to `vercel.json`.
    - **Delivered/Opened/Bounced/Complained:** Resend webhook → `CRM/api/cs-resend-webhook.js` writes onto the matching `cs_campaign_sends` row (matched by `resend_id`, now stored on send). Secured by `?key=` query secret (`CS_RESEND_WEBHOOK_SECRET`, set in CRM Vercel). We deliberately do NOT use Resend click-tracking (it wraps URLs → re-introduces the suspicious-link problem); `/try` is our click tracker.
    - **Funnel readout:** CS Dashboard now shows Sent → Delivered → Opened → Clicked → Ran → Leads (each as % of sent). `CRM/api/cs-data.js` aggregates clicks by ref_slug.
    - **Schema migrations (run in Supabase SQL editor):** `CRM/schema_cs_funnel.sql` (adds resend_id/delivered_at/opened_at/open_count/complained_at/bounced_at to cs_campaign_sends — CRM project) and `Civicscope/schema_cs_clicks.sql` (creates cs_clicks — CivicScope project).
    - **Two manual steps to fully activate:** (1) run both SQL migrations; (2) Resend dashboard → enable Open Tracking on civicscope.io (leave Click Tracking OFF) + add webhook `https://crm.jbkdevelopment.com/api/cs-resend-webhook?key=<secret>` for events email.delivered/opened/bounced/complained.
    - **Caveat:** open counts (Apple Mail Privacy + gateway prefetch) and raw clicks (gateway link-scanners hit `/try`) are inflated/directional. The high-confidence conversion remains a `tool_run` with the ref.
15. ~~**IEDA Partners campaign — Touch 1**~~ — **DONE (fully sent)** — Full IEDA directory imported (237 new companies + 17 enriched; 380 new contacts + 9 enriched; related parties filtered). Campaign id `500aa3b7-330b-44b4-aa1c-6dee698d07f6`. **All 388 Touch 1 sends complete.** Ref slugs scoped per IEDA member org (`ieda-dc-develop`, etc.) so click attribution rolls up per firm — 2 attributed runs so far (`ieda-warren-county-ledo`, `ieda-hyphen-strategies`). Single-variant template "IEDA Partners — Share Angle" (subject: *A cost reality check you can hand to your local officials*). **Resend upgraded to Pro (May 21, 2026) — 50,000/mo, no daily cap.** The plan is no longer the constraint; pace IEDA Touch 2 for deliverability/reputation, not for quota (see [project_cs_email_funnel] + Resend memory). Scripts: `CRM/scripts/ieda-import.js`, `CRM/scripts/ieda-campaign-seed.js`. CSVs in `CRM/work product/imported/`.

17. **Build new campaigns — NEXT SESSION** — design + launch the next round of CS outreach, **informed by the funnel data** from the May 21 instrumented batch (don't decide blind). Guardrails set this session:
    - **Read the funnel first.** Delivered→Opened gap = subject-line / inbox-placement problem; Opened→Clicked = body/offer problem. Build to fix what the data shows — do NOT clone-and-reblast identical content to the same list.
    - **Candidates:** IEDA Touch 2 (warmest — only got T1; needs a fresh angle); Municipal Touch 3; net-new segments not yet campaigned (superintendents / facilities directors, additional IN/MI counties).
    - **Every new campaign changes a variable** (subject or offer) and is paced for .gov reputation (Resend now Pro — pacing is for deliverability, not quota). New sends auto-use clean `/try` links + full funnel tracking (see item 16).
    - Workflow: create campaign in CRM CS module → seed audience → write/select template(s) → send measured batches → watch funnel.

## Active Backlog — Product
7. ~~**CS service_role rotation**~~ — **DONE (April 23, 2026)** — full rotation closed. Timeline:
   - April 22: Built `api/admin.js` server-side proxy for tenant writes, gated by `x-admin-secret` / `CIVICSCOPE_ADMIN_SECRET`. Removed hardcoded `SUPABASE_SVC` from `civicscope-admin/index.html`. Migrated Vercel `SUPABASE_SERVICE_KEY` to new `sb_secret_*` key.
   - April 23: Swapped legacy anon JWT on line 655 of `civicscope-admin/index.html` to `sb_publishable_*`. Pushed, tested reads + writes. Revoked the legacy HS256 shared secret in Supabase → JWT Keys → Previously Used Keys. Compromised `eyJ...Im4` service_role JWT is now dead. Supabase audit logs spot-checked for the 6-week exposure window (March 8 – April 22) — no anomalies. GitHub secret scanning alert marked as Revoked.
   - Admin writes go through `/api/admin` proxy with `sb_secret_*` server-side; client-side reads use `sb_publishable_*`. No JWTs remain anywhere in the Civicscope repo.
8. RYC GC Tenant Onboarding — set up RYC as first real tenant in GC white-label
9. Scheduler Supabase Persistence — move localStorage data to Supabase table
10. Fix PS1 vercel.json Regex — push_ryc_schedule.ps1 route injection failed; fixed manually on GitHub
11. ~~**Procore creds hardcoded in ryc-schedule-tasks.js**~~ — **RESOLVED** (April 10) — Procore detected exposed client secret in GitHub, forced rotation. Hardcoded creds replaced with `process.env.PROCORE_CLIENT_ID` / `process.env.PROCORE_CLIENT_SECRET`. Vercel env vars updated with new secret. Pushed to GitHub.
12. **Move daily digest cron to VM** — Vercel Hobby cron is unreliable (missed April 9-10 digests). Move to VM cron as a `curl` trigger, same pattern as bookmarks pipeline. Part of broader daily-email framework (see project memory `project_vm_cron_framework.md`).

## INCIDENT + FIX (June 16, 2026) — all tools were down (model retirement)
- **Symptom:** every tool returned "something went wrong"; sites loaded (HTTP 200) but estimates failed. Surfaced via a prospect (owner's rep, GA) emailing the AAN inbox after hitting the error — NOT by any alert.
- **Root cause:** all 7 tools hardcoded `claude-sonnet-4-20250514` (Claude Sonnet 4), which reached **scheduled retirement ~June 15, 2026**. The Anthropic API began returning `404 not_found_error` for it → `api/claude.js` passthrough relayed the 404 → generic tool error. (Unrelated to the same-day Anthropic credit depletion, which was already fixed.)
- **Fix #1 (model):** swapped `claude-sonnet-4-20250514` → `claude-sonnet-4-6` (rolling alias) in all 7 live tools + this doc; deployed (`7dc99b1`); verified.
- **SECOND root cause (found after Schools/Infra still failed):** all tools share `max_tokens: 1200`, but the **Schools + Infrastructure** prompts are richer and their JSON responses run **~1,150–1,300 tokens — at/over the 1,200 cap → truncated mid-JSON → `JSON.parse` throws → "something went wrong."** Municipal's shorter prompt fit under 1,200, which is why it worked while the other two didn't (same code, same cap, different output sizes). **Fix #2:** raised `max_tokens: 1200 → 2400` on civicscope/schools/infrastructure; deployed (`a8018f5`); verified all three return clean estimates.
- **Also fixed:** `/qa` was 404 — the `vercel.json` rewrite was missing (only `/admin` existed). Added `{ "/qa" → civicscope-qa }`; deployed (`589a77d`); now 200.
- **Monitoring built (cs-health, LIVE):** synthetic health-check on the VM every 10 min — fetches each tool's **actual** model off its page + runs a real structured-JSON estimate, emails Keith on failure with the named cause. Catches model-retirement / credits / truncation / site-down per tool. See memory [[project_civicscope_health_check]]. (v1 only pinged a hardcoded model → gave a FALSE "recovered" while Schools/Infra were down; rebuilt to read each tool's real model.)
- **Follow-up status (2026-06-17):** (1) **CivicScope QC process — BUILT** (post-deploy smoke gate in `push_civicscope.ps1` + `scripts/smoke-test.js`, daily VM smoke `cs-smoke-daily`, rebuilt `/qa-check`; `api/claude.js` now pins `maxDuration: 120` on Vercel Pro). See the QC bullet under Open Action Items. (2) **enable Anthropic auto-reload** — STILL OPEN (console toggle). (3) never pin a dated model — use the rolling alias. (4) NEW robustness item: harden the tools' JSON parse against occasional model prose (intermittent "something went wrong").

## Recent Changes (July 8, 2026) — Fable review: pivot verdict UPHELD + sharpened
Full independent review (funnel forensics from both Supabases + Resend logs, 8 live puppeteer drives, 375px sweep, plumbing verification): **`work product/CivicScope_Fable_Review_2026-07-08.md`**. Headlines:
- **Product is healthy — failure is commercial.** 8/8 drives clean, zero JS errors, full depth renders on all 3 verticals, July 6 claim cleanup confirmed live on every surface, email loop proven in production (real .gov users opened reports Jun 22–30). Do NOT redesign anything.
- **All 19 leads ever captured: `contacted=false`.** The funnel's bottom was never worked once — founder follow-up capacity is the binding constraint, which *strengthens* the pivot. "Contact CivicScope for guidance" CTA: 0 uses in 32 days live.
- **June = best month ever (36 runs) with zero sends — all organic splash-pad SEO, national** (NY/GA/WI/TX/AL…), small-ticket. The 5 SEO pages are the only acquisition channel that ever worked; wrong geography/ticket for JBK → keep as marketing infrastructure, stop grading as a business.
- **Campaign ledger corrected:** all 1,154 sends completed May 21 (the "51+17 pending" backlog item was stale-done); campaigns dormant 7 weeks. **The funnel meter never collected** — `delivered_at` only on the final 62-send batch, opens structurally 0 (plain-text), clicks scanner-noise (42/78 = one slug) → the "read the funnel first" gate is dead; Resend dashboard = delivery ground truth.
- **Value ledger:** Municipal tool + SEO pages KEEP (marketing infra) · Schools = wedge engine (KEEP+invest) · Infra KEEP-cheap · GC public white-label PARK (1 demo tenant ever; real GC product lives at /ryc/estimate) · Pro stays dead · daily digest/cs-health/QC gate exemplary (fired daily without a gap; caught both June outages).
- Fixes R1–R6 queued in Open Action Items above; R1 (work the leads) needs Keith personally.

## Recent Changes (July 6-7, 2026) — GTM pivot verdict + trust cleanup + RYC data-provenance
- **Codex GTM review → PIVOT verdict (2026-07-04).** Brutally-honest SaaS-advisor review: CivicScope is **not a standalone horizontal SaaS** (months of outreach → ~5 attributed runs / 0.5% / $0 revenue). Real payer isn't a municipal employee — it's a **BOT/P3 developer** paying for project origination (= JBK) or a contractor buying the **white-label estimator** (= RYC). Sharpest wedge = **Indiana school BOT** (SEA 1 + referendum-free). **Converges with the estimator calibration: the AI cost NUMBER is a wedge, not the product.** **DECISION (Keith, 2026-07-06): keep CivicScope NEUTRAL for now** (no JBK branding); school-BOT origination runs founder-led. 30-day plan at `work product/CivicScope_School_BOT_Pivot_30Day_Plan.md`. Full context: memory [[project_civicscope_gtm_pivot]].
- **Trust/claim cleanup — SHIPPED (smoke+E2E verified).** `9e7acd4`: removed the unsupportable **"typically within 15–25% of actual bid ranges"** claim (the calibration backtest proves it false), fixed the **"emailed as PDF"** promise (email is HTML — now "emailed to your inbox"), cleaned stale "In development" infra copy. `ff2ac50`: **softened overreaching benchmark claims** on all 3 tools + 3 landings — "Not an AI guess" → "Not a number pulled from nowhere"; "Historical construction benchmarks" → "Regional construction-cost patterns"; "we use regional cost data" → "we tailor the range". (The public tools just prompt `/api/claude` with no benchmark data injected — we do NOT have public benchmark data to back the old claim; only the RYC estimator legitimately injects real data.)
- **RYC data-provenance / audit layer (2026-07-07).** New shared **`ryc-dashboard/data-sources.js`** (field-provenance "📖 Data Sources" modal) loaded by BOTH `/ryc/dashboard` (v1.28.0, + new Work-on-Hand Report) AND `/ryc/foundation` (the NL→SQL tool). `/ryc/foundation` gained a live-vs-nightly/raw-vs-derived banner; its VM prompt now enforces dashboard conventions. See RYC CLAUDE.md + memory [[project_ryc_dashboard_audit_handoff]].

## Recent Changes (June 6, 2026) — Major restructure: Pro shelved, Infrastructure built, depth folded in
A 5-phase rebuild this session, all live and verified:
- **QA test harness in `/admin`** — per-vertical "Run sample" + "Send test lead" buttons open the live tool with `?qa=<preset>&autorun=1[&lead=1]`; the tool prefills realistic sample data, auto-runs, and (with `lead=1`) auto-submits a real lead email. QA mode sets `window._qaMode=true`, which short-circuits `logAction()` so test runs never hit `tool_runs`/`leads`. Presets: municipal=DPW garage (La Porte), schools=HVAC+roof reno (PHM), infrastructure=water main (Bristol).
- **NEW Infrastructure tool** — `civicscope-infrastructure/index.html` (cloned from schools). 8 heavy-civil project types (water main, sanitary sewer/lift station, storm/drainage, road, water treatment, wastewater treatment, water tower, other); prompt tuned for LF/capacity/lane-mile basis, dewatering, traffic control, restoration, SRF/BOT framing; council briefing; infra roles; `product:'infrastructure'`. Routed in vercel.json, in `push_civicscope.ps1` manifest, tier-labeled in `api/email.js`.
- **Pro depth folded into all 3 free tools** — cost methodology (added to the main `/api/claude` JSON), full timeline (un-blurred, rendered inline via `renderTimeline`), buyer's advocate guide (separate `fetchAdvocate` call), edit & re-run banner. Ported from `civicscope-pro`, re-skinned to orange `--accent`, "PRO" badges dropped.
- **Gate re-scoped to report-only** — timeline blur/tease removed; everything renders on-screen free. Gate only sends the report + lead notification. **Lead notification email now includes Build Type, Site Conditions, and the typed project description** (for follow-up).
- **Pro shelved + contact CTA** — inline "Contact CivicScope for guidance" form on all 3 tools → new `contact_inquiry` action in `api/email.js`. Pro teases stripped from tools + `for-government`/`for-schools` pricing grids (now "It's free"); `/pro` 301→`/`; admin Pro card marked shelved; `civicscope-pro/` archived (still deploys, unlinked).
- **`for-infrastructure` + hub flipped LIVE** — coming-soon/notify-form → "Use the tool" CTAs to `/infrastructure`; hub Infrastructure card un-muted; landing footers updated to the three live verticals; mini-cost SEO page `/pro` footer links repointed to Schools.
- Free tool bumped **v2.1.0 → v2.2.0**.

## Recent Changes (June 1, 2026)
- **Vertical/audience expansion — CivicScope for Schools + segment hub pages.** Turned the single municipal tool into an audience-segmented suite.
  - **New tool:** `civicscope-schools/` → `app.civicscope.io/schools` — School Facility Cost Estimator (sibling to Free/Pro; school-specific project types via `type-icon` cards). No version comment yet.
  - **New marketing hubs** on www: `for-government/`, `for-schools/`, `for-infrastructure/` (see Product Suite → Segment Hub Pages). Routes, `sitemap.xml`, and `push_civicscope.ps1` manifest all wired.
  - **for-schools v1.1.0** (this session) — added the page's first illustrations to reach parity with `for-government`: a schoolhouse hero editorial sketch with an orange cost-callout bubble ("$1.4M–$2.1M · Elkhart Co., IN · HVAC + roof"), and a **Build → Operate → Transfer** 3-step flow diagram in the BOT section. Ink line-art on cream (NOT the white-on-dark government SVGs) to fit the schools page's lighter aesthetic. Deployed commit `ed6af6a`.
  - **Schools positioning:** BOT authorized for school corporations under **IC § 5-23** (no bond referendum); framed against the **SEA 1 (2025)** operations-fund squeeze. Names JBK Development as a school-BOT-experienced developer.
  - *Process note:* this build wasn't documented at the time because a second concurrent Claude session reconstructed it from file timestamps. Always `/log` mid-build.
- **Story-format rebuild of the whole www front end (June 1, later same day).** Keith's direction: `for-government` is the gold-standard storytelling page; generalize it to the hub and make schools + infrastructure mirror it.
  - **Logo restored sitewide** — segment/hub headers had degraded to a plain orange dot (`.cs-wordmark-dot`). Re-added the real mark via shared `.cs-wordmark-svg` (building glyph + stacked "Civic / SCOPE", cream/orange) on `index`, `for-schools`, `for-infrastructure`; `for-government` + the schools tool already had it.
  - **`for-schools` → v2.0.0** — replaced the thin v1.1.0 landing with a full clone-and-reskin of `for-government` + the schools-only BOT section. Deployed `deb0d3a`.
  - **`for-infrastructure` → v2.0.0** — same full-story rebuild as a "coming soon," with a **functional** notify form (`notify_capture` → `api/email.js`, already wired, emails Keith). Deployed `c556ab7`.
  - **Hub `index.html` → v1.1.0** — wove the government story in ("Why CivicScope exists" + "Start with the number" CTA); kept the existing 3-tool chooser (Gov + Schools Live, Infra Coming soon). Deployed `ebf56e8`.
  - **Schools TOOL fix (`civicscope-schools`)** — Site Conditions (topography + "Utilities On-Site *") were showing/required even for HVAC/roof/renovation, where they're meaningless. Now the whole Site Conditions section is **hidden unless build type = New Construction** (`toggleSiteConditions()`), and the utilities-required validation only fires for new construction. Deployed `c556ab7`.

## Recent Changes (May 22, 2026)
- **Email opt-out enforcement — BUILT & DEPLOYED.** Closes the gap where a "STOP" reply had no system to honor it (CAN-SPAM + .gov reputation risk).
  - **Suppression source of truth:** CRM `contacts.tags` containing `do-not-email`. `CRM/api/cs-campaign.js` `seed_audience` excludes tagged contacts (array-contains query); `send_batch` pulls contact `tags` and skips opted-out contacts, marking the send `suppressed` (returns a `suppressed` count). No opted-out contact can be seeded or sent to.
  - **One-click unsubscribe:** every campaign send now carries a plain-text footer link **and** a `List-Unsubscribe` header → `app.civicscope.io/unsubscribe?c={contact_id}` (`Civicscope/api/unsubscribe.js`, `/unsubscribe` rewrite in vercel.json). **Two-step** (GET = branded confirm button, POST = acts) so .gov link-scanners — which only GET — can't auto-unsubscribe real recipients. The POST calls `CRM/api/cs-unsubscribe.js` **server-side** (shared `CS_UNSUB_SECRET`, set in both Vercel projects) so the recipient only ever sees civicscope.io (no JBK/CRM domain leak). Verified end-to-end with a throwaway contact.
  - **First opt-out honored:** Al Knable (Floyd County Commissioner, `aknable@floydcounty.in.gov`) replied "Stop" to Commissioner T3 on May 21 → tagged `do-not-email` + `cs-opted-out`. 120-day inbox sweep confirmed he's the only campaign opt-out to date.
  - **Routing note:** `keith@civicscope.io` / `info@civicscope.io` replies forward to **keith@anchoradvisorsnorth.com** (AAN inbox) — NOT the JBK Gmail connector. Read via the AAN OAuth token (`AAN_GMAIL_REFRESH_TOKEN` in CRM Vercel). See memory `reference_aan_inbox_access`.
  - **TODO (CAN-SPAM):** add a physical postal address line to the campaign footer — legally required, not yet present. Needs the CivicScope/AAN business mailing address.
- **Open tracking — confirmed ON in Resend (track.civicscope.io verified), but Opened will always read 0.** Campaign sends are plain-text and Resend's open pixel only embeds in an HTML body. This is the right trade (plain text = better .gov inbox placement; opens are noise from Apple MPP + gateway prefetch anyway). **Read the funnel as Delivered → `/try` click → tool_run; ignore the Opened stage.** Click tracking stays OFF (we use `/try`).
- **Bad-contact purge (data hygiene).** Deleted 11 unmailable campaign contacts: 3 hard-bounced .gov addresses (Billy Hoffman/Ohio Co., Rhonda Yoder/Goshen, Derek Dieter/St. Joseph Co.) + 8 import placeholders whose email was the literal string `not found` (David Richards + 7). Company records retained, so org-level leads survive. Kept Brian Dissette (valid mailbox, departed Berrien Co.; successor Michael J. Sepic recorded). Root cause for the placeholders: an enrichment import wrote `"not found"` into the email field instead of NULL.

## Recent Changes (April 24, 2026)
- **CivicScope LinkedIn Page created** — credibility surface for IEDA/municipal outreach prospects who Google the brand. Not a content channel (no posting cadence committed — JBK Page already absorbs that load). Brand assets built:
  - Square profile logo (800x800, building icon + stacked Civic/SCOPE wordmark on cream w/ orange accent bar) — [civicscope-li-logo-square.png](Civicscope/work product/linkedin/civicscope-li-logo-square.png)
  - Icon-only fallback (800x800) — [civicscope-li-logo-icon.png](Civicscope/work product/linkedin/civicscope-li-logo-icon.png) (weak at hero size; use only if LI needs a non-wordmark fallback)
  - Page cover banner (2256x382, 1128x191 @2x) — [civicscope-li-cover.png](Civicscope/work product/linkedin/civicscope-li-cover.png). Banner content shifted right to x=240px to clear LI's profile-logo overlay zone at bottom-left. Current tagline on right: *"A cost reality check before the vote."*
  - HTML sources in [Civicscope/work product/linkedin/](Civicscope/work product/linkedin/) for future re-renders via `skills/render-image/render-image.js`
  - Page description: *"AI-powered cost feasibility for municipal projects - in 30 seconds."*

## Recent Changes (April 7, 2026)
- **Free v2.1.0 + Pro v2.10.0 — Report email + in-experience overhaul:**
  - **Email: Delivery Path section** — new side-by-side cards (Traditional Design-Bid-Build vs Recommended BOT/P3 with GMP) inserted between Key Assumptions and Timeline.
  - **Email: Board or Council Briefing** — replaced old "Council Briefing Guide" (scripted opening line + Q&A pairs) with 3 fixed talking points + recommended ask. Still conditional on `briefingHtml`.
  - **Email: What to Do Next** — new 3-step section (validate range, consider delivery path, talk through numbers) with numbered orange circles. Inserted after briefing, before footer CTA.
  - **Email: Section reorder** — Cost → Assessment → Assumptions → Delivery Path → Timeline → Board or Council Briefing → What to Do Next → Footer CTA.
  - **In-experience: `renderBriefing()` stripped** — removed Opening Line and Likely Council Questions & Suggested Answers blocks from both Free and Pro. Keeps Key Talking Points (AI-generated) and Recommended Ask.
  - **In-experience: Heading renamed** — "Council Briefing Guide" → "Board or Council Briefing" with updated subtitle.
  - **In-experience: Sidebar updated** — "Council briefing guide — AI-drafted talking points" → "Board or council briefing — talking points and recommended ask" (Free). Pro sidebar and feature pill updated similarly.
  - **Admin version cards updated** — Free v1.8.0 → v2.1.0, Pro v2.7.0 → v2.10.0.
- **GC Internal v1.5.0 — Batch upload for large plan sets** — removed 20-page PDF cap. Large documents are now automatically split into batches of ~10 pages each. Batch 1 gets the full estimator prompt; subsequent batches extract supplemental details; a final consolidation call merges everything into one unified estimate. 15-second delays between batches to respect Anthropic API rate limits (30K input tokens/min). Auto-retry on 429 with 30s backoff. Loading bar shows batch progress throughout. A 57-page plan set runs in ~3-4 minutes across 6-7 batches.

## Recent Changes (March 31, 2026)
- **Free v2.0.0 + Pro v2.9.0 — Results page redesign** — major UI overhaul on both Free and Pro tools:
  - **Utilities input simplified** — 4 checkboxes replaced with Yes/No toggle buttons. Required field, no default.
  - **Cost hero bar** — dark full-width bar at top of results with cost range + realistic timeline side-by-side. Confidence line below.
  - **Results body** — narrative, delivery cards, and assumption chips in a single connected card below the hero bar.
  - **Delivery path comparison** — side-by-side cards: Traditional (Design-Bid-Build) vs Recommended (BOT/P3). BOT card has orange border, "Recommended path" eyebrow, and lead bullet: "You select your team based on qualifications and trust — not lowest bid." Indiana/Michigan law reference.
  - **Assumption chips** — 2-column grid of styled chips replacing bullet list.
  - **Sidebar collapse** — right-rail explainer panels hide when results display, grid collapses to full-width. Restores on re-run.
  - **"What to Do" step 3 removed** — "Get a formal opinion of probable cost" step cut (was sending users to architects before engaging with CivicScope).
  - **Old procurement block removed** — replaced by delivery cards inside results body.
  - **Timeline in hero bar** — Free: total from Claude response. Pro: populated when timeline API call completes.
  - Backup files at `civicscope/index.html.bak-2026-03-31` and `civicscope-pro/index.html.bak-2026-03-31`.

## Recent Changes (March 24, 2026)
- **Ref tracking** — `?ref=` URL parameter captured on tool_runs for campaign attribution. Added `ref` column to Supabase `tool_runs` table, wired through `api/log.js` and `civicscope/index.html`. Tested and confirmed working.
- **Report email timeline fix** — `timeline` field was not destructured from request data in `api/email.js`; now passes through to `buildReportEmail()` and renders in the email.
- **Layout fix** — `.cta-block.next-steps` had undefined CSS vars (`--bg-alt`, `--border`) replaced with `--cream-dark`, `--rule`; added `display:block` to override parent flex layout.
- **Post-form CTA** — hidden block revealed after gate submission: Pro upsell + info@civicscope.io contact line.
- **Daily digest** — `api/digest.js` sends daily summary (runs, leads, campaign tracking by ref) at 7am ET via Vercel cron. `CRON_SECRET` env var required. Sends "quiet day" email when no activity (updated March 26).
- **Messaging overhaul** — Landing page hero: "Get a cost range on any municipal project in 30 seconds." Free tool: "You've got a project idea. Let's see if the budget holds up." Bridge sentence above THE PROBLEM section. Landing v1.2.0, Free v1.9.1.
- **Pro early access form** — swapped from dead Formspree to Resend via `api/email.js` `pro_capture` action.
- **Contact CTA** — "Want to talk?" line added to report email footer and landing page Get Started section.
- **Push script updated** — `push_civicscope.ps1` now includes `api/log.js` and `api/digest.js`

---

## Recent Changes (March 2026)
- Free v1.9.0 / Pro v2.8.0: Removed JBK CTA block; added "What to Do Next" 4-step list, neutral delivery path comparison, timeline tease, Pro nudge
- GC External v1.6.0-gc: New/Renovation toggle, expanded project types, sq footage field, file upload + Claude Vision
- Email routing: All lead notifications → info@civicscope.io; JBK references removed
- RYC Scheduler v1.0.0: Built and deployed

---

## Key Learnings
- Cloudflare Email Address Obfuscation rewrites mailto: links at CDN layer — workaround is data-cfEmail="" on anchor. Moot since JBK CTA removed in v1.9.0.
- api/claude.js is a **prompt** passthrough — never inject/rewrite prompt content server-side. It DOES (added 2026-06-23, after the Anthropic 529 "elevated error rate" outage) add **transport resilience**: bounded retry-with-backoff on 429/5xx/529, then an **OpenAI-compatible fallback** that translates the Anthropic-shaped request → OpenAI and the reply back into Anthropic's `{content:[{text}]}` shape (no tool change). Fallback is OFF until `OPENAI_API_KEY` is set in Vercel; model via `OPENAI_FALLBACK_MODEL` (default `gpt-4o` — NOT Codex, a code model). Text-only requests only (GC image/doc uploads skip fallback). Retry/transport changes here are allowed; prompt passthrough is the invariant.
