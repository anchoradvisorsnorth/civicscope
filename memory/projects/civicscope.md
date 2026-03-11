# CivicScope — Product & Technical Details

## What It Is
AI-powered municipal construction cost feasibility tool. 4 product versions
serving different audiences, all powered by same Anthropic API proxy.

## Architecture
- Static HTML/JS frontends on Vercel
- `api/claude.js` — shared proxy (direct passthrough, no prompt modification)
- Supabase for persistence (sessions, tool_runs, leads, tenants)
- GitHub repo: anchoradvisorsnorth/civicscope

## Four Versions

### Free (civicscope/index.html) — v1.7.0
- **Audience**: Municipal employees (town managers)
- **Inputs**: Location, ZIP, project type, build type, description, topography, utilities
- **Output**: JSON → Low/High range, confidence, narrative, assumptions, project label
- **Tone**: "Write for a town manager, not a contractor"
- **max_tokens**: 1200
- **Tab title**: CivicScope - Free | Municipal Project Feasibility
- **Favicon**: Inline SVG civic building mark, orange (#c2410c)

### Pro (civicscope-pro/index.html) — v2.5.0
- **Audience**: Municipal officials (SaaS potential)
- **Inputs**: Same as Free
- **Output**: JSON → Same as Free + methodology (basis, SF range, $/SF, key drivers, exclusions)
- **Extra features**: Cost methodology, timeline, buyer's advocate guide, council briefing, print/PDF
- **max_tokens**: 1200
- **Tab title**: CivicScope - Pro | Municipal Project Feasibility
- **Favicon**: Inline SVG civic building mark, navy (#1e3a5f)

### GC White-Label (civicscope-gc/index.html) — v1.3.0-gc
- **Audience**: GC's prospective clients (lead gen)
- **Inputs**: Municipality, project type, location, description
- **Output**: Plain text → Cost range, confidence, narrative, assumptions, process steps with timeline
- **Tone**: "Warm, honest, confident and human — like a trusted advisor"
- **Multi-tenant**: Loads config from `/api/gc-config?slug=` (Supabase tenants table)
- **max_tokens**: 1200

### GC Internal (civicscope-gc/estimator/index.html) — v1.1.0-gc-int
- **Audience**: GC estimating teams
- **Inputs**: Municipality, project type, location, SF, construction type, stories, occupancy,
  site condition, utilities, foundation, structural, description
- **Output**: Plain text → Cost range, confidence, narrative, assumptions, gap questions with ±$ impact
- **Tone**: "Estimator-to-estimator — precise, direct, no hand-holding"
- **Special**: Gap questions refinement loop (confirm answers → re-run with tighter estimate)
- **max_tokens**: 1200

## Standardized Cost Rules (March 2026 normalization)
All 4 versions share these rules:
- Include contractor overhead, general conditions, permitting, and basic engineering/design allowance (3-5%)
- Exclude land acquisition
- If no utilities on site, add realistic extension costs
- If demo required, include demo costs
- Vague or incomplete descriptions → Low confidence with wider ranges
- Regional labor market costs reflected
- No proprietary database names (RSMeans, Gordian)
- Confidence scale: High / Medium / Low (no "Moderate")
- Temperature: 0.3 on all versions for run-to-run consistency

## Logo & Branding
- Nav logo: SVG civic building mark — orange (#c2410c) on Free/landing, navy (#1e3a5f) on Pro
- Favicon: Inline SVG data URI in <head> — same mark, same color rules
- Email headers: Styled text only (SVG not supported in email clients)
  - Free emails: "CivicScope"
  - Pro emails: "CivicScope Pro"
- Email subjects include tier: "Your CivicScope Free/Pro Feasibility Report..."
- Brand guide and SVG reference files: G:\Drive\civicscope
