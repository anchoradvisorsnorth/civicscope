// api/ryc-foundation-refresh.js — trigger the VM Foundation (accounting) refresh on demand
// Mirrors the POST branch of api/ryc-active.js (Procore), but simpler downstream:
// foundation-refresh.js writes CRM Supabase directly — no GitHub push, no redeploy —
// so the dashboard just refetches /api/ryc-foundation after this returns.
// VM route has a single-flight lock + 5-min success cooldown; pass those statuses through.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const VM_URL = process.env.M365_VM_URL || 'http://20.230.82.67:8080';
  const headers = { 'X-API-Key': process.env.M365_VM_API_KEY || '' };
  try {
    const r = await fetch(`${VM_URL}/api/foundation-refresh`, { method: 'POST', headers });
    if (r.ok) return res.status(200).json(await r.json());
    return res.status(502).json({ error: 'VM refresh trigger failed', status: r.status });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach VM', detail: e.message });
  }
}
