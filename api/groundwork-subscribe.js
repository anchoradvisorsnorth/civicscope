// Groundwork — newsletter signup.
//   POST /api/groundwork-subscribe  body: {email, first_name?, organization?, source?, source_url?}
//   Single opt-in for v1 (active=true, confirmed=true). Idempotent: re-subscribing
//   an active row is a no-op; re-subscribing an inactive row reactivates.

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
    const { email, first_name, last_name, organization, source, source_url } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email required' });
    }
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "That doesn't look like a valid email." });
    }

    // Check for existing subscriber (case-insensitive — lowercase index on civic_subscribers)
    const existing = await sb(
      `civic_subscribers?email=eq.${encodeURIComponent(cleanEmail)}&select=id,active,confirmed`
    );
    if (existing && existing.length > 0) {
      const sub = existing[0];
      if (sub.active) {
        return res.json({ ok: true, message: "You're already on the list. See you Tuesday." });
      }
      // Reactivate previously-unsubscribed person
      await sb(`civic_subscribers?id=eq.${sub.id}`, 'PATCH', {
        active: true,
        subscribed_at: new Date().toISOString(),
        unsubscribed_at: null,
        unsubscribe_reason: null,
      });
      return res.json({ ok: true, message: "Welcome back — you're resubscribed." });
    }

    // Create new subscriber (single opt-in for v1)
    const created = await sb('civic_subscribers', 'POST', {
      email: cleanEmail,
      first_name: first_name || null,
      last_name: last_name || null,
      organization: organization || null,
      source: source || 'signup_page',
      source_url: source_url || null,
      active: true,
      confirmed: true,
      confirmed_at: new Date().toISOString(),
    });

    return res.json({ ok: true, message: "Done — you're on the list. See you Tuesday." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
