# CLAUDE.md — CivicScope Working Memory

## Who I'm Working With
- **Keith Plummer** — keith@anchoradvisorsnorth.com
- Wears multiple hats: JBK Development (day job), CivicScope (product), AAN/MTP (side project)
- Microsoft shop, PowerShell-oriented, deploys via bat/ps1 → GitHub API → Vercel

## Key Terms
- **JBK** = JBK Development (sister to RYC & T&C)
- **RYC** = R Yoder Construction
- **T&C** = Town & Country Homes
- **BOT** = Build-Operate-Transfer (municipal dev model)
- **P3** = Public-Private Partnership
- **AAN** = Anchor Advisors North (umbrella brand)
- **MTP** = My Trust Plan (lead gen for RLTs)
- **RLT** = Revocable Living Trust
- **Wellfield** = Wellfield Botanic Gardens (JBK project, Elkhart IN)

## CivicScope Product Suite (4 versions + QA)
All call same `api/claude.js` proxy → Anthropic claude-sonnet-4-20250514

| Version | URL | Audience |
|---------|-----|----------|
| Free | app.civicscope.io/civicscope | Municipal employees |
| Pro | app.civicscope.io/civicscope-pro | Municipal (SaaS potential) |
| GC White-Label | app.civicscope.io/gc/:slug | GC's prospective clients |
| GC Internal | app.civicscope.io/gc/:slug-internal | GC estimating teams |
| QA Tool | app.civicscope.io/qa | Headless validation (Keith only) |
| Admin | app.civicscope.io/admin | Dashboard (Keith only) |

## Infrastructure
- **Hosting**: Vercel (auto-deploy from GitHub)
- **Repo**: anchoradvisorsnorth/civicscope (GitHub)
- **DB**: Supabase (sessions, tool_runs, leads, tenants) — raw fetch, NOT @supabase/supabase-js
- **Email**: Resend (info@civicscope.io)
- **Deploy**: PUSH_CIVICSCOPE.bat → push_civicscope.ps1 → GitHub Trees API → Vercel
- **Sandbox**: START_SANDBOX.bat → Python server at localhost:8888
- **Model**: claude-sonnet-4-20250514

## Vercel Env Vars
ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY

## Recent Changes (March 2026)
- **Prompt Normalization**: Standardized cost estimation rules across all 4 versions
  - All versions now include: contractor overhead, GC, permitting, engineering/design allowance (3-5%)
  - All exclude: land acquisition
  - Removed Free-only "renovation 60-80% rule" (only GC Internal has renovation as dropdown)
  - Standardized confidence language: "Vague or incomplete descriptions → Low confidence with wider ranges"
  - Added proprietary database prohibition to Free version (others already had it)
- **QA Tool**: Headless validation framework at /qa — runs test scenarios against all 4 prompts, compares results

## Pending — Next Batch Update
- [ ] **max_tokens alignment**: Free has 1000, others have 1200 — align to 1200
- [ ] **Confidence scale**: Free/Pro use "High/Moderate/Low", GC uses "High/Medium/Low" — pick one

## API Pattern — IMPORTANT
All api/*.js files use raw fetch to Supabase REST API. Do NOT use @supabase/supabase-js.
api/claude.js is a pure passthrough to Anthropic — prompts are built client-side.

## Routing (vercel.json)
- Literal rewrites for internal tools (e.g., /gc/acme-internal) ABOVE wildcard :slug
- :slug wildcard LAST
- /admin, /qa are literal rewrites

## Preferences
- Concise, direct communication
- Prefers structured testing/validation
- Values pricing consistency across product versions

## Deep Reference
See memory/ directory for: glossary, project details, company structure, Supabase schemas, email flows
