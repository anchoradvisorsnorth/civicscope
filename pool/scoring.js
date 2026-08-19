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
