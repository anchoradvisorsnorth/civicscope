// api/football-pool.js — friends' weekly football ATS pool (college + NFL), v1 built 2026-07-15.
// Storage: football_pools (CS Supabase, RLS on, service key only) — slug-keyed jsonb rows:
//   'config'    → { players: [{name, email, pin}] }
//   '2026-w01'… → { label, games:[{id,league,date,name,short,homeAbbrev,awayAbbrev,favAbbrev,line,spreadText,manual}],
//                   slateLocked, lockedAt, deadline, picks:{PLAYER:{picks:{gameId:abbrev}, locked, savedAt}},
//                   finalized, results, weeklyWinner }
// Commissioner actions gated by FOOTBALL_POOL_CODE env var; player writes gated by per-player PIN.
// Pick privacy: GET strips other players' picks until the week deadline passes (name+pin reveals your own).

const CODE = () => process.env.FOOTBALL_POOL_CODE;
// Bump on every change to this file — GET ?ver=1 returns it, so the LIVE function build is verifiable
// (the Vercel webhook has served stale function builds before; see CLAUDE.md deploy gotcha 2026-07-16).
const VER = '1.1.0-reply-to-aan';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sb = (path, opts = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const getRow = async (slug) => {
    const r = await sb(`football_pools?slug=eq.${slug}&select=slug,data,updated_at`);
    return (await r.json())[0] || null;
  };
  const putRow = async (slug, data) => {
    const r = await sb('football_pools?on_conflict=slug', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ slug, data, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error('db write failed: ' + (await r.text()).slice(0, 150));
    return (await r.json())[0];
  };
  const cleanSlug = (s) => String(s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
  const pastDeadline = (wk) => wk.deadline && Date.now() > Date.parse(wk.deadline);
  // All roster players have a locked pick → the competitive reason to hide picks is gone.
  const allLocked = (wk, roster) => {
    if (!roster || !roster.length || !wk.picks) return false;
    return roster.every(p => wk.picks[p.name] && wk.picks[p.name].locked);
  };
  // Reveal everyone's picks once all are locked OR first kickoff passes, whichever comes first.
  const isRevealed = (wk, roster) => pastDeadline(wk) || allLocked(wk, roster);

  // Email the group that all picks are in and the board is live. Best-effort; SMS added later.
  async function notifyAllLocked(wk, slug, roster) {
    const picked = Object.keys(wk.picks || {});
    const rows = picked.sort().map(n => `<tr><td style="padding:3px 12px 3px 0;font-weight:700">${n}</td><td style="padding:3px 0;color:#475467">locked</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#101828">
      <div style="background:linear-gradient(135deg,#0a2240,#14532d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
        <div style="font-size:20px;font-weight:800">🏈 All picks are in — ${wk.label || slug} is locked</div>
        <div style="font-size:13px;color:#b9c6da;margin-top:3px">Everyone's locked in, so all picks are now visible.</div>
      </div>
      <div style="border:1px solid #e4e7ec;border-top:none;border-radius:0 0 10px 10px;padding:18px 22px;background:#fff">
        <table style="font-size:13px;border-collapse:collapse;margin-bottom:12px">${rows}</table>
        <div style="text-align:center;margin:8px 0">
          <a href="https://app.civicscope.io/football" style="display:inline-block;background:#c8a24b;color:#1a1300;font-weight:800;font-size:16px;padding:12px 24px;border-radius:10px;text-decoration:none">See everyone's picks →</a>
        </div>
        <div style="font-size:12px;color:#667085">Live scoring against the spread all weekend. Good luck.</div>
      </div></div>`;
    for (const p of roster) {
      if (!p.email) continue;
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com', to: [p.email], subject: `🏈 All picks are in — ${wk.label || slug} is locked`, html }),
        });
      } catch (e) { /* best-effort */ }
    }
  }

  try {
    if (req.method === 'GET') {
      // live-build check: curl "…/api/football-pool?ver=1" → must match the VER in the repo
      if (req.query.ver !== undefined) return res.status(200).json({ ver: VER });
      // list all weeks for a season (summaries only — no picks)
      if (req.query.list) {
        const season = String(req.query.list).replace(/\D/g, '');
        const r = await sb(`football_pools?slug=like.${season}-w*&select=slug,data,updated_at&order=slug.asc`);
        const rows = await r.json();
        return res.status(200).json(rows.map(({ slug, data, updated_at }) => ({
          slug, updated_at,
          label: data.label, slateLocked: !!data.slateLocked, deadline: data.deadline || null,
          finalized: !!data.finalized, weeklyWinner: data.weeklyWinner || null,
          games: (data.games || []).length,
          pickedBy: Object.entries(data.picks || {}).filter(([, v]) => v.locked).map(([k]) => k),
          // full detail (incl. picks + results) only when the pick window is closed
          full: (data.deadline && Date.now() > Date.parse(data.deadline)) ? data : null,
        })));
      }
      // players roster — names only, never pins/emails
      if (req.query.players !== undefined) {
        const cfg = await getRow('config');
        return res.status(200).json({ players: ((cfg?.data?.players) || []).map(p => ({ name: p.name })) });
      }
      // one week
      const slug = cleanSlug(req.query.week);
      if (!slug) return res.status(400).json({ error: 'week required' });
      const row = await getRow(slug);
      if (!row) return res.status(200).json({ slug, data: null });
      const wk = row.data;
      const cfg = await getRow('config');
      const roster = (cfg?.data?.players) || [];
      const revealed = isRevealed(wk, roster);
      if (!revealed && wk.picks) {
        // pick privacy: until everyone locks (or kickoff), only your own picks come back (name+pin); others show locked-status only
        const name = String(req.query.name || '').toUpperCase();
        const pin = String(req.query.pin || '');
        const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        const masked = {};
        for (const [player, v] of Object.entries(wk.picks)) {
          masked[player] = (me && player.toUpperCase() === name)
            ? v
            : { locked: !!v.locked, savedAt: v.savedAt, hidden: true };
        }
        wk.picks = masked;
      }
      return res.status(200).json({ slug: row.slug, data: wk, revealed, updated_at: row.updated_at });
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      // ---- commissioner actions ----
      if (['save_players', 'get_players_full', 'save_week', 'lock_slate', 'finalize_week'].includes(action)) {
        if (!CODE() || req.body.code !== CODE()) return res.status(403).json({ error: 'bad code' });

        if (action === 'save_players') {
          const players = (req.body.players || []).map(p => ({
            name: String(p.name || '').toUpperCase().slice(0, 20),
            email: String(p.email || '').slice(0, 80),
            pin: String(p.pin || Math.floor(1000 + Math.random() * 9000)),
          })).filter(p => p.name);
          await putRow('config', { players });
          return res.status(200).json({ players });
        }
        if (action === 'get_players_full') {
          const cfg = await getRow('config');
          return res.status(200).json({ players: (cfg?.data?.players) || [] });
        }
        if (action === 'save_week') {
          const slug = cleanSlug(req.body.slug);
          if (!slug) return res.status(400).json({ error: 'slug required' });
          const existing = (await getRow(slug))?.data || {};
          const data = { ...existing, ...req.body.data };
          await putRow(slug, data);
          return res.status(200).json({ slug, ok: true });
        }
        if (action === 'lock_slate') {
          const slug = cleanSlug(req.body.slug);
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          if (!(wk.games || []).length) return res.status(400).json({ error: 'no games in slate' });
          const noLine = wk.games.filter(g => g.line == null || !g.favAbbrev);
          if (noLine.length) return res.status(400).json({ error: 'games missing a spread: ' + noLine.map(g => g.short).join(', ') });
          wk.slateLocked = true;
          wk.lockedAt = new Date().toISOString();
          wk.deadline = wk.games.map(g => g.date).sort()[0]; // picks close at first kickoff
          wk.picks = wk.picks || {};
          await putRow(slug, wk);
          // notify players (best-effort; skips players without an email)
          let emailed = 0;
          if (req.body.notify) {
            const cfg = await getRow('config');
            const players = (cfg?.data?.players) || [];
            const base = `https://app.civicscope.io/football`;
            const gameRows = wk.games.map(g =>
              `<tr><td style="padding:4px 12px 4px 0">${g.short}</td><td style="padding:4px 0;font-weight:700">${g.spreadText}</td><td style="padding:4px 0 4px 12px;color:#667085">${new Date(g.date).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' })} ET</td></tr>`).join('');
            for (const p of players) {
              if (!p.email) continue;
              const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#101828">
                <div style="background:linear-gradient(135deg,#0a2240,#14532d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
                  <div style="font-size:20px;font-weight:800">🏈 ${wk.label || slug} slate is LOCKED — make your picks</div>
                  <div style="font-size:13px;color:#b9c6da;margin-top:3px">Picks close at first kickoff: ${new Date(wk.deadline).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</div>
                </div>
                <div style="border:1px solid #e4e7ec;border-top:none;border-radius:0 0 10px 10px;padding:18px 22px;background:#fff">
                  <table style="font-size:14px;border-collapse:collapse;margin-bottom:14px">${gameRows}</table>
                  <div style="text-align:center;margin:14px 0">
                    <a href="${base}/picks" style="display:inline-block;background:#c8a24b;color:#1a1300;font-weight:800;font-size:16px;padding:12px 24px;border-radius:10px;text-decoration:none">Make your picks →</a>
                    <div style="font-size:13px;color:#667085;margin-top:8px">${p.name} · your PIN: <b style="color:#101828;font-size:15px">${p.pin}</b></div>
                  </div>
                  <div style="font-size:12px;color:#667085">Pick the winner against the spread for every game, then lock. Live pool all weekend at <a href="${base}">${base.replace('https://', '')}</a>.</div>
                </div></div>`;
              const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com', to: [p.email], subject: `🏈 ${wk.label || slug} slate is locked — picks due before first kickoff`, html }),
              });
              if (r.ok) emailed++;
            }
          }
          return res.status(200).json({ slug, locked: true, deadline: wk.deadline, emailed });
        }
        if (action === 'finalize_week') {
          const slug = cleanSlug(req.body.slug);
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          wk.finalized = true;
          wk.results = req.body.results || wk.results;       // {gameId:{homeScore,awayScore,coverAbbrev|'PUSH'}}
          wk.weeklyWinner = req.body.weeklyWinner || wk.weeklyWinner; // name or 'TIE: A, B'
          await putRow(slug, wk);
          return res.status(200).json({ slug, finalized: true, weeklyWinner: wk.weeklyWinner });
        }
      }

      // ---- player action ----
      if (action === 'save_picks') {
        const slug = cleanSlug(req.body.slug);
        const name = String(req.body.name || '').toUpperCase();
        const pin = String(req.body.pin || '');
        const cfg = await getRow('config');
        const me = ((cfg?.data?.players) || []).find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        if (!me) return res.status(403).json({ error: 'bad name or PIN' });
        const row = await getRow(slug);
        if (!row) return res.status(404).json({ error: 'week not found' });
        const wk = row.data;
        if (!wk.slateLocked) return res.status(400).json({ error: 'slate not locked yet' });
        if (pastDeadline(wk)) return res.status(400).json({ error: 'picks closed — first game has kicked off' });
        wk.picks = wk.picks || {};
        const mine = wk.picks[me.name] || {};
        if (mine.locked && !req.body.unlock) return res.status(400).json({ error: 'your picks are locked' });
        const valid = new Set((wk.games || []).map(g => String(g.id)));
        const picks = {};
        for (const [gid, side] of Object.entries(req.body.picks || {})) {
          if (valid.has(String(gid))) picks[gid] = String(side).slice(0, 6);
        }
        wk.picks[me.name] = { picks, locked: !!req.body.lock, savedAt: new Date().toISOString() };
        const roster = (cfg?.data?.players) || [];
        // If this lock completes the board (everyone locked), fire the "all in" email once.
        // Set the guard flag BEFORE persisting so a retry can't double-send.
        let fireNotify = false;
        if (req.body.lock && !wk.notifiedAllLocked && allLocked(wk, roster)) {
          wk.notifiedAllLocked = true;
          fireNotify = true;
        }
        await putRow(slug, wk);
        if (fireNotify) await notifyAllLocked(wk, slug, roster);
        return res.status(200).json({ ok: true, locked: !!req.body.lock, count: Object.keys(picks).length, allLocked: fireNotify });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
