// api/golf-pool.js — storage for the friends' golf pool picks (The Open 2026).
// GET  ?slug=open-2026            → { slug, name, data, updated_at }  (public read; hidden pool)
//      PICKS ARE MASKED until data.locked (or ?code=<commissioner code>) — see the GET branch.
// POST { slug, code, name?, data } → upsert, gated by GOLF_POOL_CODE env var (commissioner code).
// data shape: { participants: [{ name, picks: [espnDisplayName x10] }], locked: bool, lockedAt, lockedBy }
// Table: golf_pools in the CivicScope Supabase project (RLS on, service-key access only).

// Bump on every change — GET ?ver=1 returns it, so the LIVE function build is verifiable
// (the Vercel webhook has served stale function builds before; CLAUDE.md deploy gotcha).
const VER = '1.1.0-masked-until-lock';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });

  try {
    if (req.query && req.query.ver !== undefined) return res.status(200).json({ ver: VER });
    /* PICKS ARE MASKED UNTIL THE POOL IS LOCKED (Codex 2026-08-01 finding #2 — Confirmed/High).
       This GET is public and used to return the entire blob — every participant's full slate —
       to anyone who knew the slug, whether or not the pool had been locked. Golf's lock is the
       commissioner's "everyone's in" moment, so it is the reveal boundary until competitions
       carry their own deadline in the rebuild.
       Masked responses still report WHO has entered and how many picks they have, so the board
       can show readiness without showing the picks themselves. */
    if (req.method === 'GET') {
      const slug = String(req.query.slug || 'open-2026').replace(/[^a-z0-9-]/gi, '');
      const r = await sb(`golf_pools?slug=eq.${slug}&select=slug,name,data,updated_at`);
      const rows = await r.json();
      const row = rows[0];
      if (!row) return res.status(200).json({ slug, name: null, data: null });

      const locked = !!(row.data && row.data.locked);
      const revealCode = String(req.query.code || '');
      const isCommish = process.env.GOLF_POOL_CODE && revealCode === process.env.GOLF_POOL_CODE;
      if (locked || isCommish) return res.status(200).json(row);

      const masked = Object.assign({}, row.data, {
        participants: ((row.data && row.data.participants) || []).map(p => ({
          name: p.name,
          pickCount: (p.picks || []).length,      // readiness, not content
        })),
        picksHidden: true,
      });
      return res.status(200).json(Object.assign({}, row, { data: masked }));
    }

    if (req.method === 'POST') {
      const { slug: rawSlug, code, name, data } = req.body || {};
      const expected = process.env.GOLF_POOL_CODE;
      if (!expected || code !== expected) return res.status(403).json({ error: 'bad code' });
      const slug = String(rawSlug || 'open-2026').replace(/[^a-z0-9-]/gi, '');
      if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data object required' });
      const row = { slug, data, updated_at: new Date().toISOString() };
      if (name) row.name = name;
      const r = await sb('golf_pools?on_conflict=slug', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row),
      });
      if (!r.ok) return res.status(502).json({ error: 'db write failed', detail: (await r.text()).slice(0, 200) });
      const saved = await r.json();
      return res.status(200).json(saved[0] || { ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
