# CLAUDE.md — Civicscope Module

> Root context: Cowork\CLAUDE.md

---

> **📚 History & deep reference → [`HISTORY.md`](HISTORY.md)** — version history, dated change logs,
> retired/paused subsystems. Deliberately NOT loaded at session start; open on demand.
>
> This file is the **operating contract**: what it is, what's live now, how to work here, and
> what's open. Deep history goes to `HISTORY.md` **for findability, not for size** — nothing is
> deleted, condensed or summarised to hit a token number. There is no token budget here; the only
> legitimate size problem is genuine **read truncation**, fixed once by splitting into topic files
> behind a concise index, verbatim. Root `CLAUDE.md` § Execution Discipline → 7 and
> `auto-memory/feedback_preserve_context_verbatim.md`.
> *(Corrected 2026-08-05 — this line previously imposed a "~8K tokens" cap, contradicting the
> preserve-context rule Keith set 2026-08-01.)*

## What It Is
AI-powered municipal construction cost feasibility tool. Four product versions serving different audiences, all powered by the same Anthropic API proxy. Standalone SaaS — no JBK branding anywhere.

**Repo:** anchoradvisorsnorth/civicscope

> **Groundwork newsletter — PAUSED (as of 2026-06-11).** Weekly CivicScope-branded civic-development newsletter for greater Michiana. v1 was fully built and deployed at [groundwork.civicscope.io](https://groundwork.civicscope.io) (collectors → extractor → assembler → web archive; Edition #1 in `civic_issues`), but the project is **on hold** — its remaining work (Resend send wiring, VM cron, PDF fallback, Cost Lens) is NOT active. See **Groundwork architecture** section below. **NOTE:** Groundwork and the **Municipal Agenda Notifier** (the live Clark tool, below) are **separate products** — Groundwork grew out of the Elkhart/Clark agenda exercise but must not be merged with it.
**Hosting:** Vercel (auto-deploy from GitHub)
**DB:** Supabase — raw fetch only, NEVER @supabase/supabase-js
**Email:** Resend from info@civicscope.io — **Free tier since 2026-07-19** (was Pro May 21–Jul 19; campaigns dormant, ~50 sends/mo, free caps 3,000/mo·100/day·1 domain are fine). **Account login = keith@anchoradvisorsnorth.com** (NOT info@civicscope.io — resets/billing land in the AAN Gmail)
**AI:** All tools → api/claude.js → **claude-sonnet-4-6**, temp 0.3. **max_tokens: 2400** on Municipal/Schools/Infrastructure (raised from 1200 on 6/16 — Schools/Infra responses run ~1,150–1,300 tokens and truncated mid-JSON at 1200); GC/other tools still 1200. `api/claude.js` pins `maxDuration: 120` (Vercel Pro) so a long Schools run can't 504. (Model was `claude-sonnet-4-20250514` until it RETIRED ~June 15, 2026 → 404'd every tool; see Recent Changes June 16. **Never pin a dated/soon-retiring model — use the rolling alias.**)
**Deploy:** PUSH_CIVICSCOPE.bat → GitHub Trees API → Vercel (~60s)

---

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

---

## Prompt Standards (all versions)
- Include: contractor overhead, GC markup, permitting, engineering/design (3-5%)
- Exclude: land acquisition
- Confidence: High / Medium / Low — never "Moderate"
- Vague descriptions → Low confidence, wider ranges
- No proprietary database names (RSMeans, Gordian)

---

---

## API & Infrastructure
- All api/*.js use raw fetch to Supabase REST
- api/claude.js is a pure passthrough — prompts built client-side
- Vercel env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
- Email routing: Free/Pro → info@civicscope.io; GC → tenant notify_email + BCC Keith
- No JBK references anywhere — removed March 2026

---

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
- **/pool — "The Pool" unified hub (2026-07-19).** All friends'-pool pages (hidden personal, not a CivicScope product) merged under `pool/`: hub `index.html` + `golf.html`/`golf-picks.html` + `football.html`/`football-picks.html`/`commish.html` + **`live.html` (NEW 2026-08-09 — `/pool/live`, the bookmarkable phone-first live tracker)** + **`scoring.js` (NEW — the ONE client-side copy of the pool scoring rules, loaded by both `football.html` and `live.html`; mirror any change in `api/football-pool.js` and nowhere else)** + `sms.html` (A2P opt-in form → `sms_optin` action) + `privacy.html`/`terms.html` (A2P legal). Old `/golf*` + `/football*` URLs **301-redirect** (vercel.json; old file paths = meta-refresh stubs). APIs unchanged: [api/golf-pool.js](api/golf-pool.js) (`GOLF_POOL_CODE`) + [api/football-pool.js](api/football-pool.js) (`FOOTBALL_POOL_CODE`; `GET ?ver=1` returns its `VER` const — bump every edit + curl-verify live after deploy). Pool emails: `reply_to keith@anchoradvisorsnorth.com` on every send (pool@ has no mailbox — replies bounced before 7/19). **Full state/conventions live in `Cowork\Pools\CLAUDE.md` — read it before ANY pool work** (golf history incl. The Open final BOB, football demo state, no-odds rule, Twilio SMS status).
- **/invoices — RYC Invoices, the AP register (NEW 2026-08-11).** Third RYC workspace in the
  shared shell (`ryc-invoices/`), alongside `/ryc/estimate` and `/ryc/command`. `/invoices`,
  `/invoices/:path*` and `/ryc/invoices` all rewrite to `ryc-invoices/index.html`. Deliberately
  NOT a Command page — Command reports on the business, this is where a PM does a job daily.
  Backed by `api/ryc-invoices.js` + `schema_ryc_invoices.sql`. Per-PM access via `?c=<code>`
  (`RYC_INVOICE_PMS`) or a signed `?k=` link (`RYC_INVOICE_LINK_SECRET`); the server derives the
  PM from the credential and there is no `pm` parameter a browser can send. Scans live in the
  PRIVATE Supabase bucket `ryc-invoice-scans`, served as 15-minute signed URLs. Full detail:
  **RYC CLAUDE.md**.
- /admin, /qa are literal rewrites
- :slug wildcard LAST

---

---

## Schema Changes (Supabase)
**Data goes through the service-role REST API. SCHEMA goes through versioned migrations** —
`Civicscope\migrations\NNN_name.sql` plus a required `NNN_name.verify.sql`, applied by
`node scripts/db-migrate.js apply`. Dry run is the default; the migration, its verification
assertion and the ledger row commit as ONE transaction, so a failed verify rolls the change back
instead of leaving a half-true schema live. Full contract:
[`migrations/README.md`](migrations/README.md).

**Do not ask Keith to paste SQL into the Supabase SQL editor.** The wrapper authenticates itself
from protected storage and refuses to run unless the API confirms it is pointed at the CivicScope
production project — by reference, name and health — before doing anything. (The reference itself
is not written here: this repo is PUBLIC, and infrastructure identifiers belong in
`infra/env-var-inventory.md`, not in a public git history.) Root `CLAUDE.md` § Execution
Discipline → 10 is canonical.

⚠ **The 15 legacy `schema_*.sql` files in this folder are NOT in git** — `Cowork/.gitignore`
ignores `Civicscope/**` with narrow re-includes, so the DDL defining production has no history,
no diff and no undo. New work goes in `migrations/`; whether to re-include
`Civicscope/migrations/**` and `Civicscope/scripts/db-migrate.js` (both secret-free by inspection)
is a one-line decision for Keith.

## Deploy Workflow
1. Edit files locally in Cowork\Civicscope\
2. Run PUSH_CIVICSCOPE.bat `<comma,separated,paths>` `["message"]` — scope is REQUIRED
   - ⚠ `push_civicscope.ps1` must stay **UTF-8 WITH BOM** — the .bat runs Windows PowerShell 5.1, which reads no-BOM as ANSI and shatters on the script's em-dashes (bit 2026-07-08: deploy died at a parse error + "Press any key"). If a tool re-saves it without BOM, re-add before deploying.
   - Set `CS_DEPLOY_NONINTERACTIVE=1` for any agent/unattended run — it skips the `pause`/`set /p` prompts that otherwise block on a console.
3. Run PUSH_RYC_SCHEDULE.bat separately for RYC scheduler only
4. CLAUDE.md pushed separately via GitHub Contents API PUT
5. Validate at app.civicscope.io/qa after deploy

### Deploy exit-code contract (rebuilt 2026-08-07/08 — stall remediation + Codex review)
**Exit 0 means deployed AND verified. It is the only success code.** Anything else is not a deploy
you can report as done:

| Code | Meaning |
|---|---|
| 0 | deployed and verified |
| 10 | REFUSED — nothing shipped, safe to fix and retry |
| 20 | commit landed but its contents are wrong/partial — production changed |
| 30 | build failed, or the origin is not serving what was shipped — site NOT updated |
| 40 | deployed and built, but a verification gate failed |
| 50 | **deployed but NOT verified** — budget expired, verification skipped, or the build could not be tied to this commit. Re-run with `-Resume`. Not a hang, not a success |
| 60 | internal error |

**Verification is selected from the declared paths — you do not pick it.** Two axes combine:

*Profile* (functional depth): `pool/*`,`golf/*`,`football/*`,`api/{golf,football}-pool.js`,
`api/pool-sms.js` → pool integrity. `api/claude.js`, the three tool dirs, `civicscope.css`,
`api/{email,log,try,gc-*,qa-log,admin}.js` → estimating gates (smoke + browser E2E). `ryc-*`,
`api/ryc-*` and marketing/docs → no extra functional gate. **A pool deploy no longer runs the
three-vertical AI estimating gates** — minutes of unrelated Anthropic calls proving nothing.

*Capability* (what a path can even prove): **asset** → content proof · **api** → contract registry
in `scripts/verify-api-endpoints.js` · **config** (`vercel.json`/`middleware.js`/`package.json`) →
routing probes + an exact-commit READY build · **repo-only** (`memory/*`) → exact-commit READY
build. Mixed scopes take the union. Override with `-VerifyProfile`; inspect with `-DryRun`.

**API verification is a contract registry, not a liveness probe.** Every deployable `api/*.js` has
an entry: a *safe* request exercising the handler's real read path with an exact expected status
and a response-shape assertion (`golf-pool`, `gc-config?slug=acme`, `ryc-active`,
`groundwork-editions`, `football-pool?ver=1`); or *delegated* to a gate that genuinely drives it
(`api/claude.js` → the estimating smoke gate); or **no safe contract** because the only
unauthenticated surface is a guard and the real path writes/sends/charges. The last group is
**inconclusive → exit 50, never verified**. A 405 method guard is not evidence the changed code
works — a handler can break behind an intact guard. Adding an API to the manifest without a
registry entry also yields inconclusive, by design.

**A route with no safe contract is not permanently unverifiable — build it one (2026-08-13).**
`api/pool-sms.js` was registered `noSafeContract` ("Twilio webhook; the real path sends SMS"),
which was true and meant an api/pool-sms deploy **could never reach exit 0 — inconclusive by
construction, every time**. The fix was not to relax the gate but to give the handler a genuinely
safe read: `{action:'recent_messages', pw:…, limit:1}` authenticates to Twilio with the same
credentials every send uses, reads the message log for our own number, and writes nothing. That
exercises the real credential path rather than bouncing off the code guard. **The same question is
worth asking of every remaining `noSafeContract` entry**: is there a read that proves the handler
works, or is the route genuinely write-only? (It also answered an operational question that had
been unanswerable from a laptop — see `Pools/CLAUDE.md` 2026-08-13: the `TWILIO_*` vars are
Sensitive in Vercel, so only the deployed runtime can report what was actually sent.)

**The API contract registry supports POST contracts (added 2026-08-11).** Several handlers —
every RYC one — are POST-only, so a GET-only probe could never do better than `noSafeContract`
and an RYC API deploy could never reach exit 0. A POST contract is allowed under the same rule as
a GET one: **read-only, costs nothing, exercises the handler's real path** — not a bounce off a
guard. `api/ryc-invoices.js` uses `{action:"cost_codes"}`, a pure read of RYC's cost-code table.
Credentials still never appear in the file: a contract needing one reads it from the environment
(`RYC_ESTIMATE_PASSWORD`, see `infra/env-var-inventory.md`) and reports **CANNOT RUN ->
inconclusive** when absent, never a silent skip.

**Routing asserts destinations, not just "a redirect happened":** `/pro`→`/`, `/golf`→`/pool/golf`,
`/football`→`/pool/football`, `/ryc/dashboard`→`/ryc/command`, each with its exact 301 status,
matching `vercel.json`. A redirect to the wrong place, one replaced by a 200, or one that keeps
the right path **on a different host** all fail — an absolute `Location` must stay on the origin
under test (or an origin passed via `--allow-origins`), otherwise the same path off-site would
have counted as correct.

> An **API-only or config-only scope used to be unverifiable forever** — content proof skips paths
> that are never served, so it returned "inconclusive" and every `-Resume` repeated the same
> impossible check. Capability routing is what makes those scopes completable.

**Content proof compares against the commit, never the working tree.** The sha256 of each shipped
file is frozen at blob-creation time, persisted in the journal, and recoverable from the commit's
blobs on GitHub. This matters because 2–3 sessions share this tree: if another session rewrote a
file between the commit and the gate — especially back to the *previous* production bytes — a
worktree-based comparison would match the stale deployment and pass a commit that was never served.

- **`-NoSmoke` is deprecated and now means "verify nothing" → exit 50, never 0.** It no longer
  exists as a way to make a deploy finish faster; the profile does that correctly.
- **Long deploys:** run `-NoGate` (commit + build, exits **50**), then `-Resume` (gates, exits 0).
  Both fit inside a caller timeout. `-MaxSeconds` (default 540) is the script's own budget — it
  expires *before* the caller's so you always get a `DEPLOY-RESULT:` verdict instead of a kill.
- **`-Resume` is commit-centric and never writes anything.** It matches the journal on the declared
  *path set* + repo/branch/API — deliberately **not** on file contents — adopts that commit, and
  proves it still owns those paths in production before verifying. It cannot create a blob, tree,
  commit or ref update under any circumstance. If there is no matching journal
  (`NOTHING_TO_RESUME`) or a later commit has landed on those paths (`RESUME_SUPERSEDED`), it stops
  non-zero and asks for a fresh deploy. This matters because the tree is shared: matching on
  content meant a concurrent edit between the exit-50 and the `-Resume` made the journal look
  foreign, and the resume shipped *the other session's* bytes — a rollback commit if they had
  restored the previous production content.
- **A refused `-Resume` leaves `.deploy-journal.json` byte-for-byte untouched.** All resume
  validation runs before any journal object exists, so the write path is unreachable from a
  refusal. Previously, resuming with the wrong `-Paths` returned the correct `NOTHING_TO_RESUME`
  *and* erased the commit SHA, deployment id, frozen digests and gate progress of the deploy that
  was genuinely waiting — so retyping the right command failed too.
- **Duplicate-deploy guard:** if every declared file already matches production the script refuses
  to commit (`-AllowEmpty` forces it). A timed-out run resumes; it does not re-ship.
- Gate + harness scripts live in `scripts/` — **version-controlled but deliberately NOT in the
  deploy manifest** (they run on Keith's PC, they never ship): `smoke-test.js`, `e2e-check.js`,
  `verify-deployed-content.js`, `verify-api-endpoints.js`, `verify-routing.js`,
  `verify-pool-integrity.js`, plus `deploy-mock-server.js` + `test-deploy-harness.js`. All are
  secret-free — **every credential and pool access code comes from the environment only**; the
  rest of `Civicscope/scripts/` stays gitignored because it carries hardcoded keys.
  Local suite: `node scripts/test-deploy-harness.js` — fully mocked, no commit, no deploy, no
  network egress. **Certification is the `HARNESS-COMPLETE: <checks>, <scenarios>, exit 0` line**,
  not a screenful of PASSes and not a bare exit 0. The runner's markers:

| Marker | Means |
|---|---|
| `HARNESS-COMPLETE` | **the only certification.** Unfiltered run, every declared scenario ran, every assertion passed, no fatal event |
| `HARNESS-TARGET-COMPLETE` | a `--only` diagnostic passed. **Does NOT certify the suite** — most scenarios were deliberately skipped |
| `HARNESS-INCOMPLETE` | failed checks, scenarios that never ran, or a fatal event. Exits 1 |
| `HARNESS-FATAL` | an uncaught exception / unhandled rejection latched. Emitted immediately so the signal survives even if the process dies before the summary |

  A fatal event is **monotonic**: once latched, `HARNESS-COMPLETE` is unreachable and no timer can
  restore exit 0. `--only` is for diagnosis only; never quote it as a suite pass.
- A verifier that cannot run for lack of credentials exits **3 = "could not verify"**, never
  2 = "broken". The deploy turns that into exit 50, not a false failure.

---

## Key Points
- Sandbox (START_SANDBOX.bat → localhost:8888) — retain for risky changes only
- RYC Scheduler deploy is isolated — zero risk to civicscope.io
- Acme = demo tenant only, never modify
- **RYC = first REAL GC tenant — CREATED 2026-07-21** (slug `ryc`, id `ca502d19`, inserted via Supabase service key pulled from Vercel env — the admin secret is write-only "sensitive" type). `/gc/ryc` + `/gc/ryc-internal` LIVE but **unlisted** (leads notify keith@jbkdevelopment.com, NOT RYC — reveal held for Keith's dashboard-license conversation with Steve; see memory `project_ryc_dashboard_license_play`). Brand values/contact email pending Keith review in `/admin`. ⚠ Do NOT circulate `/gc/ryc-internal` inside RYC — the real internal estimator is `/ryc/estimate` (data-grounded); the generic white-label variant muddies that story. Command Center deliberately NOT tenant-wired until cutover auth or GC customer #2.

---

---

## Open Action Items

Forward-looking action queue. Source of truth for the CRM dashboard's "Across All Businesses → CivicScope" card. Curated at `/wrap`. Done items are removed, not strikethroughed — historical context lives in the `## Active Backlog` sections below.


- **CivicScope QC process (built 2026-06-17)** — response to the June 16 silent outage. Now in place: **(1)** rebuilt `/qa-check` skill (`skills/qa-check/SKILL.md`) — model-alias/`max_tokens`-headroom/`maxDuration`/push-manifest guards as section 1; **(2)** **two-stage post-deploy gate** in `push_civicscope.ps1`, both **fail the deploy** so "fixed" can't be reported on a broken ship: **(2a)** backend smoke `scripts/smoke-test.js` (real full estimate per vertical vs `/api/claude`, validates a cost range), **(2b)** browser E2E `scripts/e2e-check.js` (puppeteer-core + local Chrome; drives the REAL page via `?qa=<preset>&autorun=1`, asserts a cost renders in `#costRange` — catches client-side breaks the backend smoke can't see); **(3)** **daily VM smoke** (`cs-smoke-daily`, 8am ET) catches truncation/timeout from model drift the 10-min cheap probe misses; **(4)** `cs-health` (every 10 min) as the always-on catastrophic watch. The tools' JSON parse was hardened (strict → outermost-`{…}` fallback) so occasional model prose no longer 500s. **Gate scripts are local-only** (`Civicscope/scripts/`, not in the deploy manifest; the gate runs on Keith's PC). **Still TODO:** external dead-man's-switch (heartbeat service) so a *dead* cs-health pages Keith — pending Keith's healthchecks.io/UptimeRobot signup + ping URL; Anthropic auto-reload (console toggle); model-retirement calendar.
- **Activate the OpenAI fallback in `api/claude.js` (wired 2026-06-23, dormant).** After the June 23 Anthropic 529 "elevated error rate" outage, `api/claude.js` gained bounded **retry on 429/5xx/529** (live) + an **OpenAI-compatible fallback** that's OFF until `OPENAI_API_KEY` is set in CivicScope's Vercel. **To activate:** Keith provides a general-purpose OpenAI key (NOT Codex — it's a code model; fallback defaults to `gpt-4o`, override via `OPENAI_FALLBACK_MODEL`); Claude sets both env vars via the Vercel REST API (avoid the empty-string pipe gotcha) + redeploy. Can't be end-to-end tested without inducing an Anthropic failure — will self-validate on the next real 529. **New platform → add OpenAI to the tracker** (`opsStatus: watch` until proven).
- **External dead-man's-switch for cs-health (NEW 2026-06-17)** — cs-health is one VM cron; if it dies (VM/cron/script), there are no checks AND no alert — only the weekly AAN email surfaces it (too slow). Need an independent heartbeat (healthchecks.io free tier or UptimeRobot heartbeat) that pages Keith when the 10-min ping goes missing. **Blocked on Keith:** 2-min signup → create one check → set alert target (email/SMS) → paste the ping URL; then ~5 lines on the VM (curl the ping URL at the end of each successful cs-health run). Closes the last "I can't be the last to know" gap.
- ✅ **`scripts/test-deploy-harness.js` exit-255 aborts — FIXED 2026-08-08.** Two consecutive runs had died at a *different* scenario each time with **no FAIL assertions** — output simply stopped after a section header, and the Windows libuv abort `!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94` pointed at the harness's `proc.kill()` of its mock servers. Diagnosis held: the same assertion had already been hit and fixed in `verify-routing.js` earlier that day, from the same root cause — **abrupt process teardown while libuv handles are still live**. Three unsafe patterns removed: (1) mocks were spawned with **piped stdio** and killed abruptly — they now inherit a *file* for stdout/stderr (the parent holds no pipe handles at all) and publish their port to a file; (2) teardown is now a graceful `/__shutdown` followed by an **awaited** exit, force-kill only as a backstop; (3) the runner ended with `process.exit()` — it now sets `process.exitCode` and lets the loop drain. **Belt and braces, because a crash can still come from outside this file:** every scenario is registered in `EXPECTED_SCENARIOS`, the summary prints `scenarios: N/M ran`, and the run emits **`HARNESS-COMPLETE`** *only* when every declared scenario ran and every assertion passed — otherwise `HARNESS-INCOMPLETE` + exit 1, naming the scenarios that never ran. **Require that marker; never trust a tail of PASSes or a bare exit code.** A `harness-teardown-stress` scenario (25 rapid start/stop cycles with live sockets) covers the regression directly.
- **A NEW FILE MUST BE ADDED TO `push_civicscope.ps1`'s `$files` MANIFEST BEFORE IT CAN DEPLOY (hit 2026-08-09).** Declaring an undeclared path is refused at exit 10 — *"a path this script cannot ship must not look like it shipped."* Correct behaviour, but it is the one step that is easy to forget when adding a page: `pool/live.html` and `pool/scoring.js` had to be added to the manifest first. ⚠ After any tool rewrites that script, re-check it kept its **UTF-8 BOM** (verified 2026-08-09 — intact).
- **A COMMA-SEPARATED `-Paths` STRING PASSED THROUGH `PUSH_CIVICSCOPE.bat` IS SPLIT BY cmd.exe (found 2026-08-09).** PowerShell only quotes an argument containing spaces, so `"a.html,b.html"` arrives unquoted and cmd treats the comma as an argument separator: only the first file was declared, and the deploy *message* landed in `-VerifyProfile` ("Unknown verification profile …"). **For a multi-file scope, call `push_civicscope.ps1` directly** rather than through the .bat.
- **A best-effort catch that counts nothing is a silent-failure generator — audit the pool's SMS sends (found 2026-08-13).** The pool's "all picks are in" notice sent nothing to anyone on 2026-08-09 and left **no trace at all**: it swallowed every error, counted nothing, returned nothing, and the caller latched its "already notified" flag *before* calling it — so a total failure and a clean run were byte-identical, and the one-shot could never retry. It was only provable four days later by adding a read-only Twilio message log. Fixed for that path (`3.8.0-allinreceipt`), but **`notifyLock`, `notifyWinner` and both reminders still swallow individual send failures** — anything that does not report a per-channel count can fail the same way. Detail in `Pools/CLAUDE.md`.
- **Gate expectations are part of the contract — update them deliberately, never relax them.** The 2026-08-09 scoring change (a push scores 0, not ½) was caught by `verify-pool-integrity.js` on the first deploy attempt, exactly as designed. The right response was to change the asserted numbers *with the reason recorded*, not to soften the assertion. Same run, a second gate failure was **my test data**, not the code (a half-point total can never land on the number) — the gate distinguishing those two is the whole value of it.
- **The pool-integrity gate SKIPPED on every deploy from 2026-08-07 to 2026-08-08 — fixed, but read the lesson.** It exits **3 = "could not verify"** without `FOOTBALL_POOL_CODE`/`GOLF_POOL_CODE`, which were on no machine, so `push_civicscope.ps1` recorded SKIP and the deploy still reported cleanly. **A gate that skips is indistinguishable from a gate that passes in a summary line.** Both are now Windows User env vars (`infra/env-var-inventory.md`) and the verifier was rebuilt for the identity schema — 29/29. **Audit the other gates for the same shape:** any gate whose "cannot run" path is a soft skip needs the deploy result to *name* it, not just count it.
- **A LOGIC GATE FOR THE AP MATCHER — `scripts/verify-ryc-invoice-matcher.mjs` (NEW 2026-08-13).**
  The invoices matcher decides which desk an invoice is routed to, and it fails silently in BOTH
  directions: too strict and every invoice reads "not placed" (the real state that morning — 0 of
  16 placed, including "Ashley WWTP"); too loose and it names a confident wrong desk. Neither
  shows up in a smoke test. The harness asserts **85 outcomes against the LIVE Procore +
  Foundation feeds** — the traps that must refuse, the signals that must place, and a sweep where
  all 53 job names must resolve to their own job — and emits `MATCHER-COMPLETE` or exits 2. Exit 3
  = could not verify (feed unreadable), never a false red. It required exporting `__matcher` from
  `api/ryc-invoices.js`; the matcher is the one piece of that module with real logic and no I/O,
  so it is the one piece that can be tested exhaustively without touching production.
  ⚠ **`.mjs`, not `.js`** — `Civicscope/package.json` has no `"type": "module"`, so an ESM gate
  script here must carry the extension or it dies at `import`.
- **`-AllowUndeclared` is the normal case in this tree, not an alarm.** Six deploys this session
  each refused at exit 10 first, because `memory/context/infrastructure.md` and
  `ryc-estimate/ryc-sub-pricing-benchmarks.json` differ from production — the latter is the VM's
  own weekly benchmark push, i.e. expected drift, not another session's work. The flag ships ONLY
  the declared files; the blast-radius report still names what it left alone, which is the part
  worth reading.
- **RYC Invoices — `ryc-invoices/` is PUBLIC-repo-safe by design, keep it that way.** RYC's 280
  cost codes are served from Supabase (`ryc_cost_codes`) rather than shipped as an asset, because
  this repo is public. ⚠ **Pre-existing and unresolved:** `ryc-estimate/lineitem-probe.html` and
  the two `ryc-*-benchmarks.json` files DO carry RYC line codes / sub pricing in this public repo.
  Decide deliberately whether that is acceptable or move them behind the API too.
- **Schema files are versioned NOWHERE — PARTLY FIXED 2026-08-12.** New schema work now goes
  through `migrations/` and IS versioned: `Civicscope/migrations/*.sql` + `scripts/db-migrate.js`
  are narrowly re-included in Cowork's `.gitignore` (local-only repo, and verified absent from
  `push_civicscope.ps1`'s manifest, so they cannot reach this public repo). **The 15 legacy
  `schema_*.sql` files are still untracked** — the DDL defining production has no history, no diff
  and no undo. Inventory (not applied, just recorded): `migrations/LEGACY_INVENTORY.md`. Bringing
  them under version control is a separate decision: they are large and some carry RYC control
  failures and dollar figures in their comments. ⚠ `schema_ryc_slice2e.sql` is still headed
  `STATUS: STAGED — NOT APPLIED`.
- **Fable review R1 — work the 19 leads (KEITH, ½ day)** — every lead ever captured sits at `contacted=false`, incl. four live .gov hand-raisers from Jun 22–30 (names/towns in the Fable review doc — deliberately NOT in this public-repo file). Triage all 19, reply to the warm ones, mark `contacted`. Then wire "N uncontacted leads" into the daily digest / Monday email so the loop can't silently stall again. Cheapest calibration of the 30-day plan.
- **Fable review R2 — 30-day school-BOT plan Week 1** — ~50-district target list (agenda/BoardDocs mining tech already proven), Triage Memo template, outreach sequence. The schools wedge has ZERO organic pull (4 runs ever, ~all internal) — founder-led outreach is the only test. Plan: `work product/CivicScope_School_BOT_Pivot_30Day_Plan.md`, graded B+ in the Fable review.
- **Fable review R6 — infra repeat-run variance** — two identical watermain runs 43s apart returned $1.05M–$1.55M vs $1.85M–$2.75M (±76% midpoint; municipal + schools were deterministic across repeats). Add a repeat-run stability probe to the QA harness; consider prompt grounding discipline.
- **JBK-mention decision** — 3 live surfaces (for-schools, schools tool, infra tool) still name JBK Development despite the 2026-07-06 stay-neutral decision. Sweep for true neutrality or own deliberately — current state is drift.
- ⏸️ **Groundwork (newsletter) — PAUSED / on hold (2026-06-11)** — entire backlog frozen (Resend send wiring, VM cron, PDF fallback for Mishawaka packets, Cost Lens integration, project-tracker dedup). Detail preserved in the **Groundwork — Architecture** section. Separate product from the Municipal Agenda Notifier — do not merge.
- **Facebook Ads pixel** — create a CivicScope-specific Meta Pixel in Business Manager (separate from MTP/AAN pixel). Implementation plan at `Civicscope/FB_AD_IMPLEMENTATION_PLAN.md`.
- **Move daily digest cron to VM** — Vercel cron is unreliable (missed April 9-10 digests). Move to VM cron as a `curl` trigger, same pattern as bookmarks pipeline. **Less urgent since 2026-08-11:** the digest now reports a *named ET calendar day*, so a missed day is no longer lost — re-send it with `POST /api/digest?date=YYYY-MM-DD`. Under the old rolling window a late cron silently dropped the uncovered hours forever.
- **`CRON_SECRET` on CivicScope's Vercel is far too short for what it guards** (observed 2026-08-11 while wiring the digest gate — the value and its length are recorded in `infra/env-var-inventory.md`, deliberately not in this public repo). It protects an endpoint that sends mail and, since the `?dry=1` addition, answers with activity counts. Rotating it is a one-liner and cannot break the schedule — Vercel injects the same variable into its own cron call. **Not done unilaterally: it is a live credential change.**
- ⏸️ **GC public white-label — PARKED (Fable review 2026-07-08)** — one demo tenant (acme) in 4 months; the real GC product lives at /ryc/estimate and is proving itself there. Revisit RYC-as-public-tenant only if a paying second tenant materializes.
- **CivicScope restructure — loose ends (June 6)** — add version comments to the Schools + Infra tool footers; sweep the inert `.timeline-tease`/`.tease-*` dead CSS from the 3 tools; final end-to-end harness tire-kick of Schools + Infra (Municipal confirmed). The `Segment Hub Pages` table near the top still lists Infrastructure as "coming soon" — update that row when convenient.

---

---

## Key Learnings
- **A REPORT CAN COUNT CORRECTLY AND STILL LIE — the daily digest, fixed 2026-08-11.** It queried
  `created_at >= now - 24h` and then headlined the email with **today's** date. The cron fires at
  7am ET, so the window was 7am yesterday → 7am today: almost entirely *yesterday*, sent under
  *today's* name. Every run made during business hours landed in the **next** morning's email,
  while the email carrying the date it happened said **"Quiet day"** — Aug 3, Aug 5 and Aug 7 each
  had 2 runs and each got a "Quiet day" email bearing its own date. **Nothing was miscounted;
  every run was reported exactly once**, which is precisely why it survived five months and why
  every "is the digest broken?" check that counted rows said no. The bug was in the *label*, and
  it inverted the only signal the email exists to carry. **When a report and reality disagree,
  check what the report claims to be about before checking its arithmetic.**
  Fixed to a named ET calendar day, `[00:00, 24:00)` in `America/Indiana/Indianapolis`, measured
  per-instant so the DST days are genuinely 23h and 25h. A named day is also **idempotent** —
  `?date=YYYY-MM-DD` re-sends a missed day, where a sliding window lost the uncovered hours
  permanently.
- **A "quiet day" email that cannot tell "nobody came" from "everybody who came failed" is a
  blind spot, not a status.** Same fix: the digest now counts sessions and separates likely-bot
  from human, and a day with human visitors and zero completed runs is reported as **a drop-off**,
  not as quiet. Aug 8 had 5 human sessions and 0 runs and read as "quiet".
- **Two projects, one variable name.** The digest gate first failed 401 because `CRON_SECRET` on
  Keith's machine is **CRM's** secret; CivicScope's lives only in its own Vercel project. The
  verification contract reads **`CS_CRON_SECRET`** (Windows User env var, added 2026-08-11) so an
  absent credential is *inconclusive* rather than a permanent false red. Never point a gate at a
  variable name another project already owns.
- Cloudflare Email Address Obfuscation rewrites mailto: links at CDN layer — workaround is data-cfEmail="" on anchor. Moot since JBK CTA removed in v1.9.0.
- **A cap on `api/claude.js` MUST be tested with a multi-page IMAGE payload.** The abuse ceiling added 2026-08-02 capped every request at 200KB based on an audit of *text* prompts (~25KB). One rendered plan page is 70–220KB of base64 and the RYC takeoff deliberately batches to 3MB/10 pages, so the flat cap 413'd every multi-page vision request — the RYC plan-set takeoff (the product's core function) and the new-pursuit document reader. **Single-page requests slipped under it, so every quick test passed.** Fixed `82e66dc`: text and images bounded separately (200KB text · 4MB / 16 images), and both refusals report the measured numbers instead of a bare "Request too large". The three vertical smoke tests did NOT catch this — they are text-only.
- api/claude.js is a **prompt** passthrough — never inject/rewrite prompt content server-side. It DOES (added 2026-06-23, after the Anthropic 529 "elevated error rate" outage) add **transport resilience**: bounded retry-with-backoff on 429/5xx/529, then an **OpenAI-compatible fallback** that translates the Anthropic-shaped request → OpenAI and the reply back into Anthropic's `{content:[{text}]}` shape (no tool change). Fallback is OFF until `OPENAI_API_KEY` is set in Vercel; model via `OPENAI_FALLBACK_MODEL` (default `gpt-4o` — NOT Codex, a code model). Text-only requests only (GC image/doc uploads skip fallback). Retry/transport changes here are allowed; prompt passthrough is the invariant.
