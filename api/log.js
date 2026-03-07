// api/log.js — CivicScope data capture endpoint
// Handles session creation, tool run logging, and lead capture

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  async function supabase(table, method, body, id) {
    const url = id
      ? `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`
      : `${SUPABASE_URL}/rest/v1/${table}`;
    const r = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Supabase error: ${err}`);
    }
    return r.json();
  }

  try {
    const { action, data } = req.body;

    // ── Create session ──────────────────────────────────────────────
    if (action === 'create_session') {
      const rows = await supabase('sessions', 'POST', {
        referrer: data.referrer || null,
        user_agent: data.userAgent || null
      });
      return res.status(200).json({ session_id: rows[0].id });
    }

    // ── Log tool run ────────────────────────────────────────────────
    if (action === 'log_run') {
      const rows = await supabase('tool_runs', 'POST', {
        session_id: data.session_id || null,
        zip: data.zip,
        state: data.state,
        municipality: data.municipality,
        project_type: data.project_type,
        build_type: data.build_type,
        scope_description: data.scope_description,
        topography: data.topography,
        utilities: data.utilities || [],
        cost_low: data.cost_low,
        cost_high: data.cost_high,
        cost_midpoint: data.cost_midpoint,
        confidence: data.confidence,
        confidence_reason: data.confidence_reason,
        narrative: data.narrative,
        assumptions: data.assumptions || [],
        project_label: data.project_label,
        run_duration_ms: data.run_duration_ms,
        product: 'free'
      });
      return res.status(200).json({ run_id: rows[0].id });
    }

    // ── Log lead (gate form submission) ────────────────────────────
    if (action === 'log_lead') {
      const rows = await supabase('leads', 'POST', {
        session_id: data.session_id || null,
        tool_run_id: data.tool_run_id || null,
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        role: data.role,
        municipality: data.municipality,
        followup_answers: data.followup_answers || null
      });
      return res.status(200).json({ lead_id: rows[0].id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Log error:', err);
    // Never fail silently — but also never block the user experience
    return res.status(200).json({ error: err.message, logged: false });
  }
}
