// api/ryc-active.js — Serve cached Procore data for active RYC jobs
// Data is refreshed weekly by procore-refresh.js on keith-agent-01 VM
// Reads from static procore-cache.json (pushed to GitHub by VM script)
// On-demand refresh: POST triggers VM to re-run procore-refresh.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST = trigger on-demand refresh via VM
  if (req.method === 'POST') {
    const VM_URL = process.env.M365_VM_URL || 'http://20.230.82.67:8080';
    try {
      const r = await fetch(`${VM_URL}/api/procore-refresh`, {
        method: 'POST',
        headers: { 'X-API-Key': process.env.M365_VM_API_KEY || '' },
      });
      if (r.ok) {
        return res.status(200).json({ message: 'Refresh triggered on VM. Data will update in ~60 seconds after Vercel redeploy.' });
      }
      return res.status(502).json({ error: 'VM refresh trigger failed', status: r.status });
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach VM', detail: e.message });
    }
  }

  // GET = serve cached data from static file
  try {
    const cacheUrl = new URL('/ryc-dashboard/procore-cache.json', `https://${req.headers.host}`);
    const r = await fetch(cacheUrl.toString());
    if (r.ok) {
      const data = await r.json();
      return res.status(200).json(data);
    }
    return res.status(200).json({ refreshed: null, jobs: [], note: 'No cache available. Run procore-refresh.js on VM.' });
  } catch (e) {
    return res.status(200).json({ refreshed: null, jobs: [], error: e.message });
  }
}
