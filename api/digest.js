// api/digest.js — CivicScope Daily Digest
// Reports ONE NAMED ET CALENDAR DAY of tool_runs + leads + sessions, emails Keith.
// Triggered by Vercel cron at 11:00 UTC (7am ET, see vercel.json) — reports YESTERDAY.
// Manual: POST /api/digest with Authorization: Bearer <CRON_SECRET>
//   ?date=YYYY-MM-DD  report that ET day instead of yesterday (re-send a missed day)
//   ?dry=1            compute and return the JSON, send no email
//
// ===== ONE EMAIL A DAY (Keith, 2026-10-18) ===================================================
// This is the ONLY CivicScope estimator notice. The instant "New CivicScope Lead" email and the
// BCC copy of every report (api/email.js) were folded in here. A RUN is a completed estimate; it
// becomes a LEAD when the person fills in the form (leads.tool_run_id -> tool_runs.id). Each run
// is listed once and marked RUN or LEAD. Indiana/Michigan runs and leads lead the email and the
// subject. No runs and no leads -> subject and body say "Quiet Day".
// (Before this change Keith read the digest as "always quiet": it was correct — e.g. the Griswold
// runs of 9:12pm ET Oct 15 sat in the Oct 15 email — but his mail filter put active days under a
// separate label, so the one he watched only ever held quiet days.)
//
// ===== WHY A CALENDAR DAY AND NOT "THE LAST 24 HOURS" (fixed 2026-08-11) =====================
// v1 queried `created_at >= now - 24h` and then labelled the email with TODAY'S date. The cron
// fires at 7am ET, so the window was 7am yesterday -> 7am today: almost entirely YESTERDAY, sent
// under today's headline. Every run made during business hours therefore appeared in the NEXT
// morning's email, and the email carrying the date it actually happened said "Quiet day".
//
// It was not a counting error — every run was reported exactly once — which is why it survived.
// It was a LABELLING error, and it inverted the only signal the email exists to carry:
//   Aug 3: 2 runs -> the "Aug 3" email said Quiet day, the "Aug 4" email said 2 runs
//   Aug 5: 2 runs -> the "Aug 5" email said Quiet day, the "Aug 6" email said 2 runs
//   Aug 7: 2 runs -> the "Aug 7" email said Quiet day, the "Aug 8" email said 2 runs
//
// A sliding window is also not idempotent: if the cron runs late, the hours between the last run
// and the new window's start belong to NO digest and are lost permanently (Vercel cron has missed
// days here before — see CLAUDE.md). If it runs early, rows are counted twice. A named calendar
// day is stable: the same ?date= always reports the same rows, and a missed day can be re-sent.
// =============================================================================================

const TZ = 'America/Indiana/Indianapolis';

// ms to ADD to a wall-clock-as-UTC value to get the real instant in TZ.
// For EDT (UTC-4) this is +4h; it changes across the DST boundary, which is why it is measured
// at the instant in question rather than hardcoded.
function tzDiff(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).map(x => [x.type, x.value])
  );
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return date.getTime() - wallAsUtc;
}

// The UTC instant of local midnight starting the given ET calendar day.
function etMidnightUtc(y, m, d) {
  const wall = Date.UTC(y, m - 1, d, 0, 0, 0);
  const inst = wall + tzDiff(new Date(wall));
  // Re-measure at the candidate instant: on a DST-change day the first guess can sit on the
  // wrong side of the transition.
  const refined = wall + tzDiff(new Date(inst));
  return new Date(refined);
}

const etDateString = date =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date); // YYYY-MM-DD

// Resolve the ET day to report: explicit ?date=, else yesterday in ET.
function resolveTargetDay(now, explicit) {
  if (explicit && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const [y, m, d] = etDateString(now).split('-').map(Number);
  return etDateString(new Date(etMidnightUtc(y, m, d).getTime() - 12 * 60 * 60 * 1000));
}

// Crawlers create a session on page load exactly like a person does, so an unfiltered session
// count reads as traffic that isn't there. This is a heuristic label, not a claim.
const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|python-requests|curl\/|wget|Go-http|scan|bytespider|ahrefs|semrush|petal|dataforseo/i;
const isBot = ua => !ua || BOT_UA.test(ua);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>
  // Manual trigger: same header
  const authHeader = req.headers['authorization'];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (authHeader !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const KEITH_EMAIL = 'info@civicscope.io';

  try {
    const now = new Date();
    const q = req.query || {};
    const dryRun = q.dry === '1' || q.dry === 'true';

    // ── The reported day: one ET calendar day, [00:00:00, next 00:00:00) ──────
    const day = resolveTargetDay(now, typeof q.date === 'string' ? q.date : null);
    const [dy, dm, dd] = day.split('-').map(Number);
    const dayStart = etMidnightUtc(dy, dm, dd);
    const dayEnd = etMidnightUtc(dy, dm, dd + 1); // Date.UTC normalises the month rollover
    const since = dayStart.toISOString();
    const until = dayEnd.toISOString();

    // Labels describe the day being REPORTED, never the day the email is sent.
    const labelFor = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts })
      .format(new Date(dayStart.getTime() + 12 * 60 * 60 * 1000)); // midday, DST-safe
    const dateLabel = labelFor({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const shortLabel = labelFor({ month: 'short', day: 'numeric' });

    const sbGet = async (table, extra = '') => {
      /* 2026-09-15: the 2026-09-14 digest died on `Supabase leads error: {"message":"Gateway Timeout"}` — the
         same intermittent 502/504 from Supabase's API gateway that took down /centreville and the well-testing
         review on 09-12→14, and the same fix: these three calls are pure READS, so a 5xx (or a dropped connection)
         is retried three times with a short backoff; a 4xx is an answer and is not retried. Mirrors sb() in
         api/muni-ask.js. The Resend send below is a WRITE and is deliberately not retried. */
      const url = `${SUPABASE_URL}/rest/v1/${table}?created_at=gte.${since}&created_at=lt.${until}${extra}`;
      let r = null, lastErr = null;
      for (const wait of [0, 300, 900, 1800]) {
        if (wait) await new Promise((ok) => setTimeout(ok, wait));
        try {
          r = await fetch(url, {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
          });
        } catch (e) { lastErr = e; r = null; continue; }
        if (r.ok || r.status < 500) break;
        lastErr = new Error(`Supabase ${table} error: ${r.status} ${(await r.text()).slice(0, 120)}`);
      }
      if (!r) throw lastErr || new Error(`Supabase ${table} unreachable`);
      if (!r.ok) throw new Error(`Supabase ${table} error: ${await r.text()}`);
      return r.json();
    };


    const [runs, leads, sessions] = await Promise.all([
      sbGet('tool_runs', '&order=created_at.asc'),
      sbGet('leads', '&order=created_at.asc'),
      sbGet('sessions', '&select=created_at,referrer,user_agent')
    ]);

    // A lead is a run whose person then filled in the form. Every lead row carries tool_run_id
    // (27 of 27 when this was written). The form is normally filled within minutes of the run, but
    // a run at 11:58pm can become a lead after midnight — so a lead whose run is not in this day's
    // window is fetched by id and shown with its own date, never dropped.
    const runById = new Map(runs.map(r => [r.id, r]));
    const missing = [...new Set(leads.map(l => l.tool_run_id).filter(id => id && !runById.has(id)))];
    if (missing.length) {
      const extra = await sbGetAny('tool_runs', `id=in.(${missing.join(',')})`);
      extra.forEach(r => runById.set(r.id, { ...r, _otherDay: true }));
    }
    const leadByRun = new Map();
    leads.forEach(l => { if (l.tool_run_id) leadByRun.set(l.tool_run_id, l); });

    // A day with visitors who never finished a run is NOT the same as a day with no visitors.
    // The old email called both "quiet", which is the shape of blindness that hides a broken
    // funnel — or a broken tool — behind a reassuring word.
    const humanSessions = sessions.filter(s => !isBot(s.user_agent)).length;
    const traffic = { total: sessions.length, human: humanSessions, bot: sessions.length - humanSessions };

    // Indiana and Michigan are the home market — they lead the email and the subject line.
    const homeRuns = runs.filter(r => isHome(r.state));
    const homeLeads = leads.filter(l => isHome((runById.get(l.tool_run_id) || {}).state));
    const quiet = runs.length === 0 && leads.length === 0;
    const subject = buildSubject({ runs, leads, homeRuns, homeLeads, shortLabel, quiet });

    if (dryRun) {
      return res.status(200).json({
        dry: true, day, window: { since, until },
        runs: runs.length, leads: leads.length,
        home: { runs: homeRuns.length, leads: homeLeads.length },
        traffic, subject
      });
    }

    const html = quiet
      ? buildQuietDayEmail({ dateLabel, traffic })
      : buildDigestEmail({ dateLabel, runs, leads, runById, leadByRun, homeRuns, homeLeads, traffic });

    // ── Send via Resend (a WRITE — deliberately not retried) ─────────────
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'CivicScope <info@civicscope.io>',
        to: [KEITH_EMAIL],
        subject,
        html
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      throw new Error(`Resend error: ${err}`);
    }

    const result = await emailRes.json();
    await cronHeartbeat('ok', quiet
      ? `${day}: quiet day (${traffic.human} human sessions)`
      : `${day}: ${runs.length} runs, ${leads.length} leads, ${homeRuns.length} IN/MI runs`);
    return res.status(200).json({
      sent: true, id: result.id, day, runs: runs.length, leads: leads.length,
      home: { runs: homeRuns.length, leads: homeLeads.length }, traffic, quiet
    });

    // Reads a table by an arbitrary filter (not the day window). Same retry policy as sbGet.
    async function sbGetAny(table, filter) {
      const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}`;
      let r = null, lastErr = null;
      for (const wait of [0, 300, 900, 1800]) {
        if (wait) await new Promise((ok) => setTimeout(ok, wait));
        try {
          r = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
        } catch (e) { lastErr = e; r = null; continue; }
        if (r.ok || r.status < 500) break;
        lastErr = new Error(`Supabase ${table} error: ${r.status}`);
      }
      if (!r) throw lastErr || new Error(`Supabase ${table} unreachable`);
      if (!r.ok) throw new Error(`Supabase ${table} error: ${await r.text()}`);
      return r.json();
    }

  } catch (err) {
    console.error('Digest error:', err);
    await cronHeartbeat('fail', err.message);
    return res.status(500).json({ error: err.message });
  }
}

const HOME_STATES = /^(indiana|michigan|in|mi)$/i;
const isHome = (state) => !!state && HOME_STATES.test(String(state).trim());

const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;

// Subject: "Quiet Day" when nothing ran; otherwise the counts, with Indiana/Michigan named first.
// The date label stays LAST — the deploy gate pins the subject to "(Aug 7)" at the end.
function buildSubject({ runs, leads, homeRuns, homeLeads, shortLabel, quiet }) {
  if (quiet) return `CivicScope Daily — Quiet Day (${shortLabel})`;
  const counts = `${plural(runs.length, 'run')}, ${plural(leads.length, 'lead')}`;
  if (homeRuns.length || homeLeads.length) {
    const home = homeLeads.length
      ? `${plural(homeLeads.length, 'lead')} from IN/MI`
      : `${plural(homeRuns.length, 'run')} from IN/MI`;
    return `CivicScope Daily — ★ ${home} · ${counts} (${shortLabel})`;
  }
  return `CivicScope Daily — ${counts} (${shortLabel})`;
}

// Everything a visitor typed reaches this email. Escape it.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Email Template ──────────────────────────────────────────────────────────
function buildDigestEmail({ dateLabel, runs, leads, runById, leadByRun, homeRuns, homeLeads, traffic }) {
  const money = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') : esc(n || '—'));
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Indiana/Indianapolis', hour: 'numeric', minute: '2-digit'
  });
  const dayOf = (iso) => new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric'
  });
  const place = (r) => esc([r.municipality, r.state].filter(Boolean).join(', ') + (r.zip ? ' ' + r.zip : ''));
  const label = (t) => `<div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">${t}</div>`;
  const leadBadge = `<span style="display:inline-block;padding:2px 8px;background:#c2410c;color:#fff;font-size:10px;font-weight:700;border-radius:10px;letter-spacing:0.5px;">LEAD</span>`;
  const runBadge = `<span style="display:inline-block;padding:2px 8px;background:#f5f0eb;color:#78716c;font-size:10px;font-weight:600;border-radius:10px;letter-spacing:0.5px;">RUN</span>`;
  const conf = (c) => `<span style="color:${c === 'High' ? '#15803d' : c === 'Medium' ? '#92400e' : '#c2410c'};">${esc(c || '—')}</span>`;

  // One card per lead: who, how to reach them, and the run that produced it.
  const leadCard = (l) => {
    const r = runById.get(l.tool_run_id) || {};
    const name = esc(`${l.first_name || ''} ${l.last_name || ''}`.trim() || '—');
    const subj = encodeURIComponent(`Re: Your ${r.project_type || 'project'}${l.municipality ? ' in ' + l.municipality : ''}`);
    return `
      <div style="border:1px solid #e7e2d8;border-left:3px solid #c2410c;border-radius:6px;padding:14px 16px;margin-bottom:12px;background:#fff;">
        <div style="font-size:15px;font-weight:700;color:#1a2744;">${name} ${isHome(r.state) ? '<span style="color:#c2410c;">★</span>' : ''}</div>
        <div style="font-size:13px;margin-top:3px;"><a href="mailto:${esc(l.email)}?subject=${subj}" style="color:#c2410c;text-decoration:none;">${esc(l.email)}</a> · ${esc(l.role || 'role not given')}</div>
        <div style="font-size:13px;color:#44403c;margin-top:8px;"><strong>${esc(r.project_type || '—')}</strong> — ${place(r) || esc(l.municipality || '—')}</div>
        <div style="font-size:13px;color:#44403c;margin-top:2px;">${money(r.cost_low)} – ${money(r.cost_high)} · ${conf(r.confidence)} confidence · form filled ${time(l.created_at)}${r._otherDay ? ` (run was ${dayOf(r.created_at)})` : ''}</div>
        ${r.scope_description ? `<div style="font-size:12px;color:#78716c;margin-top:6px;line-height:1.45;font-style:italic;">"${esc(truncate(r.scope_description, 300))}"</div>` : ''}
      </div>`;
  };

  // One row per run; a run that became a lead says so.
  const runRow = (r) => {
    const l = leadByRun.get(r.id);
    return `
    <tr style="border-bottom:1px solid #e7e2d8;">
      <td style="padding:10px 12px;font-size:12px;color:#78716c;white-space:nowrap;vertical-align:top;">${time(r.created_at)}</td>
      <td style="padding:10px 12px;vertical-align:top;">
        <div style="font-size:13px;font-weight:600;color:#1a2744;">${esc(r.project_type || '—')} ${isHome(r.state) ? '<span style="color:#c2410c;">★</span>' : ''}</div>
        <div style="font-size:12px;color:#44403c;margin-top:2px;">${place(r)}</div>
        ${r.scope_description ? `<div style="font-size:12px;color:#78716c;margin-top:4px;line-height:1.4;font-style:italic;">"${esc(truncate(r.scope_description, 120))}"</div>` : ''}
        ${l ? `<div style="font-size:12px;color:#c2410c;margin-top:4px;">→ became a lead: ${esc(`${l.first_name || ''} ${l.last_name || ''}`.trim())}</div>` : ''}
      </td>
      <td style="padding:10px 12px;text-align:right;vertical-align:top;white-space:nowrap;">
        <div style="font-size:13px;font-weight:600;color:#1a2744;">${money(r.cost_low)} – ${money(r.cost_high)}</div>
        <div style="font-size:11px;margin-top:2px;">${conf(r.confidence)}</div>
      </td>
      <td style="padding:10px 12px;text-align:center;vertical-align:top;">
        ${l ? leadBadge : runBadge}
        <div style="font-size:10px;color:#a8a29e;margin-top:4px;">${r.ref ? esc(r.ref) : 'organic'}</div>
      </td>
    </tr>`;
  };

  // ── Indiana & Michigan — top of the email ──
  const homeRunIds = new Set(homeRuns.map(r => r.id));
  const homeLeadsOtherDay = homeLeads.filter(l => !homeRunIds.has(l.tool_run_id));
  const homeHtml = (homeRuns.length || homeLeads.length) ? `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:18px 20px;margin-bottom:28px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#c2410c;margin-bottom:10px;">★ Indiana &amp; Michigan</div>
      ${homeRuns.map(r => {
        const l = leadByRun.get(r.id);
        return `<div style="font-size:14px;color:#1a2744;padding:6px 0;border-bottom:1px solid #fde4cc;">
          ${l ? leadBadge : runBadge} <strong>${place(r)}</strong> — ${esc(r.project_type || '—')}, ${money(r.cost_low)} – ${money(r.cost_high)}
          ${l ? `<div style="font-size:13px;margin-top:3px;">${esc(`${l.first_name || ''} ${l.last_name || ''}`.trim())} · <a href="mailto:${esc(l.email)}" style="color:#c2410c;text-decoration:none;">${esc(l.email)}</a> · ${esc(l.role || '—')}</div>` : ''}
        </div>`;
      }).join('')}
      ${homeLeadsOtherDay.map(l => {
        const r = runById.get(l.tool_run_id) || {};
        return `<div style="font-size:14px;color:#1a2744;padding:6px 0;border-bottom:1px solid #fde4cc;">
          ${leadBadge} <strong>${place(r)}</strong> — ${esc(r.project_type || '—')} (run ${dayOf(r.created_at)})
          <div style="font-size:13px;margin-top:3px;">${esc(`${l.first_name || ''} ${l.last_name || ''}`.trim())} · <a href="mailto:${esc(l.email)}" style="color:#c2410c;text-decoration:none;">${esc(l.email)}</a></div>
        </div>`;
      }).join('')}
    </div>` : '';

  const statsHtml = `
    <div style="display:flex;gap:0;margin-bottom:28px;">
      ${statCard('Runs', runs.length, '#1a2744')}
      ${statCard('Leads', leads.length, '#c2410c')}
      ${statCard('IN / MI', homeRuns.length, '#c2410c')}
      ${statCard('Visitors', traffic ? traffic.human : '—', '#0f766e')}
      ${statCard('Campaign', runs.filter(r => r.ref).length, '#15803d')}
    </div>`;

  const leadsHtml = leads.length ? `
    <div style="margin-bottom:28px;">
      ${label(`Leads (${leads.length}) — runs where the person filled in the form`)}
      ${leads.map(leadCard).join('')}
    </div>` : '';

  const runsHtml = runs.length ? `
    <div style="margin-bottom:28px;">
      ${label(`All runs (${runs.length})`)}
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
        <tr style="background:#f5f0eb;">
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Time</th>
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Project</th>
          <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Cost Range</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Status</th>
        </tr>
        ${runs.map(runRow).join('')}
      </table>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:-apple-system,Segoe UI,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#fff;">
  <div style="background:#1a2744;padding:28px 36px;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">CivicScope Daily</div>
    <div style="color:#9aa5c4;font-size:12px;margin-top:4px;">Activity for ${dateLabel}</div>
  </div>
  <div style="padding:32px 36px;">
    ${homeHtml}
    ${statsHtml}
    ${leadsHtml}
    ${runsHtml}
    <div style="border-top:1px solid #e7e2d8;padding-top:20px;margin-top:8px;">
      <p style="font-size:12px;color:#a8a29e;margin:0;line-height:1.5;">A <strong>run</strong> is an estimate someone completed. It becomes a <strong>lead</strong> when they fill in the form to email themselves the report — this email is the only notice of a lead. Covers ${dateLabel}, midnight to midnight Eastern${traffic ? ` — ${plural(traffic.total, 'session')}, ${traffic.bot} likely automated` : ''}. ★ = Indiana or Michigan.</p>
    </div>
  </div>
  <div style="background:#f5f0eb;padding:16px 36px;border-top:1px solid #e7e2d8;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">CivicScope Daily · <a href="https://civicscope.io" style="color:#a8a29e;">civicscope.io</a></p>
  </div>
</div>
</body>
</html>`;
}

function statCard(label, value, color) {
  return `
    <div style="flex:1;padding:16px;text-align:center;border:1px solid #e7e2d8;margin-right:-1px;">
      <div style="font-size:28px;font-weight:700;color:${color};">${value}</div>
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;margin-top:4px;">${label}</div>
    </div>`;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '…' : str;
}

function buildQuietDayEmail({ dateLabel, traffic }) {
  const t = traffic || { total: 0, human: 0, bot: 0 };
  // "Quiet" means nobody completed a run. If people did come and none of them finished one, say
  // that too — that is a drop-off (or a broken tool), and it is worth a look.
  const trafficLine = t.human > 0
    ? `<p style="font-size:13px;color:#92400e;margin:12px 0 0;background:#fffbeb;border-left:3px solid #d97706;padding:10px 12px;"><strong>${plural(t.human, 'visitor')} reached a tool and none completed a run.</strong> Worth checking the tool still works end to end.</p>`
    : `<p style="font-size:13px;color:#78716c;margin:12px 0 0;">No human visitors either — ${plural(t.total, 'session')} logged, all of them likely automated.</p>`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:-apple-system,Segoe UI,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#fff;">
  <div style="background:#1a2744;padding:28px 36px;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">CivicScope Daily</div>
    <div style="color:#9aa5c4;font-size:12px;margin-top:4px;">Activity for ${dateLabel}</div>
  </div>
  <div style="padding:32px 36px;">
    <p style="font-size:22px;font-weight:700;color:#1a2744;margin:0 0 8px;">Quiet Day</p>
    <p style="font-size:15px;color:#44403c;margin:0;">No runs and no leads on ${dateLabel}.</p>
    ${trafficLine}
  </div>
  <div style="background:#f5f0eb;padding:16px 36px;border-top:1px solid #e7e2d8;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">CivicScope Daily · <a href="https://civicscope.io" style="color:#a8a29e;">civicscope.io</a></p>
  </div>
</div>
</body>
</html>`;
}

// Report this run to the CRM automation registry (best-effort).
// The registry's cron secret comes from the environment (CRM_CRON_SECRET on this Vercel project). Until
// 2026-09-15 it was a LITERAL in this file — a live CRM credential in a PUBLIC repo. Never put it back.
async function cronHeartbeat(status, detail) {
  try {
    if (!process.env.CRM_CRON_SECRET) return;
    await fetch('https://crm.jbkdevelopment.com/api/task-heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRM_CRON_SECRET },
      body: JSON.stringify({ id: 'cs-digest', status, detail: (detail || '').toString().slice(0, 200) }),
    });
  } catch {}
}
