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
const VER = '3.16.0-slate-order';  // the lock email lists games in kickoff order, like the picks card

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
  const loadRoster = async (weekSlug) => loadRosterByPool(poolSlugFor(weekSlug));
  /* ⛔ THE ROSTER READS ADDRESSED THE DEFAULT POOL WHILE THE WRITE ADDRESSED THE REQUESTED ONE
     (found by the pool-integrity gate, 2026-08-19). `save_players` resolves `poolSlug` from the
     request and writes memberships to THAT pool — but its shrink guard, its response body and
     `get_players_full` all called `loadRoster('')`, and `poolSlugFor('')` is `football-2026`.
     So the guard whose entire job is to stop a roster being wiped was counting a DIFFERENT pool's
     members. It refused a legitimate 2-player save to `sandbox-football` because the live pool
     happened to hold 3 — and, in the direction that actually costs something, it would have
     ALLOWED a write cutting a ten-member pool to four, because four is not fewer than three.
     `get_players_full` was worse: it echoed the requested `poolSlug` back with
     `football-2026`'s players underneath it, so the editor could paint one pool's roster under
     another pool's name — and the next Save would write those people into it.
     This is the 2026-08-07 roster overwrite's own lesson one layer up: that fix taught the WRITE
     which world it was in and left the READS behind. A boundary that covers most of the accesses
     is not a boundary. Pool-addressed callers now name the pool; week-addressed ones still derive
     it from the week. */
  const loadRosterByPool = async (slug) => {
    const poolSlug = encodeURIComponent(String(slug || 'football-2026'));
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
      /* OBSERVER = on the roster for NOTIFICATIONS, not for play (migration 061, Keith 2026-08-29:
         "I wont be one of the players … is it possible to include me in the notifications despite
         not being a player"). The notify loops below iterate the whole roster on purpose — one
         roster, one trigger, one place where "who gets told" is decided — so an observer receives
         everything a player receives. Everything that SCORES, CHARGES or REVEALS filters to
         players instead. Anything unrecognised counts as a player: the conservative direction is
         to include someone in the game, never to silently drop them out of it. */
      isPlayer: m.role !== 'observer',
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

  /* ===================== THE WEEKLY CLOCK (Keith 2026-08-09) =====================
     "Mike will build the slate each week by Thursday at 9:30. Picks are due from players by
     Saturday morning at 10am EST."

     Two fixed weekly moments, not "whenever the first game happens to kick off":
       BUILD  — Thursday 09:30 ET   (commissioner nudged 3h before, at 06:30, if not locked)
       PICKS  — Saturday 10:00 ET   (players nudged 3h before, at 07:00, if not locked in)

     ⚠ ONE HARD SAFETY, AND IT IS NOT NEGOTIABLE: the deadline can never fall AFTER the first
     kickoff. A fixed Saturday 10:00 works for a Sat/Sun slate; the moment a slate carries a
     Thursday or Friday game — every preseason week does — a Saturday deadline would let someone
     pick a game whose result is already known. So the effective deadline is
     min(Saturday 10:00 ET, first kickoff), and lock_slate REPORTS when the earlier one won so
     the commissioner is never surprised by a deadline he did not choose.

     ET offset: America/New_York is UTC-4 in football season (EDT through early November) and
     UTC-5 after. Derived from the date rather than assumed — a hand-assumed offset is exactly
     what put the hand-built preseason kickoffs an hour out. */
  const etParts = (d) => {                     // {y,m,day,weekday,hour,minute} in America/New_York
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
    return { y: +f.year, m: +f.month, day: +f.day, weekday: f.weekday, hour: +f.hour % 24, minute: +f.minute };
  };
  // UTC instant for a given ET wall-clock time, found by correcting the guess against the real zone.
  const etToUtc = (y, m, day, hour, minute) => {
    let t = Date.UTC(y, m - 1, day, hour, minute);
    for (let i = 0; i < 3; i++) {
      const p = etParts(new Date(t));
      const driftMin = (p.hour * 60 + p.minute) - (hour * 60 + minute)
        + (p.day !== day ? (p.day > day || p.m > m ? 1440 : -1440) : 0);
      if (!driftMin) break;
      t -= driftMin * 60000;
    }
    return new Date(t);
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // The next occurrence of <weekday> at <hh:mm> ET, strictly after `from`.
  const nextEtWeekday = (from, weekdayName, hh, mm) => {
    const want = DAYS.indexOf(weekdayName);
    for (let add = 0; add <= 8; add++) {
      const probe = new Date(from.getTime() + add * 86400000);
      const p = etParts(probe);
      if (DAYS.indexOf(p.weekday) !== want) continue;
      const t = etToUtc(p.y, p.m, p.day, hh, mm);
      if (t > from) return t;
    }
    return null;
  };
  const PICKS_DAY = 'Sat', PICKS_HH = 10, PICKS_MM = 0;      // picks due Saturday 10:00 ET
  const BUILD_DAY = 'Thu', BUILD_HH = 9, BUILD_MM = 30;      // slate built by Thursday 09:30 ET
  /* The week's pick deadline: the Saturday 10:00 ET the group plays to, pulled earlier if any
     game on the slate kicks off before it. Returns the reason so callers can say why. */
  const deadlineFor = (games, now = new Date()) => {
    const kicks = (games || []).map(g => Date.parse(g.date)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    const firstKick = kicks.length ? new Date(kicks[0]) : null;
    // Anchor on the slate itself when we have it: the Saturday belonging to these games, not to
    // whenever the lock button happened to be pressed.
    const anchor = firstKick ? new Date(Math.min(firstKick.getTime(), now.getTime()) - 1000) : now;
    const sat = nextEtWeekday(anchor, PICKS_DAY, PICKS_HH, PICKS_MM);
    if (!firstKick) return { deadline: sat, reason: 'schedule', firstKick: null };
    if (sat && sat < firstKick) return { deadline: sat, reason: 'schedule', firstKick };
    return { deadline: firstKick, reason: 'kickoff', firstKick };
  };
  /* ⛔ THE LOCKED-SLATE EMAIL LISTS THE GAMES IN THE ORDER THEY ARE PLAYED (Keith 2026-09-02:
     "when picking games these should present in the order of games, first to last — same thing
     for the email that goes out to tell people that picks are locked").

     `wk.games` is stored in the order the commissioner BUILT the slate, and he loads NFL and
     college separately, so a mixed week arrives grouped by league and is chronological only by
     accident. Week 1 went out with Sunday 7:30pm at the top and Saturday 3:30pm second.

     ⚠ THIS IS THE SERVER'S COPY OF `slateOrder()` IN pool/scoring.js, and it exists for exactly
     the reason coverOf() is duplicated below: the browser and this function cannot share a module
     here. The card the player fills in and the email telling him to fill it in MUST agree about
     which game is first, so if one of these two changes the other has to move with it. Display
     only — it returns a SORTED COPY, and scoring iterates `wk.games`, which is order-independent.

     The `#ou` twin stays beside its own fixture (spread above total), same rule as the board. */
  const slateOrder = (games) => (games || []).slice().sort((a, b) => {
    const ka = Date.parse(a.date) || 0, kb = Date.parse(b.date) || 0;
    if (ka !== kb) return ka - kb;
    const ida = String(a.id).split('#')[0], idb = String(b.id).split('#')[0];
    if (ida !== idb) return ida < idb ? -1 : 1;
    const ma = a.market === 'total' ? 1 : 0, mb = b.market === 'total' ? 1 : 0;
    if (ma !== mb) return ma - mb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
  /* ⛔ WHO IS IN *THIS WEEK* — NOT WHO IS ON THE ROSTER (Keith 2026-08-25).
     "There will usually be 6 players, I won't be playing — that said they may have the occasional
     random person join for a week."

     Both halves of that break the old rule. `allLocked` was `roster.every(...)` and
     `outstandingFor` listed every member without a locked card, so **a member who is not playing
     is permanently outstanding**: the board never opens on "everyone is locked in", the
     "all picks are in" text NEVER FIRES, and the week only reveals when the deadline passes —
     every week, silently, with nothing naming the cause. A one-week guest does the same thing to
     every subsequent week until somebody deletes them from the roster.

     So the week carries its own participant list, snapshotted when the commissioner locks the
     slate. `wk.participants` is an array of person ids.

     ⚠ THE DEFAULT IS THE FULL ROSTER, DELIBERATELY. Nothing about an existing week changes
     behaviour, and a week locked before this existed has no `participants` at all and falls back
     to exactly today's rule. The commissioner opts people OUT at lock; he does not have to opt
     anyone in.

     ⚠ AND AN EMPTY/UNMATCHED LIST FALLS BACK RATHER THAN REVEALING. If every id in the snapshot
     has since left the roster, `participants` would be empty — and an empty list makes
     `outstandingFor` empty, which would throw the board open to the public. Falling back to the
     roster is the conservative direction; revealing is not. */
  /* The roster members who actually play. An observer (migration 061) is on the roster to be
     TOLD things and for no other reason, so every set that decides scoring, pricing, reveal or
     "who are we waiting on" is built from this rather than from the roster. */
  const playersOf = (roster) => (roster || []).filter(p => p.isPlayer !== false);
  const participantsOf = (wk, roster) => {
    const players = playersOf(roster);
    const ids = wk && wk.participants;
    /* ⛔ THE DEFAULT IS THE PLAYERS, NOT THE WHOLE ROSTER (061). An observer left in the default
       set would be auto-ticked at lock, the week would wait forever for a card he is refused
       permission to file, the all-picks-in notice would never fire and the board would only open
       at the deadline — every week, silently. That is precisely the fault 3.13.0-participants was
       built to remove, re-entering through a role that did not exist when it was written. */
    if (!Array.isArray(ids) || !ids.length) return players;
    const want = new Set(ids.map(String));
    /* A stored snapshot is still filtered to players: a week locked BEFORE 061 has the observer's
       id baked into it, and honouring that would resurrect the same stall on exactly the weeks
       nobody would think to check. */
    const chosen = players.filter(p => want.has(String(p.id)));
    return chosen.length ? chosen : players;
  };
  // Everyone IN THIS WEEK has a locked pick — fires the "all picks are in" notice and the reveal.
  // Keyed by person id now — a rename can no longer detach someone's entry from their identity.
  const allLocked = (wk, roster) => {
    const ps = participantsOf(wk, roster);
    if (!ps.length || !wk.picks) return false;
    return ps.every(p => wk.picks[p.id] && wk.picks[p.id].locked);
  };
  /* REVEAL = EVERYONE LOCKED, OR THE DEADLINE — whichever comes first (Keith, 2026-08-12).
     The weekly motion he set: build → lock the slate → everyone is notified to pick → and once
     ALL players have picked, everyone is notified and the picks become viewable.

     History matters here, because this is a reversal. Codex #2 removed the all-locked reveal on
     sound reasoning: a lock could be UNDONE, so the last player to lock could read everyone
     else's card, unlock, and revise. That was true then. The unlock path was deleted on
     2026-08-09 — `save_picks` 403s a locked entry and no client offers the button — and the
     comment there already records that this "retires the reason the all-locked reveal had to be
     removed". The precondition is gone, so the restriction goes with it.

     ⛔ LOCKED, never merely SAVED. A saved card stays editable until the deadline; revealing on
     "saved" would hand back the exact exploit Codex #2 closed. `allLocked` requires every roster
     member to have `locked: true`, so one unlocked card keeps the whole board masked. */
  /* ⛔ REVEAL IS A LATCH, NOT A RECOMPUTATION (Keith 2026-08-19, adding a player mid-week).
     `allLocked` is derived from the CURRENT roster, so adding a member to a week that had
     already opened made it false again — and the board silently RE-MASKED for the people who
     had already been shown it. A reveal is an event that happened; a later roster change cannot
     un-happen it. `revealedAt` is stamped by save_picks the moment the last card locks, and is
     what keeps the board open afterwards. `allLocked` stays as the live fallback for weeks that
     opened before this existed. */
  /* THE LATCH HAS TO COVER WEEKS THAT OPENED BEFORE IT EXISTED, AND IT CANNOT DO THAT BY
     REWRITING THEM. `revealedAt` is stamped by save_picks, and locking is final — so no week
     already open will ever be saved again, and the live `2026-pre2` (open since
     2026-08-18T20:02:46Z, three texted, three emailed) would have had no latch at all. Adding a
     player to it would have re-masked the board for the three who had already seen it: precisely
     the bug this change exists to remove, still live on the only week that matters.
     It does not need a data migration, because the moment the board opened is ALREADY on the row.
     `notifiedAllLocked` and `allLockedNotice.at` are written by the SAME condition at the SAME
     instant, so they are evidence that it opened. `allLockedNotice` is the better of the two:
     when a notice reaches nobody the 2026-08-13 fix deliberately releases `notifiedAllLocked`,
     but it still records the attempt — and the board opened either way, because a text failing is
     not the board closing. Neither can mark a week open that never opened; the worst case is a
     fall-through to `allLocked`, which is exactly today's behaviour. */
  const openedAt = (wk) => wk.revealedAt || (wk.allLockedNotice && wk.allLockedNotice.at) || null;
  const isRevealed = (wk, roster) =>
    pastDeadline(wk) || !!openedAt(wk) || !!wk.notifiedAllLocked || allLocked(wk, roster);
  /* Members who could still be filling a card in: on the roster, no locked entry, deadline not
     passed. Once this is empty there is nobody left to protect a pick from, and the board is
     public exactly as it always was. While it is NOT empty — the only case being someone added
     after the board opened — the open board is answered per viewer. */
  /* ⛔ THIS IS THE *PRIVACY* SET, AND IT IS THE ROSTER — NOT THE PARTICIPANTS (2026-08-25).
     Making this participants-based regressed the 2026-08-19 rule and the gate caught it on the
     deploy: a member added mid-week is not in a snapshot taken at lock, so this went EMPTY, the
     board read as "nobody left to protect a pick from", and it opened to the newcomer — and to a
     signed-out reader — before they had filled a card in.

     Two different questions were sharing one function:
       · WHO IS THE WEEK WAITING ON to declare itself open, fire the all-picks-in notice and stamp
         the reveal? → the PARTICIPANTS. A member who is not playing must not hold that up.
         That is `allLocked`, and it is participants-based.
       · WHO COULD STILL PUT A CARD IN, and therefore must not read everyone else's first?
         → ANYONE ON THE ROSTER, because `save_picks` lets any member pick a locked week before
         the deadline. That is this function, and it stays the roster.
     Keeping the conservative set here costs nothing that matters: by the time the week is open,
     every participant has locked by definition, so every actual player already sees the board.
     The only reader still held out is someone who has not picked — which is the point. */
  /* ⛔ AN OBSERVER IS NOT OUTSTANDING, AND LEAVING HIM HERE WOULD CLOSE THE BOARD FOREVER (061).
     This set is "who could still put a card in". An observer never can — `save_picks` refuses him
     outright — so he has no pick to protect and would otherwise sit here permanently, meaning the
     set is never empty, meaning the board never becomes public again for anybody. The 08-25 rule
     that this is the ROSTER and not the participants is untouched: a player added mid-week is
     still held out until he picks. The only thing removed is someone who cannot pick at all. */
  const outstandingFor = (wk, roster) => (pastDeadline(wk) ? []
    : playersOf(roster).filter(p => !(wk.picks && wk.picks[p.id] && wk.picks[p.id].locked)));

  /* Cover vs the FROZEN line — identical rule to the board's coverOf() and the sim's cover().
     Kept server-side so scoring never depends on what a browser computed. */
  const coverOf = (g, sc) => {
    if (!sc || sc.homeScore == null || sc.awayScore == null) return null;
    /* OVER/UNDER (Keith 2026-08-09: "at times Mike wants to offer a game based on over-under not
       the line — a game can be available in the slate as both against the line and over-under").
       A total is a SECOND, INDEPENDENT entry for the same fixture: same teams, same kickoff, its
       own id (`<id>#ou`), its own market, its own point. The sides are OVER and UNDER rather than
       two team abbreviations, and exactly on the number is a push — same as landing on a spread.
       Must mirror coverOf() in pool/football.html exactly. */
    if (g.market === 'total') {
      const combined = sc.homeScore + sc.awayScore;
      if (combined > g.total) return 'OVER';
      if (combined < g.total) return 'UNDER';
      return 'PUSH';
    }
    /* PICK 'EM (Keith 2026-08-08: "if there is not line just make it a pick em"). Preseason lines
       are thin or absent, so a game can be scored straight up: highest score wins, a tie is a push.
       No spread is involved, which is why `line` stays null and `pickem` is the flag — inferring
       pick'em from `line === 0` would collide with a real pick'em-priced spread. */
    if (g.pickem) {
      if (sc.homeScore === sc.awayScore) return 'PUSH';
      return sc.homeScore > sc.awayScore ? g.homeAbbrev : g.awayAbbrev;
    }
    const favHome = g.favAbbrev === g.homeAbbrev;
    const favScore = favHome ? sc.homeScore : sc.awayScore;
    const dogScore = favHome ? sc.awayScore : sc.homeScore;
    const dog = favHome ? g.awayAbbrev : g.homeAbbrev;
    if (favScore - dogScore > g.line) return g.favAbbrev;
    if (favScore - dogScore === g.line) return 'PUSH';
    return dog;
  };
  /* SCORING (Keith 2026-08-09): "Winner is the one who wins the most games against the spread.
     Ties are worth zero points." So a push scores **0**, not the half point it used to — the
     weekly total is simply how many games you won outright against the number. Changed here AND
     in pool/football.html's weekPoints(); the rule lives in two places by design (persisted score
     vs live board) and they must move together or the board lies about who won. */
  /* Resolve a game's final score by id, then by the BASE id (an over/under entry is `<id>#ou`),
     then by matchup — the same three-way lookup the board uses. Without the base-id and matchup
     fallbacks a total would sit unscored forever with no error, which is exactly the failure the
     hand-built preseason slate hit in August. */
  const resultFor = (g, results) => {
    const r = results || {};
    return r[g.id]
      || r[String(g.id).split('#')[0]]
      || r[`${g.awayAbbrev}@${g.homeAbbrev}`]
      || null;
  };
  const scoreWeek = (wk, results) => {
    const pts = {}, covers = {};
    for (const g of (wk.games || [])) covers[g.id] = coverOf(g, resultFor(g, results));
    /* Entries are keyed by person id; each carries a `name` SNAPSHOT for display. Scores and the
       weekly winner are reported by name so the board and emails read naturally, while the durable
       key stays the id. */
    for (const [pid, entry] of Object.entries(wk.picks || {})) {
      const name = entry.name || pid;
      let p = 0;
      for (const g of (wk.games || [])) {
        const cov = covers[g.id], side = (entry.picks || {})[g.id];
        if (!cov || !side) continue;
        if (cov === 'PUSH') continue;              // a tie against the number is worth nothing
        else if (cov === side) p += 1;
      }
      pts[name] = p;
    }
    const best = Math.max(-1, ...Object.values(pts));
    const winners = Object.keys(pts).filter(n => pts[n] === best).sort();
    return { points: pts, covers, winner: winners.length > 1 ? 'TIE: ' + winners.join(', ') : (winners[0] || null) };
  };

  /* Tell the GROUP that everyone is locked in — text and email, on the same channel rules as
     every other notification (Keith 2026-08-09: "notify the group when everyone has saved and
     locked"). It used to be email-only, and the list of names was the raw picks keys, which
     since the identity migration are UUIDs. */
  /* ⛔ THIS FUNCTION COULD FAIL COMPLETELY AND LEAVE NO TRACE (fixed 2026-08-13).
     It sent, counted nothing, returned nothing, and swallowed every error — while `save_picks`
     latched `notifiedAllLocked = true` BEFORE calling it. So "the group was told" and "every
     message failed" were byte-identical afterwards, and the latch meant it could never be retried.
     That is not hypothetical: on 2026-08-09 the all-picks-in notice fired at 23:02 from a build
     whose notifyAllLocked was EMAIL-ONLY (the SMS loop landed at 23:07, five minutes later), so
     Keith and Mike got the email and no text — and the week is permanently flagged as notified.
     Nothing recorded that, and nothing could have.
     Now it counts both channels and hands the numbers back, `save_picks` persists them on the week,
     and a notice that reached NOBODY releases the latch so it can be sent again. Same shape as
     lock_slate, which has always returned {emailed, texted} — this is that lesson applied to the
     one notification that did not have it. */
  async function notifyAllLocked(wk, slug, roster) {
    let texted = 0, emailed = 0;
    const picked = Object.values(wk.picks || {}).map(v => v.name).filter(Boolean);
    const rows = picked.sort().map(n => `<tr><td style="padding:3px 12px 3px 0;font-weight:700">${n}</td><td style="padding:3px 0;color:#475467">locked</td></tr>`).join('');
    const tag = (wk.isTest || isSandbox(slug)) ? '[TEST — no action needed] ' : '';
    const sms = `${tag}The Pool: everyone is locked in for ${wk.label || slug} — all picks are `
      + `now visible. See who took what: app.civicscope.io/pool/football`;
    for (const p of roster) {
      if (p.canText) { try { if (await sendSms(p.phone, sms + '\nReply STOP to opt out.')) texted++; } catch (e) { /* best-effort */ } }
    }
    const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#101828">
      <div style="background:linear-gradient(135deg,#0a2240,#14532d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
        <div style="font-size:20px;font-weight:800">🏈 All picks are in — ${wk.label || slug} is locked</div>
        <div style="font-size:13px;color:#b9c6da;margin-top:3px">Everyone is locked in, so every card is now visible on the board.</div>
      </div>
      <div style="border:1px solid #e4e7ec;border-top:none;border-radius:0 0 10px 10px;padding:18px 22px;background:#fff">
        <table style="font-size:13px;border-collapse:collapse;margin-bottom:12px">${rows}</table>
        <div style="text-align:center;margin:8px 0">
          <a href="https://app.civicscope.io/pool/football" style="display:inline-block;background:#c8a24b;color:#1a1300;font-weight:800;font-size:16px;padding:12px 24px;border-radius:10px;text-decoration:none">Open the board →</a>
        </div>
        <div style="font-size:12px;color:#667085">Picks reveal at kickoff, then live scoring against the spread all weekend. Good luck.</div>
      </div></div>`;
    for (const p of roster) {
      if (!p.email || !p.wantsEmail) continue;
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com', to: [p.email], subject: `${tag}🏈 All picks are in — ${wk.label || slug} is locked`, html }),
        });
        if (r.ok) emailed++;
      } catch (e) { /* best-effort */ }
    }
    return { texted, emailed };
  }

  /* THE WINNER IS NEWS — tell the group (Keith 2026-08-09: "notify the group when a winner is
     established"). Fired from finalize_week, off the SAME derived result that gets persisted, so
     the message can never disagree with the board. */
  async function notifyWinner(wk, slug, roster, scored) {
    const tag = (wk.isTest || isSandbox(slug)) ? '[TEST — no action needed] ' : '';
    const label = wk.label || slug;
    const board = Object.entries(scored.points || {}).sort((a, b) => b[1] - a[1]);
    const top = board.length ? board[0][1] : 0;
    const headline = String(scored.winner || '').startsWith('TIE:')
      ? `${scored.winner.replace('TIE: ', '')} tie for the win`
      : `${scored.winner} wins ${label}`;
    const sms = `${tag}The Pool: ${headline} — ${top} game${top === 1 ? '' : 's'} against the spread. `
      + `Full board: app.civicscope.io/pool/football`;
    const rows = board.map(([n, p], i) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#98a2b3">${i + 1}</td>`
      + `<td style="padding:4px 14px 4px 0;font-weight:${i === 0 ? 800 : 600}">${n}</td>`
      + `<td style="padding:4px 0;font-weight:800">${p}</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#101828">
      <div style="background:linear-gradient(135deg,#0a2240,#14532d);color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
        <div style="font-size:20px;font-weight:800">🏆 ${headline}</div>
        <div style="font-size:13px;color:#b9c6da;margin-top:3px">${label} is final — most games won against the spread. A push is worth nothing.</div>
      </div>
      <div style="border:1px solid #e4e7ec;border-top:none;border-radius:0 0 10px 10px;padding:18px 22px;background:#fff">
        <table style="font-size:14px;border-collapse:collapse;margin-bottom:12px">${rows}</table>
        <div style="text-align:center;margin:8px 0">
          <a href="https://app.civicscope.io/pool/football" style="display:inline-block;background:#c8a24b;color:#1a1300;font-weight:800;font-size:16px;padding:12px 24px;border-radius:10px;text-decoration:none">See the full board →</a>
        </div>
      </div></div>`;
    let texted = 0, emailed = 0;
    for (const p of roster) {
      if (p.canText) { try { if (await sendSms(p.phone, sms + '\nReply STOP to opt out.')) texted++; } catch (e) { /* best-effort */ } }
      if (p.email && p.wantsEmail) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com', to: [p.email], subject: `${tag}🏆 ${headline}`, html }),
          });
          if (r.ok) emailed++;
        } catch (e) { /* best-effort */ }
      }
    }
    return { texted, emailed };
  }

  /* THE FINALIZE SEQUENCE, IN ONE PLACE. `finalize_week` (commissioner, scores in the body) and
     `auto_finalize` (cron, scores fetched here) must produce identical outcomes — this file has
     already been bitten twice by a rule living in two places (scoreWeek vs the board's
     weekPoints, server vs client pick'em), so the third copy does not get written. */
  async function applyFinalize(slug, wk, results, forceAnnounce) {
    const scored = scoreWeek(wk, results);
    wk.results = results;
    wk.scores = scored.points;                 // persisted — survives ESPN dropping history
    wk.covers = scored.covers;
    wk.weeklyWinner = scored.winner;           // derived, never supplied
    wk.finalized = true;
    wk.finalizedAt = new Date().toISOString();
    wk.scoringVersion = VER;
    /* The flag is set BEFORE the write, so re-running finalize (to correct a score, say) never
       re-announces the same winner to seven phones. A deliberate re-announce is `notify: true`. */
    const announce = (!wk.notifiedWinner || forceAnnounce === true);
    if (announce) wk.notifiedWinner = true;
    await putRow(slug, wk);
    let told = { texted: 0, emailed: 0 };
    if (announce) told = await notifyWinner(wk, slug, await loadRoster(slug), scored);
    return { scored, announce, told };
  }

  /* Final scores, read SERVER-SIDE. The browser uses site.api.espn.com, which 403s every request
     from our network — that block is why finalize was a button. site.web.api.espn.com answers the
     same paths with the same shape from the VM and from here. Parsing mirrors pool/scoring.js
     liveScores() exactly, including the matchup key: a hand-built slate carries our own ids
     (`pre1-DET-CIN`) which can never equal an ESPN event id, so id-only lookup would leave every
     game silently unscored. */
  const SB_SERVER = {
    nfl: 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
    cfb: 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  };
  const datesSpan = (games) => {
    const ds = games.map(g => new Date(g.date)).filter(d => !isNaN(d));
    if (!ds.length) return null;
    const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const min = new Date(Math.min(...ds)), max = new Date(Math.max(...ds));
    min.setDate(min.getDate() - 1); max.setDate(max.getDate() + 2);
    return f(min) + '-' + f(max);
  };
  async function fetchFinals(games) {
    const out = {};
    const notes = [];
    for (const lg of ['nfl', 'cfb']) {
      const mine = (games || []).filter(g => g.league === lg);
      if (!mine.length) continue;
      const span = datesSpan(mine);
      if (!span) continue;
      const url = `${SB_SERVER[lg]}?dates=${span}${lg === 'cfb' ? '&groups=80' : ''}`;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'the-pool/1.0' } });
        if (!r.ok) { notes.push(`${lg}: HTTP ${r.status}`); continue; }
        const j = await r.json();
        for (const e of (j.events || [])) {
          const c = (e.competitions || [])[0];
          if (!c) continue;
          const home = (c.competitors || []).find(x => x.homeAway === 'home');
          const away = (c.competitors || []).find(x => x.homeAway === 'away');
          if (!home || !away) continue;
          const sc = {
            homeScore: Number(home.score || 0), awayScore: Number(away.score || 0),
            state: c.status && c.status.type ? c.status.type.state : undefined,
            detail: (c.status && c.status.type && c.status.type.shortDetail) || '',
          };
          out[String(e.id)] = sc;
          out[`${away.team.abbreviation}@${home.team.abbreviation}`] = sc;
        }
      } catch (e) { notes.push(`${lg}: ${e.message}`); }
    }
    return { scores: out, notes };
  }

  /* ⛔ THE SPREAD A WEEK LOCKS AT MUST BE THE SPREAD AT LOCK TIME (Keith 2026-08-30: "The pick
     should reflect the live spread at the time of the lock regardless of when they were saved").
     It did not. `slate.push({...g})` in commish.html copies ESPN's numbers at the moment a game
     is ADDED, "Save draft" persists that copy, and openWeek() reads it straight back — nothing
     re-fetched odds, ever, and no timestamp was stored so nobody could see how old a number was.
     Build the slate Sunday, lock Wednesday, and the crew played Sunday's line while the lock
     screen said "freezes every spread as shown". Now the server re-pulls at lock and overwrites.
     Mirrors parseOdds() in commish.html exactly — same endpoint shape as fetchFinals(), same
     id + AWAY@HOME keying, because a hand-built slate carries our own ids. */
  function parseOddsServer(c) {
    const o = ((c || {}).odds || [])[0];
    if (!o) return null;
    const ou = (o.overUnder != null && isFinite(+o.overUnder)) ? +o.overUnder : null;
    if (!o.details || o.details === 'EVEN') return ou == null ? null : { favAbbrev: null, line: null, spreadText: null, overUnder: ou };
    const m = String(o.details).match(/^([A-Z&\.\-']+)\s+(-?\d+(\.\d+)?)/i);
    if (!m) return ou == null ? null : { favAbbrev: null, line: null, spreadText: null, overUnder: ou };
    return { favAbbrev: m[1].toUpperCase(), line: Math.abs(parseFloat(m[2])), spreadText: o.details, overUnder: ou };
  }

  async function fetchLines(games) {
    const out = {};
    const notes = [];
    for (const lg of ['nfl', 'cfb']) {
      const mine = (games || []).filter(g => g.league === lg);
      if (!mine.length) continue;
      const span = datesSpan(mine);
      if (!span) continue;
      const url = `${SB_SERVER[lg]}?dates=${span}${lg === 'cfb' ? '&groups=80' : ''}`;
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'the-pool/1.0' } });
        if (!r.ok) { notes.push(`${lg}: HTTP ${r.status}`); continue; }
        const j = await r.json();
        for (const e of (j.events || [])) {
          const c = (e.competitions || [])[0];
          if (!c) continue;
          const odds = parseOddsServer(c);
          if (!odds) continue;
          const home = (c.competitors || []).find(x => x.homeAway === 'home');
          const away = (c.competitors || []).find(x => x.homeAway === 'away');
          out[String(e.id)] = odds;
          if (home && away) out[`${away.team.abbreviation}@${home.team.abbreviation}`] = odds;
        }
      } catch (e) { notes.push(`${lg}: ${e.message}`); }
    }
    return { lines: out, notes };
  }

  /* Refresh in place. Returns what moved and what could not be refreshed.
     LEFT ALONE ON PURPOSE:
       · `manual` — the commissioner typed that number himself; a live line must not silently
         overwrite a deliberate choice.
       · `pickem` — PK is a decision to score the game straight up (see commish.html "if there is
         no line just make it a pick em"). A line appearing later does not undo it.
     Everything else is re-read: spreads take favAbbrev/line/spreadText, totals take the O/U. */
  function refreshLines(games, lines, stampedAt) {
    const moved = [], unpriced = [];
    for (const g of (games || [])) {
      if (g.manual || g.pickem) continue;
      const fresh = lines[String(g.id)] || lines[`${g.awayAbbrev}@${g.homeAbbrev}`];
      if (!fresh) { unpriced.push(g); continue; }
      const before = g.spreadText || null;
      if (g.market === 'total') {
        if (fresh.overUnder == null) { unpriced.push(g); continue; }
        g.total = fresh.overUnder;
        g.spreadText = 'O/U ' + fresh.overUnder;
      } else {
        if (fresh.line == null || !fresh.favAbbrev) { unpriced.push(g); continue; }
        g.favAbbrev = fresh.favAbbrev;
        g.line = fresh.line;
        g.spreadText = fresh.spreadText;
      }
      g.capturedAt = stampedAt;
      if (before !== g.spreadText) moved.push({ game: g.short, from: before, to: g.spreadText });
    }
    return { moved, unpriced };
  }

  try {
    if (req.method === 'GET') {
      // live-build check: curl "…/api/football-pool?ver=1" → must match the VER in the repo
      if (req.query.ver !== undefined) return res.status(200).json({ ver: VER });
      // list all weeks for a season (summaries only — no picks)
      if (req.query.list) {
        /* `?list=sandbox` addresses the sandbox season. Not a widening of the sandbox boundary —
           poolSlugFor() already resolves a sandbox- week to the sandbox pool — but without it this
           branch was UNREACHABLE for any test: the pattern is built from digits only, so no sandbox
           week could ever appear in a list, and the `full:` gate below (the side door onto a board
           being withheld from someone) could not be asserted at all. A branch nothing can reach is
           a branch nothing is checking. */
        const season = /^sandbox$/i.test(String(req.query.list))
          ? 'sandbox'
          : String(req.query.list).replace(/\D/g, '');
        /* ⛔ `${season}-w*` MADE THE ENTIRE PRESEASON INVISIBLE (found 2026-08-08 chasing Keith's
           phone screenshot). Preseason weeks are slugged `2026-pre1` — the commish page even
           offers that placeholder — but this pattern only matched `-w`, so `?list=` returned an
           EMPTY array while `2026-pre1` sat in the table. Every client reads its weeks from here:
           the board's week picker, the commissioner's week list, and currentWeek() on the picks
           page. So the built-and-waiting preseason slate could have been locked by Mike and the
           picks page would still have said "no open slate right now" — with no error anywhere,
           because an empty list is a legitimate answer. lock_reminder below already used
           `${season}-*`; that inconsistency is exactly why the Wednesday nudge could see a week
           no page could. One pattern, one place. */
        const r = await sb(`football_pools?slug=like.${season}-*&select=slug,data,updated_at&order=slug.asc`);
        const rows = await r.json();
        /* One roster for the whole list: loadRoster() resolves the POOL from the week slug, and
           every week of a season belongs to one pool. Loaded once so `full` can apply the same
           reveal rule as the single-week GET rather than a second, quietly different one. */
        const listRoster = rows.length ? await loadRoster(rows[0].slug) : [];
        return res.status(200).json(rows.map(({ slug, data, updated_at }) => ({
          slug, updated_at,
          label: data.label, slateLocked: !!data.slateLocked, deadline: data.deadline || null,
          finalized: !!data.finalized, weeklyWinner: data.weeklyWinner || null,
          games: (data.games || []).length,
          /* NAMES, NOT IDS. Since picks became person-keyed (2026-08-07) this returned raw UUIDs,
             so the commissioner's queue read "picked-in: 3160542a-0a31-44a3-…". Every entry
             already carries a display-name snapshot for exactly this reason — use it. */
          pickedBy: Object.entries(data.picks || {}).filter(([, v]) => v.locked).map(([k, v]) => v.name || k),
          savedBy: Object.entries(data.picks || {}).filter(([, v]) => !v.locked).map(([k, v]) => v.name || k),
          // full detail (incl. picks + results) only once the board is revealed — same rule as
          // the single-week GET: everyone locked in, or the deadline passed.
          /* Same rule as the single-week GET, and the list has no viewer to be identified — so
             while anyone is outstanding it carries no picks at all. Without this the season list
             is a side door onto the board a newcomer is being held out of. */
          full: (isRevealed(data, listRoster) && !outstandingFor(data, listRoster).length) ? data : null,
        })));
      }
      // players roster — id + name only, never pins/emails/phones
      if (req.query.players !== undefined) {
        /* This feeds the sign-in name list on /pool/football/picks, so it is PLAYERS only (061).
           Listing an observer here would offer him a name to pick under and then have save_picks
           403 him at the end of a filled-in card — the exact "first learn the PIN was wrong when
           save_picks 403'd" shape that verify_pin was added to remove. The commissioner's own
           view of the full roster, observers included, is `get_players_full`. */
        const roster = await loadRoster(req.query.week || '');
        return res.status(200).json({ players: playersOf(roster).map(p => ({ id: p.id, name: p.name })) });
      }
      // one week
      const slug = cleanSlug(req.query.week);
      if (!slug) return res.status(400).json({ error: 'week required' });
      const row = await getRow(slug);
      if (!row) return res.status(200).json({ slug, data: null });
      const wk = row.data;
      const roster = await loadRoster(slug);
      const name = String(req.query.name || '').toUpperCase();
      const pin = String(req.query.pin || '');
      const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
      /* ⛔ AN OPEN BOARD IS ANSWERED PER VIEWER (Keith 2026-08-19): "the newly added player should
         not be able to see everyone elses picks until they have picked, even though those picks
         have been revealed to existing player."
         Those two requirements cannot both be met by one global answer, so they stop being one
         answer. `boardOpen` is the week's own state and never goes backwards; what a given
         request is ALLOWED to see is decided per request. While anyone is still outstanding, only
         a viewer who has locked their own card gets the picks — and that includes an
         unidentified viewer, because the board is a public URL and a gate the newcomer can walk
         around by opening it signed-out is not a gate. The moment nobody is outstanding the board
         is public again, which is every ordinary week. */
      const boardOpen = isRevealed(wk, roster);
      const stillOut = outstandingFor(wk, roster);
      const meLocked = !!(me && wk.picks && wk.picks[me.id] && wk.picks[me.id].locked);
      const revealed = boardOpen && (!stillOut.length || meLocked);
      if (!revealed && wk.picks) {
        // pick privacy: only your own picks come back (name+pin); everyone else shows
        // locked-status only.
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
        /* Told apart deliberately, so a client can say WHY it is showing a locked board rather
           than implying the week never opened: boardOpen = the week is open, waitingOn = who we
           are still holding it from you for. */
        boardOpen, waitingOn: stillOut.map(p => p.name),
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

      /* ---- WEDNESDAY LOCK NUDGE (Keith 2026-08-08: "the platform should prompt Mike to lock the
         picks by Wed") ----
         Cron-triggered, not client-side: a reminder that only fires when the commissioner happens
         to have the page open is not a reminder. Cron-secret gated, same posture as every other
         scheduled job in the stack.
         It nudges on the two failure modes that actually happen: a week built but never locked, and
         no week built at all. Silent when there is nothing to chase — a job that pings every week
         regardless gets ignored, and then the one that matters gets ignored too. */
      /* ⏰ THE ET WINDOW IS CHECKED HERE, NOT IN CRON. The VM runs UTC, so `30 10 * * 4` is
         06:30 ET in summer and 05:30 ET after the November clock change — a reminder that
         silently drifts an hour is the same class of bug as the hand-converted kickoff times.
         Cron fires at BOTH candidate UTC hours and this guard lets exactly one through, so the
         schedule is correct on both sides of DST with nothing to remember. `force:true` is for
         verification. */
      const etWindow = (weekday, hour) => {
        const p = etParts(new Date());
        return p.weekday === weekday && p.hour === hour;
      };
      if (action === 'lock_reminder') {
        if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
          return res.status(401).json({ error: 'unauthorized' });
        }
        // Slate is due Thursday 09:30 ET → nudge at 06:30 ET, three hours out.
        if (!req.body.force && !etWindow('Thu', 6)) {
          return res.status(200).json({ nudged: false, reason: 'outside the Thu 06:30 ET window' });
        }
        const season = new Date().getFullYear();
        const lr = await sb(`football_pools?slug=like.${season}-*&select=slug,data&order=slug.desc`);
        const rows = lr.ok ? await lr.json() : [];
        const weeks = rows.filter(r => /^\d{4}-(w\d+|pre\d+|post\d+)$/.test(r.slug));
        const open = weeks.filter(w => !w.data?.finalized);
        const unlocked = open.filter(w => !w.data?.slateLocked);

        /* Retimed 2026-08-09 to 3 hours before the BUILD deadline (Thursday 09:30 ET), per Keith:
           "remind Mike 3 hours before slate is due via text if he has not already locked." The
           copy names the deadline, because a nudge that does not say when something is due is
           just noise. */
        let msg = null;
        if (unlocked.length) {
          const w = unlocked[0];
          const n = (w.data?.games || []).length;
          msg = `The Pool: ${w.data?.label || w.slug} is built (${n} game${n === 1 ? '' : 's'}) but NOT locked — it is due by 9:30 this morning. Lock it so the group can pick: app.civicscope.io/pool/commish`;
        } else if (!open.length) {
          msg = `The Pool: no week is built yet and the slate is due by 9:30 this morning. Build and lock it at app.civicscope.io/pool/commish`;
        }
        if (!msg) return res.status(200).json({ nudged: false, reason: 'a slate is already locked' });

        // Goes to the COMMISSIONER — the person who can actually act on it.
        const roster = await loadRoster('');
        const commish = roster.filter(p => p.role === 'commissioner' || p.globalRole === 'commissioner');
        let texted = 0, emailed = 0;
        for (const c of commish) {
          if (c.canText && await sendSms(c.phone, msg + '\nReply STOP to opt out.')) texted++;
          if (c.email && c.wantsEmail) {
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com',
                to: [c.email], subject: '🏈 Lock the slate — the group is waiting',
                html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#101828">
                  <p>${msg.replace('The Pool: ', '')}</p>
                  <p><a href="https://app.civicscope.io/pool/commish" style="background:#c8a24b;color:#1a1300;font-weight:800;padding:11px 20px;border-radius:9px;text-decoration:none">Open the commissioner page</a></p>
                  <p style="color:#667085;font-size:12px">Locking freezes the spreads and texts everyone their PIN.</p></div>`,
              }),
            });
            if (r.ok) emailed++;
          }
        }
        return res.status(200).json({ nudged: true, msg, commissioners: commish.length, texted, emailed });
      }

      /* ---- PICKS REMINDER (Keith 2026-08-09: "remind players to make picks 3 hours before the
         Saturday deadline if they have not already") ----
         Cron-triggered Saturday 07:00 ET. Chases ONLY the people who have not locked in, by name,
         and is silent when there is nobody to chase — the same discipline as the lock nudge: a
         message that arrives every week regardless teaches the group to ignore the one that
         matters. A player who has saved a draft but not locked IS chased, because an unlocked
         draft is not a submitted card in the new flow. */
      if (action === 'picks_reminder') {
        if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
          return res.status(401).json({ error: 'unauthorized' });
        }
        // Picks are due Saturday 10:00 ET → nudge at 07:00 ET, three hours out.
        if (!req.body.force && !etWindow('Sat', 7)) {
          return res.status(200).json({ nudged: false, reason: 'outside the Sat 07:00 ET window' });
        }
        const season = new Date().getFullYear();
        const pr = await sb(`football_pools?slug=like.${season}-*&select=slug,data&order=slug.desc`);
        const prRows = pr.ok ? await pr.json() : [];
        const candidates = prRows
          .filter(r => /^\d{4}-(w\d+|pre\d+|post\d+)$/.test(r.slug))
          .filter(r => r.data?.slateLocked && !r.data?.finalized && r.data?.deadline)
          .filter(r => Date.parse(r.data.deadline) > Date.now());
        if (!candidates.length) {
          return res.status(200).json({ nudged: false, reason: 'no locked week with a live deadline' });
        }
        // The one closing soonest is the one being played.
        candidates.sort((a, b) => Date.parse(a.data.deadline) - Date.parse(b.data.deadline));
        const wkRow = candidates[0], wk = wkRow.data;
        const roster = await loadRoster(wkRow.slug);
        /* Players only — nudging an observer to "make your picks" would be telling him to do the
           one thing save_picks refuses him, and it would hand him a PIN prompt for a card he
           cannot file. ⚠ Note for a later session: this still nudges a player the commissioner
           UNTICKED from the week, who is not in participantsOf() and whom allLocked() does not
           wait for. Pre-existing, out of scope here, and worth closing. */
        const outstanding = playersOf(roster).filter(p => !(wk.picks || {})[p.id]?.locked);
        if (!outstanding.length) {
          return res.status(200).json({ nudged: false, reason: 'everyone is already locked in', slug: wkRow.slug });
        }
        const when = new Date(wk.deadline).toLocaleString('en-US',
          { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
        const tag = (wk.isTest || isSandbox(wkRow.slug)) ? '[TEST — no action needed] ' : '';
        let texted = 0, emailed = 0;
        for (const p of outstanding) {
          const started = (wk.picks || {})[p.id];
          const line = started
            ? `your picks are SAVED but not locked in — lock them before ${when} ET or they don't count`
            : `you haven't made your picks yet — they're due ${when} ET`;
          if (p.canText) {
            if (await sendSms(p.phone, `${tag}The Pool: ${p.name.split(' ')[0]}, ${line}. `
              + `Your PIN: ${p.pin}. app.civicscope.io/pool/football/picks\nReply STOP to opt out.`)) texted++;
          }
          if (p.email && p.wantsEmail) {
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com',
                to: [p.email], subject: `${tag}⏰ ${wk.label || wkRow.slug} — picks due ${when} ET`,
                html: `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#101828">
                  <p>${p.name.split(' ')[0]}, ${line}.</p>
                  <p>Your PIN: <b>${p.pin}</b></p>
                  <p><a href="https://app.civicscope.io/pool/football/picks" style="background:#c8a24b;color:#1a1300;font-weight:800;padding:11px 20px;border-radius:9px;text-decoration:none">Make your picks</a></p>
                  <p style="color:#667085;font-size:12px">Locking is final — save without locking if you want to keep editing until the deadline.</p></div>`,
              }),
            });
            if (r.ok) emailed++;
          }
        }
        return res.status(200).json({
          nudged: true, slug: wkRow.slug, deadline: wk.deadline,
          outstanding: outstanding.map(p => p.name), texted, emailed,
        });
      }

      // ---- commissioner actions ----
      if (['save_players', 'get_players_full', 'list_people', 'save_week', 'lock_slate', 'finalize_week', 'notify_all_locked'].includes(action)) {
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
          const pr = await sb(`pools?slug=eq.${encodeURIComponent(poolSlug)}&select=id,name,sport`);
          const pool = pr.ok ? (await pr.json())[0] : null;
          if (!pool) return res.status(404).json({ error: `no pool '${poolSlug}'` });
          // Who is in the pool BEFORE this write — used to spot genuinely new members below.
          const beforeRes = await sb(`pool_memberships?pool_id=eq.${pool.id}&select=person_id`);
          const before = new Set(beforeRes.ok ? (await beforeRes.json()).map(m => m.person_id) : []);

          const incoming = (req.body.players || []).map(p => {
            const d = String(p.phone || '').replace(/\D/g, '');
            return {
              id: p.id || null,          // present for anyone already on the roster — see below
              name: String(p.name || '').toUpperCase().slice(0, 20),
              email: String(p.email || '').slice(0, 80) || null,
              phone: d.length === 11 && d[0] === '1' ? '+' + d : (d.length === 10 ? '+1' + d : null),
              pin: String(p.pin || ''),          // '' means "not supplied" — resolved below
              notify_email: p?.notify?.email !== false,
              notify_sms: p?.notify?.sms !== false,
              updated_at: new Date().toISOString(),
            };
          }).filter(p => p.name);

          /* ⛔ A BLANK PIN BOX USED TO REROLL A PIN THE MEMBER ALREADY HAD (Keith, 2026-08-16,
             re-adding BOB N). This line was `pin: String(p.pin || <random>)`, and a row typed by
             hand — or added by "+ Add existing", which sent no id — carried an empty PIN box. It
             then went through `pool_people?on_conflict=name_key` with `resolution=merge-duplicates`,
             so the freshly minted number was written straight over the real one. Bob's PIN 4169
             was texted to him on 2026-08-08 when he sent JOIN; the next save would have changed it
             underneath him, silently, and his existing text would have stopped working.

             A PIN is a CREDENTIAL THE MEMBER ALREADY HOLDS. It may only be minted for a person who
             does not exist yet. So: look up everyone this save touches, by id, by name_key and by
             phone — the same three handles the rest of this module matches people on — and keep
             what is on file. Only a genuinely unknown person gets a new number. */
          /* The whole table, deliberately — it holds the seven people in this crew and would hold
             tens at any plausible size. Filtering would mean interpolating names into a PostgREST
             `or=(...)`, and a member called "BOB N, JR" would break the query or silently match
             nothing, which fails in the direction that rerolls a PIN. Cheap and total beats clever
             and fragile here. */
          const seenPeople = await sb('pool_people?select=id,name_key,phone,pin');
          const known4 = seenPeople.ok ? await seenPeople.json() : [];
          const pinById = new Map(known4.map(r => [r.id, r.pin]));
          const pinByKey = new Map(known4.map(r => [r.name_key, r.pin]));
          const pinByPhone = new Map(known4.filter(r => r.phone).map(r => [r.phone, r.pin]));
          for (const p of incoming) {
            if (p.pin) continue;                                     // typed deliberately — honour it
            const held = (p.id && pinById.get(p.id))
              || pinByKey.get(p.name)
              || (p.phone && pinByPhone.get(p.phone));
            p.pin = String(held || Math.floor(1000 + Math.random() * 9000));
          }

          const cur = await loadRosterByPool(poolSlug);   // THIS pool, not the default one
          if (!req.body.confirmShrink && cur.length > 1 && incoming.length < cur.length) {
            return res.status(409).json({
              error: `refusing to shrink ${poolSlug} from ${cur.length} to ${incoming.length} participants`,
              hint: 'pass confirmShrink:true if that is genuinely intended',
              current: cur.map(p => p.name),
            });
          }

          /* ⛔ RENAMING WAS IMPOSSIBLE UNTIL 2026-08-08. Everything upserted on `name_key`, so
             editing someone's name stopped matching their existing row, tried to INSERT a second
             person, and died on the unique phone — reported as "that mobile is already on file for
             BRANDON", which is true, unhelpful, and describes the person you were editing.
             Existing people are now updated BY ID (the client already has it from
             get_players_full), so a rename is just a rename. Only genuinely new rows — the ones
             with no id — go through the name_key upsert. */
          const known = incoming.filter(p => p.id);
          const fresh = incoming.filter(p => !p.id).map(({ id, ...rest }) => rest);
          const people = [];
          for (const p of known) {
            const { id, ...fields } = p;
            const r = await sb(`pool_people?id=eq.${id}`, {
              method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(fields),
            });
            if (!r.ok) {
              const raw = await r.text();
              if (/23505/.test(raw) && /name_key/i.test(raw)) {
                return res.status(409).json({
                  error: `Another member is already called "${p.name}".`,
                  hint: 'Names are unique across every pool — that is what keeps history attached to the right person. Pick a different one.',
                });
              }
              if (/23505/.test(raw) && /phone/i.test(raw)) {
                return res.status(409).json({
                  error: `That mobile already belongs to a different member.`,
                  hint: 'A mobile can only belong to one person — it is how a JOIN text is matched back.',
                });
              }
              return res.status(500).json({ error: 'Could not save the roster. Nothing was changed.' });
            }
            people.push((await r.json())[0]);
          }
          const up = fresh.length ? await sb('pool_people?on_conflict=name_key', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(fresh),
          }) : { ok: true, json: async () => [] };
          if (!up.ok) {
            /* Never leak raw Postgres at a commissioner. A 23505 here is not a fault — it is the
               identity guarantee doing its job, and it has a specific, actionable meaning:
               PHONE IS UNIQUE BECAUSE IT IS THE IDENTITY KEY. An inbound JOIN carries nothing but
               the number, so two people sharing one would make the marry-back ambiguous. Say who
               already owns it and what to do about it. */
            const raw = await up.text();
            if (/23505/.test(raw) && /phone/i.test(raw)) {
              const num = (raw.match(/\(phone\)=\(([^)]+)\)/) || [])[1] || '';
              let owner = '';
              if (num) {
                const o = await sb(`pool_people?phone=eq.${encodeURIComponent(num)}&select=name`);
                if (o.ok) owner = ((await o.json())[0] || {}).name || '';
              }
              return res.status(409).json({
                error: `${num || 'That mobile'} is already on file for ${owner || 'another member'}.`,
                hint: owner
                  ? `A mobile can only belong to one person — it is how a JOIN text is matched back. Use "+ Add existing" to put ${owner} in this pool, or give this new member a different number.`
                  : 'A mobile can only belong to one person — it is how a JOIN text is matched back.',
                conflictWith: owner || null,
              });
            }
            if (/23505/.test(raw) && /name_key/i.test(raw)) {
              return res.status(409).json({
                error: 'Two members on this roster normalise to the same name.',
                hint: 'Names must be unique across the whole Pool, not just this competition — that is what keeps history attached to the right person. Use "+ Add existing" to reuse someone who already exists.',
              });
            }
            return res.status(500).json({ error: 'Could not save the roster. Nothing was changed.' });
          }
          // `people` already holds the id-updated rows; append the newly-created ones.
          people.push(...(await up.json()));
          const keep = people.map(p => p.id);

          await sb(`pool_memberships?pool_id=eq.${pool.id}&person_id=not.in.(${keep.join(',')})`, { method: 'DELETE' });
          /* ⛔ THIS USED TO RECOMPUTE EVERY ROLE ON EVERY SAVE, AND THAT SILENTLY UNDID 'observer'.
             The line was `role: p.global_role === 'commissioner' ? 'commissioner' : 'participant'`
             — derived purely from the person's GLOBAL role, so any per-pool role was overwritten
             the next time the commissioner touched the roster for an unrelated reason. An observer
             would have become a full player with no announcement: scored, charged the weekly $50
             and rendered as a column, discovered only by someone noticing an extra name on the
             board. A per-pool fact must not be rebuilt from a global one.
             The existing role is now carried forward, and derivation only fills in someone who has
             no membership yet. `incomingRole` lets the commissioner change it deliberately from
             /pool/commish, which is the only way it should ever move. */
          const roleNow = new Map(cur.map(p => [String(p.id), p.role]));
          const roleWanted = new Map((req.body.players || [])
            .filter(p => p.id && (p.role === 'observer' || p.role === 'participant'))
            .map(p => [String(p.id), p.role]));
          await sb('pool_memberships?on_conflict=pool_id,person_id', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(people.map(p => {
              const held = roleNow.get(String(p.id));
              // The commissioner never demotes himself by editing the roster.
              const role = held === 'commissioner' || p.global_role === 'commissioner'
                ? 'commissioner'
                : (roleWanted.get(String(p.id)) || held || 'participant');
              return { pool_id: pool.id, person_id: p.id, role };
            })),
          });
          /* CONSENT IS PER PERSON AND PERMANENT — never ask twice (Keith 2026-08-07).
             Once someone has opted in, being added to a LATER pool is not a new consent event; it
             is a notification. So a newly-added member who already has consent simply gets told
             they're in, with a link to that pool. Somebody who has never opted in gets nothing —
             adding them to a pool must never become a backdoor to texting them, which is exactly
             the forced-consent shape that A2P rejection 30923 was about.
             This is also why consent lives on pool_people and not on the membership. */
          const added = people.filter(p => !before.has(p.id));
          let notified = 0;
          if (added.length) {
            const link = pool.sport === 'golf'
              ? 'app.civicscope.io/pool/golf'
              : 'app.civicscope.io/pool/football';
            for (const p of added) {
              const canText = p.sms_consent === true && p.sms_opted_out !== true
                           && !!p.phone && p.notify_sms !== false;
              if (!canText) continue;
              const ok = await sendSms(p.phone,
                `The Pool: you're in ${pool.name}. Picks and standings: ${link}\nReply STOP to opt out.`);
              if (ok) notified++;
            }
          }
          return res.status(200).json({
            poolSlug, players: await loadRosterByPool(poolSlug),
            addedCount: added.length, notified,
          });
        }
        /* People outlive pools, so adding a participant should usually mean REUSING one — that is
           the whole point of "a participant may be in multiple pools, past and future". Without
           this the only way to add someone is to retype them, which collides on the unique name or
           phone and looks like a bug (it did, 2026-08-07). */
        if (action === 'list_people') {
          const poolSlug = String(req.body.poolSlug || 'football-2026');
          const pr = await sb(`pools?slug=eq.${encodeURIComponent(poolSlug)}&select=id`);
          const pool = pr.ok ? (await pr.json())[0] : null;
          const all = await sb('pool_people?select=id,name,phone,email,global_role&order=name');
          const mem = pool ? await sb(`pool_memberships?pool_id=eq.${pool.id}&select=person_id`) : null;
          const inPool = new Set(mem && mem.ok ? (await mem.json()).map(m => m.person_id) : []);
          return res.status(200).json({
            people: (all.ok ? await all.json() : []).map(p => ({
              id: p.id, name: p.name, phone: p.phone || '', email: p.email || '',
              globalRole: p.global_role, inPool: inPool.has(p.id),
            })),
          });
        }
        if (action === 'get_players_full') {
          const poolSlug = String(req.body.poolSlug || 'football-2026');
          return res.status(200).json({
            poolSlug,
            players: (await loadRosterByPool(poolSlug)).map(p => ({
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
          /* ⛔ A SAVE MUST NOT BE ABLE TO DESTROY A SLATE (2026-08-09).
             `2026-pre1` — 16 hand-built preseason games — was replaced with `games: []` by a
             single "Save draft" click from a commissioner page whose in-memory slate was empty
             (a reloaded tab, a second tab, a slug typed before the week was opened). The write
             was perfectly valid, returned 200, and there is no undo: the games existed only in
             that row. Same family as the 2026-08-07 roster overwrite, and the same answer —
             a full replace that SHRINKS a shared record has to be asked for explicitly.
             An empty save is refused with the count it would have destroyed; `confirmWipe: true`
             is the deliberate path (clearing a week you actually mean to clear). */
          const hadGames = Array.isArray(existing.games) ? existing.games.length : 0;
          const nowGames = Array.isArray(data.games) ? data.games.length : 0;
          if (hadGames > 0 && nowGames === 0 && !req.body.confirmWipe) {
            return res.status(409).json({
              error: `refusing to erase ${hadGames} game${hadGames === 1 ? '' : 's'} from ${slug}`,
              hint: 'The editor is empty but this week has a slate saved. Open the week first (§4 "Needs your attention" → open), or pass confirmWipe to clear it deliberately.',
              games: hadGames,
            });
          }
          await putRow(slug, data);
          return res.status(200).json({ slug, ok: true, games: nowGames });
        }
        if (action === 'lock_slate') {
          const slug = cleanSlug(req.body.slug);
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          /* ⛔ LOCKING TWICE RE-TEXTS THE WHOLE GROUP (Keith 2026-08-09: "we need to fix allowing
             the commissioner to have the lock slate freeze button available after he has done
             that for the week"). The button stayed live because §3 only knows the slate is locked
             once the week has been OPENED — on a fresh page it reads unlocked. But the real cost
             was here: a second lock re-froze the spreads, recomputed the deadline and sent every
             player a second "slate is locked, here is your PIN" text. Refuse it. */
          if (wk.slateLocked && !req.body.relock) {
            return res.status(409).json({
              error: `${wk.label || slug} is already locked`,
              hint: 'Locking again would re-freeze the spreads and text everyone a second time. Open the week to view it, or finalize it once every game is final.',
              deadline: wk.deadline || null,
              lockedAt: wk.lockedAt || null,
            });
          }
          if (!(wk.games || []).length) return res.status(400).json({ error: 'no games in slate' });
          /* RE-PULL THE LINES BEFORE ANYTHING ELSE LOOKS AT THEM (Keith 2026-08-30). This runs
             ahead of the validation below on purpose: a game saved days ago with no line may well
             be priced by now, and validating the stale copy would reject a slate that is actually
             fine. It also runs ahead of the notification build, so the locked-slate email and text
             carry the numbers the week actually locked at — they read wk.games. */
          const lockStamp = new Date().toISOString();
          const fetched = await fetchLines(wk.games);
          const { moved, unpriced } = refreshLines(wk.games, fetched.lines, lockStamp);
          /* ⛔ "NOT ON ESPN" AND "ESPN DID NOT ANSWER" ARE DIFFERENT, AND CONFLATING THEM BROKE THE
             LOCK (caught by the pool-integrity gate on the first deploy of this change, 2026-08-30).
             The first version refused whenever any game came back unrefreshed — which is every
             hand-built game (`pre1-DET-CIN`, and the whole 16-game Preseason Week 1), every
             preseason fixture ESPN carries with no odds, and every sandbox slate the gate builds.
             A game ESPN does not price cannot be re-priced by anybody, so blocking the lock helps
             nobody: it holds its saved number and is REPORTED, exactly like a manual spread.
             What genuinely warrants a refusal is the other case — ESPN did not answer at all, so
             the live numbers for games that DO have them were never read, and locking now would
             silently freeze stale ones. That is what `notes` records. */
          const fetchFailed = fetched.notes.length > 0 && wk.games.some(g => !g.manual && !g.pickem);
          if (fetchFailed && !req.body.acceptStale) {
            return res.status(409).json({
              error: 'could not reach the live odds feed, so the spreads on this slate were not re-checked',
              hint: 'Locking now would freeze whatever was saved earlier, which may be out of date. Try again in a minute — or lock anyway if you know the saved numbers are the ones you want.',
              notes: fetched.notes,
              holding: wk.games.filter(g => !g.manual && !g.pickem).map(g => ({ game: g.short, holding: g.spreadText || null })),
              acceptStale: true,
            });
          }
          wk.linesRefreshedAt = lockStamp;
          /* Every game must carry a scoreable market: a spread, a pick'em, or a total. */
          const noTotal = wk.games.filter(g => g.market === 'total' && !(typeof g.total === 'number' && isFinite(g.total)));
          if (noTotal.length) return res.status(400).json({
            error: 'these over/under games have no number set: ' + noTotal.map(g => g.short).join(', '),
            hint: 'Type the total (e.g. 44.5) in the O/U box, or remove the entry.',
          });
          const noLine = wk.games.filter(g => g.market !== 'total' && !g.pickem && (g.line == null || !g.favAbbrev));
          if (noLine.length) return res.status(400).json({
            error: 'these games have no spread and are not marked pick’em: ' + noLine.map(g => g.short).join(', '),
            hint: 'Set a spread, or tap PK to score it straight up.',
          });
          /* Two entries for the same fixture is the POINT (spread + total), but two entries for
             the same MARKET is a mistake that would double-count one result. */
          const seen = new Set(), dupes = [];
          for (const g of wk.games) {
            const k = `${g.awayAbbrev}@${g.homeAbbrev}|${g.market === 'total' ? 'total' : 'spread'}`;
            if (seen.has(k)) dupes.push(g.short); else seen.add(k);
          }
          if (dupes.length) return res.status(400).json({
            error: 'the same game is on the slate twice for the same market: ' + dupes.join(', '),
            hint: 'A fixture can appear once against the spread AND once as an over/under — but not twice for either.',
          });
          /* ⛔ SNAPSHOT WHO IS IN THIS WEEK (2026-08-25). See participantsOf() above for why the
             live roster is the wrong set. Default = everyone, so this changes nothing on its own;
             the commissioner narrows it by passing `participants: [<id>, …]` from the lock screen,
             which is the one moment he is already looking at the week and the roster together.
             Ids are validated against the real roster — an unknown id is dropped rather than
             stored, so a stale browser cannot write a participant who does not exist. */
          {
            // Observers are never in the snapshot — they cannot pick, so a week that waited on
            // one would never declare itself open. See participantsOf() and migration 061.
            const rosterNow = playersOf(await loadRoster(slug));
            let chosen = rosterNow;
            if (Array.isArray(req.body.participants)) {
              const want = new Set(req.body.participants.map(String));
              chosen = rosterNow.filter(p => want.has(String(p.id)));
              if (!chosen.length) return res.status(400).json({
                error: 'no players selected for this week',
                hint: 'Tick at least one player. Leave the list alone entirely to include everyone.',
              });
            }
            wk.participants = chosen.map(p => p.id);
          }
          wk.slateLocked = true;
          wk.lockedAt = new Date().toISOString();
          /* Picks close Saturday 10:00 ET — unless a game kicks off before that, in which case
             the earlier kickoff wins. See deadlineFor(). Both the value and WHY are stored, so
             the pages and the reminder job never have to re-derive it. */
          const dl = deadlineFor(wk.games);
          wk.deadline = dl.deadline.toISOString();
          wk.deadlineReason = dl.reason;                      // 'schedule' | 'kickoff'
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
            /* A TEST NOTIFICATION MUST ANNOUNCE ITSELF (2026-08-09). Verifying that lock really
               texts meant sending Keith a real text — and it read exactly like a live one, so it
               landed as "I didn't lock anything, why am I being told a slate is locked?" The
               message is the only thing the recipient sees; a sandbox slug and an isTest flag are
               invisible from a phone. Any week marked isTest, and every sandbox- slug by
               construction, now says TEST in the first characters of the SMS and the subject
               line. Cheap, and it removes a whole class of false alarm. */
            const isTest = !!wk.isTest || isSandbox(slug);
            const tag = isTest ? '[TEST — no action needed] ' : '';
            const gameRows = slateOrder(wk.games).map(g =>
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
                body: JSON.stringify({ from: 'The Football Pool <pool@civicscope.io>', reply_to: 'keith@anchoradvisorsnorth.com', to: [p.email], subject: `${tag}🏈 ${wk.label || slug} slate is locked — picks due before first kickoff`, html }),
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
                  `${tag}The Pool: ${wk.label || slug} slate is locked. Picks close ${when} ET. `
                  + `Your PIN: ${p.pin}. ${base}/picks\nLive all weekend: app.civicscope.io/pool/live\nReply STOP to opt out.`);
                if (ok) texted++;
              }
            }
          }
          return res.status(200).json({
            slug, locked: true, deadline: wk.deadline, deadlineReason: wk.deadlineReason, emailed, texted,
            /* What the re-pull changed. The commissioner has just frozen the week for everybody;
               if a line moved between his draft and this moment he should see it here rather than
               discover it on the board. Empty array = the saved numbers were already current. */
            linesRefreshedAt: wk.linesRefreshedAt, movedLines: moved,
            ...(unpriced.length ? { heldAtSaved: unpriced.map(g => g.short) } : {}),
            /* Say it out loud when the Saturday cadence did NOT apply. A commissioner who expects
               "picks due Saturday 10am" and gets Thursday evening needs to be told which game
               pulled it in, not left to notice later. */
            ...(wk.deadlineReason === 'kickoff' ? {
              note: `picks close at first kickoff (${(wk.games || []).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0]?.short || 'first game'}), which is EARLIER than the usual Saturday 10:00 ET`,
            } : {}),
          });
        }
        /* THE SERVER DECIDES THE WINNER (Codex finding #3 — Confirmed/High).
           This used to take `weeklyWinner` as free text from the commissioner and the season
           table counted that string — so a typo, a stale browser calculation, or a crafted
           request permanently credited the wrong person. The winner is now derived from the
           frozen picks and the frozen lines; a client-supplied winner is ignored and reported
           back if it disagrees. Scores are PERSISTED so the board no longer depends on ESPN
           keeping the history around. */
        /* RE-SEND THE ALL-PICKS-IN NOTICE. The trigger is a one-shot on the last player's lock, so
           a notice that failed — or that fired from a build which could not yet send it, as on
           2026-08-09 — has no second chance: nobody locks twice. This is that second chance, and
           it is the ONLY way to recover one. Refuses unless the board is genuinely open (everyone
           locked, or the deadline has passed), because the message states that every card is now
           visible; sending it early would be false AND would leak that picks are readable when
           they are not. Reports both channel counts rather than claiming success. */
        if (action === 'notify_all_locked') {
          const slug = cleanSlug(req.body.slug);
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          const roster = await loadRoster(slug);
          if (!isRevealed(wk, roster)) {
            return res.status(400).json({
              error: 'the board is not open yet — not everyone is locked in and the deadline has not passed',
              hint: 'this notice tells the group every card is visible; it must not go out before that is true',
            });
          }
          const told = await notifyAllLocked(wk, slug, roster);
          wk.notifiedAllLocked = true;
          wk.allLockedNotice = { ...told, at: new Date().toISOString(), manual: true };
          await putRow(slug, wk);
          return res.status(200).json({ slug, ...told, reachable: roster.filter(p => p.canText).length });
        }

        if (action === 'finalize_week') {
          const slug = cleanSlug(req.body.slug);
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          /* ⛔ THIS ACTION COULD NOT BE CALLED FROM THE COMMISSIONER PAGE AT ALL (found 2026-08-13).
             commish.html posted `finalize_week` with a prompted winner and NO `results`, and no
             week has ever carried `wk.results` before it is finalized — so the 🏆 button 400'd
             every time it was pressed, on "final scores required to finalize", which reads as
             though the commissioner failed to supply something he was never asked for.
             The scores were never his to supply: the browser cannot reach ESPN from our network,
             which is the whole reason fetchFinals() runs server-side. `fetch:true` lets the one
             remaining manual path read them the same way auto_finalize does — same host, same
             parser, same completeness rule — so the escape hatch and the cron cannot disagree
             about what "final" means. A caller-supplied `results` still works, unchanged. */
          let results = req.body.results || wk.results;
          let fetchNotes = null;
          if (req.body.fetch === true) {
            const got = await fetchFinals(wk.games || []);
            results = got.scores;
            fetchNotes = got.notes;
            const unfinished = (wk.games || []).filter(g => {
              const sc = resultFor(g, results);
              return !sc || sc.state !== 'post' || sc.homeScore == null || sc.awayScore == null;
            });
            if (unfinished.length) {
              return res.status(400).json({
                error: `not every game is final yet: ${unfinished.map(g => g.short || g.id).join(', ')}`,
                hint: 'the hourly auto-finalizer will score this week as soon as the last game ends — there is nothing to do',
                notes: fetchNotes,
              });
            }
          }
          if (!results || !Object.keys(results).length) {
            return res.status(400).json({
              error: 'final scores required to finalize',
              hint: 'pass fetch:true to have the server read the finals from ESPN itself',
            });
          }
          /* Resolve through the SAME three-way lookup the scoring uses. Checking `results[g.id]`
             directly meant an over/under entry (`<id>#ou`) always looked unscored, so a slate
             carrying both markets could never be finalized at all. */
          const missing = (wk.games || []).filter(g => {
            const sc = resultFor(g, results);
            return !sc || sc.homeScore == null || sc.awayScore == null;
          });
          if (missing.length) {
            return res.status(400).json({ error: `not every game has a final score (${missing.map(g => g.short || g.id).join(', ')})` });
          }
          const claimed = req.body.weeklyWinner || null;
          const { scored, announce, told } = await applyFinalize(slug, wk, results, req.body.notify === true);
          return res.status(200).json({
            slug, finalized: true, weeklyWinner: wk.weeklyWinner, points: scored.points, announced: announce, ...told,
            ...(fetchNotes && fetchNotes.length ? { notes: fetchNotes } : {}),
            ...(claimed && claimed !== scored.winner
              ? { note: `ignored the submitted winner "${claimed}" — the frozen picks and lines score to "${scored.winner}"` }
              : {}),
          });
        }
      }

      /* ---- AUTO-FINALIZE (cron) — the commissioner's week ends at the lock -------------
         Finds every locked, unfinalized week whose deadline has passed, reads the finals itself,
         and finalizes any week where EVERY game is complete. Silent otherwise: a week with a game
         still in progress is not an error, it is simply not finished, and a job that reports a
         problem every hour teaches everyone to ignore it.
         Same cron gate as the two reminder actions. It cannot be driven from a browser, and it
         accepts no scores and no winner from the caller — see fetchFinals(). */
      if (action === 'auto_finalize') {
        if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
          return res.status(403).json({ error: 'forbidden' });
        }
        const season = String(req.body.season || new Date().getFullYear());
        const r = await sb(`football_pools?slug=like.${season}-*&select=slug,data&order=slug.asc`);
        const rows = (await r.json()) || [];
        const due = rows.filter(x => x.data && x.data.slateLocked && !x.data.finalized
          && x.data.deadline && Date.parse(x.data.deadline) < Date.now());

        /* READ-ONLY PROBE. Whether THIS runtime can reach ESPN is the single assumption the whole
           feature rests on, and a run that finds nothing due never exercises it — so the first
           real test would be the night it matters. `probe:true` reports what fetchFinals() sees
           for the latest locked week and writes NOTHING. */
        if (req.body.probe === true) {
          const target = rows.filter(x => x.data && x.data.slateLocked)
            .sort((a, b) => (a.slug < b.slug ? 1 : -1))[0] || rows[rows.length - 1];
          if (!target) return res.status(200).json({ probe: true, reason: 'no weeks exist' });
          const games = target.data.games || [];
          const found = await fetchFinals(games);
          return res.status(200).json({
            probe: true,
            slug: target.slug,
            games: games.length,
            reachedEspn: Object.keys(found.scores).length > 0,
            scoreKeys: Object.keys(found.scores).length,
            fetchNotes: found.notes,
            perGame: games.map((g) => {
              const sc = resultFor(g, found.scores);
              return {
                game: g.short || g.id,
                league: g.league,
                state: sc ? sc.state || null : null,
                score: sc ? String(sc.awayScore) + '-' + String(sc.homeScore) : null,
              };
            }),
          });
        }

        if (!due.length) return res.status(200).json({ finalized: [], reason: 'no locked week past its deadline is awaiting finalizing' });

        const done = [], waiting = [];
        for (const row of due) {
          const wk = row.data;
          const { scores, notes } = await fetchFinals(wk.games || []);
          /* EVERY game must be complete. A partially-final week must not score — the winner would
             be computed off games that have not happened. `state === 'post'` is ESPN's own
             completion flag; resultFor() does the id -> base-id -> matchup resolution so an
             over/under entry finds its fixture's score. */
          const unfinished = (wk.games || []).filter(g => {
            const sc = resultFor(g, scores);
            return !sc || sc.state !== 'post' || sc.homeScore == null || sc.awayScore == null;
          });
          if (unfinished.length) {
            waiting.push({ slug: row.slug, remaining: unfinished.map(g => g.short || g.id), notes });
            continue;
          }
          const { scored, announce, told } = await applyFinalize(row.slug, wk, scores, false);
          done.push({ slug: row.slug, weeklyWinner: scored.winner, announced: announce, ...told });
        }
        return res.status(200).json({ finalized: done, waiting });
      }

      /* ---- player action: change your OWN pin ----
         Keith 2026-08-08: "we need to let the player set their pin if that is going to be our
         authentication method." Correct — a credential only the commissioner can set is not the
         player's credential, and today the only way to change one is to ask Mike, who can then
         read it. Authenticates with the CURRENT pin, so this is a change-password flow, not a
         reset: knowing the old one is the proof. */
      if (action === 'set_pin') {
        const name = String(req.body.name || '').toUpperCase();
        const pin = String(req.body.pin || '');
        const next = String(req.body.newPin || '').trim();
        if (!/^\d{4}$/.test(next)) return res.status(400).json({ error: 'new PIN must be exactly 4 digits' });
        if (/^(\d)\1{3}$/.test(next) || next === '1234' || next === '0000') {
          return res.status(400).json({ error: 'pick something less guessable than that' });
        }
        const roster = await loadRoster(req.body.slug || '');
        const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        if (!me) return res.status(403).json({ error: 'bad name or PIN' });
        if (next === pin) return res.status(200).json({ ok: true, unchanged: true });
        const r = await sb(`pool_people?id=eq.${me.id}`, {
          method: 'PATCH', body: JSON.stringify({ pin: next, updated_at: new Date().toISOString() }),
        });
        if (!r.ok) return res.status(500).json({ error: 'could not change your PIN' });
        return res.status(200).json({ ok: true });
      }

      /* ---- player action: prove who you are, with NO week required ----
         2026-08-08, from Keith's phone. The picks page only ever checked a PIN as a side effect of
         loading a locked week, so between weeks — which is most of the time, and exactly when
         someone taps their JOIN link — signing in did nothing at all: no check, no error, no
         session. Worse, when a week WAS open a wrong PIN was only caught if you already had a
         picks entry to be masked; a first-time player could type anything, make a full card, and
         first learn the PIN was wrong when save_picks 403'd at the end.
         Sign-in is now its own question with its own answer. Returns identity only — never the
         pin, email or phone. Brute-force exposure is unchanged in kind: save_picks, set_pin and
         the GET reveal already accept an unthrottled name+pin. A 4-digit unthrottled credential is
         Codex finding #6 and is answered by phone-first login, not by hiding this endpoint. */
      if (action === 'verify_pin') {
        const name = String(req.body.name || '').toUpperCase();
        const pin = String(req.body.pin || '');
        const roster = await loadRoster(req.body.slug || '');
        const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        if (!me) return res.status(403).json({ error: 'bad name or PIN' });
        return res.status(200).json({ ok: true, id: me.id, name: me.name, role: me.role || 'participant' });
      }

      // ---- player action ----
      if (action === 'save_picks') {
        const slug = cleanSlug(req.body.slug);
        const name = String(req.body.name || '').toUpperCase();
        const pin = String(req.body.pin || '');
        const roster = await loadRoster(slug);
        const me = roster.find(p => p.name.toUpperCase() === name && String(p.pin) === pin);
        if (!me) return res.status(403).json({ error: 'bad name or PIN' });
        /* ⛔ AN OBSERVER CANNOT PICK, AND THIS IS THE ONLY PLACE THAT CAN STOP HIM (061).
           Everything downstream is permissive by design: the block below JOINS a picker to the
           week, the ledger prices a week from whoever holds a card, and the board renders whatever
           sits in wk.picks. So one accepted card would put a non-player into the participant
           snapshot, onto the board and into the money — quietly, and correctly according to every
           rule after this line. It has to be refused here, where the role is known. */
        if (me.isPlayer === false) {
          return res.status(403).json({
            error: 'you are set up for notifications only, not as a player in this pool',
            hint: 'The commissioner can switch you to a player on /pool/commish if you want to pick.',
          });
        }
        /* Read → modify → CONDITIONAL write, retried on contention. Only this member's entry
           is touched; if anyone else's save landed in between, the write is rejected and we
           start over from their revision instead of overwriting it. */
        let fireNotify = false, saved = null, picks = {};
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          const row = await getRow(slug);
          if (!row) return res.status(404).json({ error: 'week not found' });
          const wk = row.data;
          if (!wk.slateLocked) return res.status(400).json({ error: 'slate not locked yet' });
          if (pastDeadline(wk)) return res.status(400).json({ error: 'picks are closed for this week' });
          wk.picks = wk.picks || {};
          /* ⛔ PICKING JOINS YOU TO THE WEEK (2026-08-25). A member who is not in this week's
             participant snapshot — because the commissioner left them out, or because they were
             ADDED to the pool after the slate was locked (Keith 2026-08-19) — is still allowed to
             pick, and doing so puts them in the week.

             That is what keeps the 08-19 rule working. If a newcomer could pick WITHOUT joining
             the participant list, they would never count as outstanding, so the board would read
             as "nobody left to protect a pick from" and open to them before they had filled a
             card in — the exact bug 08-19 fixed, reintroduced through the back door. Joining here
             makes them outstanding until they lock, which masks the board from them and from an
             unidentified viewer, and leaves it open for everyone who already locked.

             It also makes a wrong exclusion harmless: if the commissioner unticks someone who did
             want to play, they simply pick and are counted. The snapshot is a default, never a
             lock-out. */
          if (Array.isArray(wk.participants) && !wk.participants.map(String).includes(String(me.id))) {
            wk.participants = wk.participants.concat([me.id]);
          }
          const mine = wk.picks[me.id] || {};
          /* ⛔ LOCKING IS FINAL (Keith 2026-08-09): "they can save — meaning they can edit before
             the deadline — or save and lock in one swoop, in which case they cannot."
             So there is no unlock path any more, for anyone. This also retires the reason the
             all-locked reveal had to be removed (Codex #2): a lock that can be undone is not a
             lock, and it was the undo that made an early reveal exploitable. A player who wants
             to keep editing simply saves without locking. */
          if (mine.locked) {
            return res.status(400).json({
              error: 'your picks are locked in and cannot be changed',
              hint: 'Locking is final. Save without locking if you want to keep editing until the deadline.',
            });
          }

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
            // An over/under entry is picked OVER or UNDER; a spread entry, one of the two teams.
            const legal = g.market === 'total'
              ? (s === 'OVER' || s === 'UNDER')
              : (s === String(g.homeAbbrev).toUpperCase() || s === String(g.awayAbbrev).toUpperCase());
            if (!legal) {
              badSides.push(`${g.short || gid}: "${side}"`);
              continue;
            }
            picks[gid] = s;
          }
          if (badSides.length) {
            return res.status(400).json({ error: `each pick must be one of the two teams, or OVER/UNDER on a total — ${badSides.join('; ')}` });
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
          if (req.body.lock && allLocked(wk, roster)) {
            /* THE REVEAL LATCH. Separate from notifiedAllLocked on purpose: that flag is about a
               message and is deliberately RELEASED when the message reaches nobody (2026-08-13),
               and the board opening must not be undone by a failed text. */
            if (!wk.revealedAt) wk.revealedAt = new Date().toISOString();
            if (!wk.notifiedAllLocked) { wk.notifiedAllLocked = true; fireNotify = true; }
          }
          saved = await putRowCAS(slug, wk, row.updated_at);
        }
        if (!saved) return res.status(409).json({ error: 'another save landed at the same moment — try again' });
        let told = null;
        if (fireNotify) {
          told = await notifyAllLocked(saved.data, slug, roster);
          /* Record what actually went out, and RELEASE THE LATCH if nothing did. The pre-latch
             stops two concurrent locks both announcing; it must not turn a total failure into a
             permanent one. A best-effort write — the player's picks are already safely saved and
             must never be risked for a bookkeeping update. */
          try {
            const after = await getRow(slug);
            if (after && after.data) {
              after.data.allLockedNotice = { ...told, at: new Date().toISOString() };
              if (!told.texted && !told.emailed) after.data.notifiedAllLocked = false;
              await putRow(slug, after.data);
            }
          } catch (e) { /* the picks are saved; this is bookkeeping */ }
        }
        return res.status(200).json({ ok: true, locked: !!req.body.lock, count: Object.keys(picks).length, allLocked: fireNotify, ...(told ? { told } : {}) });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}


