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
| **Village Hub (NEW 2026-08-18)** | **civicscope.io/:village** (live: `/centreville`) | **The village's own staff — one address for every product** | **v1.0.0-village** |
| **Ask &lt;Village&gt; (NEW 2026-08-18)** | **civicscope.io/:village/ask** (live: `/centreville/ask`) | **Village clerks + residents** | **v1.0.0-muni** ⏸ paused |
| **Water Plant Daily Log (NEW 2026-08-18)** | **app.civicscope.io/water** | **Water plant operators + the OIC who signs the MOR** | **v1.0.0-water** |
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
- **`api/alert-sms.js` — a single-destination SMS relay (NEW 2026-08-19, `1.0.0-alert`).** No page,
  no route rewrite; it is reached only as `/api/alert-sms`. An OUTSIDE monitoring system (a friend's
  down-detector, nothing to do with CivicScope) texts one fixed handset through the pool's Twilio
  number. **Deliberately NOT an action on `api/pool-sms.js`:** that file is gated by
  `FOOTBALL_POOL_CODE`, which also opens `save_players`, `lock_slate` and the message log — and the
  log carries players' PINs. This has its own code (`ALERT_SMS_CODE`) and its recipient is pinned
  server-side (`ALERT_SMS_TO`), so there is no recipient parameter to abuse. ⚠ **It shares the
  pool's A2P campaign and therefore the pool's carrier throughput**, which is a sole-prop STARTER
  registration with low daily caps — a flapping monitor could starve the pool's slate-lock and PIN
  texts, so the relay self-limits (6/hr, 24/day, identical text suppressed for 15 min) by reading
  Twilio's own message log rather than a counter table, and **refuses to send when that log is
  unreadable rather than sending blind**. Contract-gated on `?ver=1`. Rationale and the operational
  detail live in `Cowork\Pools\CLAUDE.md`; **no code, number or credential belongs in this PUBLIC
  repo.**
- **/invoices — RYC Invoices, the AP register (NEW 2026-08-11).** Third RYC workspace in the
  shared shell (`ryc-invoices/`), alongside `/ryc/estimate` and `/ryc/command`. `/invoices`,
  `/invoices/:path*` and `/ryc/invoices` all rewrite to `ryc-invoices/index.html`. Deliberately
  NOT a Command page — Command reports on the business, this is where a PM does a job daily.
  Backed by `api/ryc-invoices.js` + `schema_ryc_invoices.sql`. Per-PM access via `?c=<code>`
  (`RYC_INVOICE_PMS`) or a signed `?k=` link (`RYC_INVOICE_LINK_SECRET`); the server derives the
  PM from the credential and there is no `pm` parameter a browser can send. Scans live in the
  PRIVATE Supabase bucket `ryc-invoice-scans`, served as 15-minute signed URLs. Full detail:
  **RYC CLAUDE.md**.
- **/centreville — the VILLAGE HUB (NEW 2026-08-18)**, `civicscope-village/index.html`. A village's
  front door: it reads that village's `muni_tenants` row and offers the products that village
  actually has — **Ask &lt;Village&gt;** when `active`, **Well Sampler** when `water_wssn` is set
  (migration `011`). Tenant-generic like everything else here; a second village is a rewrite line
  plus a row. **Two rewrites under one slug both answer 200**, so `verify-routing.js` asserts
  *which page* each serves via its version comment (`servesPage()`) — a status-only check would let
  the hub and the ask tool swap silently. Google sign-in is **not built**; the hub says so in
  words rather than showing a dead button.
- **/centreville/ask — Ask &lt;Village&gt; (moved here 2026-08-18** from `/centreville`, which is now
  the hub). One page (`civicscope-muni/index.html`)
  serves every municipality; the tenant comes from the path, so adding a village is a
  `muni_tenants` row + one literal rewrite here. **Literal per tenant on purpose — never a root
  `/:slug` wildcard**, which would swallow every unmatched path on the site. Backed by
  `api/muni-ask.js` + migrations `006`–`009` (`muni_tenants` / `muni_docs` / `muni_chunks` /
  `muni_questions` + the `muni_search()` ranked-retrieval function). Corpus is built by
  `scripts/ingest-muni-corpus.mjs`. Full detail: **Municipal Documents** section below.
- **/water — Water Plant Daily Log (NEW 2026-08-18).** `civicscope-water/index.html`, one page for
  every water supply; the supply comes from the WSSN typed at unlock, not the path, because the
  audience is a named operator with a credential rather than the public. Backed by
  `api/water-ops.js` + migration `010_water_ops.sql` (nine `water_*` tables). **The arithmetic
  lives in `civicscope-water/derive.js` and is imported by BOTH the page and the API** — ship the
  three files together. Gated by `WATER_OPS_CODE` (Vercel env, production+preview) plus a
  per-operator PIN; writes REFUSE if the code is unset. Full detail: **Water Plant Daily Log** below.
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

**`water` profile (NEW 2026-08-18) — `civicscope-water/*` + `api/water-ops.js` → the derivation
gate.** `derive()` produces numbers that are **filed with the State of Michigan**, and the
api-contract gate can only prove the route answers, never that it answers with the right numbers.
`scripts/verify-water-derivation.mjs` replays Centreville's real July 2026 — 93 well-days
transcribed from the scans — through the exact function the tablet calls and checks it against
what the operator wrote by hand (569 assertions). It fires on **both** files, because the
arithmetic lives in `derive.js` while `api/water-ops.js` re-derives authoritatively at submit;
changing one alone is precisely the drift this catches. **Not `optional`** — unlike the pool and
RYC gates it needs no credential and no network, so "could not run" is never legitimate here.
*(Until this existed, the plant's arithmetic shipped ungated.)*

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

## Municipal Documents (`/centreville`) — NEW 2026-08-18

**What it is.** A village publishes its ordinances as a tree of Google Drive PDFs. That is a filing
cabinet with a URL: a clerk who wants the commercial-vehicle rule has to already know which of
twenty subject folders holds it, then read a 90-page PDF. This turns that into a question box that
answers from the village's own documents and links the source every time.

**Live:** `civicscope.io/centreville` (apex 307s to `www`, both resolve). Corpus = the Village of
Centreville, MI **Code of Ordinances**: 21 documents, 547 passages.

**⚠ THE CORPUS IS PARTLY SCANNED PAPER — that is the hard part of this product, not the AI.**
`Environment.pdf` is 10.3 MB across 24 pages and `pdftotext` extracts **zero** characters from it.
Nobody can Ctrl+F those documents today — not the clerk, not a resident, not Google. **7 of the 21
ordinance documents had no text layer at all** and had to be transcribed before they could be
searched. The transcripts are stored in `muni_docs.raw_text` and are the only machine-readable copy
of those ordinances that exists anywhere; losing them means paying to recreate them.
**Do not assume a municipal corpus is digital — measure it** (`--list` then a `pdftotext` probe).

**Provenance travels with every passage.** `muni_docs.text_source` is `text-layer` or `ocr`, the
retrieval function returns it per passage, the prompt labels passages `[text]`/`[scan]`, and the
model is told to flag a *figure* it is relying on from a transcription. A misread digit in a
setback or a fee is the failure mode this product has to guard against, and it is visible in the
live answers ("the 14-day, 60-day and 30-day figures all come from scanned pages, so confirm
them"). The UI shows a `scan` tag on those sources.

**Retrieval is Postgres FTS, not embeddings — deliberately.** Anthropic has no embeddings endpoint,
so vectors would mean a new vendor, a new key and a new bill before the first question is answered.
Municipal code is also unusually well suited to lexical search: it is written in stable specific
nouns and the citation the reader needs is a section number. Headings carry tsvector weight **A**
and body text weight **B**, and `muni_search()` boosts the adopted code over meeting minutes
(1.60 / 1.35 / 1.15 / 1.00) — *an ordinance is what the village adopted; minutes are what a board
discussed*. A vector column can be added later without moving the chunk rows.

**The heading is load-bearing, and getting it wrong is worse than leaving it null.** Weight A means
whatever lands in `heading` is weighted far above body text — so capturing a body sentence
("Section A — The fire department will consist of a maximum of 30 members unless altered by…")
double-counts that sentence and drags unrelated queries toward one chunk. `looksLikeTitle()` in the
ingest script is the guard: ≤70 chars, no trailing sentence punctuation, no `shall/will/must/may`.

**Cost, and why it is scoped.** OCR runs **~$0.03/page** on `claude-opus-5` at `effort: low`
(transcription is mechanical — the default effort ran ~5 min for 15 pages and bought nothing;
thinking stays ON because disabling it on this model risks `<thinking>` tags leaking into output,
which would land in the corpus as if it were ordinance text). The full Code of Ordinances cost
**~$1.90**. **The remaining 584 documents are mostly years of meeting minutes and have NOT been
ingested — that is Keith's call**, and the whole stack shares one Anthropic key with an org spend
limit (memory `reference_anthropic_shared_key_spof`).

**Re-runs are cheap by construction, and the ordering matters.** The change check is keyed on
Drive's `modifiedTime` and runs **ahead of extraction** — the first build had it after, which would
have re-transcribed the whole corpus at full price to discover nothing had changed. `--rechunk`
re-chunks from stored text for free, so chunk size, overlap and heading detection can be tuned
against the real corpus; `--reocr` is the expensive escape hatch.

```bash
node scripts/ingest-muni-corpus.mjs --tenant centreville --list     # enumerate, nothing fetched
node scripts/ingest-muni-corpus.mjs --tenant centreville --probe    # MEASURE cost before spending
node scripts/ingest-muni-corpus.mjs --tenant centreville --ocr      # full ingest
node scripts/ingest-muni-corpus.mjs --tenant centreville --rechunk  # free, no fetch, no OCR
```

**`--probe` before any large ingest — it is free and it is the difference between a decision and a
guess.** It downloads every PDF, checks for a real text layer, counts pages, and prints a
per-collection cost table. **Pages are what cost money, not documents**, and the two are not
correlated: the Centreville corpus is 605 documents but only **1,264 pages** — mostly one- and
two-page minutes, agendas and notices. Measured 2026-08-18: **436 of 605 documents are scans, 627
pages need OCR, ≈$21 for the entire corpus.** The pre-probe estimate, reasoning from "605 scanned
documents" without page counts, was *several hundred dollars* — wrong by more than 10×, and it was
about to cause a slice of the corpus to be left unbuilt for no reason.

**Adding a municipality:** `muni_tenants` row (`active=false`) → point `CORPORA` in the ingest
script at its Drive folders → ingest → check the answers → `active=true` → one literal rewrite in
`vercel.json`. `active` is enforced **server-side** in `api/muni-ask.js`, because the page is cached
in browsers that are already open.

**⚠ A TEXT LAYER DOES NOT MEAN THE DOCUMENT IS COVERED — TABLES GO MISSING SILENTLY (found
2026-08-18).** `Centreville Zoning Book 19.pdf` has a **645,000-character text layer**, so the
ingest classified it `text-layer`, ingested it for free, and reported 603 passages. But the
**Site Development Requirements table — the per-district front / side / rear yard setbacks, lot
sizes, heights and coverages — is not in the extracted text.** `Table 4-5` appears nowhere; the
grid survives only as debris (`R-1 20,000 sq. ft.; 80 ft`, `R-2 50 ft`), and the other tables
(e.g. Table 4-1) extract with their columns interleaved into nonsense. Those setbacks are the most
common zoning question a village gets, and the corpus cannot answer them.

**The safeguard held** — asked for residential setbacks, the model cited the Section 4.5 footnotes
it *did* have, said plainly that the base numbers sit in a table it was not given, and pointed the
reader at Section 4.5. It invented nothing. That is the "no corpus, no answer" rule doing its job,
and it is why the citation-and-provenance design matters more than retrieval quality.

**The defect is that the text-layer check is per-document and all-or-nothing.** A PDF can carry a
rich text layer and still hold image-only or layout-mangled tables. Fix (unbuilt, costs money):
detect low-text-density pages inside otherwise-textual documents and OCR **those pages**, since the
vision model reads a printed grid correctly where `pdftotext` flattens it. Until then, **do not
tell a village its zoning dimensions are covered.**

**No corpus, no answer.** Zero retrieval hits returns "not found" and never reaches the model — a
plausible answer assembled from general knowledge of municipal law is the worst thing this product
could produce. Those zero-hit questions are logged to `muni_questions` and are the village's own
"what can't we answer" list.

---

## Water Plant Daily Log (`/water`) — NEW 2026-08-18

**What it is.** A community water supply's operator walks a round: at each well he reads a meter,
reads the chlorine and phosphate tank levels, and pulls a plant-tap sample. Today that goes on a
paper Well and Pump Record and gets retyped into EGLE's Monthly Operation Report at month end.
This is the tablet that replaces the clipboard, plus the repository the records land in, plus the
generator that produces the state's own workbook from them.

**Live:** `app.civicscope.io/water`. First supply = **Village of Centreville, WSSN 01310**
(the same village as `/centreville` — this is a second product for an existing tenant). Three
entry points seeded from the July 2026 records: TP001/Well 1, TP003/Well 3, TP004/Well 4.

**⛔ THE OPERATOR ENTERS READINGS, NEVER CALCULATIONS — and reading one month of the plant's own
paperwork by hand is what proved why.** Across all three wells for the whole of July 2026, *every*
handwritten dose in the CL ppm / PH ppm columns is 3–5% off EGLE's own formula. Nobody was
careless: the operator reads a dose chart, the state's spreadsheet divides. But it means the
plant's daily log and the report the village files **have never agreed**, and nothing in the
process could have surfaced it. Four more defects were sitting in the same month:

| Found in July 2026 | What it was |
|---|---|
| Well 3, 7/21 | Both doses computed from **Well 4's** flow (70,000 gal, not Well 3's 48,000). Substitute it and both written figures reproduce to the cent. |
| Well 4, 7/2 and 7/28 (Cl); Well 3, 7/28 (PO₄) | Tank readings disagree with their own "Gallons Added" column. |
| Well 1, 7/9 | Plant tap reads **free 0.77 / total 0.69** — physically impossible, and it went to the state that way. |
| The whole month | **No bacti dates and no residuals at all** in the submitted packet. |

**`derive()` is one module, imported twice.** `civicscope-water/derive.js` is pure (no network, no
clock, no env) and is imported by the browser AND by `api/water-ops.js`. The moment that rule
exists twice, the screen and the filed report can disagree and the operator cannot tell which one
lied — which is exactly the failure above. Same lesson as `pool/scoring.js`. **Any change here
must be made once, in that file.**

**The profile is data, not code.** `water_entry_points` says what is *read* at a location
(meter + units, pressure, temp, which tap residuals) and `water_feeds` says what is *fed* there
and at what strength (0.125 for 12.5% hypochlorite, 0.25 + ortho factor 0.1 for the phosphate).
Standing up the next village is rows, not a release. EGLE's template is already shaped this way —
an EntryPoint tab per entry point, blank columns for chemicals that do not apply.

**Two states the paper cannot express, both of which happened in July:**
- **A refill.** Well 3's chlorine went 25 → 303 on 7/15, Well 4's 12 → 315 on 7/20. On paper the
  operator circles the new number. `water_feed_readings.refill_to` records what it was filled TO,
  and the next day measures from there. A tank that rose with no refill on file is **refused**,
  not silently turned into −278 lbs.
- **A well that did not run.** Well 1's meter was unchanged 7/6 → 7/7. That is a row with
  `gallons_pumped = 0`. **No row at all means nobody visited** — a different fact, kept different.

**Corrections append, never overwrite.** These are the records behind a report signed under
1976 PA 399. A correction inserts a new row carrying `corrects` + `correction_reason` and stamps
the old one `superseded_at`; the unique indexes are **partial** (`where superseded_at is null`) or
a corrected day could never be re-entered.

**The gate: `node scripts/verify-water-derivation.mjs` → 569 checks, `WATER-DERIVE-COMPLETE`.**
It replays all 93 July well-days through the real `derive()` against the scans, and pins the
refusals the clipboard never made. It also **names** the five places July's paper disagrees with
itself rather than smoothing them over — a gate that hid them would be lying about the source.
⚠ The dose tolerance is **5%**, set from the evidence (median gap 3.4%, 88 of 89 rows ≤4.5%); the
one 8.4% row is listed as a named outlier. **Do not widen it to make a run go green.**

**The loop closes back to the state's own file.** `scripts/build-mor.py --wssn 01310 --year 2026
--month 7 --template "<Blank MOR.xls>" --out <file>` fills EGLE's workbook from the stored month.
Three things make that non-trivial and all three are handled: the template is **Excel-encrypted**
(default `VelvetSweatshop`), **xlrd cannot read formulas** so a plain xlutils copy silently blanks
all 1,988 of them (re-injected from `scripts/extract-mor-formulas.mjs`), and **xlutils flattens
merged ranges**, costing every merged box its right-hand border. xlwt also writes formulas with an
empty cached result, so `FormulaRecord` is patched to "recalculate on open" or the report opens
with blank totals. Verified: zero formatting differences on any cell with content.

**July 2026 is loaded** (`scripts/backfill-water-july2026.mjs`, `source='backfill'`) — 96 readings
including a 6/30 opening balance per well, plus 23 distribution samples. Round-trip verified at
379 checks against the scans. The 7/9 impossible residuals are stored **absent, with a note
quoting the paper**: backfilling a number known to be impossible would be forging a record.

**Known gaps, deliberately:**
- ✅ **Service worker and bacti capture shipped 2026-08-18** (network-first on purpose — a
  cache-first shell could pin an old `derive.js` and make the screen and the filed record
  disagree, which is the defect class this product exists to remove).
- ⚠ **Not verified on a real tablet in a real well house.** Registration, scope and the served
  bytes are confirmed in production; "the operator walks into a concrete box and it opens" is not
  provable from here.
- `water_supplies.active` is informational — the working gate is `WATER_OPS_CODE`.

## Open Action Items

- **Centreville is now a CLIENT PROJECT with its own folder — `Cowork\Centreville\CLAUDE.md`
  (2026-08-18).** Two live products for one village (`/centreville` + `/water`). Read that file
  alongside this one for anything Centreville-specific: the plant profile, corpus state, and what
  is owed to EGLE. ⛔ **The code stays multi-tenant here — Keith declined a separate Vercel
  project, Supabase project and Anthropic workspace the same day.** Village #2 is a config row.
- ✅ **Corpus count RECONCILED 2026-08-18 — the gap was one collection, and the "full corpus"
  claim was wrong.** `--list` against the live corpus, collection by collection:

  | Collection | In Drive | Ingested | Missing |
  |---|---|---|---|
  | Code of Ordinances | 21 | 21 | — |
  | Zoning & Planning Commission | 103 | 103 | — |
  | Village Information | 201 | 201 | — |
  | Redevelopment Ready Communities | 3 | 3 | — |
  | Applications and Permits | 0 | 0 | — |
  | **Village Voice & Calendar** | **277** | **28** | **249** |
  | **TOTAL** | **605** | **356** | **249** |

  Every collection that answers a question about the law is **complete**. The whole shortfall is
  Village Voice & Calendar — the village newsletter — which is the least useful slice for
  answering anything and is **deliberately left unfinished**: it was mid-ingest when the run was
  stopped, because no commercial relationship with Centreville is recorded and further paid ingest
  is gated on that (`Centreville\CLAUDE.md`). `muni_tenants.doc_count` corrected 21 → 356, and the
  ingest now maintains it at the end of every run so it cannot drift again.
- ✅ **Water Plant Daily Log — service worker and bacti capture SHIPPED** (verified live
  2026-08-19: `/water-sw.js` 200 at root scope, bacti screen present). Left standing here as open
  after they were built.
- ✅ **2026 January–July is seeded (2026-08-19)** — 626 readings, 152 distribution samples, 14 bacti,
  loaded from the year's paper records and cross-checked against the seven MORs actually filed with
  EGLE (**meter 97.4%, tank 95.1% agreement**). Tooling in `scripts/`: `extract-mor.py`,
  `transcribe-well-sheets.mjs`, `reconcile-well-sheets.mjs`, `reread-meter-column.mjs`,
  `seed-water-2026.mjs`. Detail + findings: **`CentrevilleCLAUDE.md`**.
- ⛔ **THE AMENDMENT PATH WAS BROKEN IN THREE PLACES AND NOTHING HAD EVER EXERCISED IT.** Seeding
  six months of paper was the first thing that ever tried to CORRECT stored data, and found: a
  correction could never be saved (the replacement row was inserted before the old one was
  superseded, colliding with the partial unique index — `submit_reading` and `submit_dist` both,
  fixed `25049ea`), and `submit_bacti` had no already-recorded guard at all, so re-running a
  backfill multiplied the compliance record five-fold (fixed `73babb1`). **The ordinary path
  worked in every case; only amendment was broken — which is exactly what no smoke test walks.**
- 🚨 **August 2026 is still being written on paper.** The tablet is live and nobody is using it;
  every day that runs is another day that has to be backfilled.
- **Centreville's August 2026 is being recorded on paper right now.** `/water` is live and nobody
  is using it. Every day that runs is another day that has to be backfilled.
- **`Civicscope/scripts/` is gitignored except narrow re-includes**, so the water gate, the
  backfill, the MOR generator and their fixtures are not under version control. Same one-line
  decision as `migrations/` — they are secret-free by inspection.

Forward-looking action queue. Source of truth for the CRM dashboard's "Across All Businesses → CivicScope" card. Curated at `/wrap`. Done items are removed, not strikethroughed — historical context lives in the `## Active Backlog` sections below.


- ✅ **Municipal Documents — target village SETTLED: Centreville (Keith, 2026-08-18).** Keith's
  original ask said `civicscope.io/constantine`, but the links supplied were Centreville's; he
  confirmed same day that **Centreville is correct**. `/centreville` is the live route. No
  Constantine corpus is planned — if that changes it is a `muni_tenants` row + a `CORPORA` entry +
  an ingest run + one literal rewrite.
- **Municipal Documents — 356 of 605 ingested; the remaining 249 are GATED on a Centreville
  commercial relationship.** All four collections that bear on the law are complete (ordinances,
  zoning, village information, RRC); what is left is the Village Voice newsletter. `--probe` put
  the whole corpus at **≈$21** (1,264 pages, 627 needing OCR) against a pre-measurement guess of
  *several hundred dollars* — the scope question was never a real decision, only an unmeasured one
  (Key Learnings). **But nothing records what Centreville has agreed to or pays**
  (`Centreville\CLAUDE.md`), so the rest does not run on Keith's key until that exists.
  Finish with: `--collection "Village Voice" --ocr --max-spend 12`.
- **🚨 Municipal Documents — THE ZONING SETBACK TABLE IS NOT IN THE CORPUS (found 2026-08-18).**
  The zoning book ingested "successfully" as a text-layer document, but its Site Development
  Requirements grid (per-district setbacks, lot sizes, heights, coverage) did not survive
  extraction — see **Municipal Documents** above. Those are the numbers a village is asked for most
  often. **Do not describe zoning dimensions as covered.** Fix is per-page OCR of low-text-density
  pages inside otherwise-textual documents; costs money, so it sits behind the same Centreville
  commercial gate as the rest of the ingest.
- **Municipal Documents — `Applications and Permits` returned 0 documents.** The folder is linked
  from the village-info page and enumerates clean but is empty (or holds only non-document types).
  Worth a look before telling a village the permit forms are covered.
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
- **🚨 NEVER WRITE A COMPLETION CLAIM INTO THE DURABLE RECORD BEFORE VERIFYING IT (2026-08-18).**
  This file carried *"✅ FULL CORPUS INGESTED — All 605 documents"* while the live corpus held
  **356**. The line was written at the moment the full ingest was *launched*, not after it
  finished — and the run then lost 329 documents to an expired token and 69 more to the Anthropic
  usage limit. A parallel session found the contradiction by comparing the API against this file;
  it should never have had to. **The failure is the same shape as the exit-0-on-partial-failure bug
  in the same script**: an optimistic success signal emitted before the evidence existed. Concretely
  — a ✅ in an instruction file is a claim someone will act on (here: telling a village its records
  are covered), so it gets written *after* a reconciliation, quoting the number and the date, and
  the reconciliation is `--list` against the DB collection by collection, not a summary line from a
  run log.
- **🚨 THE MUNI INGEST EXHAUSTED THE ORG'S MONTHLY ANTHROPIC LIMIT (2026-08-18) — a bulk job on
  the shared key must police its own spend.** One Anthropic key serves every business in this
  stack (`reference_anthropic_shared_key_spof`), and a bulk OCR run is the only workload that can
  drain a monthly limit in one sitting. It did: mid-corpus, the API began returning *"You have
  reached your specified API usage limits. You will regain access on 2026-09-01"* and Keith had to
  raise the cap. **Two things made it worse than it needed to be:** the script kept going, turning
  one clear signal into **69 identical failures** and marking 69 documents "failed" that were never
  actually attempted; and the per-document `try/catch` swallowed it, so the run still looked like
  ordinary attrition. Fixed in `ingest-muni-corpus.mjs`: a usage-limit response now throws
  `AbortRun`, which the per-document handler explicitly re-throws and which unwinds the whole run
  with exit 2 and a resume note; plus a self-imposed `--max-spend` ceiling (default **$25**).
  **Generalise: any job that can spend real money on the shared key needs (a) its own ceiling,
  (b) a hard stop on the provider's limit error, and (c) an error class the per-item handler
  cannot swallow.** The estimate being right ($21 for the corpus) was no protection — the limit is
  shared with everything else already running that month.
- **RETRY TRANSIENT NETWORK FAILURES, OR A LONG WALK WILL SHRED ITSELF.** The same run lost **187
  documents to bare `fetch failed`** — dropped connections and throttled sockets against Drive —
  because `driveFetch` retried 401s and nothing else. Several hundred requests over the public
  internet *will* see transient failures; treating each as a permanent document-level failure
  discards real work and inflates the failure count until the real problem is invisible.
  Now 4 attempts with backoff on network errors, 429 and 5xx.
- **A CREDENTIAL MINTED ONCE AT STARTUP IS A TIME BOMB IN ANY JOB THAT OUTLIVES IT (muni ingest,
  2026-08-18).** The Google service-account token lives **one hour**. The full Centreville ingest
  minted it once in `main()` and threaded it through every call — so the run ingested 254 documents
  cleanly, hit the one-hour mark, and then failed **329 consecutive downloads with `401`**. It
  exited **0**: every failure was caught per-document and counted, so the job "succeeded" while
  silently completing 42% of the work. Fixed with a cached `driveToken()` that re-mints 5 minutes
  before expiry, plus a forced-refresh retry on any 401. **Ask of every long-running job: what is
  the shortest-lived credential it holds, and does the job outlive it?** Also worth noting the
  failure was *recoverable at zero cost* only because extracted text is persisted — the retry
  skipped all 254 completed documents. **Per-item error handling that keeps a job running must not
  also let it report success**; a completion summary needs to make a large failure count
  impossible to miss.
- **AN UNMEASURED COST ESTIMATE CAN COST MORE THAN THE WORK (muni ingest, 2026-08-18).** The
  Centreville corpus was scoped down to one collection because the full ingest "looked like several
  hundred dollars" — reasoned from 605 documents and 339 MB without ever counting pages. A free
  probe (download, check for a text layer, count pages) put the real figure at **≈$21**: 605
  documents but only 1,264 pages, because most are one- and two-page minutes and notices. The
  guess was wrong by more than 10×, and its only effect was to nearly leave 96% of the corpus
  unbuilt and hand Keith a decision that did not need making. **Where a job's cost scales on a
  quantity you have not measured, measure it — especially when measuring is free.** Bulk (MB) and
  item count are both poor proxies for the thing actually billed.
- **THE EXPENSIVE STEP MUST BE GATED BEFORE IT RUNS, NOT AFTER (muni ingest, 2026-08-18).** The
  first build extracted text, hashed it, and *then* asked whether the document had changed. That is
  free when the text comes from a PDF's own text layer and ruinous when it comes from OCR: every
  re-run would have re-transcribed the entire corpus at full price to discover nothing had changed,
  and tuning the chunker — a normal thing to do while improving retrieval — would have meant
  re-OCRing everything to re-chunk it. Fixed by moving the change check ahead of extraction (keyed
  on Drive's own `modifiedTime`, the only honest signal for a source we don't control) and storing
  the extracted text in `muni_docs.raw_text`. **Whenever a pipeline has one step that costs money,
  check the ordering of the skip logic against it explicitly** — "skip unchanged work" is only
  cheap if the skip happens before the cost.
- **A CORPUS THAT LOOKS DIGITAL CAN BE PHOTOGRAPHS (muni ingest, 2026-08-18).** 605 PDFs, 339 MB,
  every one `application/pdf` — and a third of the ordinance set has no text layer whatsoever.
  `pdftotext` returned 24 characters from a 10.3 MB, 24-page file. The download succeeded, the mime
  type was right, and the file was a valid PDF-1.4; nothing about the metadata hinted at it. **Probe
  extraction on a real sample before estimating any document-ingest project** — the difference
  between "index these PDFs" and "transcribe these PDFs" is the whole project.
- **DEFAULT EFFORT IS THE WRONG SETTING FOR MECHANICAL WORK.** OCR transcription at Opus 5's default
  effort ran ~5 minutes for 15 pages, spending adaptive-thinking tokens deliberating about a task
  that is "read the page, write what is printed." `effort: low` cut it dramatically with no quality
  loss. Thinking stayed **on**: disabling it on this model risks `<thinking>` tags leaking into the
  visible output, and in an ingest pipeline that text would be stored as if it were ordinance text.
- **A HEADING FIELD WITH SEARCH WEIGHT IS A LIABILITY IF IT CAN CATCH PROSE.** `muni_chunks.heading`
  is indexed at tsvector weight A. The first heading detector happily captured "Section A — The fire
  department will consist of a maximum of 30 members unless altered by the…", double-weighting a
  body sentence and pulling unrelated queries toward that chunk. **Any field that is weighted above
  the rest of the document needs a test for what it is, not just a pattern for where it starts.**
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
