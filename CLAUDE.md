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
| ~~GC External~~ | ~~/gc/:slug~~ | — | **REMOVED 2026-08-26.** Pages, both APIs and the rewrites deleted; `/gc/*` 301s to `/` |
| ~~GC Internal~~ | ~~/gc/:slug-internal~~ | — | **REMOVED 2026-08-26** (same) |
| **Village Hub** | **civicscope.io/:village** (live: `/centreville`) | **The village's own staff — one address for every product** | **v2.0.0-village** — Google sign-in gate |
| **Ask &lt;Village&gt; (NEW 2026-08-18)** | **civicscope.io/:village/ask** (live: `/centreville/ask`) | **Village clerks + residents** | **v1.0.0-muni** ⏸ paused |
| **Well Testing — crew tablet** | **app.civicscope.io/water** | **Water plant operators (no logins, by design)** | **v1.1.0-water** — name first, required, blank |
| **Well Testing — OIC review** | **civicscope.io/water/review** | **The OIC who signs the MOR** | **v1.3.0-oic** — no stall, `?m=` deep link |
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
- **/pool — "The Pool" unified hub (2026-07-19).** All friends'-pool pages (hidden personal, not a CivicScope product) merged under `pool/`: hub `index.html` + `golf.html`/`golf-picks.html` + `football.html`/`football-picks.html`/`commish.html` + **`live.html` (NEW 2026-08-09 — `/pool/live`, the bookmarkable phone-first live tracker)** + **`scoring.js` (NEW — the ONE client-side copy of the pool scoring rules, loaded by `football.html`, `live.html` **and now `index.html`**; mirror any change in `api/football-pool.js` and nowhere else. ⚠ Since 2026-08-25 it also holds the **season MONEY ledger** — `WEEKLY_STAKE` ($50, hardcoded), `seasonLedger()`, `fmtMoney()` — because three surfaces render that number and a hub and a board that disagree about what someone is OWED is the same class of fault as a board that disagrees with the server about who won. Its gate assertion is a replay of the commissioner's real 2025 spreadsheet: 120 weekly figures + 6 season totals, all matching. Full detail in `Pools\CLAUDE.md`)** + `sms.html` (A2P opt-in form → `sms_optin` action) + `privacy.html`/`terms.html` (A2P legal). Old `/golf*` + `/football*` URLs **301-redirect** (vercel.json; old file paths = meta-refresh stubs). APIs unchanged: [api/golf-pool.js](api/golf-pool.js) (`GOLF_POOL_CODE`) + [api/football-pool.js](api/football-pool.js) (`FOOTBALL_POOL_CODE`; `GET ?ver=1` returns its `VER` const — bump every edit + curl-verify live after deploy). Pool emails: `reply_to keith@anchoradvisorsnorth.com` on every send (pool@ has no mailbox — replies bounced before 7/19). **Full state/conventions live in `Cowork\Pools\CLAUDE.md` — read it before ANY pool work** (golf history incl. The Open final BOB, football demo state, no-odds rule, Twilio SMS status).
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
- **RYC = first REAL GC tenant — CREATED 2026-07-21** (slug `ryc`, id `ca502d19`, inserted via Supabase service key pulled from Vercel env — the admin secret is write-only "sensitive" type). `/gc/ryc` + `/gc/ryc-internal` LIVE but **unlisted** (leads notify keith@jbkdevelopment.com, NOT RYC — reveal held for Keith's dashboard-license conversation with Steve; see memory `project_ryc_dashboard_license_play`). ⛔ **ALL OF THAT IS GONE AS OF 2026-08-26** (below): the pages, `api/gc-config.js`, `api/gc-log.js`, both rewrites and the whole `/admin` surface were removed, and `/gc/ryc` + `/gc/ryc-internal` now **301 to `/`**. The `tenants` row for `ryc` survives in Supabase but nothing reads it. ⚠ **Historical note only, kept because it explains the row:** the concern at the time was not to circulate `/gc/ryc-internal` inside RYC, since the real internal estimator is `/ryc/estimate` (data-grounded) and the generic white-label variant muddied that story. That resolved itself — the white-label variant no longer exists. Command Center deliberately NOT tenant-wired until cutover auth or GC customer #2.

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

### The village's own website is a third source (NEW 2026-08-25)

Keith: *"can we include the actual website as a source for information as well… The website has
things like calendar of events."* `scripts/ingest-muni-website.mjs` crawls `centrevillemi.com` into
the same tables as collection **`Village Website`** — **8 pages, 26 passages**, corpus now **364
documents / 2,840 passages**. Zero cost: HTML, no OCR, no Anthropic spend, which is why it does not
sit behind the Centreville commercial gate the remaining Drive ingest does.

**It is a different KIND of source, not a lower grade of the same one.** The Drive corpus answers
*what is the rule*; the website answers *what is happening, who do I call, when is it open*. These
exist ONLY on the website: the Village Council roster and **every** committee appointment, office
address/hours/phone/fax, the water-sewer emergency call order, meeting cancellations, and the events
list. Live proof — asked who is on the council, the tool answers from the website, dates the answer,
**and flags that the 2025 Recreation Plan lists an older roster**, reasoning that the website is the
more current of the two.

⛔ **26 PASSAGES CANNOT WIN A GLOBAL RANK AGAINST 2,800, AND MIGRATION 031's HEADER WAS WRONG ABOUT
WHY.** 031 gave the collection a weight of **1.10** and argued a coefficient was the right
instrument here — unlike the Forms Manual, whose advantage no constant could bound. Measured
minutes later against the real corpus: the council roster was **not in the global top twenty**, with
four zoning-book procedure sections leading it **4.50 to 0.44**. `ts_rank_cd` is cover-density with
no length normalisation, so a zoning section saying "Village Council" eight times outranks a roster
that says it once and lists seven names — unbounded, exactly the Forms Manual shape. Two things
were fixed first and neither moved it: the collection weight, and the missing heading (below).

**The fix is not a re-rank — it is a guaranteed seat.** Migration `032` adds
`muni_search_collection()`, a **new** function (`muni_search` untouched, byte-identical) that ranks
inside one collection. `api/muni-ask.js` calls it when the website matched the question but nothing
from it survived the global cut, and **adds** its best two passages. Nothing is displaced, so a
legal question still leads with the law; the prompt separately tells the model a `[web]` passage is
not law and that an ordinance governs where they disagree about a rule. It carries **no weights on
purpose** — within one collection a weight is a constant and cannot change an ordering, so copying
the weight table would only create a second copy to drift.

⛔ **THE HEADING FIELD DECIDES WHETHER A SOURCE IS FINDABLE, AND THE FIRST BUILD THREW IT AWAY.**
`muni_chunks.heading` is indexed at tsvector weight **A**. Every website chunk came back `null`, so
26 passages competed on body text alone against 2,800 that also got the A-weight boost. GoDaddy
publishes real `<h1>`–`<h4>` — *Village Council*, *Department of Public Works*, *Finance*, *Police*,
*Covered Bridge Days*, *Utility Billing Payments* — precisely the terms people search. Those are now
captured before the tags are stripped and attached to the chunk they head, **after** the shared
chunker runs. ⚠ `scripts/lib/muni-corpus-lib.mjs` is NOT touched: enriching a result with structure
one source happens to publish is a different thing from changing how text is split.

⚠ **THIS IS THE ONLY COLLECTION THAT GOES STALE.** An ordinance from 2019 is still the ordinance; a
cancelled meeting notice is wrong the moment it is superseded. Every page stores when it was fetched,
the API labels passages `[web, read <date>]`, the UI tags the source with that date, and the model is
told to date any answer that is a date, an event or a meeting time. **The crawl is not scheduled yet
— that is the open item.**

**Two measured traps in the crawler, both of which silently destroyed the good content first:**
- **GoDaddy renders the navigation 4–5× per page** (one copy per breakpoint). Extract naively and
  every page arrives with its menu repeated ahead of the content. De-duplicated within a page.
- **Site chrome is measured, not listed** — a line appearing on ≥75% of pages is chrome. A hardcoded
  "Home | Contact | Privacy" blocklist is a guess about one site. ⚠ But a repeated line is not
  automatically worthless: anything carrying a **phone number, street address, email, date or
  opening time is kept however often it repeats**, or the tidy-up would delete the answer to "what is
  the village office number".
- ⛔ **SHORT IS NOT EMPTY.** A 40-word floor dropped **six of twelve pages**, including `/festivals`
  — whose entire content is *"11/11 Military Veteran Walk"*, *"7/18-7/20 Covered Bridge Days"* and
  Home Town Christmas. That is 39 words and it is the calendar Keith asked for by name. The floor is
  **12 words**; the pages that still fall out are a heading and a download button.
- ⛔ **A LINK LABEL WITHOUT ITS DESTINATION ANSWERS NOTHING.** `/utilities` is almost entirely button
  captions pointing at bsaonline.com and watercustomer.com; strip the hrefs and "where do I pay my
  water bill" retrieves captions and no answer. External links become `Label — https://…`.

```bash
node scripts/ingest-muni-website.mjs --tenant centreville --list    # what pages exist
node scripts/ingest-muni-website.mjs --tenant centreville --dry     # nothing written
node scripts/ingest-muni-website.mjs --tenant centreville           # skips unchanged pages
node scripts/ingest-muni-website.mjs --tenant centreville --force   # re-chunk unchanged text
```

**Gate: `node scripts/verify-muni-website-source.mjs` → `WEBSITE-SOURCE-VERIFY-COMPLETE`, 11 checks,
exit 0/2/3** — wired as the `muni` deploy profile. It asserts the website answers the questions only
it can answer, that the crawl is **current** (fails over 45 days), that the adopted code still leads
on a legal question, and — so the gate cannot go decorative — that the guarantee is **load-bearing**,
i.e. those queries really do miss the website on global rank.

### TENANT #2 — Town of Bristol, Indiana (NEW 2026-08-25), and what a second village actually cost

Keith: *"lets build bristol."* Live at **`civicscope.io/bristol`** — Ask-only, no sign-in, **719
documents / 1,316 passages**, built end to end in one session for roughly a dollar of compute.

| | Centreville | Bristol |
|---|---|---|
| Source of the code | a Drive folder of PDFs, 7 of 21 with **no text layer at all** | **Municode**, structured, section-level |
| OCR spend | ~$21, plus 240 transcriptions that exist nowhere else | **$0** |
| Time | hours | ~1 minute for 575 sections |
| Headings | recovered by heuristic from OCR'd text | the vendor hands over `Sec. 4-1. - Definitions.` |
| Citations | "page 40-ish of this 90-page PDF" | a deep link to the exact subsection |

**Ask-only and no-sign-in cost ZERO code.** The hub renders the Well Testing card only when
`water_wssn` is set, and `auth_provider='none'` opens the page. Both are rows. That is the
"village #2 is a config row" design paying for itself the first time it was tested.

⛔ **THE MUNICODE API IS OPEN AND THE ONLY THING IT WANTS IS A HEADER.** Everything under
`library.municode.com/api` answers **401** to an ordinary request and **200** to the same request
carrying **`x-csrf: 1`**. No key, no cookie, no login. Recorded because a lot of time went into
`api.municode.com`, which is a **different host** that 404s these paths. The chain, none skippable:
`/api/Products/name?clientId=<c>&productName=code+of+ordinances` → `Model.ProductID` ·
`/api/Jobs/latest/<productId>` → `Id` · `/api/codesToc?jobId&productId` → chapters ·
`/api/CodesContent?jobId&productId&nodeId` → every section.
Ingester: `scripts/ingest-municode.mjs`. Bristol is Municode client **20600**.

🚩 **BRISTOL'S CORPUS IS TEN MONTHS BEHIND AN ADOPTED CODE, AND THE TOOL NOW SAYS SO.** The root
`CodesContent` carries a `NewOrds` array: **Ordinance No. 3-5-2026-06, adopted 2026-03-05, "ADOPTING
AND ENACTING A NEW CODE FOR THE TOWN OF BRISTOL"** — while what is published is codified through an
April 2025 ordinance. ⚠ **Municode holds no text for it** (`PdfText` empty, `PDFBlobExists` false,
`WebViewerUrl` null — checked, not assumed), so what is in the corpus is a **notice**, in its own
collection `Adopted Ordinances (Not Yet Codified)` at the default 1.00 weight, deliberately never
mistakable for the code. Same shape as Centreville's missing setback table: an ingest that looks
complete and is not.

**The terms question, investigated 2026-08-25 and NOT closed.** `library.municode.com/robots.txt`
is a Cloudflare Content Signals policy: for `User-agent: *` it is `Allow: /` with
`search=yes, ai-train=no, use=reference`. **`ai-input` — which their own preamble defines as
"retrieval augmented generation" — is not specified**, and the policy's clause (c) says an omitted
signal "neither grants nor restricts". ⚠ But they `Disallow: /` **ClaudeBot, GPTBot, CCBot,
Google-Extended, Amazonbot, Applebot-Extended, Bytespider and meta-externalagent** by name; we are
none of those and identify as `CivicScope/1.0` under `*`. Literal reading permits; intent reading is
less comfortable. **The CivicPlus Terms of Service could not be read** (403 to a request, empty
headless) — that is the document that would settle it, and it is a Keith action. On copyright: the
ordinance text is a government edict outside copyright entirely (*Georgia v. Public.Resource.Org*,
2020); Municode could assert only thin *Feist* compilation copyright in arrangement — not in
Bristol's law. **The clean resolution is the town's own authorization, not a terms analysis.**

### ✅ THE ZONING SETBACK TABLE ANSWERS (2026-08-25) — and it took FOUR causes, each of which looked like the fix

*"What is the minimum rear yard setback in the R-1 district?"* now returns **30 ft front / 10 ft each
side / 40 ft rear, per Table 4-4**, flagged `[scan]` so the reader is told to confirm it. This is
the question the corpus has never been able to answer, and the value is in how many separate things
had to be true at once.

**Cause 0 — the premise was wrong.** This file recorded the table as *missing*, "surviving only as
debris". It was not missing: `pdftotext -layout` had recovered the whole of it from the text layer
all along, R-1 row included, and the page was never even thin enough for OCR to look at. **The
defect was always retrieval, never extraction.** (Also: it is **Table 4-4**, not 4-5.)

**Cause 1 — a table split from its own header row answers nothing.** The chunker packs to ~1,200
characters, so the column headers (`Zoning District … Minimum Yard Setback … Front Side Rear`)
landed in one chunk and the data rows (`R-1  20,000 sq. ft. … 30ft. 10ft. 40ft.`) in the next. One
half holds the words, the other holds the numbers, and neither answers the question. Fixed with
`chunkSegments()` in the shared lib: **any page naming a table is kept whole**, headed by its own
printed caption. One rule plus a named exception — `chunk()` is still the only thing that splits
prose, and both ingesters still call it. Persisted in `muni_docs.segments` (migration `037`) so
`--rechunk` cannot silently re-split it later.

**Cause 2 — every positional heading rule filed it under the wrong section.** The table is *printed*
on page 4-13 while Section 4.5 starts on 4-4, because this ordinance gathers its tables at the end
of an article. Section inheritance said 4.6; a contents-page lookup said 4.6. The page says what it
is on its own first lines, so `tableCaptionOf()` uses that and the positional rules became the
fallback. ⚠ A 12-line scan window found nothing — the page opens with the tail of Table 4-3 — and
the fix looked like it had failed until the window covered the page.

**Cause 3 — prose about a table beats the table.** Even whole and correctly headed, it lost: a table
states each term once, while the page of *footnotes* to it repeats "setback", "front yard" and "R-1"
many times, and `ts_rank_cd` rewards exactly that. Measured at **#9, #10 and outside the top 12**,
while "site development requirements table" put it at **#1** — findable only by someone who already
knew its name. ⛔ **Not a weight**: prose can repeat without bound, so no constant closes the gap
(018/019/020, third time). Migration `038` adds `muni_search_tables()` and `api/muni-ask.js`
**guarantees the best two tables a seat**, exactly as it does for the village website.

**Cause 4 — a guaranteed seat at the back of a full room is not a seat.** The guarantee fired, the
table was in `hits`, and it still never reached the model: guaranteed passages were **appended**, and
the twelve ranked hits for that one question total **26,621 characters against a 24,000 ceiling**, so
the context loop broke before reaching them. Guarantees now **prepend**, and the ceiling is 30,000
because a table is now one large chunk.

⚠ **Two seats, not one**: asked how tall a building may be in R-2, the best-matching table is
Table 4-1 — which states what each district is *for* and carries no dimensions — and the dimensional
table is second.

⚠ **Still honest about what it has**: the transcribed columns are misaligned for some districts, and
the tool says so. Asked for R-3's minimum lot area it *refuses to state a figure* it cannot attribute
to a row with confidence. That is the correct behaviour and it should stay.

### ⛔ IN INDIANA, A TOWN'S ZONING MAY NOT BE THE TOWN'S — Elkhart County, 2026-08-25

Keith asked whether counties control a lot of zoning and whether the law differs by state. It does,
and it had already put a hole in a live product.

**Bristol's own code says so.** Sec. 12-195 adopts the **Elkhart County Development Ordinance** by
reference under **IC 36-1-5-4**; Sec. 12-196 designates the **county** plan commission as Bristol's
municipal plan commission under **IC 36-7-4-410(a)**; Sec. 12-197 reserves only the district map to
the town. So uses, setbacks, procedures and subdivision control — every substantive zoning rule
inside Bristol — live in a county document. Ask Bristol reported 719 documents and had none of it.
Elkhart County Planning runs the same arrangement for **Middlebury, Wakarusa and Millersburg**.

⚠ **This is Indiana-shaped and does not exist in Michigan.** The Michigan Zoning Enabling Act
(PA 110 of 2006) defines a county's zoning jurisdiction to **exclude** incorporated cities and
villages, so Centreville zones itself and its corpus is genuinely whole. **Before onboarding any
Indiana municipality, check whether it delegated to a county or area plan commission** — it changes
what you ingest and arguably who the customer is.

**A pointer, not four copies.** `elkhart-county` is its own tenant (inactive, no route, not a
product) holding the county corpus; `muni_tenants.shares_corpus_with` (migration `040`) points
Bristol at it and `api/muni-ask.js` runs a second retrieval and merges. Copying a 1,071,426-character
ordinance into four town corpora would guarantee four versions drifting the first time the county
amends it. Ingested with `scripts/ingest-pdf-urls.mjs` — the third corpus shape after Drive and
Municode, and the commonest: a planning department with a page of PDF links.

⚠ **`-layout` is right for this document even though it interleaves its two-column definition
pages.** Reading-order mode destroys the district tables, which are the part that matters. Measured
both ways before choosing.

**Four more retrieval causes, all of them the same shape as the setback chain:**
- **`is_table` is now a column** (`041`), set by the ingester which *knows* it emitted a chunk whole.
  `038` identified a table by `heading ilike 'Table %'` — Centreville's house style — so 82 county
  table pages headed *"R-1 Single-Family District — Building Placement & Form"* were invisible to the
  one mechanism built to surface them.
- **Shape detection, not captions** (`tabularPages()`): this ordinance numbers no tables at all.
- **The 036 sufficiency fix was never carried to `muni_search_tables`** (`043`). ⚠ *When a retrieval
  gate is copied to a second function, its fallback conditions come with it — a fix applied to one
  and not the other is a fix and a landmine.*
- **Length normalisation** (`044`, `ts_rank_cd(…, 2)`, scoped to the table search only): every top
  hit was a 6,000–7,800-character general-provisions chunk beating a compact district table. Three
  thresholds had already been tuned on this problem; normalisation is bounded by construction.

🚩 **STILL OPEN, HONESTLY.** Bristol answers *that* the county governs it, finds the **TC Town
Character Preservation Overlay** that applies specifically to Bristol, and quotes R-3's real
setbacks. **R-1's dimensional row still does not reach the model** for setback phrasings — the chunk
is correctly built, flagged and headed, and ranks #2–#3 among county tables, so this is ranking, not
extraction. Do not tell Bristol its zoning dimensions are covered.

### ⛔ FOUR LATENT BUGS SURFACED ON 2026-08-25 — all of them silent, all of them found by use

1. **The Drive ingest had been dead since 2026-08-20.** `ingest-muni-corpus.mjs` referenced
   `SB_URL`/`SB_KEY`, which stopped existing in that file when the shared chunker moved into
   `lib/muni-corpus-lib.mjs` for the BoardDocs work. Every non-`--list` run threw `ReferenceError`.
   It hid because the `&&` **short-circuits**: `--list` never evaluates those operands, and `--list`
   is what you run when you are *checking* the corpus rather than building it — so the check that
   would have caught it was the one thing that still worked. Fixed to use the exported
   `sbConfigured()`.
2. **`muni_search`'s OR-fallback could never fire when it was needed** — see the retrieval note
   below. Latent since migration 009.
3. **The crew tablet's "← Back to the wells" buttons were dead** since the tab bar was removed.
   Inline `onclick="showTab('round')"` in a `<script type="module">`: module scope is **not** global
   scope, so the handler evaluated against `window` and threw. Replaced with one delegated
   `data-tab` listener rather than another global. ⚠ `review.html` only avoids this by style — it
   assigns `window.generateMor` etc. explicitly.
4. **`ingest-muni-website.mjs` silently truncated at `MAX_PAGES`.** Bristol discovered 144 URLs and
   quietly ingested 60, reporting a clean crawl. It now names what it dropped. Written the same day
   as the rule it broke.

### ⛔ A COINCIDENTAL EXACT MATCH WAS SUPPRESSING THE RIGHT ANSWER (migration 036)

Asking Bristol the most ordinary question a town gets — *"Are golf carts allowed on town streets?"* —
returned **the parking fine schedule, alone, at rank 0.006**, and the tool honestly said it could not
answer. Bristol **has** a golf cart ordinance: `golf cart` returns **Sec. 24-292 GOLF CART OPERATION
at 6.454**.

The strict pass requires every term. The fine schedule contains "allowed"; the ordinance does not.
So one document matched all of `{golf, cart, allow, town, street}` — the wrong one — and
`if found then return` meant the OR-fallback, which exists *precisely* for natural-sentence
questions, could never run. **Latent since 009 and affecting every tenant**; Bristol surfaced it
because its ordinances are one dense collection where an accidental all-terms match is easy to hit.

`036` switches that gate from **existence to sufficiency**: strict wins only at **≥3 rows**,
otherwise the OR pass runs. The OR pass matches a superset, so falling through can only add.
Not a weight — migration 020's lesson was that a coefficient is the wrong instrument for a
structural problem, and "found something" standing in for "found enough" is structural.
Centreville's gate stayed 11/11 after it.

**Adding a municipality:** `muni_tenants` row (`active=false`) → point the right ingester at it
(`CORPORA` for Drive, `CLIENTS` for Municode) → ingest → **crawl its website** → check the answers →
`active=true` → one literal rewrite in `vercel.json`. `active` is enforced **server-side** in
`api/muni-ask.js`, because the page is cached in browsers that are already open.

**⚠ A TEXT LAYER DOES NOT MEAN THE DOCUMENT IS COVERED — TABLES GO MISSING SILENTLY (found
2026-08-18).** `Centreville Zoning Book 19.pdf` has a **645,000-character text layer**, so the
ingest classified it `text-layer`, ingested it for free, and reported 603 passages. But the
**Site Development Requirements table — the per-district front / side / rear yard setbacks, lot
sizes, heights and coverages — is not in the extracted text.** `Table 4-4` appears nowhere; the
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

### ⚠ `muni_docs` / `muni_chunks` HAVE A SECOND WRITER (2026-08-20)

`scripts/ingest-boarddocs-policies.mjs` writes **school district board policy manuals** into the
same four tables, for FundView (`FundView\CLAUDE.md` → District Policy Corpus). Source is BoardDocs,
not Drive; the content arrives as text, so **no PDF, no OCR, no Anthropic spend**. Read this before
touching anything `muni_*`:

- **The chunker now lives in `scripts/lib/muni-corpus-lib.mjs` and is imported by BOTH ingesters.**
  `chunk()`, `headingOf()`, `looksLikeTitle()` and `sb()` moved there verbatim; the move was proved
  by diffing fixture output before and after. **Change chunking in that file only.** Two ingesters
  chunking by two copies of the same rule is how one corpus silently drifts from the other while
  `muni_search()` ranks them against each other as equals — the same argument as
  `civicscope-water/derive.js` and `pool/scoring.js`.
- **`muni_tenants` now holds two kinds of row.** Villages (`centreville`) are products. School
  districts (`sd-jgsc`, `sd-unusc`, …) are an **internal research corpus and are always
  `active=false`** — `api/muni-ask.js` refuses them server-side and no `vercel.json` route points at
  an `sd-*` slug. Flipping one active would publish a school district's policy manual under
  CivicScope's name. Do not do it as a side effect of anything.
- **`drive_id` is the generic external key**, as its own column comment says. For a BoardDocs row it
  holds the policy id (`BD2RD6622C3F`). Misnamed for that source, not misused — do not "fix" it with
  a rename; the unique index `(tenant, drive_id)` is the re-run key for both ingesters.
- **Migrations `018`–`021` govern policy-book ranking** in `muni_search()`: Policy Manual 1.60
  (adopted authority, same standing as a Code of Ordinances) · Administrative Guideline Manual 1.25
  · Forms Manual 0.45 · **plus a sort tier putting Forms Manual below every other collection that
  matched**. The village weights are unchanged — Centreville's rankings are byte-identical to their
  pre-018 baseline — and every `.verify.sql` asserts **all sets**, because the way these migrations
  fail is by rewriting the whole function and silently dropping Centreville's ranking while adding
  the new arms. `021` also writes the entire ranking contract onto the function as a comment, so
  it is visible to whoever is debugging a bad answer.
- 🚨 **NO MULTIPLIER COULD FIX THIS, AND TWO MIGRATIONS TRIED — `020` MADE IT A SORT TIER.**
  A BoardDocs "Forms Manual" entry is not a document: it is ONE stub per section listing every form
  *title* in that section. That makes it a short chunk which is almost entirely search terms, so
  `ts_rank_cd` scores it far above real prose discussing the same subject in paragraphs.
  `018` set 0.85 → jgsc's "payroll authorization" returned the form index at **0.779**, above
  `ag6510B PAYROLL AUTHORIZATION` (0.663) and above the adopted `po6510` (0.640). `019` cut it to
  0.45, which fixed jgsc → then sbcsc's "field trip request" put the form index (0.2052) above
  `ag2340A FIELD TRIP GUIDELINES` (0.1250) anyway. Back the weights out and the stub's RAW lexical
  rank is **2.3× a real policy's on jgsc and 4.6× on sbcsc** — the ratio scales with how many form
  titles a section happens to hold, so there is no constant that cancels it. `020` stopped picking
  numbers: Forms Manual gets its own **sort tier**, below every other collection that matched,
  whatever its rank, in **both** the strict and OR-fallback passes. Demoted, not removed — "which
  form do I use?" is a fair question and the stub is the right answer to it.
  **When a weight is meant to change an ordering, verify the ordering — and if what you are
  cancelling has no bound, a coefficient is the wrong instrument.**
- ⚠ **The gate that should have caught it was green, vacuously.** Its head-to-head check searched a
  term with no Forms Manual hit and reported *"nothing to compare"* as a **pass**. It now probes
  five terms, judges every genuine head-to-head, and **fails when a corpus that HAS a Forms Manual
  yields none** — while correctly reporting N/A for a district like `phm` that has no Forms Manual
  at all. A check that cannot locate its own subject has verified nothing, and calling that a pass
  is how it rots back into a green tick.
- ⚠ **A `.verify.sql`'s SHAPE decides whether it can protect anything.** `db-migrate.js` embeds a
  verification in the migration's own transaction **only when it starts with `select`**
  (`embeddableVerify()`); anything else silently degrades to a post-commit check that cannot roll
  the migration back. `020`'s first verify opened with `with src as (...)` and also carried a paren
  bug, so a correct migration went live wearing a failed-verification flag. `021` re-asserts it
  in-transaction. **`020`'s ledger row still reads "verify FAILED" deliberately** — it records what
  actually happened, and tidying that away is worse than a true blemish with an explanation beside
  it. Never open a verify file with a CTE.
- **Gate: `node scripts/verify-boarddocs-corpus.mjs` → `BOARDDOCS-CORPUS-COMPLETE`**, exit 0/2/3
  (3 = could not verify, never a false red). Its offline half needs no credential and no network.
  It pins the two defects that shipped and were caught by reading the output rather than the exit
  code: the metadata table leaking into every policy body, and two-column tables flattening into
  orphan lines — **the same failure that lost the Centreville zoning setback grid.**

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

### Reports filed — `water_mor_filings` (NEW 2026-08-20)

Keith, looking at May 2026 on the OIC page: *"why are we not showing EGLE report that she filed the
old way - I gave you all those reports"*. He had. Seven 2026 workbooks were in
`G:\My Drive\Centreville\2026 MOR Submittals` and **the product had no concept of a filing** — nine
`water_*` tables and not one recorded that a month was submitted. So the page could show every
reading behind March and could not show March.

**Migration `017_water_mor_filings.sql`.** One row per submitted report: the month, the date it went
(EGLE Cover **G39**), who certified it under 1976 PA 399, her comments to the district, and the
**exact workbook** — bytes in the private Supabase bucket `water-mor-filings`, keyed by content
hash, reached only through 15-minute signed URLs. Corrections append: an amended MOR supersedes and
both stay on the record, on the same partial unique index discipline as `water_readings`.

**`filed` is stored verbatim and never recomputed.** It holds what the workbook literally says, read
from its cells by `scripts/extract-mor.py`. Recomputing it from `water_readings` would answer a
different question — *what we would send today* — and would make every divergence vanish exactly
when it mattered.

**⛔ THE COMPARISON IS A DIFF, AND ITS FIRST VERSION WAS WRONG IN THE DANGEROUS DIRECTION.**
`diffFiling()` (exported from `api/water-ops.js`) compares filed metered million gallons and
chemical pounds against the stored records. It shipped counting **every idle well as a divergence**:
a well that did not run is a recorded `0` here and a **blank cell** on the MOR, by EGLE's own
instruction *("do not put 0 in a cell if the pumpage was not checked")*. April reported 24
differences and May 55 — burying the two days that were real inside seventy-nine that were not.
April's own Cover explains it in the operator's words: *"The water tower is currently down for
repair so we are only running well #3."* **A comparison that cries wolf is worse than none, because
the reader stops looking.** Only a non-zero figure on one side against silence on the other is a
finding.

**What it now surfaces on her page, per month:**

| Month | Filed | What differs |
|---|---|---|
| January | *(no date on the Cover — recorded absent, never guessed)* | 4 metered days · 1 filed with no reading · 7 chemical |
| February | 2026-03-10 | 6 · 3 · 11 — incl. **Well 4 day 23: filed 0, records 0.007 MG** |
| March | 2026-04-09 | 4 · 0 · 3 — incl. **Well 1 day 1 phosphate: filed 1 lb, records 10** |
| April | 2026-05-08 | 3 · 3 · 14 |
| May | 2026-06-10 | 3 · 0 · 9 — incl. **Well 3 day 29: filed 0, records 0.02 MG** |
| June | 2026-07-10 | 7 · 7 · 21 — incl. **Well 3 day 5: filed 0.02, records 0.06 MG** |
| July | **2026-08-07** | 0 · 0 · 4 |

The **five days `derive()` refused** (a tank level left blank on a day the well ran) now appear as
*"filed 0.028 MG, no reading on file"* — they had lived only in a script's JSON output. So do the
documented paper-vs-filed divergences.

**The gate: `node scripts/verify-mor-filings.mjs --base <origin>` → 28 checks,
`MOR-FILINGS-VERIFY-COMPLETE`.** Wired into the `water` deploy profile (optional: exit 3 when a
supply has no filings, which is a missing capability and not a verdict). It pins the outcome, not
the mechanism — the documented divergences must still appear, `ours_only` must stay **0** so the
idle-well false positive cannot return, sample counts must match the workbook they were seeded
from, and one workbook is downloaded through its signed link and hashed against what was recorded.
⚠ **Those numbers are the village's, not ours.** Changing one to make a run go green would change
what we say the State of Michigan was told.

**Recording them:** `python scripts/file-mor-submittals.py "<folder>" --wssn 01310 --code <WATER_OPS_CODE>`
— idempotent by content hash (a re-run reports `unchanged` and writes nothing), refuses a month
already on file with different bytes unless `--correction-reason` is given, and reads every month
back through the live API to print the comparison rather than trusting its own writes.

### Michelle generates the MOR herself — `api/build-mor.py` (NEW 2026-08-21)

The generator ran as `scripts/build-mor.py` on Keith's laptop from the day it was written, which
meant **the person legally required to sign the report could not produce it.** Every other gap on
the OIC side was a view she could not see; this one was a capability she did not have.

It is now a **Vercel Python function** — the only Python route in this project. Node cannot fill
EGLE's form: the template is Excel-encrypted, its white cells are ~1,990 formulas, and it is print
laid-out, so it has to be *filled* rather than rebuilt, which needs xlrd/xlwt/xlutils/msoffcrypto.
SheetJS community strips styles on write, and a state form that loses its formatting is not the
form. Proven before it was trusted: a branch build confirmed Vercel resolves Python 3.12 and
installs all four libraries without disturbing the Node build.

⛔ **`api/build-mor.py` IS THE ONLY COPY OF THE FILL LOGIC.** `scripts/build-mor.py` is now a thin
client that posts to it and saves the bytes; its `--template` argument is gone. Two copies of this
rule on two machines is the same defect the whole product exists to remove. **Byte-for-byte
identical output** — the July 2026 workbook produced by the old script, by the function locally,
by production, and by the browser download all share one SHA256; 6,578 cells compared, zero value,
style or merge differences.

**The template is data (migration 022).** `water_supplies.mor_template` keys into the private
`water-mor-templates` bucket, which holds the blank workbook and the formula map extracted from
that same file, paired under a manifest so they can never be resolved independently. A Class C
supply, or another state, is a key and a column value — never a branch in the generator.
Upload with `scripts/upload-mor-template.mjs`.

**Read-only by construction, and generating is not filing.** It reads a month through the ungated
`month` action and the template out of storage; it writes nothing. What Michelle sends EGLE is the
file *after* she adds her Cover comments — she writes them every month — so no draft is kept, and
the filed copy is recorded from the bytes she actually sent.

**`GET /api/build-mor` is a selftest, and it is the route's API contract.** It proves the Python
runtime, all four libraries, and that the stored template is present and decryptable, while
reading no plant data. Built at the moment the route was written rather than months later — the
lesson `api/pool-sms.js` taught in August.

### ⛔ THERE IS NO PLANT ACCESS CODE (Keith, 2026-08-21)

Asked directly whether Michelle holds one: *"there is no plant access code."* `WATER_OPS_CODE` is
an environment variable, not something any person at the village has been given.

That makes it a credential only a script can present — fine for administration, useless as a gate
on the people who operate the plant. Gated, `record_filing` was unreachable by **Michelle and by
everyone else**, while the three actions that write the *data* a future report is built from stayed
open. Backwards: a filing is a statement about a document that already went; a reading is what
flows into the next one. **`record_filing` is now an open operator action** (`1.2.0-waterops`), and
`profile` no longer returns `writesEnabled` — a flag derived from a code that governed nothing the
tablet does.

Same judgement already made about the field PIN, which was enforced for exactly one of four
operators while implying every entry was authenticated. **A gate that stops nobody but the
legitimate user is worse than no gate, because it reads as security.** `add_operator` and
`set_active` stay gated: they change who the record can be attributed to and whether the supply is
live, they are never field tasks, and only a script ever performs them. Google sign-in is what
actually closes this, for both surfaces at once.

**Known gaps, deliberately:**
- ✅ **Service worker and bacti capture shipped 2026-08-18** (network-first on purpose — a
  cache-first shell could pin an old `derive.js` and make the screen and the filed record
  disagree, which is the defect class this product exists to remove).
- ⚠ **Not verified on a real tablet in a real well house.** Registration, scope and the served
  bytes are confirmed in production; "the operator walks into a concrete box and it opens" is not
  provable from here.
- `water_supplies.active` is informational — the working gate is `WATER_OPS_CODE`.

---

## Google sign-in (`api/auth-google.js`) — NEW 2026-08-25

**What it closes.** Keith, 2026-08-25: *"Michelle wants to log in using the oauth on her account —
can we make that happen? She has an assistant that wants to do the same."* Every Centreville surface
has been open on its link and has said so in words rather than pretending otherwise, because
`WATER_OPS_CODE` was never a gate on a **person** — *"there is no plant access code"* (Keith,
2026-08-21). It is an environment variable a script presents. So every action was either open or
unreachable and there was no third state. There is now.

**The hub is the gate** (Keith: *"this is the page that should be gated with login"*). `/centreville`
requires a sign-in; the products sit behind it. Sign-in belongs there rather than on each product
because Michelle is one person holding two jobs — village office and Operator-In-Charge — so one
address, one sign-in, and the page routes her. The session cookie is scoped to `.civicscope.io`, so
following a card into Well Testing on `app.civicscope.io` does not ask again.

⛔ **THE CREW ARE NOT PART OF THIS AND MUST NOT BECOME PART OF IT.** Mark Major and Jeff Derrikson
*"wont have email logins"* (Keith, 2026-08-25). `/water` stays open and asks for a name only. The
deploy gate asserts this on every water deploy, because adding identity to `api/water-ops.js` is
exactly the change that could close the well house by mistake, and a locked tablet stops the plant's
record that day.

**Two checks, never one.** A verified Google ID token proves Google believes this browser controls
that mailbox. It proves nothing about whether the person works for the village. Collapsing those is
how "sign in with Google" becomes "anyone with a Gmail account can correct a compliance record", so
`app_users` (migration `029`) is the second check. **A verified account that is not enrolled gets a
PENDING row and no access** — `active` defaults to `false` in the schema and nothing in the handler
overrides it. That row is a *request*, and it captures the exact address the person used, which is
what turns enrolling somebody into one command instead of a round of "which Gmail did you use?".

**The token is verified here, not at `tokeninfo`** — RS256 over Google's published keys (cached, and
refetched only on an unknown `kid`, which is what a key rotation looks like from here), then issuer,
audience, expiry and `email_verified`. ⛔ **The algorithm is ours to choose, not the token's:**
reading `header.alg` and verifying with whatever it names is the alg-confusion bug in its original
form. Anything but RS256 is a forgery attempt. **There is no client secret in this flow at all** — no
code exchange, no refresh token, so no long-lived Google credential to store, rotate or leak.

**What identity actually buys, in `api/water-ops.js` (`1.3.0-waterops`).** The line is drawn where
the *job* draws it:

| | |
|---|---|
| reads | open — an MOR is a public record and its contents were already served here |
| crew writes | **open, and must stay open** |
| **office writes** | **identity required** — a signed-in person enrolled for *this supply*, or the ops code for a script |
| admin | ops code, or a signed-in CivicScope admin |

⛔ **THE CORRECTION RULE IS ABOUT THE PAYLOAD, NOT THE ACTION NAME.** `submit_reading` is an open
crew write when it records a new day and an **office** write when it carries a `correction_reason`,
because that supersedes a row sitting under a report signed under 1976 PA 399. Keying it on the
action name alone would have left the correction path open while locking the filing path — the same
inversion that was fixed on 2026-08-21, in the other direction.

⚠ **`lib/session.js` IS THE ONE COPY OF "IS THIS BROWSER SIGNED IN"**, imported by both API routes —
same discipline as `civicscope-water/derive.js` and `pool/scoring.js`. **Ship `lib/session.js`,
`api/auth-google.js` and `api/water-ops.js` together**; they are one manifest entry group in
`push_civicscope.ps1` for that reason.

**Gate: `node scripts/verify-google-signin.mjs --base <origin>` → `SIGNIN-VERIFY-COMPLETE`,
exit 0/2/3.** An auth route fails in two directions and only one is visible from a browser: too
tight and Michelle cannot get in (she says so within the hour), too loose and everything looks
perfect while a forged token works just as well. So the load-bearing checks are **negative** ones —
a forged session cookie, an unsigned token carrying plausible Google claims, a correction attempted
with no session — plus the one that stops the plant if it breaks: **the crew's tablet still opens.**
The correction probe deliberately targets a non-existent entry point, so a gate that ever fails open
dies at `404` instead of writing into a compliance record. ⚠ **Exit 3 while
`GOOGLE_SIGNIN_CLIENT_ID` is unset** — no button renders, so "Michelle can sign in" is *unproven*.
Could-not-verify, named in the deploy result, never a green tick (the lesson the pool gate taught on
2026-08-08).

### ⛔ EACH VILLAGE BRINGS ITS OWN SIGN-IN — the client id is DATA (migration 033, 2026-08-25)

Built first against a single `GOOGLE_SIGNIN_CLIENT_ID` env var. Keith, shown that: *"this is village
specific for CivicScope - Centreville. There will be more villages with different credentials (maybe
not even google)."* He is right, and the second half is the part that matters — a village on
Microsoft 365 is a different **identity provider**, which no number of Google projects addresses.

So `muni_tenants` carries **`auth_provider`** (`google` | `microsoft` | `none`, CHECK-constrained)
and **`auth_client_id`**, exactly like `water_feeds` and `mor_template`: a village is a row, not a
release. The env var survives only as a **fallback** for a single-village or preview deployment; a
tenant value always wins. `auth_provider` is REFUSED when it names a provider that is not built,
never quietly treated as Google — a column that falls through to one provider reads as support that
does not exist. `sd-*` research corpora are set to `none`.

**Three checks, and the third is the one that is easy to leave out:**
1. **`aud` is verified against THAT village's client.** With one global id this was trivially right;
   with one per village, "somebody else's app" now includes *another village's client*. There is no
   ambient default that could make this pass — the caller supplies the id.
2. The person is on `app_users` and `active`.
3. **Their `muni_tenant` is the tenant they are signing into.** Miss this and a token verified
   against village A's client authenticates its holder into village B — and because the session
   cookie is domain-wide on purpose (one sign-in across `civicscope.io` and `app.civicscope.io`, so
   following a hub card never re-prompts), `me` would have honoured it everywhere. Checked in both
   `signin` and `me`. CivicScope admins are the deliberate exception.

✅ **LIVE 2026-08-25.** The OAuth client exists and `muni_tenants.auth_client_id` carries it for Centreville; the gate reports `SIGNIN-VERIFY-COMPLETE` with the forged-token check now returning a real 401 **from the verifier** rather than short-circuiting on an unconfigured route. What it took: A **Web application OAuth client** in a Google Cloud
project owned by `keith@anchoradvisorsnorth.com` (CivicScope's account of record), consent screen
**External + In production**, **basic scopes only** (`openid`, `email`, `profile` — no Google
verification). ⛔ **It must NOT go in `jbk-claude`**: that consent screen is **Internal**, so a
personal `@gmail.com` gets `Error 403: org_internal`, and flipping it to External would break the
AAN/JBK Gmail refresh tokens (memory `reference_google_cross_org_access`). Authorized JavaScript
origins: `https://civicscope.io`, `https://www.civicscope.io`, `https://app.civicscope.io`. No
redirect URI and **no client secret** — the ID-token flow has no code exchange. Keith is creating one
project per village (`CivicScope - Centreville`), which also gives each village its own consent-screen
branding at the cost of a console pass per village.

The client id then goes in the **tenant row**, not an env var:
`update muni_tenants set auth_client_id = '<id>.apps.googleusercontent.com' where slug = 'centreville';`
`AUTH_SESSION_SECRET` (which signs our own cookie, and is village-independent) is already set in Vercel.

**Enrolling or correcting people:** `node scripts/app-access.mjs list | add | enable | disable`,
and the same script owns the plant roster (`operators`, `operator-set`, `operator-add`,
`operator-off`). Deactivating an operator removes them from the tablet picker and **nothing else** —
past readings keep both `operator_id` and the denormalised `operator_initials`.

## "The MOR is due on the 10th" — `api/water-reminder.js` (NEW 2026-08-25)

Keith: *"the EGLE - MOR … is due on the 10th of the month for the previous month's results. Can we
send an email reminder to Michelle on the 7th … provide a link to shoot her into the page where she
clicks to generate the report."* Vercel cron `0 12 7 * *` (08:00 ET). The link is
`/water/review?wssn=…&m=YYYY-MM`, which opens the review page **on that month with the Generate
button in view** — a link that lands on a generic dashboard makes the reader do the navigation the
email existed to save them.

- **It says nothing for a month already on record.** `water_mor_filings` knows. A monthly nag that
  is usually wrong gets filtered, and then the one that mattered is filtered too — the same argument
  that forced `diffFiling` to be rebuilt.
- **It is safe to call twice, deliberately.** This project's own backlog says Vercel cron is
  unreliable, and a missed digest costs a day of numbers while a missed reminder costs a filing
  date. `water_mor_reminders` (migration `030`) holds one row per (supply, period, kind) under a
  unique index **partial on `outcome = 'sent'`**, so the route can be wired to a second scheduler
  without ever mailing the OIC twice — and a run that found nobody, or failed at Resend, leaves the
  period **open for a retry** rather than occupying it.
- **"Nobody to send it to" is not a success.** Recipients are the enrolled `oic`/`staff` rows for
  that supply; an empty list mails CivicScope and records `no_recipient`. A reminder system whose
  failure mode is silence has already stopped working and nobody has noticed.
- The message carries **what the month currently holds** — well-days, distribution, bacti — because
  a month with no bacti cannot be signed cleanly, and July 2026 reached the state with none.
- Exercise it without sending: `POST /api/water-reminder?dry=1[&year=&month=]` with the cron bearer.

## What the village asks, and what it cannot answer — `scripts/muni-usage.mjs` (NEW 2026-08-25)

Keith, on the two audiences: going public is phase two, but *"indexing around how staff use the
tool will be useful."* Run `node scripts/muni-usage.mjs` (`--tenant`, `--days`, `--failures`).

### ⛔ THE QUESTION LOG WAS ASSERTING SOMETHING FALSE, AND THE METRIC COULD NOT GO RED

`muni_questions.answered` was set true whenever the model produced prose. So a question that
retrieved twelve passages and was told *"the passages I have do not contain the R-1 dimensional
table"* counted as **answered**. Measured 2026-08-25: **68 of 68 answered, 0 with zero hits** —
while a real user asked for setbacks on 18 August and could not get them for a week. A dashboard
that reports 100% on a product with a week-old hole in it is worse than no dashboard.

Migration **045** replaced it with what the model reports about its own answer (`outcome`,
`cited_collections`, `used_table`). The marker is the first line of the reply, stripped before the
reader sees it. A model that emits no marker is recorded as `answered` rather than guessed at from
its prose — **an inferred outcome is the thing this replaced.** Pre-045 rows stay `null` and print
as *"outcome unknown"*; back-filling them from `answered` would manufacture the 68 records this
exists to stop the table asserting.

### The distinction the report is built around

| Outcome | Means | What to do |
|---|---|---|
| `answered` / `partial` | the documents carried it | nothing |
| `referred` | this government does not hold the fact, and the answer named the one that does | **nothing — this is the tool working** |
| `declined` | passages were retrieved and none answered it | **a retrieval or chunking defect.** The corpus had content to offer and could not reach the answer |
| `no_corpus` | nothing matched at all | a corpus gap — go and get the document |

`declined` and `no_corpus` are the only two the report calls broken.

### ⛔ `referred` EXISTS BECAUSE 045 HAD THE MIRROR DEFECT — IT COULD NOT GO GREEN FOR A CORRECT REFUSAL

On the first day of real outcome data, two questions logged `declined`, and they are opposites:

- **Bristol, "front setback in the R-1 district"** — the Elkhart County dimensional table **is** in
  the corpus and retrieval cannot reach it. A defect.
- **Centreville, "how much does a dog license cost?"** — the Village does not issue dog licences.
  § 10-3 adopts the county dog ordinance by reference, and the tool **found that**, named the
  St. Joseph County Treasurer, and gave the Village phone number with the date the site was read.
  That is the best answer available and arguably the best answer the tool has produced.

Filed under one label, the failure list sends the village chasing a bug that does not exist while
burying one that does. And this is not an edge case: **Bristol delegates its entire zoning power to
Elkhart County**, so "the answer belongs to another government" is a routine correct outcome for a
whole tenant. Migration **046** added `referred`, counted separately and never as a failure.

### ⛔ AND THEN `referred` IMMEDIATELY ATE THE ONE DEFECT IT WAS BUILT TO EXPOSE

Minutes after shipping, Bristol’s R-1 setback logged **`referred`** — the model pointed politely at
"section 158.03(B)(3), page 3-8 of the Elkhart County Development Ordinance". **That page is in this
database.** It was merged into the passages for that very question through `shares_corpus_with`.
The model cannot know which corpora we ingested, so it will refer to a document we already hold,
and the new outcome absorbs the failure — the same disappearing act as the old `answered` flag, one
layer up.

**The server overrides the model, because only the server knows what was ingested.** If a `referred`
answer names the government whose corpus this tenant already shares, it is recorded as `declined`.
Deliberately narrow — it matches the shared tenant’s own name, so a genuine referral to a state
agency or an un-ingested county stays `referred`.

⚠ The label is stored qualified (`Elkhart County, Indiana`) while an answer writes *"the Elkhart
County Development Ordinance"*. Matching the whole label makes this **dead code that always looks
like it is working** — match the part before the comma.

Verified live after deploy: Bristol setback → `declined`, dog licence → `referred`.

### Reading the report

- **keyword-style** — staff type keywords ("irrigation wells", "what is code 21") because they want
  a *document*; residents write sentences ("how tall can a fence be?"). A distribution worth
  watching, not a claim about any one question.
- **used a table** — whether the table machinery built this month reached a real question.
  ⚠ It must not under-report: `muni_search` does not return `is_table`, so a table arriving through
  ordinary retrieval looks like prose. Counted by guaranteed chunk **id**, plus the heading test.
- **asked more than once** — the shortlist for what the village should publish, and how you notice
  one person retrying a question that keeps failing.

### ⛔ "Village Website" WAS A LITERAL STRING IN SEVEN PLACES, AND BRISTOL IS A TOWN (migration 047, 2026-08-25)

The usage report printed `WHAT ANSWERS GET CITED -> Village Website` for **Bristol**, a Town. The
collection name is not internal: it is printed under every answer as the source. Keith had already
given this correction once — *"Bristol is a town - not a villiage - village website and footer
language need to be changed"* — and migration 039 answered it with `unit_noun` for the hub, the
footer and the logo. **The data layer never got the memo**: 143 Bristol documents were still filed
under the literal string.

⚠ **The rename was not free, and that is the whole reason it is a migration.** Migration 031 gives
`Village Website` a ranking weight of **1.10**, matched as an exact string in a simple
`case d.collection`. Renaming the data alone would have dropped Bristol to the 1.00 default —
silently un-ranking its entire website corpus, no error anywhere, the only symptom being worse
answers. **And the deploy gate that exists to prove that weight is load-bearing
(`verify-muni-website-source.mjs`) defaulted to `--tenant centreville`, so it would have gone on
passing.** The gate now resolves the collection from the tenant, and it passes for both.

So the weight matches the **concept**, not one spelling of it: any collection ending in `Website`.
A City or a County ingested tomorrow inherits it without another migration. Seven call sites moved
together — `muni_search` (both weight blocks), the `muni_docs` rows, the ingester, the deploy gate,
the website guarantee in `api/muni-ask.js`, and the primary/secondary split.

### ⛔ AND THE PRIMARY/SECONDARY SPLIT WAS ALREADY BROKEN — BY AN INVISIBLE BYTE

While fixing the above, Bristol’s `Town Website` came back **secondary**. So did Centreville’s
`Village Website`. The source said, plainly:

```js
|| /\bWebsite$/.test(String(h.collection || ''))
```

**That is not what was in the file.** The `\b` was a real **U+0008 backspace character**, written by
a patch script whose escape the shell had eaten. The regex matched a control byte followed by
`Website` — it could never match anything. `grep`, `sed` and the terminal all render U+0008 as
nothing, so the line *read as correct* in every tool used to inspect it, including a fetch of the
deployed file straight from GitHub.

Half an hour went into confirming the deployment was live — the Vercel alias, the deployment id,
the commit sha, the CDN cache header — all of which said production was running exactly this code.
**They were right. The code was wrong in a way that could not be seen.** What found it:

```bash
node -e "fs.readFileSync(f,'utf8').split(/?
/).forEach((l,i)=>console.log(i+1, JSON.stringify(l)))"
```

`JSON.stringify` is the tool. It renders U+0008 as `\b` and a real backslash as `\` — the only
cheap way to tell them apart. **When behaviour contradicts source that looks correct, dump the line
through `JSON.stringify` before doubting the deployment.**

Impact: since the authority split shipped, **no village website had ever been marked primary** —
every website citation was presented to readers as a secondary source. Verified after the fix:
Centreville `Village Website` → primary, Bristol `Town Website` → primary.

⚠ Every patch in this session that wrote a backslash through a heredoc was mangled the same way
(`s` → `s`, `
` → newline, `.` → `.`). A mangled regex still **runs**; it just matches nothing,
and an assertion built on one passes vacuously. Build backslashes with `String.fromCharCode(92)`,
or write patterns that need none — migration 047’s verify counts with a length-delta instead of a
regex for exactly this reason.

### The "Try:" chips are per-tenant and VERIFIED (migration 048, 2026-08-25)

Keith: *"we should suggest questions that actually return answers"*.

The four chips were one hardcoded array in `civicscope-muni/index.html`, shown identically to every
tenant. They were written against **Centreville** and then inherited by **Bristol** — a different
body of law in a different state. Measured against Bristol live: *"Who sits on the Planning
Commission?"* came back **DECLINED** and *"Are golf carts allowed on the streets?"* only
**PARTIAL**. Both were on the page.

⛔ **That is worse than a question a resident types and we cannot answer.** A suggested question is
the product telling somebody what it is good at, in their first ten seconds with it. If the first
thing a Town clerk clicks comes back empty, the honest conclusion is that the tool does not work —
and they are right to draw it, because **we** picked the question.

`muni_tenants.sample_questions` (jsonb) now holds the chips per tenant, and nothing lands there
that has not been **asked against that tenant live corpus and come back `answered`**.
`scripts/verify-sample-questions.mjs` is the only supported writer:

```
node scripts/verify-sample-questions.mjs --tenant bristol --dry-run
node scripts/verify-sample-questions.mjs --all
```

- `partial` is rejected too — a chip that half-answers invites the follow-up we cannot do.
- `referred` is rejected — correct behaviour, but it advertises what the corpus does NOT cover.
- The candidate pool is broad and generic; the corpus decides which survive. **Do not tune the pool
  to make a tenant pass.** A tenant that cannot field four of them is a finding about its corpus,
  and the answer is to ingest the missing document, not to nominate an easier question.
- Null falls back to the generic list, so an unverified tenant still gets a prompt.

⚠ **Re-run after any ingest.** A corpus change can retire a chip as easily as it can earn one, and
a chip that silently stopped working is the whole failure this replaced. Outcomes also vary
slightly run to run at the margin (a borderline question can move between `answered` and
`partial`), so treat the set as a snapshot, not a proof for all time.

Verified sets as at 2026-08-25 — note they overlap only partly, which is the point:

| Bristol (Town) | Centreville (Village) |
|---|---|
| How tall can a fence be in a front yard? | How tall can a fence be in a front yard? |
| What are the rules for keeping chickens? | How many dogs can I keep? |
| Do I need a permit to hold a garage sale? | Do I need a permit to hold a garage sale? |
| What are the rules for operating a business out of my home? | How tall can a building be in a residential district? |

### The municipality mark is on the Ask page too (2026-08-25)

`logo_url` (migration 039) was rendered on the hub but not on `/‹slug›/ask`, so Bristol arrived at
an unbranded page from a branded one. Same markup and sizing as the hub — a reader crosses between
them and it is one product. A tenant with no `logo_url` renders nothing rather than a gap.
⚠ **Centreville has no `logo_url`** and therefore shows no mark on either surface.

### ✅ BRISTOL R-1 SETBACKS ANSWER (2026-08-25) — three defects, and the first two hid the third

The standing failure was *"In Bristol, what is the front setback in the R-1 district?"* — logged
`declined` with 15 passages retrieved. It was never a ranking problem, which is what it looked like
for a week. Asked directly, `muni_search(elkhart-county, "front setback R-1 district")` returned the
right chunk at **#1**. Three separate defects sat between that and the reader.

**1. The town own name was poisoning its own retrieval.**
People write *"In Bristol, what is..."* — naming the place is the natural way to ask. But every
document in the tenant is already about Bristol, so the word carries no information and enormous
term frequency. Measured:

| query | the town top 12 |
|---|---|
| with "Bristol" | Farmers Market ×5, Parks Dept, Fire Station, Water Bill, 2 history pages |
| without | ordinance sections, and the R-1 dimensional table ranks |

143 website pages carry the town name and `ts_rank_cd` rewards that without bound. Worse across the
shared corpus: the Elkhart County ordinance never says "Bristol", so including it **broke the strict
all-terms pass** and dropped the county to the OR fallback. The name is now stripped for RETRIEVAL
only — the model still receives the question exactly as typed.

**2. The shared corpus was appended, so the context budget ate it.**
`hits = hits.concat(shared)` — the comment said *"the county is added"*, and it was: added where the
budget throws it away. The town 12 own hits filled 25,292 of the 30,000-char budget, so the loop
broke **before any county passage at all**. Bristol zoning answer was being assembled from the
Farmers Market page. Exactly the failure the table guarantee documents one level down, unnoticed one
level up.

⚠ **They cannot simply be sorted by rank.** The two arrays come from separate `muni_search` calls
that may have taken different passes, so the numbers are not on one scale — measured on the same
question, the town scored 2.5–7.5 (strict) and the county 0.015–0.05 (OR fallback). Sorting looks
principled and is not. They are **interleaved**: each corpus keeps its own ordering and is
guaranteed seats at the front, which needs no cross-corpus comparison.

**3. ⛔ AND THE TABLE FLAG WAS ON THE WRONG PAGES — `chunkSegments` located pages from position 0.**

A detected table page is found in the assembled text by its first 120 characters. That is correct
only if those characters are unique. In a published ordinance they are the opposite of unique —
every page of a district standards opens with the same running header:

```
158.03(B)   STANDARD DISTRICTS
  R-1 Single-Family District
(3) Building Placement & Form
```

so each R-1 table page matched the FIRST page carrying that header. The result, measured:
**chunks 88–90 — the district purpose and permitted-uses pages, holding no table at all — were
flagged `is_table` and given the heading "R-1 Single-Family District — Building Placement & Form",
while the pages with the actual dimensional rows landed at 91–93 unflagged and with NO heading.**
Heading is the weight-A field. So the one passage carrying R-1 front setback was simultaneously
unfindable and unmarked, and `muni_search_tables` dutifully guaranteed a seat to a page with no
numbers on it. The fix is a monotonic scan — search forward from the last match, never from zero.

After re-ingest every district Building Placement page is one flagged, correctly-headed chunk, and
the answer is complete:

> the minimum front setback is measured **from the centerline of the road** — **50 ft from a named
> road or street, 75 ft from a numbered county road, 120 ft from a federal/state highway**

It also flagged, unprompted, that two scanned tables disagree on an adjacent figure (minimum lot
size 5,000 vs 4,000 sq ft) — the transcription-uncertainty rule doing exactly its job.

⚠ **This bug affected every corpus ingested before 2026-08-25.** Centreville Table 4-4 answers
correctly and was left alone, but **67% of Centreville chunks carry no heading** and its other
tables may be misfiled the same way. Re-ingesting the zoning book is the obvious next probe.

⚠ **`--force` writes even when the OCR rescue fails.** The first re-ingest attempt pulled the
per-tenant key from the Vercel API with `decrypt=true`, got a 1,308-character encrypted blob rather
than a key, 401ed on every OCR call — **and wrote the document anyway**, silently downgrading it
from `mixed` to `text-layer` and dropping the TC Town Character Preservation Overlay page. Recovered
by pulling the key properly (`vercel env pull`, read, then overwrite and delete the file — it holds
54 production secrets). A partial ingest should not be able to overwrite a better one.

### The Centreville re-ingest was NOT needed — and measuring that found a different bug (2026-08-25)

The plan was to re-ingest the Centreville zoning book because the `chunkSegments` position-0 bug
affected every corpus built before today. **Measured first, and it did not apply.** Of the zoning
book 23 stored segments: **0 have an ambiguous probe, 0 would be placed differently by the
monotonic scan, 0 are unfindable.** Centreville captions its tables ("Table 4-4 — SITE DEVELOPMENT
REQUIREMENTS"), so every page opens distinctly; Elkhart County numbers no tables and repeats a
running header, which is precisely why it broke there and not here. A re-ingest would have spent an
OCR run to change nothing.

The **67% of Centreville chunks carry no heading** figure was also misleading. By collection:

| collection | chunks | no heading |
|---|---|---|
| Village Information | 1,155 | 99% |
| Village Voice & Calendar | 1,098 | 96% |
| Zoning & Planning Commission | 882 | 32% |
| Code of Ordinances | 547 | **8%** |
| Village Website | 26 | 0% |

The headingless mass is newsletters and informational pages, which genuinely have no sections. The
law-bearing collections are well headed. No defect.

### ⛔ BUT `segments` HOLDS TWO KINDS OF PAGE AND `chunkSegments` CALLED BOTH A TABLE

`muni_docs.segments` deliberately records both indivisible-page kinds — the TABLES pdftotext could
read, and the sparse pages it could NOT that the vision model rescued. The comment in
`ingest-muni-corpus.mjs` says so outright. `chunkSegments` set `is_table: true` on **every** one.

On the Centreville zoning book that is 4 real tables and 18 pages that are nothing of the sort: the
ordinance TITLE PAGE, the Planning Commission bylaws, and a page of instructions about photocopying
maps. It has been invisible because Centreville was ingested before migration 041 added the column,
so the flag was never written and the legacy `heading ilike 'Table %'` fallback carried it. Elkhart
County, re-ingested today with current code, would have started accumulating it.

This is not cosmetic: **`muni_search_tables` RESERVES A SEAT** for what it believes is a table,
because a table states each term once and cannot win a term-frequency race against the prose
discussing it. Mislabelling prose spends the dimensional-standards guarantee on a title page.

Segments now carry `kind: table | rescue`, set by both ingesters. An older record without one is
judged by the same SHAPE test that detected the page — never by its heading, which is a publisher
house style (the rule 042 deliberately moved away from).

### ⚠ AND THE RETRO PASS NEEDED A DIFFERENT THRESHOLD FROM THE INGESTER — I GOT THIS WRONG FIRST

`scripts/reconcile-table-flags.mjs` fixes the flag without a re-ingest. Run at the ingest-time
threshold (`minRows 2 / minCells 4`) it flagged Table 4-4 correctly **and also the ordinance title
page and a page of bylaws** — "16-48 / 18-18 / 18-19" are page references and the cell pattern
cannot tell those from measurements. Those two writes were made and then undone by hand.

Two rules came out of it, and they pull in opposite directions on purpose:

- **The retro threshold is STRICTER** (`minRows 4 / minCells 5`). At ingest a miss is expensive —
  it splits a table from its header row — so permissive is right, and Elkhart continuation pages
  need it. Retroactively the failure mode is inverted: a false positive spends a guaranteed seat.
  Table 4-4 scores 9 rows; the two false positives score 3.
- **Add on inference, remove only on evidence.** A flag the INGESTER set came from `tabularPages`
  run against the whole page at the moment it chose to keep it intact — stronger evidence than
  anything reconstructable later. Applying the strict test symmetrically would have **stripped 72
  correct flags** off the Elkhart ordinance. A flag is now cleared only when the record says
  `kind: rescue`.

End state: Centreville has exactly one flagged table (Table 4-4), Elkhart 106 (all ingester-set),
and both setback answers verified unchanged.

### ⛔ A PARTIAL INGEST CAN NO LONGER OVERWRITE A BETTER ONE (2026-08-26)

`--force` re-ingests whether or not the text changed, which is what you want after a chunker fix.
What you do not want is 2026-08-25: the OCR key resolved to an encrypted blob, every OCR call 401ed,
**and the document was written anyway** — `mixed` to `text-layer`, silently dropping the
transcription of every page pdftotext cannot read, one of which is the TC Town Character
Preservation Overlay that applies to Bristol. The run reported `1 written` and exited 0.

Nothing about that was detectable downstream. The corpus just got quieter.

`isDowngrade(stored, incoming)` in `muni-corpus-lib.mjs` now refuses any write that would lower a
document transcription quality, in BOTH ingesters. `mixed` and `ocr` rank equal — both mean "pages
a machine could not read were transcribed" — and the only thing prevented is falling back to a text
layer already known to be insufficient. `--allow-downgrade` is the explicit opt-in. A refusal is
counted, printed, and **sets exit code 2**: an ingest that declined to do what it was asked must not
look like one that succeeded.

Verified by reproducing the exact failure with a deliberately invalid key: `REFUSED`, exit 2,
document still `mixed`. The guard then blocked a legitimate restore too (the restore had omitted
`--ocr`, so it really was producing text-layer) — which is the guard working.

### ⛔ AND TESTING THAT GUARD EXPOSED A WORSE ONE: `--rechunk` HAD NEVER PRESERVED TABLES

The `--rechunk` branch reads `prev.segments` to keep transcribed table pages whole, and carries a
six-line comment saying that without it `--rechunk` silently undoes the table fix. **The comment was
right and the code never worked**: the `muni_docs` SELECT that builds `prev` did not fetch the
`segments` column, so `prev.segments` was ALWAYS undefined. Every `--rechunk` therefore wrote
`segments: null` and fell back to the paragraph chunker.

Running it on the Centreville zoning book to test the downgrade guard did exactly that: Table 4-4
split back across 6 chunks, filed under "Section 4.6 — Special District Provisions", and the setback
question started answering *"The passages do not contain the R-1 dimensional table"* — the original
defect, restored in full, by the command whose documented purpose is improving retrieval.

Restored by re-running the ingest with OCR (19 pages, ~$0.67): 631 chunks, 23 segments, Table 4-4
whole at 3,265 characters, answer verified. The SELECT now fetches `segments`.

### One judgement, two thresholds — `isTablePage` vs `tabularPages`

| question | who asks | threshold | expensive error |
|---|---|---|---|
| which pages of this PDF must not be split? | `tabularPages`, whole document | minRows 2 | a MISS — splits a table from its header row |
| is this one page actually a table? | `isTablePage`, per page | **minRows 4 / minCells 5** | a FALSE POSITIVE — `muni_search_tables` reserves a seat for it |

The strict test exists because at the permissive threshold the Centreville ordinance TITLE PAGE
scores 3 rows — "16-48 / 18-18 / 18-19" are page references and the cell pattern cannot tell them
from measurements — as does a page of Planning Commission bylaws. Table 4-4 scores 9. Both were
flagged `is_table` twice during this work before the thresholds were separated.

⚠ **`segments` holds two kinds and only one is authoritative.** A `kind: table` written by
`tabularPages` came from scanning the whole PDF with the page in hand; a rescued page is judged by
`isTablePage`. A retro pass may ADD a flag on inference but must **remove only on evidence** — a
script written to enforce that rule broke it moments later, re-judging Elkhart 106 ingester-detected
table pages with the strict per-page test and demoting 78 of them. Restored.

End state: Centreville 4 flagged tables (4-1 to 4-4, nothing else), Elkhart 106, Bristol 0 (it has
no tables of its own — it reads the county ordinance). Both setback answers verified.

### ⛔ THE USAGE REPORT WAS COUNTING ITS OWN ROBOT (migration 049, 2026-08-26)

`muni-usage.mjs` exists to answer how STAFF use the tool. Re-verifying the chips after the corpus
work, it reported **160 questions in two days, Bristol at 23% declined** — on a day Bristol’s
retrieval had just been fixed and its answers demonstrably improved.

Almost all of that was `verify-sample-questions.mjs`, which asks a 17-question candidate pool
against every tenant and **is refused most of the time by design** — that is how it decides which
chips are safe to show. So the instrument built to stop a metric lying had started lying the same
way, and self-reinforcingly: every re-verification after an ingest makes the failure rate look
worse while the corpus is getting better.

`muni_questions.source` separates them — `web` by default, so a real question needs no cooperation
to be counted. The report shows real readers only; `--all-sources` includes the probes.

| | questions | Bristol declined |
|---|---|---|
| including verifier traffic | 160 | 19 (23%) |
| **real readers only** | **89** | **5 (19%)** |

⚠ **`source` is never read from the request body.** A public endpoint whose callers can label their
own traffic has an opt-out from its own metrics, and the first thing that would hide is exactly the
questions worth seeing. The verifier tags its rows afterwards with the service key.

⚠ The 71 historical rows were tagged by exact match against the candidate pool, asked on or after
2026-08-25. A resident could in principle type one word for word, so it is not certain — but the
pool is phrased the way the script phrases it, and leaving several hundred robot questions in a
report about staff usage is wrong in the direction that matters. Anything older, or not an exact
match, stays `web`.

### Chips re-verified after the corpus work (2026-08-26)

| Bristol (Town) | Centreville (Village) |
|---|---|
| How tall can a fence be in a front yard? | How tall can a fence be in a front yard? |
| How many dogs can I keep? | Are golf carts allowed on the streets? |
| When is trash collected…? | Do I need a permit to build a shed? |
| Do I need a permit to hold a garage sale? | How many dogs can I keep? |

Centreville needed 6 candidates to find 4, against 11 the day before: golf carts and shed permits
both moved from `partial` to `answered`. Consistent with the table restoration, though outcomes do
vary at the margin run to run, so treat it as a snapshot rather than proof.

### ✅ "What are the town hall hours?" — NOT A BUG. Bristol does not publish them (2026-08-26)

The last item in the failure list turned out to be the report accusing the tool of something it did
not do. Investigated end to end:

- The corpus carries **no** office hours for Bristol — no "Monday through Friday", no "office
  hours", nothing.
- The crawl is **not** the problem: `/town-hall-and-staff-contact-information`, `/contact-town-staff`
  and `/venue/bristol-town-hall` are all ingested.
- Fetched live and checked: **the Town of Bristol does not publish its counter hours anywhere on its
  own website.** The only hours-like text on the staff page is the Council work-session schedule.

And the answer was already the right one — hours are not published, here is the address, the meeting
schedule, the Clerk number `(574) 848-7007` with the date the page was read, and the online
bill-pay link.

⛔ **So the defect was in `muni-usage.mjs`, which printed "RETRIEVAL — 14 passages matched and none
answered it".** That asserts a diagnosis the data cannot support. `declined` means the corpus was
searched and nothing carried the answer; whether that is ranking or a fact the village never
published is exactly what the row does not know. Sending somebody to debug ranking for a fact that
does not exist wastes the trip — the same failure as calling a good referral a defect, one layer up.

Now reads `UNANSWERED — n passages matched, none carried the answer (retrieval, or the village never
published it)`, and the header is `COULD NOT ANSWER` rather than `SOMETHING IS BROKEN`. State the
fact; name both readings; let the reader decide.

⚠ This is a **client** finding, not an engineering one: if Keith wants the tool to answer it, the
hours have to come from the Town. Nothing in the code will produce them.

## The admin grew an Ask tab, an Ask Usage tab and a Water tab — 2026-08-26

Keith, looking at `/admin`: *"Where do the tenants for Ask Bristol and Ask Centerville and water
testing live - I figured they were in here"* — then *"I need an admin for Ask and Well testing -
need UI and want to track usage of Ask."*

⛔ **THEY WERE NOT IN THERE, AND THE PAGE DID NOT SAY SO.** `api/admin.js` knew exactly one tenant
registry — `tenants`, the GC white-label one — so the Overview tile read **ACTIVE TENANTS 2** while
counting `acme` and `ryc`, and the two **live** municipal products plus the water supply had no
admin surface at all. Every `muni_tenants` and `water_supplies` change since 2026-08-18 was made by
script. A dashboard that reports a confident number for the wrong population is the same defect
class as `answered` being true whenever the model produced prose: the number was never wrong about
what it measured, it was wrong about what a reader would take it to mean.

**The tile was first relabelled `GC Tenants`, and then deleted the same day** — Keith, on seeing
it: *"you can blow away the GC as tenant thing. That is dead."* So the population that caused the
confusion is not disambiguated, it is gone. See the backlog item for exactly what was removed and,
more importantly, what was not.

**Three tabs, and the reason each exists.**

| Tab | Serves | Writes through |
|---|---|---|
| **Ask** | `muni_tenants` — all 7 corpora incl. the unpublished `elkhart-county` pointer and the four `sd-*` research corpora, with a per-collection corpus breakdown (docs / passages / pages / scans) | `/api/admin` `write` |
| **Ask Usage** | `muni_questions` — outcomes, volume, what could not be answered, what gets cited, what is asked twice, and every question verbatim | read-only |
| **Water** | `water_supplies` + wells, feeds, operators, sites, filings, reminders | `/api/admin` `write` |

### ⛔ THE ADMIN PROXY IS A TABLE REGISTRY NOW, BECAUSE THE OLD ONE HAD THREE LATENT TRAPS

`api/admin.js` used a flat `ALLOWED_TABLES` / `READABLE_TABLES` pair and `?id=eq.${id}`. Adding two
products to it surfaced three separate ways that shape fails, none of which would have thrown:

1. **`?id=eq.` is wrong for `muni_tenants`, which is keyed on `slug`.** PostgREST answers a PATCH
   that matched nothing with **200 and `[]`** — so every tenant edit would have reported success and
   changed nothing. Each table now declares its key, and **a PATCH matching zero rows is a 404**
   naming the key it looked for.
2. **The read path forwarded the caller's own `select` verbatim.** `water_operators.pin` is a
   4-digit code that unlocks the crew tablet; `select=*` would have published every one of them to
   anyone holding the admin passphrase. Tables that declare `read` columns have their `select`
   **replaced, not validated** — a guard that reasons about what the caller asked for has to be
   right about every PostgREST projection syntax; overwriting it has to be right about one thing.
   The PIN can be **set** here and can never be read back; `water_state` answers `has_pin` from a
   `pin=not.is.null` query so the value never leaves the database.
3. **Any allowed table took any column.** Four columns are deliberately not writable and each for
   its own reason: **`anthropic_key_env`** names an environment variable (a value that indexes
   `process.env` must not come from a form); **`auth_client_id`/`auth_provider`** are the audience
   every ID token is verified against; **`sample_questions`** has exactly one supported writer,
   `verify-sample-questions.mjs`, because a chip typed into a box is the unverified suggestion
   migration 048 exists to prevent; **`doc_count`/`last_ingest_at`** are measurements, not settings.
   A rejected column **refuses with a 400 rather than being dropped** — a form told its edit landed
   when it did not is the same silent success as trap 1. The key column is settable on INSERT and
   never on UPDATE, because renaming a live slug orphans every `muni_docs` row pointing at it.

⛔ **`water_feeds` IS READ-ONLY ON THE PAGE AND IN THE REGISTRY.** `avail_fraction`, `ortho_factor`
and `nsf_max_dose` are the constants `civicscope-water/derive.js` multiplies to produce numbers
**filed with the State of Michigan under 1976 PA 399**. Changing 0.125 to 0.25 in a text box
silently rewrites every dose the plant reports, and the derivation gate replays 93 real well-days
against exactly those values. A genuine drum-strength change is a migration and a gate re-run.

### The usage arithmetic moved to `civicscope-admin/usage.js` — ONE copy

Three surfaces now report these numbers: `scripts/muni-usage.mjs`, the Ask Usage tab, and
`api/admin.js` which serves it. **Same shape as `civicscope-water/derive.js`** — the arithmetic
lives in one file and everything that renders it imports that file. `muni-usage.mjs` was rewritten
to call `summarize()` and produced byte-identical output on the same window (105 questions,
8 unanswered, centreville 73 / bristol 32). Ship it **with** `api/admin.js`; it is in the deploy
manifest for that reason. Change a bucket **there**.

Every bucket survives intact, including the two that exist because folding them into a neighbour
hid something: `referred` is counted and never called a failure, and a **pre-045 row with no
outcome is shown as unknown, never as answered**. Verifier traffic is excluded by default with a
toggle, exactly as the CLI does.

### ✅ "AUGUST IS STILL ON PAPER" IS A NUMBER ON A SCREEN NOW

The Water tab's first section answers the only operational question that matters — *is the plant
being logged in the product, or still on paper?* — as (well × day) slots logged against slots
possible so far this month, **split by `source`**. Measured the moment it first ran:

| Month | Logged | Source |
|---|---|---|
| 2026-08 | **1 of 78** | `tablet` 1 |
| 2026-07 | 93 of 93 | `backfill` 93 |
| 2026-06 | 85 of 90 | `backfill` 85 |

**The source split is the whole point.** A month that is 100% `backfill` is a month the tablet did
not run — paper transcribed after the fact — and a coverage bar alone would have shown July as a
perfect green month. This is the standing open item below, stated by the product instead of by a
note in this file.

### Verification

`api/admin.js` had a `noSafeContract` entry — *"admin-secret gated; GET is a 405 guard only"* — so
an admin deploy could never reach exit 0. Same question as `api/pool-sms.js` on 2026-08-13: is
there a read that proves the handler works? **`{action:'muni_corpus', tenant:'centreville'}`** —
it resolves the credential, reads `muni_docs` with the service key and runs the rollup; it writes
nothing and costs nothing. Deliberately **not** `auth_check`, which returns `{ok:true}` without
touching Supabase and proves only that the guard is intact.

⚠ **`CIVICSCOPE_ADMIN_SECRET` is SENSITIVE-typed in Vercel and `vercel env pull` returns it EMPTY**
(verified 2026-08-26 — zero-length, not missing). Until it is set on the gate machine this contract
reports **CANNOT RUN → inconclusive**, which is the honest answer and still strictly better than
"permanently unverifiable". It is the one entry in `infra/env-var-inventory.md` that cannot be
recovered from the platform.

### 🚩 THE DEPLOY HARNESS IS FLAKY, AND A FLAKY CERTIFICATION IS WORSE THAN A RED ONE

Running it twice on the **byte-identical working tree**, with no code change between:

| Run | Result |
|---|---|
| 1 | `HARNESS-INCOMPLETE: 5 failed check(s)` — 182/187 |
| 2 | `HARNESS-COMPLETE: 187/187 checks, 45/45 scenarios, exit 0` |

Both failures were in resume scenarios — `partial-then-resume-no-duplicate` and
`foreign-journal-ignored` — and both took the same shape: **exit 10 REFUSED where 0 was expected**.
Both pass every time under `--only`. So it is order- or timing-dependent state shared across
scenarios (each of those two runs a deploy, then a second deploy against the same mock and journal),
not a verdict on the tree.

⛔ **This matters more than a normal flake.** `HARNESS-COMPLETE` is defined in this file as *the*
certification, and the remedy for an INCOMPLETE run is now "run it again" — which is exactly how a
genuine regression gets waved through. **Do not treat a second green as clearing a first red until
the flake is fixed;** compare the failing check names against these two scenarios first, and if a
failure is anywhere else, believe it.

⚠ **AND `--only` CANNOT ATTRIBUTE A FULL-SUITE FAILURE.** Bisecting these two scenarios with
`--only` — HEAD version vs working-tree version — returned PASS on *both* arms, which reads like a
clean result and measures nothing, because `--only` passes regardless of the change. The runner
already prints *"HARNESS-TARGET-COMPLETE … does NOT certify the suite"*; that warning is about
coverage, and it applies just as hard to **attribution**. A full-suite failure can only be
attributed by a full-suite run.

25 assertions were driven against the real handler and the live database before shipping —
including that `select=*` and `select=pin` on `water_operators` both come back without a PIN, that
`muni_questions` and `water_readings` are **not** directly readable (usage goes through the
aggregating action), and that a PATCH on a nonexistent slug is a 404.

## ✅ R-1 SETBACKS ANSWER, AND THE TWO THINGS THAT WERE ACTUALLY WRONG (2026-08-26)

Bristol now answers *"what is the front setback in the R-1 district?"* — **50 ft from the road
centerline on a named road, 75 ft on a numbered county road**, side 10 ft, rear 15 ft — and it
answers the same for every phrasing tried, and for R-2 lot size, and for any district a reader
names. This closes the 🚩 that had stood since 2026-08-25.

⚠ **BOTH OF MY FIRST TWO DIAGNOSES WERE WRONG, and each was wrong in an instructive way:**
- I measured rank with the town name still in the query. `api/muni-ask.js` strips it before
  retrieval, so I had reproduced the **pre-fix** condition and "the R-1 table ranks #8" was an
  artefact of my own probe. **Measure through the path the product actually takes.**
- I then dumped the chunk with a line filter requiring a word like *setback* or *yard*, and the
  data rows read `Single-Family (w/o Sewer) A 50' 10' 15' 15,000 sq. ft.` — no such word anywhere.
  I briefly concluded the rows were missing when they were sitting in front of me. **A grid's data
  rows do not contain the grid's column headings.**

### Defect 1 — the context ceiling was binding on EVERY R-1 question, and starving the corpus that held the answer

Three live runs, before the fix:

| Question | used | dropped | county dropped | chars | outcome |
|---|---|---|---|---|---|
| "In Bristol, what is the front setback in the R-1 district?" | 12 | 8 | **2** | 29,521 | answered |
| "What is the minimum front yard setback for a house in R-1?" | 16 | 6 | **4** | 29,755 | **declined** |
| "setback requirements R-1" | 9 | 11 | **3** | 29,818 | partial |

Every run within 500 characters of the 30,000 ceiling; every run discarding county passages,
including the two ranked **#1 and #2**. The declined one told the reader *"the passages don't
contain the R-1 setback numbers"* while exactly those passages sat in the dropped list. That is
also why the same question came back answered, partial and declined on consecutive attempts — the
ordering was right and whether the winning chunk survived truncation was a coin flip.

**The ordering was never the problem. The ALLOCATION was.** Bristol delegates all zoning to Elkhart
County under IC 36-1-5-4, so for a zoning question the shared corpus *is* the law — yet it competed
for budget on equal terms with Bristol's own Code of Ordinances, which contains no zoning at all.

`SHARED_RESERVE = 12000` of the 30,000 is now held for a `shares_corpus_with` tenant, spent in
**two passes**: pass 1 caps the tenant's own passages at `CONTEXT_CHARS - SHARED_RESERVE` while the
shared corpus spends against the full ceiling; pass 2 reconsiders everything pass 1 could not fit
against the full ceiling. ⚠ That second pass is what makes it a **floor, not a quota** — an unused
reserve is handed straight back, and a tenant with no shared corpus is bit-for-bit unaffected.
Measured after: **0 county passages dropped, on every question.**

### Defect 2 — ⛔ THE DISTRICT A QUESTION NAMES CARRIED NO WEIGHT, AND M-1 MANUFACTURING OUTRANKED R-1

With the budget fixed, R-1 still answered inconsistently. `muni_search_tables` against the county
for *"what is the front setback in the R-1 district?"* returned, in order: 158.03, 158.04(E),
**M-1 Limited Manufacturing**, 158.04, **M-2 Heavy Manufacturing**. The R-1 table was not in the
top three the guarantee takes.

**A zoning code is a set of near-identical documents that differ mainly in which district they
describe.** Every district table is an almost equally good lexical match for a setback question,
and the one token that disambiguates them — the district code — is two characters with no
term-frequency advantage at all.

⛔ **Not a weight.** Migrations 018–021 and 038 spent four attempts learning that a coefficient
cannot fix a structural mismatch, and no constant makes `R-1` outweigh a manufacturing chapter that
repeats "setback" thirty times. The district is now looked up **directly, by heading, with no
ranking involved**, in both the tenant's corpus and its shared one, and **prepended** — the Cause-4
lesson that a guaranteed seat at the back of a full room is not a seat. It fires only when the
reader names a district, and silently does nothing on a corpus whose headings are not
district-named (Centreville's are `Table 4-4`), which is correct — that corpus has its own working
guarantee. ⚠ It also fails safe on a false positive: `M-86` is a road, the heading lookup finds
nothing, and the guarantee simply does not fire.

## "Game future questions in advance" — `scripts/question-bank.mjs` (NEW 2026-08-26)

Keith: ***"we need to figure out how to game future questions in advance!"***

48 questions a municipal counter and phone actually get, across zoning / nuisance / streets /
utilities / permits / governance, weighted by **how ordinary the question is** — ★★★ = asked
constantly. Every refusal is a finding, ranked so the most embarrassing gaps float to the top.

⛔ **This is the OPPOSITE instrument to `verify-sample-questions.mjs` and must never be merged with
it.** That one picks the four "Try:" chips and is a *publishing* gate — a candidate survives only
if it comes back `answered`, and its refusals are expected and meaningless. This one is a *coverage*
report where the refusals are the entire output. A bank tuned until it passes measures nothing,
which is why the bank is version-controlled: its history is the record that it was not tuned.

⚠ **Deliberately NOT a deploy gate.** Every run is real Anthropic spend and ~10–25s per question,
and borderline questions drift between `answered` and `partial` run to run. Wiring that into
`push_civicscope.ps1` buys a slow, flaky, expensive gate that fails deploys for reasons unrelated
to the deploy. Run it when the **corpus** changes, not when code ships. Its traffic is tagged
`source='verifier'` so it can never be counted as a village failing its residents (migration 049's
lesson, one instrument later).

```
node scripts/question-bank.mjs --tenant bristol --dry        # list it, spend nothing
node scripts/question-bank.mjs --tenant bristol --only zoning
node scripts/question-bank.mjs --tenant centreville
```

### 🚩 FIRST RUN, BRISTOL ZONING: 10 of 15 answered, and the five gaps share ONE cause

`declined`: *permit to build a shed* ★★★ · *how close to the property line can I build a garage*
★★★ · *how tall can a house be* ★★ · *can I park an RV or boat in my driveway* ★★ · *maximum lot
coverage* ★★.

⛔ **Building height and lot coverage are BOTH columns in the R-1 table the fix just made
retrievable** — `Building Height 30'`, `Lot Coverage 25%/30%`. They still fail because
**the district guarantee only fires when the reader NAMES a district, and almost nobody does.**
"How tall can a house be?" is how the question is really asked. The next fix is to infer the
district from the question's subject — a house is residential — or to guarantee the residential
district tables on any dimensional question. **This is exactly what the bank was built to find,
and it found it on the first run.**

## WHO asked — attribution on Ask, and the clock that was lying (2026-08-26)

Keith, reading the new Ask Usage tab: *"I think I was the question at 9:47 but have been Mike the
town manager who I sent the link to after that - anyway to tell?"* — then, on being told there was
not: ***"We should be able to learn from this."***

### ⛔ THE TIMESTAMPS HE WAS READING WERE UTC, PRINTED AS IF LOCAL

Before anything else: the reconstruction he was attempting could not have worked, because the
column he was reading was four hours out. `String(created_at).slice(0, 16)` on
`2026-08-26T11:31:46+00:00` renders **11:31**; the row was written at **07:31 Eastern**. The 09:47
row he thought was his was **05:47 ET**.

**This is the same defect as the daily digest headlining yesterday's numbers with today's date** —
an absolute instant rendered against the wrong calendar — and it was shipped that morning in the
very table whose job is *"who did what, when"*. Fixed: every timestamp on the page now renders in
the viewer's own clock via `toLocaleString`, the column says **When (your time)**, and
`dailyCounts()` buckets the volume series by **Eastern** calendar days rather than UTC ones —
without which every question asked after 8pm local was drawn on the following day.
⚠ `api/admin.js` passes `MUNI_TZ = 'America/New_York'`; every municipality this product serves is
Eastern, Michigan villages and Indiana towns alike.

### Migration 059 — three signals, and one that is deliberately absent

| Column | What it is |
|---|---|
| `visitor` | An opaque random id minted in the browser and kept in `localStorage`. Distinguishes **browsers, not people** |
| `via` | A tag carried on a link you handed out — `/bristol/ask?via=mike` — then remembered for that browser |
| `signed_in` | The verified email from the session cookie, where the tenant has sign-in at all |

⛔ **NO IP ADDRESS, and that is a decision, not an omission.** These are residents asking their own
government about setbacks, dog licences and meeting times. An IP is identifying, it answers no
question Keith actually has, and a table of *"who in this village asked what about their local
law"* is not a thing this product should hold. `visitor` answers the real question — one person or
three — and resolves to nobody, by us or by anyone who obtains the table.

**`via` is the one that actually answers Keith's question, and it works by CONSENT.** You learn who
somebody is because you labelled the link you gave them, not because the tool inferred it from
their traffic. Hand the town manager `?via=mike` and every session from that browser is
self-identifying; hand out an untagged link and you learn nothing about him — which is the correct
default for a public page.

`signed_in` costs no extra read: `api/auth-google.js` already signs `{sub, email, uid}` into the
session cookie. It stays null forever on Bristol, which is `auth_provider='none'` and always will
be for a public ask page.

### ⚠ NULL MEANS "WE DO NOT KNOW", AND ALL 105 EXISTING ROWS ARE NULL

Nothing is back-filled and nothing is inferred. The report counts unattributed rows in **their own
bucket**, never merged into a single anonymous "visitor" — folding everyone we could not identify
into one entry would invent one very busy person, which is the same shape of lie migrations 045,
046 and 050 were each spent removing from this exact table. The verify file asserts the columns
start **empty**, for that reason.

⛔ **So the answer to the original question is: for those rows, no, and there never will be.** They
predate 059. Attribution starts now.

### Verified end to end on production

Drove the real `/bristol/ask?via=e2eprobe` page in Chrome, asked a real question, read the row back
through `/api/admin`: `visitor=vd526d6c82385488e`, `via=e2eprobe`, `signed_in=null`, grouped into
the WHO ASKED panel as one visitor. The probe row was then set `source='verifier'` so it does not
count as a real reader.

⚠ **The first run of that test reported four failures and the feature was fine.** The wait condition
was `/source|Sec\.|could not find|ordinance/` against `document.body.innerText` — and Bristol's own
blurb contains the words *"with a link to the source every time"*, so it matched instantly, the
browser closed before the answer returned, and the read raced the insert. **A page-text wait
condition must match text the page cannot already be showing.**

## Codex review of Ask + Water — 2026-08-26

Report: `codex-reviews/reports/REVIEW_civicscope-muni-ask-and-water_2026-08-26.md`. Verdict
**FIX-FIRST**, 15 findings. Six fixed the same day; nine remain, four of which need a decision
from Keith rather than code.

### ⛔ 1 (Critical) — THE MOR NEVER WROTE BACTERIOLOGICAL SAMPLES, AND CARRIED JULY’S INTO EVERY MONTH

`bacti` appeared exactly ONCE in `api/build-mor.py`: in the stats return. `build()` wrote pumpage,
entry points and distribution, then saved. So the workbook reported "2 bacti" while containing
none, and `review.html` printed that count beside the download.

⛔ **And it is worse than an empty tab.** The stored template is not a blank state form — it is
Centreville’s FILLED July 2026 MOR (supply name, WSSN, OIC, certification, and July’s data).
`put()` returns early on `None`, and nothing cleared anything, so rows 12–13 of the Bacti tab held
the real 2026-07-29 samples for 125 W. Main St and M-86 E. Lift Station. **Generating August would
have filed July’s samples labelled August** — a false regulatory filing, not an incomplete one.
The same applied to any month with fewer distribution rows than its predecessor.

Fixed:
- Bacti written — **routine into K12:K31, repeats into K36:K44**. Not a guess: EGLE’s own formulas
  are `COUNTA(K12:K31)`, `COUNTA(K36:K44)` and `AVERAGE/MIN/MAX(L12:L31,L36:L44)`, so writing
  inside those ranges makes the state’s summary cells compute themselves and writing outside them
  drops a sample out of every total on the sheet.
- ⚠ **Routine and repeat must never be merged** — the form counts them separately, and a repeat in
  the routine block overstates routine compliance, which is the number EGLE checks against the
  monitoring schedule.
- `clear_block()` blanks each month’s data region first, skipping formula cells.
- Over-capacity **refuses** rather than dropping a sample silently.
- Stats report what reached the workbook, not what was fetched — that mismatch is what hid this.

Verified by building real workbooks and reading the cells back: July writes both samples with
dates/results/residuals and keeps its 23 distribution rows; **August now produces an empty bacti
tab** where it previously would have carried July’s.

### The other five fixed the same day

| # | Finding | Fix |
|---|---|---|
| 12 | An active user with **no** `muni_tenant` passed EVERY village gate — `u.muni_tenant &&` short-circuited. Water enrols by `water_wssn`, so a tenant-less operator row is ordinary to create and would have opened every gated hub | `u.muni_tenant !== cfg.tenant` in both gates. An entitlement is granted, never inferred from an absent field. All four current users carry `centreville`, so nobody was locked out |
| 8 | The website guarantee repeated the **"is any table present"** defect the table guarantee documents as already fixed — one stray web hit in the top 12 suppressed the collection search entirely | Always consult the collection, merge by chunk id. Presence of a source TYPE is not evidence the best passage of that type survived ranking |
| 13 | A missing/malformed marker was still logged `answered` — the same optimistic default 045 existed to abolish, one layer down | `unknown` (migration **050**), counted as neither success nor village failure: a missing marker is OUR instrumentation failing, not evidence about the documents |
| 11 | A rescued page became a segment only if it had a caption — excluding exactly the uncaptioned Elkhart tables the shape detector was added for | Every rescued page is a segment; `kind` decides table vs rescue; `sectionHeadingOf` supplies the weight-A heading |
| 14 | The reminder read, sent, then recorded — two schedulers (Vercel cron **and** the VM) could both send before either wrote | The INSERT is the lock: the unique partial index on `outcome='sent'` means one runner claims the period, a 409 means skip, and a failed send releases the claim by moving to `failed` |

Also fixed: `replace(/s/g, '')` in the URL ingester stripped the **letter s**, not whitespace, twelve
lines below an identical check that does it correctly. Lenient direction, so nothing ever looked broken.

### ⚠ Still open — four need Keith, not code

- **2 (High)** A historical insert or correction never re-derives the following day, so day 3 keeps
  a stale interval and the month total is wrong in the filing. **Decision: re-derive the successor
  transactionally, or refuse and route through an office correction flow?**
- **3 (High)** Office auth is selected solely by the presence of `correction_reason`, and the
  submit handlers require a reason only when a row already exists for that date. **An
  unauthenticated caller can therefore add a previously-absent day or bacti sample to an ALREADY
  FILED month.** Fix is clear in shape — any write into a filed month is an office write — but it
  changes what the crew tablet can do, so it is Keith’s call.
- **4 (High)** The filed-vs-held check compares distribution and bacti **by array length only**, and
  skips a chemical field when either side is null. `matches` can be true with materially different
  residuals.
- **5 (High)** A partial month generates a filing-ready workbook. Confirmed live: **August has 1
  well-day, 1 distribution sample, 0 bacti and still produces a normal-looking EGLE workbook.**
  Empty months refuse; partial months do not. **Decision: what must a month contain before the tool
  will generate?**

Remaining medium/low: **6** (truncation still discards passages that would fit, and logs nothing),
**7** (shared-corpus RPC failure is swallowed; 1:1 round-robin is an unmeasured quota), **9** (the
three-word stripping floor recreates the Bristol failure for short questions and mangles
comparative ones), **10** (batched OCR can assign a whole batch to page 1 when the model omits page
sentinels), **15** (`isDowngrade` ranks `mixed` and `ocr` equal, so a full re-OCR can replace a
verbatim text layer).

⚠ **Codex could not compare against production `b204d92`** — that SHA is not an object in the local
Cowork repo. Its findings are verified against the working tree, not against GitHub.

## Michelle owns the month — the Water workflow, and what it settled (2026-08-26)

Keith described how the EGLE report actually gets made, and it resolved four open High-severity
findings at once:

> *"Michelle will have oversight — if a reading is missing, she will add it before running the
> report. She also personally handles the bacteria report, which gets sent to lab, then she gets the
> lab results back via email 24 hours later. She can manually enter it that time. She also sometimes
> changes numbers slightly in the actual EGLE report. So we will want her to have the ability to edit
> a line or entry from what the field guys submit."*

⛔ **Read that as a specification, because it changes which defects matter.** Inserting into the
middle of a filed-or-forming month is not an edge case here — it is the ordinary path.

### She can now edit a line (`civicscope-water/review.html`)

Every recorded day, distribution sample and bacti sample carries an **Edit** control; every day the
crew did not record carries **Add**. All of it appears only when she is signed in, because every
save is an office write.

⛔ **It edits the RAW INPUTS, never the derived numbers.** Gallons, solution used and dose come from
`derive()` — one arithmetic in one file, imported by page and server alike. A "gallons" box would
create a second definition of a number that goes to the State of Michigan, and the two would
disagree the first time either changed. She edits what was OBSERVED; the arithmetic follows.

A reason is required only when replacing something already on the record. Filling a gap is not an
amendment, and demanding a justification for it is friction with no reader.

### ⛔ 2 (High) — the day AFTER an edit was silently left wrong

Every derived number hangs off the previous live reading. Editing or inserting a historical day
invalidated the day that follows, which kept the interval it computed against a row that is no
longer there. Day 1 = 100, day 2 = 150, day 3 = 200 stores 50 and 50; correct day 2 to 120 and day 2
becomes 20 while **day 3 still says 50 instead of 80** — the month totals 70 against a true 100, and
`build-mor.py` copies that straight into the filing.

`rederiveSuccessor()` now recomputes the following day through the same `derive()`, in place, keeping
its row id — a recomputation of stored arithmetic, so it supersedes nothing and needs no reason. It
walks exactly ONE day forward on purpose: that day's own successor depends on it only through the
meter and tank levels, which this does not touch. A successor that will not re-derive is **reported
to her**, never left stale.

### ⛔ 3 (High) — a filed month was open to anonymous writes

The office boundary was decided entirely by the presence of `correction_reason`, and a reason was
only demanded when a row for that date already existed. So a date with **no** row was an open crew
write even inside a month already submitted to EGLE — an unauthenticated POST could add Well 3 on
July 14 to a July filed weeks ago.

Any operator write whose date falls in a filed month is now an office write. This narrows the crew's
job by nothing — the round they enter is today's, in a month nobody has filed — and Michelle, who
does the desk work, is signed in. Verified live: an anonymous write into filed July returns **403**
with the reason; the same write into open August still reaches the crew path.

### ⛔ 4 (High) — the filed-vs-held check compared samples by COUNT

Distribution and bacti agreement was `filed.length === ours.length`. No date, no site, no residual.
Since Michelle *"sometimes changes numbers slightly in the actual EGLE report"*, this comparison **is
the record of where she deviated** — and a same-count/changed-value edit is exactly the shape of her
edits. Counting rows was blind to her entire workflow.

⚠ The two sides do not share field names, and assuming they did produced a first version that
reported **every sample of every filed month** as a mismatch — 26 phantom differences on January
alone. Caught before shipping by running it against all seven filed months. A filed row is
`{date, free, total, ortho}` for distribution and `{date, location, free, total, result}` for bacti;
ours are `sample_date` / `collected_date` / `site_name`. Identity is extracted per side, matched by
regulatory identity rather than position, because one inserted sample would otherwise shift every
later row into a false difference.

The corrected version finds **one real deviation across seven filed months, with no false
positives**: *July 17 — the report says 0.39 free, the records say 0.37.*

### Bacti can finally be corrected (migration 051)

`water_bacti_samples` was the one table with no supersede trio, so `submit_bacti` had no correction
path — a second submission for the same site and date returned 409 and stopped. That is exactly
backwards: **the results arrive by email a day after the sample is taken**, so a sample is routinely
recorded before its result exists and the row has to be completed afterwards. The one table that
could not be amended was the one whose values arrive late.

### 5 (High) — partial months: answered by her role, not by a gate

A month with one well-day still generates a filing-ready workbook. Keith's answer settles it:
**Michelle is the completeness check** and adds what is missing before running the report. A hard
block would fight the workflow — a partial month is a legitimate state while she is still working.
The review page already counts missing well-days and warns on absent bacti. **Recorded as a
deliberate decision rather than an unfixed finding**, so nobody re-opens it as a bug.

## Codex review CLOSED — the last five (2026-08-26)

All 15 findings are now fixed. The five medium/low ones:

### 6 — truncation abandoned passages that would have fitted

The context loop used `break`, so the FIRST oversized passage ended it and every later passage was
discarded whether or not it fitted. A printed table is one indivisible chunk of 3,000–7,000
characters, so the oversized passage is routinely a table — and the thing thrown away behind it is
routinely the small county passage that answers the question. Now `continue`.

⛔ **And it says so.** Three production defects have been caused by this budget silently discarding
passages, and every one was invisible because a truncated context and a complete one produce the
same shaped answer, the same `hit_count` and the same outcome. `muni_questions.retrieval`
(migration **052**) records `{ retrieved, used, dropped, chars, dropped_by_source }`.

⚠ **`dropped_by_source` had to be tagged at the merge, not derived from the row.** `muni_search`
returns no tenant column, so the first version could not tell the county from the town — and they
both file under `Code of Ordinances`, which is exactly the pair the field exists to separate. Live
now: `{"Code of Ordinances":6,"shared:elkhart-county":2}`.

### 7 — a shared-corpus failure was swallowed

For a tenant that DELEGATED its zoning the shared corpus is not an enhancement, it is the law.
Bristol's own 719 documents contain no setback, no use table and no variance procedure. A failed
county RPC was caught and ignored, so the answer came from the town's website and reported a
confident `declined` — indistinguishable from a corpus that genuinely lacks the answer. The failure
is now recorded as `shared_corpus_unavailable` in the retrieval record.

### 9 — one query became two, because the name is noise in one corpus and poison in the other

In the tenant's OWN corpus the municipality name is uninformative but can still be load-bearing — a
question CONTRASTING two municipalities means something different without it. In the SHARED corpus
it is destructive: the county ordinance never says "Bristol", so the word breaks the strict
all-terms pass.

The old three-word floor failed in both directions at once: `Bristol R-1 setbacks` leaves two words,
so the floor kept the original and re-created the failure stripping exists to prevent; and
`Does Centreville or Constantine regulate this parcel?` had Centreville removed although the
comparison is the whole question. Now the shared query always drops the name; the own query drops it
only when it is doing no work — a leading address phrase, or anywhere in a non-comparative question.

⚠ Stripping the name alone left the preposition stranded (`"In Bristol, what…"` → `"In , what…"`),
which is worse than leaving it: the tsquery gains a meaningless term and loses nothing. The leading
phrase is consumed first. Four cases unit-tested, including both of Codex's.

### 10 — a batch of OCR could be filed entirely under page 1

The batch reply was split on `Page N` or form feeds, **neither of which the prompt ever asked for**.
A continuous transcription produced ONE part, so the whole batch was assigned to the first page and
the rest were skipped — the call succeeded, the spend was real, and eight pages of law were filed
under one page's heading, section and citation.

The prompt now requires `<<<PAGE n>>>` before every page. A reply without exactly one marker per
requested page is not guessed at: the pages are retried ONE AT A TIME, where a single-page reply
cannot be misattributed by construction. Costs more only in the case that was previously silently
wrong.

### 15 — `mixed` now outranks `ocr`

They were equal because both mean "the unreadable pages were recovered". But `mixed` keeps the
document's own text layer and transcribes only what a machine could not read, while `ocr` is the
whole document rewritten by a vision model. Ranked equal, a later extraction that fell below the
text-layer threshold could silently replace every verbatim page with transcription and
`isDowngrade` would allow it. Now `needs-ocr` < `text-layer` < `ocr` < `mixed`.

⚠ Both setback answers re-verified after all five: Bristol gives 50/75/120 ft by road class,
Centreville gives 30/10/40 from Table 4-4.

## Open Action Items

- 🚩 **Bristol zoning answers 10 of 15 ordinary questions (`question-bank.mjs`, first run
  2026-08-26).** The five gaps — shed permit, garage setback, house height, RV parking, lot
  coverage — share one cause: **the district guarantee only fires when the reader names a
  district**, and real questions ("how tall can a house be?") don't. Height and lot coverage are
  columns in a table the corpus now retrieves correctly. Next fix: infer the district from the
  question's subject, or guarantee the residential tables on any dimensional question.
- **Run `node scripts/question-bank.mjs --tenant <t>` after any corpus change** — not on deploy
  (real Anthropic spend, and outcomes drift at the margin).
- **Tag the links you hand out.** `?via=<name>` on an Ask link is the only thing that puts a name
  in the WHO ASKED panel — e.g. `civicscope.io/bristol/ask?via=mike`. Untagged visitors show as
  `browser abc123`, which still tells you how many distinct people there were.
- **Michelle has not used the new edit path yet.** The review page now offers Edit on every line and
  Add on every gap; the server paths are verified but no human has exercised the UI.
- **`/admin` now covers Ask and Well Testing** (2026-08-26) — three tabs, `muni_tenants` and
  `water_supplies` editable, Ask usage over `muni_questions`. Two things it deliberately does NOT
  do, because both are decisions rather than omissions: **`sample_questions` is read-only**
  (`verify-sample-questions.mjs` is the only supported writer) and **`water_feeds` is read-only**
  (its constants are multiplied into numbers filed with the State). Nothing has a delete —
  retirement is `active=false`, because operator initials sit on readings behind filed reports.
- **`CIVICSCOPE_ADMIN_SECRET` cannot be recovered from Vercel** — it is SENSITIVE-typed and
  `vercel env pull` returns it zero-length. Until it is set as a Windows User var, the new
  `api/admin.js` contract reports CANNOT RUN and any admin deploy lands at exit 50 rather than 0.
  ⚠ Setting it via `SetEnvironmentVariable(name, '', 'User')` with an **empty** value DELETES the
  variable rather than setting it, and reports no error — so a mistyped `Read-Host` looks exactly
  like a successful set. Verify by reading the length back, never by the absence of an error.
- ✅ **The two GC product cards had been throwing on every `/admin` load since they were built** —
  found 2026-08-26 by driving the live page in Chrome. `loadProductData()` sets `dur-<key>` and
  `time-<key>` for every product, but those two cards carry "Tenant" and "Access" meta fields
  instead of "Avg Duration", so `getElementById('dur-gc-ext')` was null and the loop threw. The
  `catch` logged and moved on, which is why nobody noticed — the exception aborted before the
  `last-*` assignment, so **both cards' "Last Run" read "Loading…" forever**. Resolved the same day
  by deleting the cards outright (GC white-label is dead). ⚠ Worth keeping as a pattern: a
  `catch` that logs and continues turns a null-deref into a field that never fills, and nothing
  about the page looks broken. Still open on that page: `/favicon.ico` 404s. Cosmetic.
- 🚩 **THE ESTIMATING SMOKE GATE IS ALSO INTERMITTENTLY RED — and that is now TWO gates whose
  remedy is "run it again" (2026-08-26).** The GC-removal deploy failed at exit 40 with
  `Municipal — JSON UNPARSEABLE — likely truncation`, on a deploy touching only
  `civicscope-admin/index.html` and `api/admin.js` — neither of which is in `/api/claude`'s code
  path. Municipal had passed 35 minutes earlier and passed standalone immediately after; the
  `-Resume` then went 3/3. So: real model-output variance, the same failure mode `max_tokens` was
  raised for on 6/16 and the JSON parse was hardened for. **Do not diagnose a gate failure by
  re-running it.** Ask first whether the changed files can even reach the failing path — that is a
  structural answer, available in seconds, and it is the difference between a transient and a
  regression. ⚠ Two flaky gates is the point at which "re-run and it went green" stops being
  evidence of anything.
- 🚩 **`scripts/test-deploy-harness.js` IS FLAKY — two resume scenarios failed one run and passed
  the next on a byte-identical tree** (2026-08-26, detail in the admin section above). The remedy
  for an INCOMPLETE run is currently "run it again", which is indistinguishable from waving through
  a real regression. Fix the shared state in `partial-then-resume-no-duplicate` and
  `foreign-journal-ignored`, or the certification line cannot mean what this file says it means.
- **Re-run `node scripts/verify-sample-questions.mjs --all` after any corpus ingest.** The chips
  are verified against the live corpus (048); an ingest can retire one as easily as earn it.
  Done 2026-08-26 after the zoning-book restore. Its own traffic is tagged `verifier` (049) so it
  no longer pollutes the usage report.
- **Bristol town-hall hours: ask the Town.** Not a bug — verified 2026-08-26 that Bristol
  publishes no counter hours on its own site, and the tool already answers with the address, the
  meeting schedule and the Clerk number. Only Keith can close this, by getting the hours from the
  Town and adding them to the corpus.
- **Centreville has no `logo_url`** — the hub and the Ask page both show no mark for it. Bristol
  hotlinks the Town own PNG. Needs a logo file from the Village if Keith wants parity.
- ⚠ **6 segments across the corpora match no chunk exactly** (`reconcile-table-flags.mjs` reports
  them). Left alone rather than guessed at. Worth a look if a table ever goes missing.
- **Centreville is now a CLIENT PROJECT with its own folder — `Cowork\Centreville\CLAUDE.md`
  (2026-08-18).** Two live products for one village (`/centreville` + `/water`). Read that file
  alongside this one for anything Centreville-specific: the plant profile, corpus state, and what
  is owed to EGLE. ⛔ **The code stays multi-tenant here — Keith declined a separate Vercel
  project, Supabase project and Anthropic workspace the same day.** Village #2 is a config row.
- ⛔ **THE AMENDMENT PATH WAS BROKEN IN THREE PLACES AND NOTHING HAD EVER EXERCISED IT.** Seeding
  six months of paper was the first thing that ever tried to CORRECT stored data, and found: a
  correction could never be saved (the replacement row was inserted before the old one was
  superseded, colliding with the partial unique index — `submit_reading` and `submit_dist` both,
  fixed `25049ea`), and `submit_bacti` had no already-recorded guard at all, so re-running a
  backfill multiplied the compliance record five-fold (fixed `73babb1`). **The ordinary path
  worked in every case; only amendment was broken — which is exactly what no smoke test walks.**
- 🚨 **August 2026 is still being written on paper — MEASURED 2026-08-26: 1 of 78 well-days logged,
  and the one that exists came from the tablet.** July was 93 of 93 and every single row was
  `backfill`, i.e. paper transcribed afterwards. The tablet is live and nobody is using it; every
  day that runs is another day that has to be backfilled. This now reports itself at the top of
  `/admin` → **Water**, split by source, so it stops being a note in this file.
- **"Mark as filed" is the last step of the loop, and it is HALF BUILT.** `record_filing` is open
  and working (it took all seven 2026 workbooks), but nothing on the page reaches it, so recording
  a filing still needs a script. Remaining: an `extract` action on `api/build-mor.py` returning
  `{cover, filed}` from an uploaded workbook — the EGLE cell map must move there rather than being
  copied, since `api/water-ops.js` is Node and cannot read a .xls — then an upload + date control
  in the Reports filed panel. `record_filing` already accepts `source:'product'`, and nothing writes
  it yet, so the first report filed from here stays distinguishable from the seven that came before.
- 🚨 **THE WEBSITE CRAWL IS NOT SCHEDULED, AND IT IS THE ONE COLLECTION THAT GOES STALE.** Everything
  else in the corpus is a document that stays true; a meeting cancellation or an event date is wrong
  the moment the village edits the page. The gate fails the deploy once the newest page is over 45
  days old, so this cannot rot silently — but a gate is not a schedule. Re-crawl is one free command
  (`node scripts/ingest-muni-website.mjs --tenant centreville`) and belongs on the VM cron alongside
  the other pipelines, **not** in a lambda: the shared chunker lives in `scripts/lib/` and is not
  deployed, and putting a second copy in a deployable lib is the exact drift migrations 018–021 were
  spent on. Weekly is ample for a 12-page site.
- **The crew tablet shows validation errors before anything is typed.** Opening a well greets the
  operator with *"Meter reading is required. Sodium hypochlorite 12.5% tank level is required.
  Aquadine tank level is required."* — three red-flavoured lines for someone who has done nothing
  wrong, in a one-handed app used in a concrete room. Suppress until first input or first submit.
- **`Civicscope/scripts/` is gitignored except narrow re-includes**, so the water gate, the
  backfill, the MOR generator and their fixtures are not under version control. Same one-line
  decision as `migrations/` — they are secret-free by inspection.

Forward-looking action queue. Source of truth for the CRM dashboard's "Across All Businesses → CivicScope" card. Curated at `/wrap`. Done items are removed, not strikethroughed — historical context lives in the `## Active Backlog` sections below.


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
- ✅ **SCOPE SETTLED 2026-08-26 — ONLY GC DIED. NOTHING ELSE IS BEING SUNSET.** Keith, on the
  teardown: *"I want CivicScope Free to live on. Everything else can be sunset."* Read in front of
  the QA harness that lists Municipal / Schools / Infrastructure, that reads like an instruction to
  keep one vertical and retire two. It was not. Asked before touching anything, and the answer was:
  *"Stop. The product should remain for municipality, school, and infrastructure Estimator - free..
  Also we are keeping ask and water."* **"CivicScope Free" is the FREE MODEL across all three
  verticals, not the Municipal tool alone.** So: `/civicscope`, `/schools` and `/infrastructure`
  all stay, Ask (`/centreville`, `/bristol`) stays, Well Testing (`/water`) stays. ⛔ **Do not
  re-derive a sunset list from that sentence** — it was ambiguous, it was clarified, and the
  clarification is the record.
- ⛔ **GC public white-label — DEAD, and its admin is gone (2026-08-26).** Keith: *"you can blow away the GC as tenant thing. That is dead."* Removed from `/admin`: the GC Tenants tab, the tenant editor form, both GC product cards, the sidebar summary, the Overview tile, the ping targets, the smoke-test entries, and the `tenants` entry in `api/admin.js`'s table registry — **28,116 bytes out of the page**, and with them the null-deref that had been throwing on every load since those cards were built. Was PARKED after the 2026-07-08 Fable review (one demo tenant in four months; the real GC product is `/ryc/estimate`).
  **AND THEN THE WHOLE PRODUCT WENT, the same day** — Keith: *"tear out the GC thing."* Removed:
  `civicscope-gc/index.html`, `civicscope-gc/estimator/index.html`, `api/gc-config.js`,
  `api/gc-log.js` (deleted from the repo through the Contents API — **the deploy script only ever
  adds or updates blobs, it has no delete path**), both `vercel.json` rewrites, the manifest
  entries, both `estimating` profile patterns, the `api/gc-config.js` contract and the
  `api/gc-log.js` entry in the API registry, and the `/api/gc-config` responder in the deploy
  mock server. Copies + rationale: `Cowork/archive/civicscope-gc-white-label-2026-08-26/`.

  **`/gc/*` 301s to `/`, the same treatment `/pro` got — NOT a 404, deliberately.** `/gc/ryc` and
  `/gc/ryc-internal` were live (unlisted) and somebody holds those links; more to the point, a 404
  there would be indistinguishable from a routing regression. `verify-routing.js` now asserts both
  destinations, so the gate proves the product is *deliberately* gone rather than accidentally
  broken. Verified live: `/gc/acme`, `/gc/ryc`, `/gc/ryc-internal`, `/gc/acme-internal` → 301 to
  `/`; `/civicscope-gc/index.html`, `/api/gc-config`, `/api/gc-log` → 404.

  ⚠ **THE `tenants` TABLE AND ITS `acme`/`ryc` ROWS ARE STILL IN SUPABASE, AND NOTHING READS THEM.**
  Left deliberately: its DDL is one of the 15 legacy `schema_*.sql` files that were never version
  controlled (`migrations/LEGACY_INVENTORY.md`), so a `DROP` has no undo. Dropping it is one
  migration whenever Keith wants it. Historical `tool_runs` rows with `product = 'gc-acme'` /
  `'gc-int-acme'` also stay — they are the record of what ran, and `/admin`'s Activity feed still
  badges them correctly.
- **CivicScope restructure — loose ends (June 6)** — add version comments to the Schools + Infra tool footers; sweep the inert `.timeline-tease`/`.tease-*` dead CSS from the 3 tools; final end-to-end harness tire-kick of Schools + Infra (Municipal confirmed). The `Segment Hub Pages` table near the top still lists Infrastructure as "coming soon" — update that row when convenient.

---

---

## Key Learnings
- **🚨 A COMPARISON THAT CRIES WOLF IS WORSE THAN NO COMPARISON (`diffFiling`, 2026-08-20).** The
  filed-vs-held check shipped counting every idle well as a divergence — 24 in April, 55 in May —
  because a well that did not run is a stored `0` and a **blank cell** on EGLE's form, which is the
  form's own instruction. The genuine findings (a well that ran on a day the state was told nothing,
  a phosphate tank read ten times its filed usage) were two lines inside seventy-nine. **When a
  check's whole value is that a human reads it, its false-positive rate is a correctness property,
  not a polish item.** The fix was not a threshold: it was recognising that *absent* and *zero* are
  the same claim on this form, and only silence against a non-zero is a disagreement. Pinned by
  `scripts/verify-mor-filings.mjs` asserting `ours_only = 0` in every month, forever.
- **🚨 A MISSING STORAGE BUCKET IS NOT AN HTTP 404 (2026-08-20).** Supabase Storage answers an
  upload into a bucket that does not exist with **HTTP 400**, carrying `"code":"NoSuchBucket"` and
  `"statusCode":"404"` *as a string* in the body. The create-on-missing path was keyed on
  `r.status === 404`, so it never fired, and the first real run failed all seven workbooks with
  "Bucket not found" while the code written to prevent exactly that sat unreachable. **Match on the
  condition the service reports, not on the transport code you expected it to use** — and note that
  a create-on-missing path is only ever exercised once, so it is precisely the code that ships
  untested.
- **A WINDOWS CONSOLE CAN DECIDE WHETHER A JOB FINISHES.** `file-mor-submittals.py` recorded a
  filing, then died on `UnicodeEncodeError` printing the ✓ in its own success message — cp1252
  raises rather than degrading. The write had already happened, so the run was both successful and
  a crash. `sys.stdout.reconfigure(encoding='utf-8', errors='replace')` at the top of any script
  that prints anything but ASCII; never let output formatting sit on the completion path.
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
