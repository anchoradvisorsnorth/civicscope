# CLAUDE.md — Civicscope Module

> Root context: Cowork\CLAUDE.md

---

## What It Is
AI-powered municipal construction cost feasibility tool. Four product versions serving different audiences, all powered by the same Anthropic API proxy. Standalone SaaS — no JBK branding anywhere.

**Repo:** anchoradvisorsnorth/civicscope
**Hosting:** Vercel (auto-deploy from GitHub)
**DB:** Supabase — raw fetch only, NEVER @supabase/supabase-js
**Email:** Resend from info@civicscope.io
**AI:** All tools → api/claude.js → claude-sonnet-4-20250514, temp 0.3, max_tokens 1200
**Deploy:** PUSH_CIVICSCOPE.bat → GitHub Trees API → Vercel (~60s)

---

## Product Suite & Current Versions

| Product | URL | Audience | Version |
|---------|-----|----------|---------|
| Free | app.civicscope.io/civicscope | Municipal employees | v2.1.0 |
| Pro | app.civicscope.io/civicscope-pro | Municipal officials | v2.10.0 |
| GC External | app.civicscope.io/gc/:slug | GC prospective clients | v1.6.0-gc |
| GC Internal | app.civicscope.io/gc/:slug-internal | GC estimating teams | v1.5.0-gc-int |
| QA Tool | app.civicscope.io/qa | Keith only | v1.0.0-qa |
| Admin | app.civicscope.io/admin | Keith only | v1.0.0-admin |
| RYC Scheduler | app.civicscope.io/ryc/schedule | RYC crew | v1.0.0 |
| Pro Landing | civicscope.io/pro | Early access signup | — |

**Version rule:** Bump in BOTH the product HTML footer AND civicscope-admin/index.html product cards.

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
- /pro → pro/index.html
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
12. **Municipal campaign — Touch 1 in progress** — "Northern Indiana + SW Michigan Municipal" campaign created, 168 contacts seeded. Batch 1 (50) sent April 5. 118 pending. Templates: "Credibility Angle" (A) + "Permission Angle" (B). One auto-reply received (Holly Taylor, Valparaiso — inbox delivery confirmed, `[Suspicious URL]` flag is Valpo's email gateway, not Gmail).
13. **Commissioner campaign — Touch 2 in progress** — "Commissioner Touch 2 — Number Before the Vote" template created. Batch 1 (50) sent April 5. 101 pending. Single template (no A/B split).
14. **CS Campaign: Future touches** — write follow-up copy for commissioners Touch 3 and municipal Touch 2. Monitor engagement on Touch 2 sends. Consider `/try/{slug}` redirect on civicscope.io to reduce suspicious URL flags from municipal email gateways.
15. **IEDA Partners campaign — Touch 1 ready to send (April 20, 2026)** — Full IEDA directory imported into CRM: 237 new companies + 17 enriched (IN municipalities/EDCs already in CRM got county/notes/metadata backfilled). 380 new contacts + 9 enriched. Related parties filtered (R. Yoder Construction, JBK Development, Mike Miller, Keith Plummer). "IEDA Partners" campaign created in `cs_campaigns` (id `500aa3b7-330b-44b4-aa1c-6dee698d07f6`), 388 pending sends seeded at Touch 1 with `campaign_type: ieda-partner`. Ref slugs scoped to the IEDA member org (`ieda-dc-develop`, `ieda-baker-tilly-...`) so click attribution rolls up per firm. Single-variant template "IEDA Partners — Share Angle" (subject: *A cost reality check you can hand to your local officials*) active in `cs_email_templates`. **Resend Free tier is the binding constraint — 100/day cap, 3,000/mo** (confirmed via April 5–7 quota-warning emails during prior batches). Plan IEDA sends across ≥4 days or share quota with other active campaigns. Scripts: `CRM/scripts/ieda-import.js` (handles both companies/contacts, `SKIP_COMPANY_NAMES` list at top), `CRM/scripts/ieda-campaign-seed.js`. CSVs moved to `CRM/work product/imported/`.

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
