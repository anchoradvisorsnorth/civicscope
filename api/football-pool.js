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
const VER = '2.0.0-identity';   // roster from pool_people/pool_memberships; picks keyed by person id

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
  /* COMPARE-AND-SWAP write (Codex 2026-08-01 finding #1 — Confirmed/High).
     save_picks read the whole week, changed one player's entry, and wrote the whole document
     back. Two players saving at once both read revision A; the second write was derived from A
     and ERASED the first player's picks. The filter below makes the write conditional on the
     row not having moved: PostgREST returns 0 rows if updated_at changed, and the caller
     re-reads and retries. A per-member entry row is the real fix and belongs to the rebuild;
     this removes the data-loss window on the schema that exists today. */
  const putRowCAS = async (slug, data, expectedUpdatedAt) => {
    const r = await sb(`football_pools?slug=eq.${slug}&updated_at=eq.${encodeURIComponent(expectedUpdatedAt)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error('db write failed: ' + (await r.text()).slice(0, 150));
    const rows = await r.json();
    return rows.length ? rows[0] : null;          // null = someone else wrote first
  };
  const cleanSlug = (s) => String(s || '').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
  /* SMS — A2P 10DLC campaign approved 2026-08-05 (CM4c09562b..., use case SOLE_PROPRIETOR).
     Deliberately rides the SAME notify loop as the email rather than becoming a second
     notification system: one roster, one trigger, one place where "who gets told" is decided.

     ⚠ CONSENT IS THE WHOLE BALLGAME. Four A2P rejections were about this, the last one
     (30923) for treating consent as a condition of service. So the gate is strict and
     positive: a member is texted ONLY if they set smsConsent === true themselves through
     /pool/sms. Missing flag, falsy flag, or a mobile typed in by the commissioner on someone
     else's behalf = no text. Never widen this to `if (p.mobile)`. */
  const sendSms = async (to, body) => {
    const KS = process.env.TWILIO_API_KEY_SID, KX = process.env.TWILIO_API_KEY_SECRET;
    const AC = process.env.TWILIO_ACCOUNT_SID, MS = process.env.TWILIO_MESSAGING_SERVICE_SID;
    if (!KS || !KX || !AC || !MS) return false;
    if (!/^\+1\d{10}$/.test(String(to || ''))) return false;
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${KS}:${KX}`).toString('base64'),
                   'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, MessagingServiceSid: MS, Body: String(body).slice(0, 320) }),
      });
      return r.ok;
    } catch { return false; }        // a texting failure must never break the lock or the email
  };
  /* SANDBOX BOUNDARY (Keith, 2026-08-01: "sandbox this thing for now").
     A competition whose slug starts with `sandbox-` reads its roster from `sandbox-config`,
     never from the live `config` row. That makes test play a genuinely separate world instead
     of something that borrows the real crew — and it means verification never has to write to
     a shared production record and put it back afterwards (the pattern flagged as unsafe in
     the deploy review). Real competitions are untouched by anything sandboxed. */
  const isSandbox = (slug) => String(slug || '').startsWith('sandbox-');

  /* ===================== IDENTITY (2026-08-07) =====================
     The roster is no longer a jsonb blob keyed by NAME. It comes from pool_people joined through
     pool_memberships, so a person exists independently of any pool and carries their history across
     pools — see Civicscope/schema_pool_identity.sql for why the name-keyed model had to go.
     Consent and channel preference now live on the PERSON, which is what removes the silently-wrong
     join that shipped earlier the same day. */
  const poolSlugFor = (weekSlug) => (isSandbox(weekSlug) ? 'sandbox-football' : 'football-2026');
  const loadRoster = async (weekSlug) => {
    const poolSlug = poolSlugFor(weekSlug);
    const r = await sb(`pool_memberships?select=role,pools!inner(slug),pool_people!inner(id,name,email,phone,pin,sms_consent,sms_opted_out,notify_sms,notify_email,global_role)&pools.slug=eq.${poolSlug}`);
    if (!r.ok) return [];
    return (await r.json()).map(m => ({
      id: m.pool_people.id,
      name: m.pool_people.name,
      email: m.pool_people.email || '',
      phone: m.pool_people.phone || '',
      pin: m.pool_people.pin || '',
      role: m.role,
      globalRole: m.pool_people.global_role,
      smsConsent: m.pool_people.sms_consent === true && m.pool_people.sms_opted_out !== true,
      notifySms: m.pool_people.notify_sms !== false,
      notifyEmail: m.pool_people.notify_email !== false,
      // A text requires consent AND preference. Preference alone never creates permission.
      canText: m.pool_people.sms_consent === true && m.pool_people.sms_opted_out !== true
               && !!m.pool_people.phone && m.pool_people.notify_sms !== false,
      wantsEmail: m.pool_people.notify_email !== false,
    }));
  };
  const findPerson = async (nameOrPhone) => {
    const v = String(nameOrPhone || '').trim();
    if (!v) return null;
    const digits = v.replace(/\D/g, '');
    const q = digits.length >= 10
      ? `phone=eq.${encodeURIComponent(digits.length === 11 ? '+' + digits : '+1' + digits)}`
      : `name_key=eq.${encodeURIComponent(v.toUpperCase())}`;
    const r = await sb(`pool_people?${q}&select=*`);
    return r.ok ? ((await r.json())[0] || null) : null;
  };
  const pastDeadline = (wk) => wk.deadline && Date.now() > Date.parse(wk.deadline);
  // All roster players have a locked pick — used ONLY to fire the "all picks are in" email.
  // Keyed by person id now — a rename can no longer detach someone's entry from their identity.
  const allLocked = (wk, roster) => {
    if (!roster || !roster.length || !wk.picks) return false;
    return roster.every(p => wk.picks[p.id] && wk.picks[p.id].locked);
  };
  /* THE DEADLINE IS THE ONLY THING THAT REVEALS (Codex finding #2 — Confirmed/High).
     This used to also reveal once everyone had locked. The reasoning ("all locked → the
     competitive reason to hide picks is gone") only holds if a lock is FINAL — and it isn't,
     there is a supported unlock path. So the last player to lock could read everyone else's
     card, unlock, and revise. Mike confirmed 2026-08-01 he does not need the early board. */
  const isRevealed = (wk) => pastDeadline(wk);

  /* Cover vs the FROZEN line — identical rule to the board's coverOf() and the sim's cover().
     Kept server-side so scoring never depends on what a browser computed. */
  const coverOf = (g, sc) => {
    if (!sc || sc.homeScore == null || sc.awayScore == null) return null;
    const favHome = g.favAbbrev === g.homeAbbrev;
    const favScore = favHome ? sc.homeScore : sc.awayScore;
    const dogScore = favHome ? sc.awayScore : sc.homeScore;
    const dog = favHome ? g.awayAbbrev : g.homeAbbrev;
    if (favScore - dogScore > g.line) return g.favAbbrev;
    if (favScore - dogScore === g.line) return 'PUSH';
    return dog;
  };
  // 1 point a cover, 0.5 a push, 0 a loss — computed from FROZEN picks + FROZEN lines.
  const scoreWeek = (wk, results) => {
    const pts = {}, covers = {};
    for (const g of (wk.games || [])) covers[g.id] = coverOf(g, (results || {})[g.id]);
    /* Entries are keyed by person id; each carries a `name` SNAPSHOT for display. Scores and the
       weekly winner are reported by name so the board and emails read naturally, while the durable
       key stays the id. */
    for (const [pid, entry] of Object.entries(wk.picks || {})) {
      const name = entry.name || pid;
      let p = 0;
      for (const g of (wk.games || [])) {
        const cov = covers[g.id], side = (entry.picks || {})[g.id];
        if (!cov || !side) continue;
        if (cov === 'PUSH') p += 0.5;
        else if (cov === side) p += 1;
      }
      pts[name] = p;
    }
    const best = Math.max(-1, ...Object.values(pts));
    const winners = Object.keys(pts).filter(n => pts[n] === best).sort();
    return { points: pts, covers, winner: winners.length > 1 ? 'TIE: ' + winners.join(', ') : (winners[0] || null) };
  };

  // Email the group that all picks are in and the board is live. Best-effort; SMS added later.
  async function notifyAllLocked(wk, slug, roster) {
    const picked = Object.keys(wk.picks || {});
    const rows = picked.sort().map(n => `<tr><td style="padding:3px 12px 3px 0;font-weight:700">${n}</td><td style="padding:3px 0;color:#475467">locked</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#101828">
      <div style="background:linear-gradient(135deg,#0a2240,#14532d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
        <div style="font-size:20px;font-weight:800">🏈 All picks are in — ${wk.label || slug} is locked</div>
        <div style="font-size:13px;color:#b9c6da;margin-top:3px">Everyone is locked in. Picks stay hidden until kickoff, then the board goes live.</div>
      </div>
      <div style="border:1px solid #e4e7ec;border-top:none;border-radius:0 0 10px 10px;padding:18px 22px;background:#fff">
        <table style="font-size:13px;border-collapse:collapse;margin-bottom:12px">${rows}</table>
        <div style="text-align:center;margin:8px 0">
          <a href="https://app.civicscope.io/pool/football" style="display:inline-block;background:#c8a24b;color:#1a1300;font-weight:800;font-size:16px;padding:12px 24px;border-radius:10px;text-decoration:none">Open the board →</a>
        </div>
        <div style="font-size:12px;color:#667085">Picks reveal at kickoff, then live scoring against the spread all weekend. Good luck.</div>
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
      // players roster — id + name only, never pins/emails/phones
      if (req.query.players !== undefined) {
        const roster = await loadRoster(req.query.week || '');
        return res.status(200).json({ players: roster.map(p => ({ id: p.id, name: p.name })) });
      }
      // one week
      const slug = cleanSlug(req.query.week);
      if (!slug) return res.status(400).json({ error: 'week required' });
      const row = await getRow(slug);
      if (!row) return res.status(200).json({ slug, data: null });
      const wk = row.data;
      const roster = await loadRoster(slug);
      const revealed = isRevealed(wk);
      if (!revealed && wk.picks) {
        // pick privacy: until the DEADLINE, only your own picks come back (name+pin);
        // everyone else shows locked-status only. Locking no longer reveals anything.
        const name = String(req.query.name || '').toUpperCase();
        const pin = String(req.query.pin || '');
        const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        const masked = {};
        for (const [pid, v] of Object.entries(wk.picks)) {
          masked[pid] = (me && pid === me.id)
            ? v
            : { name: v.name, locked: !!v.locked, savedAt: v.savedAt, hidden: true };
        }
        wk.picks = masked;
      }
      // Roster travels with the week so clients can render names from person ids without a 2nd call.
      return res.status(200).json({
        slug: row.slug, data: wk, revealed, updated_at: row.updated_at,
        roster: roster.map(p => ({ id: p.id, name: p.name })),
      });
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      // ---- public member registration + optional SMS opt-in (the /pool/sms web form — the verifiable A2P call-to-action) ----
      // SMS consent is voluntary: smsChoice 'no' registers the member with no phone and no consent (A2P 30923 fix).
      if (action === 'sms_optin') {
        if (req.body.hp) return res.status(200).json({ ok: true }); // honeypot: swallow bots silently
        const name = String(req.body.name || '').trim().slice(0, 60);
        if (!name) return res.status(400).json({ error: 'name required' });
        const optIn = req.body.smsChoice === 'yes';
        let phone = null;
        if (optIn) {
          const digits = String(req.body.phone || '').replace(/\D/g, '');
          if (digits.length < 10 || digits.length > 11) return res.status(400).json({ error: 'valid US mobile required for text alerts' });
          phone = digits.length === 11 ? '+' + digits : '+1' + digits;
        }
        /* Registration now writes THE PERSON (2026-08-07). It used to append to a name-keyed
           `sms-optins` list, which is precisely the row the notify path failed to join against.
           One record, one truth: consent, phone and preference all land on pool_people. */
        const cnt = await sb('pool_people?select=id&limit=101');
        if (cnt.ok && (await cnt.json()).length > 100) return res.status(429).json({ error: 'list full' });
        const patch = optIn
          ? { name, phone, sms_consent: true, sms_opted_out: false,
              sms_consent_at: new Date().toISOString(),
              sms_consent_text: String(req.body.consentText || '').slice(0, 600), updated_at: new Date().toISOString() }
          : { name, sms_consent: false, updated_at: new Date().toISOString() };
        const up = await sb('pool_people?on_conflict=name_key', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(patch),
        });
        if (!up.ok) {
          const t = await up.text();
          // A phone already claimed by a different person must not silently overwrite them.
          if (/duplicate key|unique/i.test(t) && /phone/i.test(t)) {
            return res.status(409).json({ error: 'that mobile number is already registered to someone else' });
          }
          return res.status(500).json({ error: 'registration failed' });
        }
        return res.status(200).json({ ok: true });
      }

      // ---- commissioner actions ----
      if (['save_players', 'get_players_full', 'save_week', 'lock_slate', 'finalize_week'].includes(action)) {
        if (!CODE() || req.body.code !== CODE()) return res.status(403).json({ error: 'bad code' });

        /* ⛔ THE SANDBOX BOUNDARY DID NOT COVER THIS ACTION, AND IT COST THE LIVE ROSTER
           (2026-08-07). `save_players` hard-coded putRow('config') and IGNORED req.body.slug —
           so a caller passing slug:'sandbox-config', believing it was writing to the sandbox
           world the rest of this file honours, silently REPLACED the real crew. It did exactly
           that during SMS verification: seven real players (BOB/BRAD/MARK/MIKE/NICK/KEITH/
           BRANDON) were overwritten by two test rows, and their PINs — which exist nowhere
           else, not in the week backups — were destroyed.
           The write is now addressed explicitly and can only ever hit one of two known rows. */
        /* Now writes pool_people + pool_memberships. The `config` blob is dead for reads; the row
           is left in place until the client pages stop referencing it. The v1.7.2 shrink guard is
           kept in spirit — removing participants is a membership delete and still needs an explicit
           confirmShrink, because the mistake it was written for (a caller wiping the roster while
           believing it was addressing a sandbox) is a class, not a one-off. */
        if (action === 'save_players') {
          const poolSlug = String(req.body.poolSlug || 'football-2026');
          const pr = await sb(`pools?slug=eq.${encodeURIComponent(poolSlug)}&select=id`);
          const pool = pr.ok ? (await pr.json())[0] : null;
          if (!pool) return res.status(404).json({ error: `no pool '${poolSlug}'` });

          const incoming = (req.body.players || []).map(p => {
            const d = String(p.phone || '').replace(/\D/g, '');
            return {
              name: String(p.name || '').toUpperCase().slice(0, 20),
              email: String(p.email || '').slice(0, 80) || null,
              phone: d.length === 11 && d[0] === '1' ? '+' + d : (d.length === 10 ? '+1' + d : null),
              pin: String(p.pin || Math.floor(1000 + Math.random() * 9000)),
              notify_email: p?.notify?.email !== false,
              notify_sms: p?.notify?.sms !== false,
              updated_at: new Date().toISOString(),
            };
          }).filter(p => p.name);

          const cur = await loadRoster('');
          if (!req.body.confirmShrink && cur.length > 1 && incoming.length < cur.length) {
            return res.status(409).json({
              error: `refusing to shrink ${poolSlug} from ${cur.length} to ${incoming.length} participants`,
              hint: 'pass confirmShrink:true if that is genuinely intended',
              current: cur.map(p => p.name),
            });
          }

          // Upsert the PEOPLE (they outlive any pool), then reconcile this pool's memberships.
          const up = await sb('pool_people?on_conflict=name_key', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(incoming),
          });
          if (!up.ok) return res.status(500).json({ error: 'people upsert failed: ' + (await up.text()).slice(0, 200) });
          const people = await up.json();
          const keep = people.map(p => p.id);

          await sb(`pool_memberships?pool_id=eq.${pool.id}&person_id=not.in.(${keep.join(',')})`, { method: 'DELETE' });
          await sb('pool_memberships?on_conflict=pool_id,person_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(people.map(p => ({
              pool_id: pool.id, person_id: p.id,
              role: p.global_role === 'commissioner' ? 'commissioner' : 'participant',
            }))),
          });
          return res.status(200).json({ poolSlug, players: await loadRoster('') });
        }
        if (action === 'get_players_full') {
          return res.status(200).json({
            poolSlug: String(req.body.poolSlug || 'football-2026'),
            players: (await loadRoster('')).map(p => ({
              id: p.id, name: p.name, email: p.email, phone: p.phone, pin: p.pin, role: p.role,
              // Preference (editable by the commissioner) and consent (never editable here) are
              // reported separately so the UI can show WHY someone will or will not get a text.
              notify: { sms: p.notifySms, email: p.notifyEmail },
              smsConsent: p.smsConsent,
              canText: p.canText,
            })),
          });
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
          let emailed = 0, texted = 0;
          if (req.body.notify) {
            /* One source of truth. `canText` already folds consent + not-opted-out + a phone on
               file + the member's channel preference, all read off the PERSON. The old version
               looked consent up in a separate name-keyed row and got it silently wrong. */
            const players = await loadRoster(slug);
            const base = `https://app.civicscope.io/pool/football`;
            const gameRows = wk.games.map(g =>
              `<tr><td style="padding:4px 12px 4px 0">${g.short}</td><td style="padding:4px 0;font-weight:700">${g.spreadText}</td><td style="padding:4px 0 4px 12px;color:#667085">${new Date(g.date).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' })} ET</td></tr>`).join('');
            for (const p of players) {
              // Channel choice is per member. Email defaults on; a member who turned it off is skipped.
              if (p.email && p.wantsEmail) {
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

              /* `canText` folds all four conditions read off the PERSON: consent given, not
                 opted out, a phone on file, and the member's own channel preference. Preference
                 alone is never enough — it cannot manufacture permission. */
              if (p.canText) {
                const when = new Date(wk.deadline).toLocaleString('en-US',
                  { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
                const ok = await sendSms(p.phone,
                  `The Pool: ${wk.label || slug} slate is locked. Picks close ${when} ET. `
                  + `Your PIN: ${p.pin}. ${base}/picks\nReply STOP to opt out.`);
                if (ok) texted++;
              }
            }
          }
          return res.status(200).json({ slug, locked: true, deadline: wk.deadline, emailed, texted });
        }
        /* THE SERVER DECIDES THE WINNER (Codex finding #3 — Confirmed/High).
           This used to take `weeklyWinner` as free text from the commissioner and the season
           table counted that string — so a typo, a stale browser calculation, or a crafted
           request permanently credited the wrong person. The winner is now derived from the
           frozen picks and the frozen lines; a client-supplied winner is ignored and reported
           back if it disagrees. Scores are PERSISTED so the board no longer depends on ESPN
           keeping the history around. */
        if (action === 'finalize_week') {
          const slug = cleanSlug(req.body.slug);
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          const results = req.body.results || wk.results;
          if (!results || !Object.keys(results).length) {
            return res.status(400).json({ error: 'final scores required to finalize' });
          }
          const missing = (wk.games || []).filter(g => !results[g.id] || results[g.id].homeScore == null || results[g.id].awayScore == null);
          if (missing.length) {
            return res.status(400).json({ error: `not every game has a final score (${missing.map(g => g.short || g.id).join(', ')})` });
          }
          const scored = scoreWeek(wk, results);
          const claimed = req.body.weeklyWinner || null;
          wk.results = results;
          wk.scores = scored.points;                 // persisted — survives ESPN dropping history
          wk.covers = scored.covers;
          wk.weeklyWinner = scored.winner;           // derived, never supplied
          wk.finalized = true;
          wk.finalizedAt = new Date().toISOString();
          wk.scoringVersion = VER;
          await putRow(slug, wk);
          return res.status(200).json({
            slug, finalized: true, weeklyWinner: wk.weeklyWinner, points: scored.points,
            ...(claimed && claimed !== scored.winner
              ? { note: `ignored the submitted winner "${claimed}" — the frozen picks and lines score to "${scored.winner}"` }
              : {}),
          });
        }
      }

      // ---- player action ----
      if (action === 'save_picks') {
        const slug = cleanSlug(req.body.slug);
        const name = String(req.body.name || '').toUpperCase();
        const pin = String(req.body.pin || '');
        const roster = await loadRoster(slug);
        const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        if (!me) return res.status(403).json({ error: 'bad name or PIN' });
        /* Read → modify → CONDITIONAL write, retried on contention. Only this member's entry
           is touched; if anyone else's save landed in between, the write is rejected and we
           start over from their revision instead of overwriting it. */
        let fireNotify = false, saved = null, picks = {};
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          if (!wk.slateLocked) return res.status(400).json({ error: 'slate not locked yet' });
          if (pastDeadline(wk)) return res.status(400).json({ error: 'picks closed — first game has kicked off' });
          wk.picks = wk.picks || {};
          const mine = wk.picks[me.id] || {};
          if (mine.locked && !req.body.unlock) return res.status(400).json({ error: 'your picks are locked' });

          /* VALIDATE AGAINST THE SLATE (Codex finding #4 — Confirmed/High). Completeness and
             legality used to be enforced only by the browser's lock button, so the API would
             accept zero picks, a subset, or any 6-char string as a "side". Under a deadline
             freeze the latest draft becomes final automatically, so a card the server never
             checked could be scored. */
          const byId = new Map((wk.games || []).map(g => [String(g.id), g]));
          picks = {};
          const badSides = [];
          for (const [gid, side] of Object.entries(req.body.picks || {})) {
            const g = byId.get(String(gid));
            if (!g) continue;                                    // not on this slate — ignore
            const s = String(side).toUpperCase().slice(0, 6);
            if (s !== String(g.homeAbbrev).toUpperCase() && s !== String(g.awayAbbrev).toUpperCase()) {
              badSides.push(`${g.short || gid}: "${side}"`);
              continue;
            }
            picks[gid] = s;
          }
          if (badSides.length) {
            return res.status(400).json({ error: `pick must be one of the two teams in the game — ${badSides.join('; ')}` });
          }
          const total = (wk.games || []).length;
          const complete = Object.keys(picks).length === total;
          // Locking requires a COMPLETE card; a partial draft may be saved but not locked.
          if (req.body.lock && !complete) {
            return res.status(400).json({ error: `all ${total} games need a pick to lock (you have ${Object.keys(picks).length})` });
          }
          // Keyed by PERSON ID; the stored name is a display snapshot, so the board reads
            // naturally while the durable key survives a rename or a roster rebuild.
          wk.picks[me.id] = { name: me.name, picks, locked: !!req.body.lock, complete, savedAt: new Date().toISOString() };

          // If this lock completes the board, fire the "all in" email once. The guard flag is
          // set BEFORE persisting so a retry can't double-send.
          fireNotify = false;
          if (req.body.lock && !wk.notifiedAllLocked && allLocked(wk, roster)) {
            wk.notifiedAllLocked = true;
            fireNotify = true;
          }
          saved = await putRowCAS(slug, wk, row.updated_at);
        }
        if (!saved) return res.status(409).json({ error: 'another save landed at the same moment — try again' });
        if (fireNotify) await notifyAllLocked(saved.data, slug, roster);
        return res.status(200).json({ ok: true, locked: !!req.body.lock, count: Object.keys(picks).length, allLocked: fireNotify });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}


