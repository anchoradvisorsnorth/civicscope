// api/ryc-bc-load.js — Estimating Assist → BuildingConnected draft-project loader proxy.
// Proxies to the VM's /api/bc-load-project (Estimating Agent Phase 1, 2026-07-22).
// mode=preview: no writes — returns the package plan (trade mapping, bidder-list template,
// preferred-subs top-5) for UI review. mode=create: builds the DRAFT project + packages in
// BuildingConnected (drafts email no one; publishing stays a human step in the BC UI).
// Mirrors api/ryc-foundation-asof.js plumbing (same VM service + API key).
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  if (!['preview', 'create'].includes(b.mode)) return res.status(400).json({ error: 'mode must be preview|create' });
  if (!String(b.projectName || '').trim()) return res.status(400).json({ error: 'projectName required' });
  if (!Array.isArray(b.divisions) || b.divisions.length < 1 || b.divisions.length > 60) {
    return res.status(400).json({ error: 'divisions must be a list of 1-60 items' });
  }

  const VM_URL = process.env.M365_VM_URL || 'http://20.230.82.67:8080';
  const headers = { 'X-API-Key': process.env.M365_VM_API_KEY || '', 'Content-Type': 'application/json' };
  try {
    const r = await fetch(`${VM_URL}/api/bc-load-project`, {
      method: 'POST', headers,
      body: JSON.stringify({
        mode: b.mode, projectName: String(b.projectName).trim().slice(0, 250),
        description: b.description ? String(b.description).slice(0, 1500) : null,
        bidsDueAt: b.bidsDueAt || null,
        // Enforced server-side: NO amounts reach BuildingConnected. RYC leaves BC's Estimate
        // field blank by process — internal conceptual carries / quote values must never be
        // exposed in the sub-facing system (Codex review 2026-08-01, finding #3).
        divisions: b.divisions.slice(0, 60).map(d => ({
          div: (d && d.div) || null,
          name: String((d && d.name) || '').slice(0, 250),
          scope: (d && d.scope) ? String(d.scope).slice(0, 500) : null,
        })),
      }),
    });
    const data = await r.json().catch(() => null);
    if (r.ok && data) return res.status(200).json(data);
    return res.status(502).json({ error: 'VM loader failed', status: r.status, detail: data && data.detail });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach VM', detail: e.message });
  }
}
