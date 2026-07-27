// api/ryc-estimate-log.js — run log for /ryc/estimate (Phase A, 2026-07-23)
// Gate password verified SERVER-side; service key never ships to the browser.
// Actions: save (insert one run), list (recent runs, light columns), get (full row).

const LIST_COLS_BASE = 'id,created_at,estimator,project_name,location,client_type,work_type,cost_low,cost_high,cost_mid,confidence,version,files,bc_project_id,bc_url';
const LIST_COLS = LIST_COLS_BASE + ',workflow'; // workflow may not exist yet — list falls back to BASE if the column is absent

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
      let r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS}&order=created_at.desc&limit=${limit}`);
      if (!r.ok) {
        // workflow column not migrated yet → retry without it so the board still loads
        const txt = await r.text();
        if (/workflow/.test(txt)) r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS_BASE}&order=created_at.desc&limit=${limit}`);
        if (!r.ok) return res.status(r.status).json({ error: r.ok ? '' : txt });
      }
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

    // Persist pursuit workflow state (stage + typed checklist) onto an estimate row.
    // Isolated from `save` so the core estimate log never depends on the workflow column:
    // returns a soft 200 {ok:false, needs_migration:true} if the column isn't there yet.
    if (action === 'set_workflow') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const wf = req.body.workflow;
      if (wf === undefined || wf === null || typeof wf !== 'object') return res.status(400).json({ error: 'workflow object required' });
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
        method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ workflow: wf }),
      });
      if (!r.ok) {
        const txt = await r.text();
        if (/workflow/.test(txt) && /column|schema|does not exist|PGRST204/i.test(txt)) {
          return res.status(200).json({ ok: false, needs_migration: true, detail: 'workflow column not present — run the Phase C migration' });
        }
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ ok: true });
    }

    // Stamp a BC draft-project linkage onto an existing estimate row so the tool
    // knows it was already loaded and can hard-block a duplicate BC create.
    if (action === 'link_bc') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const patch = {};
      if (req.body.bc_url !== undefined) patch.bc_url = req.body.bc_url ? String(req.body.bc_url).slice(0, 500) : null;
      if (req.body.bc_project_id !== undefined) patch.bc_project_id = req.body.bc_project_id ? String(req.body.bc_project_id).slice(0, 120) : null;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to patch' });
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
        method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, { method: 'DELETE' });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
