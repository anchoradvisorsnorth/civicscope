// api/ryc-estimate-log.js — run log for /ryc/estimate (Phase A, 2026-07-23)
// Gate password verified SERVER-side; service key never ships to the browser.
// Actions: save (insert one run), list (recent runs, light columns), get (full row).

const LIST_COLS = 'id,created_at,estimator,project_name,location,client_type,work_type,cost_low,cost_high,cost_mid,confidence,version,files';

const SAVE_FIELDS = [
  'estimator', 'project_name', 'location', 'client_type', 'work_type', 'size_sf',
  'target_budget', 'scope_notes', 'files', 'scope_constraints', 'cost_low', 'cost_high',
  'cost_mid', 'confidence', 'narrative', 'divisions', 'assumptions', 'gaps',
  'version', 'batches', 'duration_ms', 'quotes',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GATE_PW = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Server misconfigured' });

  const { pw, action } = req.body || {};
  if (pw !== GATE_PW) return res.status(401).json({ error: 'Unauthorized' });

  const sb = (path, opts) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      ...(opts && opts.headers),
    },
  });

  try {
    if (action === 'save') {
      const rec = { tenant: 'ryc' };
      const src = req.body.record || {};
      for (const f of SAVE_FIELDS) if (src[f] !== undefined && src[f] !== null) rec[f] = src[f];
      if (!rec.project_name) return res.status(400).json({ error: 'project_name required' });
      if (typeof rec.estimator === 'string') rec.estimator = rec.estimator.slice(0, 40);
      const r = await sb('ryc_estimates', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(rec),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      return res.status(200).json({ ok: true, id: rows[0] && rows[0].id });
    }

    if (action === 'list') {
      const limit = Math.min(Number(req.body.limit) || 200, 500);
      const r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS}&order=created_at.desc&limit=${limit}`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true, runs: await r.json() });
    }

    if (action === 'get') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r = await sb(`ryc_estimates?id=eq.${id}&limit=1`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ ok: true, run: rows[0] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
