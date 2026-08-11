// api/digest.js — CivicScope Daily Digest
// Reports ONE NAMED ET CALENDAR DAY of tool_runs + leads + sessions, emails Keith.
// Triggered by Vercel cron at 11:00 UTC (7am ET, see vercel.json) — reports YESTERDAY.
// Manual: POST /api/digest with Authorization: Bearer <CRON_SECRET>
//   ?date=YYYY-MM-DD  report that ET day instead of yesterday (re-send a missed day)
//   ?dry=1            compute and return the JSON, send no email
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
      const url = `${SUPABASE_URL}/rest/v1/${table}?created_at=gte.${since}&created_at=lt.${until}${extra}`;
      const r = await fetch(url, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      if (!r.ok) throw new Error(`Supabase ${table} error: ${await r.text()}`);
      return r.json();
    };

    const [runs, leads, sessions] = await Promise.all([
      sbGet('tool_runs', '&order=created_at.desc'),
      sbGet('leads', '&order=created_at.desc'),
      sbGet('sessions', '&select=created_at,referrer,user_agent')
    ]);

    // A day with visitors who never finished a run is NOT the same as a day with no visitors.
    // The old email called both "quiet", which is the shape of blindness that hides a broken
    // funnel — or a broken tool — behind a reassuring word.
    const humanSessions = sessions.filter(s => !isBot(s.user_agent)).length;
    const traffic = { total: sessions.length, human: humanSessions, bot: sessions.length - humanSessions };

    if (dryRun) {
      return res.status(200).json({
        dry: true, day, window: { since, until },
        runs: runs.length, leads: leads.length, traffic,
        subject: runs.length === 0 && leads.length === 0
          ? `CivicScope Daily — Quiet day (${shortLabel})`
          : `CivicScope Daily — ${runs.length} run${runs.length !== 1 ? 's' : ''}, ${leads.length} lead${leads.length !== 1 ? 's' : ''} (${shortLabel})`
      });
    }

    // ── Quiet day — send a short "no activity" email ─────────────────
    if (runs.length === 0 && leads.length === 0) {
      const quietHtml = buildQuietDayEmail({ dateLabel, traffic });
      const quietRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'CivicScope <info@civicscope.io>',
          to: [KEITH_EMAIL],
          subject: `CivicScope Daily — Quiet day (${shortLabel})`,
          html: quietHtml
        })
      });
      if (!quietRes.ok) {
        const err = await quietRes.text();
        throw new Error(`Resend error: ${err}`);
      }
      const result = await quietRes.json();
      await cronHeartbeat('ok', `${day}: quiet day (${traffic.human} human sessions)`);
      return res.status(200).json({ sent: true, id: result.id, day, runs: 0, leads: 0, traffic, quiet: true });
    }

    // ── Segment runs ─────────────────────────────────────────────────
    const campaignRuns = runs.filter(r => r.ref);
    const organicRuns = runs.filter(r => !r.ref);

    // Campaign ref breakdown
    const refCounts = {};
    campaignRuns.forEach(r => {
      refCounts[r.ref] = (refCounts[r.ref] || 0) + 1;
    });

    // Product breakdown
    const productCounts = {};
    runs.forEach(r => {
      const p = r.product || 'free';
      productCounts[p] = (productCounts[p] || 0) + 1;
    });

    // ── Build email HTML ─────────────────────────────────────────────
    const html = buildDigestEmail({
      dateLabel,
      runs,
      leads,
      campaignRuns,
      organicRuns,
      refCounts,
      productCounts,
      traffic
    });

    // ── Send via Resend ──────────────────────────────────────────────
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'CivicScope <info@civicscope.io>',
        to: [KEITH_EMAIL],
        subject: `CivicScope Daily — ${runs.length} run${runs.length !== 1 ? 's' : ''}, ${leads.length} lead${leads.length !== 1 ? 's' : ''} (${shortLabel})`,
        html
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      throw new Error(`Resend error: ${err}`);
    }

    const result = await emailRes.json();
    await cronHeartbeat('ok', `${day}: ${runs.length} runs, ${leads.length} leads`);
    return res.status(200).json({ sent: true, id: result.id, day, runs: runs.length, leads: leads.length, traffic });

  } catch (err) {
    console.error('Digest error:', err);
    await cronHeartbeat('fail', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Report this run to the CRM automation registry (best-effort).
async function cronHeartbeat(status, detail) {
  try {
    await fetch('https://crm.jbkdevelopment.com/api/task-heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': '14a8f1c985aa1345179433b701555d2887bd3a6c7d00d790' },
      body: JSON.stringify({ id: 'cs-digest', status, detail: (detail || '').toString().slice(0, 200) }),
    });
  } catch {}
}

// ── Email Template ──────────────────────────────────────────────────────────
function buildDigestEmail({ dateLabel, runs, leads, campaignRuns, organicRuns, refCounts, productCounts, traffic }) {
  const fmt = (n) => typeof n === 'number' ? '$' + n.toLocaleString('en-US') : n;
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Indiana/Indianapolis',
    hour: 'numeric', minute: '2-digit'
  });

  // ── Summary stats row ──
  const statsHtml = `
    <div style="display:flex;gap:0;">
      ${statCard('Visitors', traffic ? traffic.human : '—', '#0f766e')}
      ${statCard('Total Runs', runs.length, '#1a2744')}
      ${statCard('Leads', leads.length, '#c2410c')}
      ${statCard('Campaign', campaignRuns.length, '#15803d')}
      ${statCard('Organic', organicRuns.length, '#78716c')}
    </div>`;

  // ── Campaign tracking ──
  let campaignHtml = '';
  if (Object.keys(refCounts).length > 0) {
    const rows = Object.entries(refCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ref, count]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e7e2d8;font-size:13px;color:#1a2744;font-weight:600;">${ref}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e7e2d8;font-size:13px;color:#44403c;text-align:right;">${count} run${count !== 1 ? 's' : ''}</td>
        </tr>`)
      .join('');
    campaignHtml = `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">Campaign Tracking (by ref)</div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
          ${rows}
        </table>
      </div>`;
  }

  // ── Individual runs table ──
  const runRows = runs.map(r => `
    <tr style="border-bottom:1px solid #e7e2d8;">
      <td style="padding:10px 12px;font-size:12px;color:#78716c;white-space:nowrap;vertical-align:top;">${time(r.created_at)}</td>
      <td style="padding:10px 12px;vertical-align:top;">
        <div style="font-size:13px;font-weight:600;color:#1a2744;">${r.project_type || '—'}</div>
        <div style="font-size:12px;color:#44403c;margin-top:2px;">${r.municipality || ''}${r.state ? ', ' + r.state : ''}${r.zip ? ' ' + r.zip : ''}</div>
        ${r.scope_description ? `<div style="font-size:12px;color:#78716c;margin-top:4px;line-height:1.4;font-style:italic;">"${truncate(r.scope_description, 120)}"</div>` : ''}
      </td>
      <td style="padding:10px 12px;text-align:right;vertical-align:top;white-space:nowrap;">
        <div style="font-size:13px;font-weight:600;color:#1a2744;">${fmt(r.cost_low)} – ${fmt(r.cost_high)}</div>
        <div style="font-size:11px;color:${r.confidence === 'High' ? '#15803d' : r.confidence === 'Medium' ? '#92400e' : '#c2410c'};margin-top:2px;">${r.confidence || '—'}</div>
      </td>
      <td style="padding:10px 12px;text-align:center;vertical-align:top;">
        ${r.ref ? `<span style="display:inline-block;padding:2px 8px;background:#dcfce7;color:#15803d;font-size:10px;font-weight:600;border-radius:10px;letter-spacing:0.5px;">${r.ref}</span>` : `<span style="color:#a8a29e;font-size:11px;">organic</span>`}
      </td>
    </tr>`).join('');

  const runsTableHtml = runs.length > 0 ? `
    <div style="margin-bottom:28px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">All Runs (${runs.length})</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
        <tr style="background:#f5f0eb;">
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Time</th>
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Project</th>
          <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Cost Range</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Source</th>
        </tr>
        ${runRows}
      </table>
    </div>` : '';

  // ── Leads table ──
  let leadsHtml = '';
  if (leads.length > 0) {
    const leadRows = leads.map(l => `
      <tr style="border-bottom:1px solid #e7e2d8;">
        <td style="padding:10px 12px;font-size:12px;color:#78716c;white-space:nowrap;">${time(l.created_at)}</td>
        <td style="padding:10px 12px;">
          <div style="font-size:13px;font-weight:600;color:#1a2744;">${l.first_name} ${l.last_name}</div>
          <div style="font-size:12px;color:#44403c;margin-top:2px;"><a href="mailto:${l.email}" style="color:#c2410c;text-decoration:none;">${l.email}</a></div>
        </td>
        <td style="padding:10px 12px;font-size:12px;color:#44403c;">${l.role || '—'}</td>
        <td style="padding:10px 12px;font-size:12px;color:#44403c;">${l.municipality || '—'}</td>
      </tr>`).join('');

    leadsHtml = `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">New Leads (${leads.length})</div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
          <tr style="background:#f5f0eb;">
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Time</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Contact</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Role</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Municipality</th>
          </tr>
          ${leadRows}
        </table>
      </div>`;
  }

  // ── Product breakdown ──
  const productRows = Object.entries(productCounts)
    .map(([p, c]) => `<span style="display:inline-block;margin-right:12px;font-size:12px;color:#44403c;"><strong>${p}</strong>: ${c}</span>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:-apple-system,Segoe UI,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#fff;">
  <div style="background:#1a2744;padding:28px 36px;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">CivicScope Daily Digest</div>
    <div style="color:#9aa5c4;font-size:12px;margin-top:4px;">Activity for ${dateLabel}</div>
  </div>
  <div style="padding:32px 36px;">
    ${statsHtml}
    <div style="margin:20px 0 28px;padding:0;">${productRows}</div>
    ${campaignHtml}
    ${leadsHtml}
    ${runsTableHtml}
    <div style="border-top:1px solid #e7e2d8;padding-top:20px;margin-top:8px;">
      <p style="font-size:12px;color:#a8a29e;margin:0;">This digest covers ${dateLabel}, midnight to midnight Eastern${traffic ? ` — ${traffic.total} session${traffic.total !== 1 ? 's' : ''}, ${traffic.bot} likely automated` : ''}. Campaign runs are attributed via <code style="background:#f5f0eb;padding:1px 4px;border-radius:3px;">?ref=</code> parameter.</p>
    </div>
  </div>
  <div style="background:#f5f0eb;padding:16px 36px;border-top:1px solid #e7e2d8;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">CivicScope Daily Digest · <a href="https://civicscope.io" style="color:#a8a29e;">civicscope.io</a></p>
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
  // "Quiet" must mean nobody came. If people did come and none of them finished a run, say that
  // instead — that is a drop-off (or a broken tool), and it is the more urgent of the two.
  const trafficLine = t.human > 0
    ? `<p style="font-size:13px;color:#92400e;margin:12px 0 0;background:#fffbeb;border-left:3px solid #d97706;padding:10px 12px;"><strong>${t.human} visitor${t.human !== 1 ? 's' : ''} reached a tool and none completed a run.</strong> Not a quiet day — a drop-off. Worth checking the tool still works end to end.</p>`
    : `<p style="font-size:13px;color:#78716c;margin:12px 0 0;">No human visitors either — ${t.total} session${t.total !== 1 ? 's' : ''} logged, all of them likely automated.</p>`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:-apple-system,Segoe UI,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#fff;">
  <div style="background:#1a2744;padding:28px 36px;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">CivicScope Daily Digest</div>
    <div style="color:#9aa5c4;font-size:12px;margin-top:4px;">Activity for ${dateLabel}</div>
  </div>
  <div style="padding:32px 36px;">
    <p style="font-size:15px;color:#1a2744;margin:0 0 8px;">No runs or leads on ${dateLabel}.</p>
    ${trafficLine}
  </div>
  <div style="background:#f5f0eb;padding:16px 36px;border-top:1px solid #e7e2d8;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">CivicScope Daily Digest · <a href="https://civicscope.io" style="color:#a8a29e;">civicscope.io</a></p>
  </div>
</div>
</body>
</html>`;
}
