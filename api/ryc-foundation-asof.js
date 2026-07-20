// api/ryc-foundation-asof.js — as-of-date Foundation query for the Command Center WOH view.
// Proxies to the VM's /api/foundation-asof (live read-only ODBC): per-active-job SUM of
// cost with v_job_history.date_posted <= date and billings with v_em_jc_billings.transaction_date <= date.
// date_posted (not date_booked) per Data Dictionary #10 — payroll books future pay-dates.
// Mirrors api/ryc-foundation-refresh.js plumbing (same VM service + API key).
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const date = req.body && req.body.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (date > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'date cannot be in the future' });

  const VM_URL = process.env.M365_VM_URL || 'http://20.230.82.67:8080';
  const headers = { 'X-API-Key': process.env.M365_VM_API_KEY || '', 'Content-Type': 'application/json' };
  try {
    const r = await fetch(`${VM_URL}/api/foundation-asof`, { method: 'POST', headers, body: JSON.stringify({ date }) });
    if (r.ok) return res.status(200).json(await r.json());
    return res.status(502).json({ error: 'VM as-of query failed', status: r.status });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach VM', detail: e.message });
  }
}
