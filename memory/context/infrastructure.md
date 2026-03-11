# Infrastructure Deep Reference

## Supabase
- Project: anchoradvisorsnorth's Project (AWS us-east-1)
- URL: https://tyvtmqzaydrbjwzvjoei.supabase.co
- Tables: sessions, tool_runs, leads, tenants

### tool_runs schema
id, session_id, created_at, zip, state, municipality, project_type, build_type,
scope_description, topography, utilities (array), cost_low, cost_high,
cost_midpoint (integer), confidence, confidence_reason, narrative,
assumptions (array), project_label, run_duration_ms, product
product field values: 'free', 'pro', 'gc-[slug]', 'gc-int-[slug]'

### tenants schema
id (uuid), slug (unique), gc_name, logo_url, primary_color, hero_headline,
hero_subhead, cta_headline, cta_body, cta_button_label, cta_url,
contact_email, from_email, project_types (jsonb), region,
gate_enabled (boolean), active (boolean), created_at, notify_email,
brand_statement (text), brand_values (jsonb array)

## Email (Resend)
- Sends from info@civicscope.io
- api/email.js routes by product prefix: gc- → GC templates, else → CS templates
- Keith BCC'd on all CS reports
- Free/Pro subject lines include tier: "CivicScope Free" or "CivicScope Pro"

## Deploy Workflow
PUSH_CIVICSCOPE.bat → push_civicscope.ps1 → GitHub Trees API → Vercel auto-redeploy (~60s)
- CLAUDE.md is NOT in PUSH_CIVICSCOPE.bat — push separately via UPDATE_CLAUDE_MD.ps1
- CONTEXT_BRIEFING.md is sunset — do not reference or recreate
- api/claude.js and api/log.js deployed separately (rarely change)

## API Pattern
Raw fetch to Supabase REST API. NEVER use @supabase/supabase-js.

## File Locations
- Working memory: C:\Users\kmplu\Cowork\CLAUDE.md (root level — covers all projects)
- Product files: C:\Users\kmplu\Cowork\civicscope\ (pushed by PUSH_CIVICSCOPE.bat)
- RYC files: C:\Users\kmplu\Cowork\RYC\ (pushed by PUSH_RYC_SCHEDULE.bat)
