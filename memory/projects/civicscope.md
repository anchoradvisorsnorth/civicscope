# CivicScope — Product & Technical Details

## What It Is
AI-powered municipal construction cost feasibility tool. 4 product versions serving different audiences, all powered by same Anthropic API proxy.

## Architecture
- Static HTML/JS frontends on Vercel
- `api/claude.js` — shared proxy (direct passthrough, no prompt modification)
- Supabase for persistence (sessions, tool_runs, leads, tenants)
- GitHub repo: anchoradvisorsnorth/civicscope

## Four Versions

### Free (civicscope/index.html) — v1.4.0
- **Audience**: Municipal employees (town managers)
- **Inputs**: Location, ZIP, project type, build type, description, topography, utilities
- **Output**: JSON → Low/High range, confidence, narrative, assumptions, project label
- **Tone**: "Write for a town manager, not a contractor"
- **max_tokens**: 1000

### Pro (civicscope-pro/index.html) — v2.2.0
- **Audience**: Municipal officials (SaaS potential)
- **Inputs**: Same as Free
- **Output**: JSON → Same as Free + methodology (basis, SF range, $/SF, key drivers, exclusions)
- **Extra features**: Cost methodology, timeline, buyer's advocate guide, council briefing, print/PDF
- **max_tokens**: 1200

### GC White-Label (civicscope-gc/index.html) — v1.2.0-gc
- **Audience**: GC's prospective clients (lead gen)
- **Inputs**: Municipality, project type, location, description
- **Output**: Plain text → Cost range, confidence, narrative, assumptions, process steps with timeline
- **Tone**: "Warm, honest, confident and human — like a trusted advisor"
- **Multi-tenant**: Loads config from `/api/gc-config?slug=` (Supabase tenants table)
- **max_tokens**: 1200

### GC Internal (civicscope-gc/estimator/index.html) — v1.0.0-gc-int
- **Audience**: GC estimating teams
- **Inputs**: Municipality, project type, location, SF, construction type, stories, occupancy, site condition, utilities, foundation, structural, description
- **Output**: Plain text → Cost range, confidence, narrative, assumptions, gap questions with ±$ impact
- **Tone**: "Estimator-to-estimator — precise, direct, no hand-holding"
- **Special**: Gap questions refinement loop (confirm answers → re-run with tighter estimate)
- **max_tokens**: 1200

## Standardized Cost Rules (March 2026 normalization)
All 4 versions now share these rules:
- Include contractor overhead, general conditions, permitting, and basic engineering/design allowance (3-5%)
- Exclude land acquisition
- If no utilities on site, add realistic extension costs
- If demo required, include demo costs
- Vague or incomplete descriptions → Low confidence with wider ranges
- Regional labor market costs reflected
- No proprietary database names (RSMeans, Gordian)

### What Changed
| Rule | Before | After |
|------|--------|-------|
| Design allowance | Free: "basic engineering/design", GC: "Hard costs only" | All: 3-5% engineering/design allowance |
| Renovation rule | Free: "60-80% of new per SF" hardcoded | Removed from Free (only GC Int has renovation dropdown) |
| Confidence language | Free: "Vague = Low + wider ranges", others: varied/missing | All: standardized phrasing |
| Database prohibition | Pro/GC had it, Free didn't | All versions |

## Known Bugs (from testing)
1. GC White-Label: Missing comma formatting in dollar amounts
2. GC White-Label: Dropdown finicky (needs form_input, not click)
3. Free: max_tokens (1000) lower than others (1200) — still divergent
4. Confidence scale inconsistency: Free/Pro use "Moderate", GC uses "Medium"

## Test Data (Splash Pad, Granger IN 46530)
| Version | Low | High | Midpoint |
|---------|-----|------|----------|
| Free | $280K | $420K | $350K |
| Pro | $180K | $280K | $230K |
| GC White-Label | $175K | $275K | $225K |
| GC Internal | $225K | $375K | $300K |

*Note: These were pre-normalization results. Retest needed post-deploy.*
