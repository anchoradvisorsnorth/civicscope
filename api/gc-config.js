// api/gc-config.js
// Fetches tenant config from Supabase by slug
// GET /api/gc-config?slug=acme

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tenants?slug=eq.${slug}&active=eq.true&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Accept': 'application/json'
        }
      }
    );

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Supabase error: ${err}`);
    }

    const rows = await r.json();
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Strip sensitive fields before sending to browser
    const { contact_email, from_email, ...safeConfig } = rows[0];
    return res.status(200).json(safeConfig);

  } catch (err) {
    console.error('gc-config error:', err);
    return res.status(500).json({ error: err.message });
  }
}
