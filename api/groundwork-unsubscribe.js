// Groundwork — one-click unsubscribe (RFC 8058 List-Unsubscribe compliant).
//   POST /api/groundwork-unsubscribe  body: {id, reason?}
//   Soft-delete: sets active=false, unsubscribed_at=now(). Reactivation via
//   /api/groundwork-subscribe with the same email.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }

  async function sb(path, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'User-Agent': 'curl/8.0',
        Prefer: 'return=representation',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  try {
    const { id, reason } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Subscriber id required' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid subscriber id format' });
    }

    const existing = await sb(`civic_subscribers?id=eq.${id}&select=id,active`);
    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'Subscriber not found' });
    }
    if (!existing[0].active) {
      return res.json({ ok: true, message: 'Already unsubscribed.' });
    }

    await sb(`civic_subscribers?id=eq.${id}`, 'PATCH', {
      active: false,
      unsubscribed_at: new Date().toISOString(),
      unsubscribe_reason: reason || null,
    });

    return res.json({ ok: true, message: "Done — you've been removed from the list." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
