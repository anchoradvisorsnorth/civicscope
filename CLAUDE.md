# CLAUDE.md — Civicscope Module

> Root context: Cowork\CLAUDE.md

---

## What It Is
AI-powered municipal construction cost feasibility tool. Four product versions serving different audiences, all powered by the same Anthropic API proxy. Standalone SaaS — no JBK branding anywhere.

**Repo:** anchoradvisorsnorth/civicscope

> **New product — Groundwork newsletter (built May 26, 2026):** Weekly (Tuesday AM) CivicScope-branded civic-development newsletter for greater Michiana — CivicScope's top-of-funnel + authority engine. **v1 fully built and deployed at [groundwork.civicscope.io](https://groundwork.civicscope.io).** Pipeline: collectors → extractor → assembler → web archive. Edition #1 in `civic_issues`. Remaining work: Resend send wiring, VM cron, PDF fallback for packets, Cost Lens integration. See **Groundwork architecture** section below.
**Hosting:** Vercel (auto-deploy from GitHub)
**DB:** Supabase — raw fetch only, NEVER @supabase/supabase-js
**Email:** Resend from info@civicscope.io
**AI:** All tools → api/claude.js → claude-sonnet-4-20250514, temp 0.3, max_tokens 1200
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
- /admin, /qa are literal rewrites
- :slug wildcard LAST

---

## Deploy Workflow
1. Edit files locally in Cowork\Civicscope\
2. Run PUSH_CIVICSCOPE.bat — pushes product HTML + api/*.js
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

- **Finish in-flight campaign sends** — 51 Commissioner T3 pending + 17 Municipal T2 pending. Resend is on Pro now (no daily cap); pacing is for .gov inbox reputation, not quota.
- **Build next campaign informed by funnel data** — let the post-instrumentation funnel report read first (Delivered → /try click → tool_run). Candidates: IEDA Touch 2 (warmest), Municipal Touch 3, net-new segments (superintendents, additional counties). Every new campaign changes a variable.
- **CAN-SPAM postal address** — add physical mailing address line to the opt-out footer. Legally required, not yet present. Needs the CivicScope/AAN business mailing address.
- **Groundwork — Resend send wiring** — actual newsletter delivery via Resend (`/api/groundwork-send.js` + `civic_issue_sends` updates). Until built, editions are draft-only.
- **Groundwork — VM cron** — daily run of all 7 collectors + weekly Tuesday assembler. Same pattern as bookmarks pipeline. Currently all manual.
- **Groundwork — PDF fallback for Mishawaka packets** — server text endpoint returns empty for the 28MB Agenda Packet PDFs; need pdftotext-based fallback to capture the rich content for Cost Lens.
- **Groundwork — Cost Lens integration** — wire `civic_projects.cost_lens_run_id` to an actual CivicScope estimate (run /civicscope on a project, store the run_id, surface the result in the Cost Lens section).
- **Groundwork — project tracker polish** — current fuzzy name match misses some touchpoint dedup (e.g., McKinley redevelopment appeared as 2 projects). LLM-based canonical name resolution or address-keyed dedup.
- **Facebook Ads pixel** — create a CivicScope-specific Meta Pixel in Business Manager (separate from MTP/AAN pixel). Implementation plan at `Civicscope/FB_AD_IMPLEMENTATION_PLAN.md`.
- **Move daily digest cron to VM** — Vercel Hobby cron is unreliable (missed April 9-10 digests). Move to VM cron as a `curl` trigger, same pattern as bookmarks pipeline.
- **RYC GC Tenant Onboarding** — set up RYC as first real tenant in GC white-label.
- **Municipal Agenda Notifier — voice tuning** — caption is neutral civic v1; tune to Councilman Steven Clark's actual voice after he reacts to the first real June draft (June 11–18 window). Tool is LIVE; this is refinement.
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

## Municipal Agenda Notifier (built 2026-05-31)

CivicScope sub-product, **sibling to Groundwork**. Watches a Cloudflare-protected county site for the monthly council agenda; on a new posting, drafts a constituent-facing Facebook post and emails it to Keith to review → forward. First user: **Councilman Steven Clark** (Elkhart County Council). **LIVE on the VM.**

- **Source:** `Cowork\Civicscope\agenda-notifier\` (council_agenda.py + README). Runtime on VM at `/home/azureuser/council-agenda/`, daily cron 11:30 UTC (self-gates to ~7 days before each 3rd-Thursday meeting).
- **Engine:** FlareSolverr (Docker :8191) solves Cloudflare → `curl_cffi` (Chrome TLS impersonation) downloads the PDF → PyMuPDF text + page PNGs → Sonnet 4.6 drafts FB-safe caption → Resend (civicscope.io, from agenda@civicscope.io) emails keith@jbkdevelopment.com.
- **Why it matters to CivicScope:** the CF-bypass + PDF-text engine **solves the open "Groundwork — PDF fallback for Mishawaka packets" backlog item** and adds Cloudflare-walled county sources Groundwork can't currently reach. Kept standalone for now; candidate to share a CF/PDF lib with Groundwork later.
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
- api/claude.js is pure passthrough — never modify it to inject prompts server-side
