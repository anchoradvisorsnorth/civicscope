# RYC module — DELETED from CivicScope 2026-09-12 (RYC migration Phase 7)

RYC moved to `https://command.ryoderconstruction.com` on RYC's own Azure + Entra tenant on
2026-09-05 (plan: [`infra/ryc-migration-plan-v2.md`](../infra/ryc-migration-plan-v2.md)). After a week
of real use by the front office, Joe, Annette and Tristan, Keith approved deletion on 2026-09-12 and
every RYC file was removed from the public `civicscope` repo in one commit (list below). The code is
the canonical repository `RYC/app` (remote `itryc/Keith-move-over`), deployed by `RYC/app/deploy.sh`.

**What stays here, deliberately:**
- `vercel.json` **redirects** — every legacy RYC path 308s to Command (`/ryc/*`, `/command*`, `/desk*`,
  `/invoices*`, `/ryc-data/*`, `/ryc-estimate/*.json`). People hold these links; `scripts/verify-routing.js`
  asserts them (origin + path) on every static deploy.
- The frozen `ryc_*` tables in the CivicScope Supabase project carry a permanent freeze trigger and
  are read by nothing. Dropping them is a separate decision.
- `migrations/0xx_ryc_*` — the applied-migration ledger, never deployed. The `scripts/*ryc*` gates/probes and the
  `schema_ryc_*.sql` files moved to `archive/ryc-module-civicscope-2026-09-12/` (2026-09-12).

**Deleted (GitHub `civicscope` main, 2026-09-12):** `api/ryc-active.js`, `api/ryc-ask.js`,
`api/ryc-bc-load.js`, `api/ryc-desk-intake.js`, `api/ryc-desk-upload.js`, `api/ryc-dodge-project.js`,
`api/ryc-estimate-log.js`, `api/ryc-foundation-asof.js`, `api/ryc-foundation-query.js`,
`api/ryc-foundation-refresh.js`, `api/ryc-invoices.js`, `api/ryc-schedule-tasks.js`, `api/ryc-sync-log.js`,
`api/schedule-notify.js`, and the whole of `ryc-billing/`, `ryc-command/`, `ryc-dashboard/`, `ryc-data/`,
`ryc-estimate/`, `ryc-foundation/`, `ryc-invoices/`, `ryc-schedule/`, `ryc-shell/`. Local copies removed
the same day; `push_civicscope.ps1` no longer lists any RYC path and has no `ryc` profile rule.
Vercel env vars freed from this project: `RYC_*`, `PROCORE_CLIENT_ID/SECRET`, `M365_VM_URL/API_KEY`.

⚠ Git history still holds every deleted file (this repo is public). Treat anything that was ever
committed here as disclosed — that was already the standing position from 2026-08-26.

## KEEP — NOT RYC (the owned SaaS)
`civicscope/`, `civicscope-schools/`, `civicscope-infrastructure/`, `for-government/`, `for-schools/`,
`for-infrastructure/`, the hub, `api/claude.js`/`email.js`/`log.js`/`digest.js`, admin, QA, the municipal
document answers (`civicscope-village/`, `civicscope-muni/`, `api/muni-ask.js`), the water plant log
(`civicscope-water/`, `api/water-ops.js`, `api/build-mor.py`) and the friends' pool (`pool/`, `golf/`,
`football/`). The public repo is now a clean municipal SaaS.
