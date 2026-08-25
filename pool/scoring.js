/* pool/scoring.js — THE ONE CLIENT-SIDE COPY OF THE POOL'S SCORING RULES.
 *
 * Why this file exists (2026-08-09): the rule already lives in two places by necessity — the
 * server persists the score (api/football-pool.js scoreWeek/coverOf) and the browser recomputes it
 * live from ESPN, because ESPN 403s every server-side request from our network. Two copies is the
 * unavoidable minimum, and the codebase has warned for weeks that if they ever disagree "the board
 * silently lies about who won the week". Adding a live tracker page would have made it THREE.
 *
 * So both browser pages — the full board (football.html) and the bookmarkable live tracker
 * (live.html) — load this. Any change here must be mirrored in api/football-pool.js, and nowhere
 * else.
 *
 * THE RULES
 *   spread : the favourite must win by MORE than the line; exactly on it is a push
 *   pickem : no line, highest score wins; a tie is a push
 *   total  : combined score over/under the number; exactly on it is a push
 *   scoring: 1 point per correct pick. A PUSH IS WORTH ZERO (Keith 2026-08-09; it was ½ before).
 *   winner : most games won. Ties share the crown.
 *
 * A fixture may appear TWICE on one slate — once against the spread and once as a total. They are
 * separate entries with separate ids (`<id>` and `<id>#ou`) and they score independently.
 */
const POOL_SB = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  cfb: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
};

function datesParam(games) {
  const ds = games.map(g => new Date(g.date));
  const f = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const min = new Date(Math.min(...ds)), max = new Date(Math.max(...ds));
  min.setDate(min.getDate() - 1); max.setDate(max.getDate() + 2);
  return f(min) + '-' + f(max);
}

async function liveScores(games) {
  const out = {};
  for (const lg of ['nfl', 'cfb']) {
    if (!games.some(g => g.league === lg)) continue;
    try {
      const j = await (await fetch(POOL_SB[lg] + '?dates=' + datesParam(games.filter(g => g.league === lg)) + (lg === 'cfb' ? '&groups=80' : ''), { cache: 'no-store' })).json();
      for (const e of (j.events || [])) {
        const c = e.competitions[0];
        const home = c.competitors.find(x => x.homeAway === 'home'), away = c.competitors.find(x => x.homeAway === 'away');
        const sc = {
          homeScore: Number(home.score || 0), awayScore: Number(away.score || 0),
          state: c.status && c.status.type ? c.status.type.state : undefined,
          detail: (c.status && c.status.type && c.status.type.shortDetail) || '',
          /* ESPN's OWN kickoff, in ms. Carried purely so the board can order finished games by
             when they ended (see boardOrder below). Preferred over our stored g.date because a
             hand-built slate's times were converted ET->UTC by hand and can be an hour out — and
             an hour is exactly the size of error that reorders a Sunday. */
          kickoff: Date.parse(e.date) || null,
        };
        out[String(e.id)] = sc;
        /* ALSO key by matchup. A hand-built slate carries our own ids, which will never equal an
           ESPN event id — lookup by id alone would find nothing and every game would sit unscored
           forever with no error. Matchup is stable and unique within a week, and it is also what
           lets an over/under entry (`<id>#ou`) resolve to the same fixture's score. */
        out[away.team.abbreviation + '@' + home.team.abbreviation] = sc;
      }
    } catch (e) { /* a failed fetch leaves those games unscored, which renders as "—" */ }
  }
  return out;
}

// The covering side: a team abbreviation, 'OVER', 'UNDER', 'PUSH', or null when not yet scoreable.
function coverOf(g, sc, requireFinal) {
  if (!sc) return null;
  if (requireFinal && sc.state !== 'post') return null;
  if (sc.homeScore == null || sc.awayScore == null) return null;
  if (g.market === 'total') {
    const combined = sc.homeScore + sc.awayScore;
    if (combined > g.total) return 'OVER';
    if (combined < g.total) return 'UNDER';
    return 'PUSH';
  }
  if (g.pickem) {
    if (sc.homeScore === sc.awayScore) return 'PUSH';
    return sc.homeScore > sc.awayScore ? g.homeAbbrev : g.awayAbbrev;
  }
  const favHome = g.favAbbrev === g.homeAbbrev;
  const favScore = favHome ? sc.homeScore : sc.awayScore, dogScore = favHome ? sc.awayScore : sc.homeScore;
  const dog = favHome ? g.awayAbbrev : g.homeAbbrev;
  if (favScore - dogScore > g.line) return g.favAbbrev;
  if (favScore - dogScore === g.line) return 'PUSH';
  return dog;
}

// Three-way lookup, mirroring resultFor() on the server: id → base id → matchup.
const scoreFor = (g, scores) =>
  scores[g.id] || scores[String(g.id).split('#')[0]] || scores[g.awayAbbrev + '@' + g.homeAbbrev] || null;

// How a market is written. A total must never render as an empty spread.
const marketLabel = g => g.market === 'total' ? ('O/U ' + g.total) : (g.pickem ? 'PICK EM' : g.spreadText);

/* ─────────────────────────────────────────────────────────────────────────────
   DISPLAY ORDER (Mike, via Keith 2026-08-21; refined 2026-08-22).

   A slate is stored in **the order the commissioner built it**, which is not chronological and
   has no reason to be: `2026-pre2` shipped with LV @ HOU — the Thursday-night game, the FIRST to
   finish — sitting fourth, below three games that had not kicked off. The result you most wanted
   to look at was the one furthest down the page.

   THE ORDER DEPENDS ON WHETHER THE WEEK IS STILL RUNNING, because a live board and a finished
   board are answering two different questions.

     WHILE THE WEEK IS LIVE — "what just happened?"
       1. FINAL, most recently finished first
       2. IN PROGRESS
       3. NOT STARTED, soonest kickoff first
       The newest result is always at the top, where you look first.

     ONCE THE WEEK IS FINALIZED — "how did the week go?"
       Plain chronological, oldest first. A finished week is a RECORD, and a record reads
       forwards: Thursday at the top, the game that decided it at the bottom. Keith, on the
       finalized `2026-pre2` board, 2026-08-22 — the same reason a completed golf pool stopped
       polling ESPN and started rendering a stored result. Live affordances and records are not
       the same artifact.

   ⚠ ESPN PUBLISHES NO "GAME ENDED AT" TIMESTAMP, so "most recently finished" is necessarily
   inferred. Within the finished group we order by KICKOFF, latest first — football games are
   close enough to the same length that later-starting means later-finishing, and two games in
   the same slot end within minutes of each other anyway. It is a proxy, and it is named as one
   here rather than dressed up as a fact. The kickoff used is ESPN's own (`sc.kickoff`) where we
   have it, falling back to the stored `g.date`.

   Leagues are deliberately NOT grouped: a mixed NFL/college week reads as ONE timeline. Both
   pages label every row with its league, because the abbreviations are not unique across the two
   codes (CIN, BUF, MIA, HOU are the same string in both).

   THIS IS DISPLAY ONLY. Scoring iterates `wk.games` and is order-independent; this returns a
   SORTED COPY and never mutates the week. Nothing here may change a score, and no server change
   is required — which is the whole reason it is safe to derive on the client on every paint.
   ───────────────────────────────────────────────────────────────────────────── */
function boardOrder(games, scores, finalized) {
  const bucket = (g) => {
    const st = (scoreFor(g, scores) || {}).state;
    return st === 'post' ? 0 : st === 'in' ? 1 : 2;
  };
  const kickOf = (g) => {
    const sc = scoreFor(g, scores) || {};
    return sc.kickoff || Date.parse(g.date) || 0;
  };
  /* SAME KICKOFF. Two entries for ONE fixture (spread + its `#ou` twin) must stay adjacent in
     BOTH modes — splitting a game away from its own over/under would be worse than the order it
     replaced. Group by base id, spread above total, then by id so the sort is total and the paint
     never jitters between refreshes. */
  const pair = (a, b) => {
    const ida = String(a.id).split('#')[0], idb = String(b.id).split('#')[0];
    if (ida !== idb) return ida < idb ? -1 : 1;
    const ma = a.market === 'total' ? 1 : 0, mb = b.market === 'total' ? 1 : 0;
    if (ma !== mb) return ma - mb;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  };
  return (games || []).slice().sort((a, b) => {
    const ka = kickOf(a), kb = kickOf(b);
    // A FINALIZED WEEK IS A RECORD — read it forwards, and never mind the buckets (by the time a
    // week can be finalized every game in it is final anyway; finalize_week refuses otherwise).
    if (finalized) return ka !== kb ? ka - kb : pair(a, b);
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    // Finished games run newest-first; anything still to come reads forwards, as a schedule should.
    if (ka !== kb) return ba === 0 ? kb - ka : ka - kb;
    return pair(a, b);
  });
}

function weekPoints(wk, scores) {
  const pts = {}, detail = {};
  const players = Object.keys(wk.picks || {});
  players.forEach(p => { pts[p] = 0; detail[p] = {}; });
  for (const g of (wk.games || [])) {
    const cov = coverOf(g, scoreFor(g, scores), true);
    for (const p of players) {
      const mypick = (wk.picks[p].picks || {})[g.id];
      if (!mypick) { detail[p][g.id] = '—'; continue; }
      if (!cov) { detail[p][g.id] = mypick; continue; }
      if (cov === 'PUSH') { detail[p][g.id] = 'P'; }        // a push is worth ZERO
      else if (cov === mypick) { pts[p] += 1; detail[p][g.id] = 'W'; }
      else detail[p][g.id] = 'L';
    }
  }
  return { pts, detail };
}

/* ─────────────────────────────────────────────────────────────────────────────
   WHO IS LOOKING (2026-08-19). An open board is now answered PER VIEWER: while a
   member added mid-week still has a card to fill, only a viewer who has locked their
   own picks gets to see everyone else's (api/football-pool.js). That is only usable
   if the read-only pages can say who they are — before this, the board and the live
   tracker were entirely anonymous, so a player who HAD picked would have lost the
   board to a gate meant for someone else.

   Stored under one key, in ONE place, for the same reason the scoring rules are:
   three pages read it. It moves from sessionStorage to localStorage because the
   tracker is meant to be BOOKMARKED — a per-tab session is gone by the time it is
   opened from the home screen, which is exactly how it gets used. A tab already
   holding the old session keeps working: the read falls back to sessionStorage and
   migrates it forward.

   ⚠ This puts a 4-digit PIN in localStorage on the member's own phone. It is the same
   credential already sent to them by text and already accepted in a GET query string
   (Codex #6, deliberately deferred) — phone-as-identity with a one-time code is the
   real answer and is scoped as that rebuild, not as a patch here.
   ───────────────────────────────────────────────────────────────────────────── */
const POOL_SESSION_KEY = 'fb_me';
const poolSession = {
  get() {
    try {
      let raw = localStorage.getItem(POOL_SESSION_KEY);
      if (!raw) {
        raw = sessionStorage.getItem(POOL_SESSION_KEY);
        if (raw) localStorage.setItem(POOL_SESSION_KEY, raw);   // carry an open tab forward
      }
      const v = raw ? JSON.parse(raw) : null;
      return v && v.name && v.pin ? v : null;
    } catch (e) { return null; }
  },
  set(name, pin) {
    try { localStorage.setItem(POOL_SESSION_KEY, JSON.stringify({ name, pin })); } catch (e) {}
    try { sessionStorage.setItem(POOL_SESSION_KEY, JSON.stringify({ name, pin })); } catch (e) {}
  },
  clear() {
    try { localStorage.removeItem(POOL_SESSION_KEY); } catch (e) {}
    try { sessionStorage.removeItem(POOL_SESSION_KEY); } catch (e) {}
  },
  // Identity for a read-only GET. Empty string when signed out, so it concatenates safely.
  query() {
    const s = poolSession.get();
    return s ? '&name=' + encodeURIComponent(s.name) + '&pin=' + encodeURIComponent(s.pin) : '';
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
   THE MONEY (Keith 2026-08-25).

   Taken from the commissioner's OWN 2025 workbook — `Pool Screenshots\Picks week 1.xlsx`,
   20 weeks, six players (Mike, Nick, Mark, Bob, Brandon, Brad) — rather than invented here.
   What that sheet encodes, and what this reproduces exactly:

     · EVERY PLAYER IN A WEEK PAYS $50. The pot is entrants x $50.
     · THE WEEKLY WINNER TAKES THE POT. Week 1 2025: Nick +250, five others -50.
     · A TIE SPLITS IT. Week 3: Mark and Brad +100 each (pot 300 / 2 = 150, less their own 50).
       Week 9: a three-way, +50 each (300 / 3 = 100, less 50). Both check out to the dollar.
     · THE SEASON TOTAL IS THE SUM OF THE WEEKS. The sheet totals in blocks of four and then
       recaps; the recap is all that matters here. 2025 finished Mark +600 · Bob +50 · Brad +50 ·
       Brandon 0 · Mike -150 · Nick -550.
     · The legend, printed twice on that sheet and reused verbatim on both pages here:
       **"Black Gets / Red Pays."** It is the crew's own language for the column and it says in
       three words what a signed number does not.

   ⛔ IT IS ZERO-SUM, AND THAT IS THE INVARIANT WORTH TESTING. Every dollar paid in is paid out
   in the same week, so the season column must always sum to exactly 0. The 2025 recap does. If
   a change here ever makes it not, the ledger is inventing or destroying money and the gate
   fails on that single assertion rather than on six numbers nobody can check by eye.

   WHO IS IN A WEEK. Entrants come from the week summary's own `pickedBy`/`savedBy` — names, not
   ids, and present on every `?list=` row whether or not the board is revealed, so the hub can
   price a week without ever seeing a pick. Both lists count: `pickedBy` is locked cards and
   `savedBy` is saved-not-locked, and weekPoints() scores BOTH, so charging only the locked ones
   would bill a different set of people than the one that could win. A named winner missing from
   both is folded in rather than dropped — you cannot win a week without a card in it, and
   dropping them would quietly break zero-sum by paying a pot to nobody.

   PRESEASON IS PRICED LIKE ANY OTHER WEEK (Keith, 2026-08-25: "pre-season is just for test — you
   can act as if they carry money. But we will reset everything once the regular season starts.
   No one is picking for real"). So there is deliberately NO preseason exemption in this code:
   the shakedown exercises the real ledger, and the slate wipe at the regular season resets it.

   THE STAKE IS HARDCODED at Keith's instruction — a constant, not pool config. Changing it is a
   one-line edit and a deploy.
   ───────────────────────────────────────────────────────────────────────────── */
const WEEKLY_STAKE = 50;

// "TIE: BOB N, NICK P" → ['BOB N','NICK P']; a single name → one entry; nothing → [].
function weekWinners(w) {
  return String((w && w.weeklyWinner) || '')
    .replace(/^TIE:\s*/i, '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

// Everyone with a card in the week, plus any winner not listed in one (see the note above).
function weekEntrants(w, winners) {
  const seen = {}, out = [];
  const push = (n) => {
    const k = String(n || '').trim().toUpperCase();
    if (!k || seen[k]) return;
    seen[k] = 1; out.push(k);
  };
  ((w && w.pickedBy) || []).forEach(push);
  ((w && w.savedBy) || []).forEach(push);
  (winners || []).forEach(push);
  return out;
}

/* The season ledger. Reads ONLY `?list=<season>` summaries — no picks, no ESPN, no second
   request — which is why the hub can render it from the one fetch it already makes.
   Returns { rows, weeks, unsettled, stake }, rows sorted the way the sheet reads: most money
   first, weekly wins breaking a tie, then name so the order never jitters. */
function seasonLedger(weeks) {
  const by = {}, order = [];
  const row = (n) => {
    if (!by[n]) { by[n] = { name: n, weeks: 0, wins: 0, paid: 0, won: 0, net: 0, paidC: 0, wonC: 0 }; order.push(n); }
    return by[n];
  };
  let counted = 0, unsettled = 0;
  const stakeC = Math.round(WEEKLY_STAKE * 100);
  for (const w of (weeks || [])) {
    if (!w || !w.finalized) continue;
    const winners = weekWinners(w);
    const entrants = weekEntrants(w, winners);
    /* A finalized week with no named winner, or with nobody in it, is NOT priced. It would
       otherwise charge six people $50 for a pot that is paid to no one — money destroyed, and
       the zero-sum check would catch it as a bug in the arithmetic when the real fault is a
       week that never scored. Counted separately so a page can say so out loud. */
    if (!winners.length || !entrants.length) { unsettled++; continue; }
    counted++;
    /* ⛔ INTEGER CENTS, AND THE REMAINDER IS HANDED OUT — NOT ROUNDED AWAY.
       The 2025 sheet never met this: six players is a $300 pot, which divides evenly by one, two
       or three winners. SEVEN players is $350, and a three-way tie is $116.666… — round each
       share to the cent independently and the pot pays out $350.01. A ledger that invents a penny
       has broken the only invariant that makes it checkable, and it would have started doing so
       the first time the full crew tied three ways. So the split is floor-to-the-cent and the
       leftover cents go one each to the winners in a stable (sorted) order, which keeps the week
       exactly zero-sum and makes the same week always split the same way. */
    const potC = entrants.length * stakeC;
    const baseC = Math.floor(potC / winners.length);
    let extraC = potC - baseC * winners.length;
    for (const n of entrants) { const r = row(n); r.weeks++; r.paidC = (r.paidC || 0) + stakeC; }
    for (const n of winners.slice().sort()) {
      const r = row(n); r.wins++;
      r.wonC = (r.wonC || 0) + baseC + (extraC > 0 ? (extraC--, 1) : 0);
    }
  }
  const rows = order.map(n => by[n]);
  for (const r of rows) {
    r.paid = (r.paidC || 0) / 100;
    r.won = (r.wonC || 0) / 100;
    r.net = ((r.wonC || 0) - (r.paidC || 0)) / 100;
    delete r.paidC; delete r.wonC;
  }
  rows.sort((a, b) => (b.net - a.net) || (b.wins - a.wins) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rows, weeks: counted, unsettled, stake: WEEKLY_STAKE };
}

/* Black gets, red pays — the sign is carried by the colour on the page, and by the +/- here so
   the number still reads correctly on a black-and-white printout. Cents appear only when the
   split actually produced them. */
function fmtMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100, abs = Math.abs(v);
  return (v > 0 ? '+$' : v < 0 ? '-$' : '$') +
    abs.toLocaleString('en-US', { minimumFractionDigits: abs % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/* Node can load this file to unit-test the pure rules — scripts/verify-pool-integrity.js does,
   because the deploy gate hits the deployed API and can otherwise say nothing at all about the
   client-side ordering. `module` is undefined in a browser, so this is inert there. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    coverOf, scoreFor, marketLabel, weekPoints, boardOrder,
    WEEKLY_STAKE, weekWinners, weekEntrants, seasonLedger, fmtMoney,
  };
}
