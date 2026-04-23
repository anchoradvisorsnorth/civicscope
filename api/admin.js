// api/admin.js — CivicScope admin write proxy
// Gates service_role writes behind CIVICSCOPE_ADMIN_SECRET so the key
// never ships to the browser. Reads stay client-side on the anon key.

const ALLOWED_TABLES = new Set(['tenants']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ADMIN_SECRET = process.env.CIVICSCOPE_ADMIN_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!ADMIN_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supplied = req.headers['x-admin-secret'];
  if (!supplied || supplied !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { action, table, body, id } = req.body || {};

    if (action === 'auth_check') {
      return res.status(200).json({ ok: true });
    }

    if (action === 'write') {
      if (!ALLOWED_TABLES.has(table)) {
        return res.status(400).json({ error: `Table not allowed: ${table}` });
      }
      const url = id
        ? `${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`
        : `${SUPABASE_URL}/rest/v1/${table}`;
      const method = id ? 'PATCH' : 'POST';
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
        return res.status(r.status).json({ error: err });
      }
      return res.status(200).json(await r.json());
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Admin proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}
