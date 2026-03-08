// api/gc-log.js
// Logs GC white label sessions and tool runs to shared CivicScope Supabase project

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  async function supabase(table, body) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
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

    if (action === 'create_session') {
      const rows = await supabase('sessions', {
        referrer: data.referrer || null,
        user_agent: data.userAgent || null
      });
      return res.status(200).json({ session_id: rows[0].id });
    }

    if (action === 'log_run') {
      const rows = await supabase('tool_runs', {
        session_id:        data.session_id || null,
        municipality:      data.municipality || null,
        project_type:      data.project_type || null,
        scope_description: data.scope_description || null,
        cost_low:          data.cost_low || null,
        cost_high:         data.cost_high || null,
        cost_midpoint:     data.cost_midpoint || null,
        confidence:        data.confidence || null,
        narrative:         data.narrative || null,
        assumptions:       data.assumptions || [],
        product:           `gc-${data.slug}`
      });
      return res.status(200).json({ run_id: rows[0].id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('gc-log error:', err);
    return res.status(200).json({ error: err.message, logged: false });
  }
}
