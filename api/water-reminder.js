// api/water-reminder.js — "the MOR is due on the 10th."
//
// Keith, 2026-08-25: *"the EGLE - MOR (monthly operating report) is due on the 10th of the month for
// the previous month's results. Can we send an email reminder to Michelle on the 7th of the month -
// reminding her to do the report - provide a link to shoot her into the page where she clicks to
// generate the report."*
//
// WHAT IT ACTUALLY GUARDS. Not a task in someone's calendar — a statutory filing date under
// 1976 PA 399. Centreville's own 2026 record shows the shape of the risk: January's report went to
// EGLE with **no submission date on its Cover tab at all**, and July was filed on 2026-08-07,
// three weeks after the month closed. Nothing in the product has ever said "this is due".
//
// ⛔ IT SENDS FOR A MONTH THAT IS NOT YET ON RECORD, AND SAYS NOTHING FOR ONE THAT IS.
// `water_mor_filings` already knows which months were submitted, so a reminder for a month Michelle
// has already filed is noise — and noise is not a neutral cost here. The filed-vs-held comparison in
// this same product had to be rebuilt because its first version reported every idle well as a
// divergence and buried two real findings inside seventy-nine. A monthly nag that is usually wrong
// gets filtered, and then the one that mattered is filtered too.
//
// ⛔ IT IS SAFE TO CALL TWICE, ON PURPOSE, BECAUSE THE SCHEDULE MUST NOT BE A SINGLE POINT OF
// FAILURE. This project's own backlog carries *"Move daily digest cron to VM — Vercel cron is
// unreliable (missed April 9-10 digests)"*. A missed digest is a lost day of numbers; a missed
// reminder is a missed filing date. So this route is idempotent by construction — `water_mor_reminders`
// holds one row per (supply, reported period, kind) under a unique index partial on outcome='sent' —
// and can therefore be wired to Vercel's cron AND the VM's without ever mailing the OIC twice.
// The partial index matters as much as the index: a run that found nobody to send to, or that failed
// at the provider, does NOT occupy the period, so the next caller retries it.
//
// ⛔ "NOBODY TO SEND IT TO" IS NOT A SUCCESS. Recipients come from `app_users` — the people actually
// enrolled for this supply — and if that list is empty the run records `no_recipient`, tells
// CivicScope, and leaves the period open for a retry. A reminder system whose failure mode is
// silence is a reminder system that has already stopped working and nobody has noticed.

export const config = { maxDuration: 30 };

export const VER = '1.0.0-morremind';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM = 'CivicScope <info@civicscope.io>';
const OPS_MAILBOX = 'info@civicscope.io';   // where a run with no recipient is reported
const SITE = 'https://civicscope.io';

const MN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

async function sb(pathAndQuery, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

/* The reported period is derived in EASTERN time, not UTC. The cron fires at 12:00 UTC, which is
   08:00 ET — but on the 1st of a month a UTC-derived "previous month" would be right only by luck,
   and the digest in this same project spent five months proving that a report's LABEL is the part
   that goes wrong while its arithmetic stays perfect. So: what month is it, where the plant is. */
function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return { y: Number(f.year), m: Number(f.month), d: Number(f.day) };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sendMail({ to, subject, html, text }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html, text, reply_to: OPS_MAILBOX }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`resend ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.id || null;
}

function body({ supply, y, m, link, wellDays, dist, bacti }) {
  const period = `${MN[m]} ${y}`;
  /* The counts are in the email on purpose. The single most useful thing this message can say is
     not "it is due" — she knows that — but what the month currently holds, because a month with no
     bacti on file is a report that cannot be signed cleanly, and July 2026 reached EGLE with no
     bacti dates and no residuals at all. Better she learns that on the 7th than on the 10th. */
  const gaps = [];
  if (!wellDays) gaps.push('there are <strong>no well readings on file at all</strong> for this month');
  if (!bacti) gaps.push('there are <strong>no bacti samples on file</strong> — the Bacti &amp; Cl Res tab will go to EGLE empty');
  if (!dist) gaps.push('there are <strong>no distribution samples on file</strong>');

  const html = `<div style="font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:560px">
  <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;margin:0 0 10px">CivicScope · ${esc(supply.name)}</p>
  <h1 style="font-size:22px;margin:0 0 14px">The ${esc(period)} report is due on the 10th</h1>
  <p style="margin:0 0 16px">Your Monthly Operation Report for <strong>${esc(period)}</strong> goes to EGLE by
     <strong>${MN[m === 12 ? 1 : m + 1]} 10</strong>. Well Testing can fill EGLE's own workbook from the
     readings already recorded — open the month, check what is there, and generate it.</p>
  <p style="margin:0 0 22px">
    <a href="${esc(link)}" style="display:inline-block;background:#0f2942;color:#fff;text-decoration:none;
       border-radius:8px;padding:13px 22px;font-weight:600">Open ${esc(period)} and generate the report →</a>
  </p>
  <p style="margin:0 0 8px;color:#334155"><strong>What ${esc(period)} holds right now:</strong></p>
  <ul style="margin:0 0 18px;padding-left:20px;color:#334155">
    <li>${wellDays} well-day${wellDays === 1 ? '' : 's'} recorded</li>
    <li>${dist} distribution sample${dist === 1 ? '' : 's'}</li>
    <li>${bacti} bacti sample${bacti === 1 ? '' : 's'}</li>
  </ul>
  ${gaps.length ? `<p style="margin:0 0 18px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;
     padding:12px 14px;color:#b45309">Worth checking before you sign: ${gaps.join('; ')}.</p>` : ''}
  <p style="margin:0 0 6px;color:#64748b;font-size:14px">The workbook is filled from exactly those records — every
     figure derived once, when the reading was stored, so the report and the screen cannot disagree.
     Add your Cover comments and sign it before sending.</p>
  <p style="margin:18px 0 0;color:#94a3b8;font-size:13px">You are getting this because you are on the access list for
     ${esc(supply.name)}. Reply to this email if it should go to someone else.</p>
</div>`;

  const text = `The ${period} report is due on the 10th.\n\n`
    + `Open ${period} and generate the report:\n${link}\n\n`
    + `What ${period} holds right now: ${wellDays} well-days, ${dist} distribution samples, ${bacti} bacti samples.\n`
    + (gaps.length ? `\nWorth checking before you sign: ${gaps.join('; ').replace(/<[^>]+>/g, '')}.\n` : '');

  return { subject: `${supply.name} — the ${period} MOR is due ${MN[m === 12 ? 1 : m + 1]} 10`, html, text };
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.ver) return res.status(200).json({ ver: VER });

  /* Same auth as api/digest.js: Vercel's own cron sends this header, and so can the VM. There is
     no unauthenticated surface here at all — the route sends mail. */
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'storage not configured' });
  if (!RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const q = req.query || {};
  const dry = q.dry === '1' || q.dry === 'true';
  /* `?force=1` re-sends a period already marked sent. For testing the message itself, and for the
     one case the idempotency guard cannot judge — she asks for it again. It is deliberately NOT
     what a scheduler sends. */
  const force = q.force === '1' || q.force === 'true';

  try {
    const now = etParts();
    // The reported period: the month that just ended, unless one is named explicitly.
    let y = Number(q.year) || (now.m === 1 ? now.y - 1 : now.y);
    let m = Number(q.month) || (now.m === 1 ? 12 : now.m - 1);
    if (!(y > 2000 && m >= 1 && m <= 12)) return res.status(400).json({ error: 'bad year/month' });

    const supplies = await sb('water_supplies?active=eq.true&select=id,wssn,name,oic_name');
    const out = [];

    for (const supply of supplies || []) {
      const step = { wssn: supply.wssn, year: y, month: m };

      // Already filed? Then there is nothing to remind anyone about.
      const filed = await sb(`water_mor_filings?supply_id=eq.${supply.id}&report_year=eq.${y}` +
        `&report_month=eq.${m}&superseded_at=is.null&select=id,submitted_date&limit=1`);
      if (filed && filed[0]) { out.push({ ...step, skipped: 'already filed', submitted: filed[0].submitted_date }); continue; }

      if (!force) {
        const already = await sb(`water_mor_reminders?supply_id=eq.${supply.id}&report_year=eq.${y}` +
          `&report_month=eq.${m}&kind=eq.due-soon&outcome=eq.sent&select=id,sent_at&limit=1`);
        if (already && already[0]) { out.push({ ...step, skipped: 'already reminded', sent_at: already[0].sent_at }); continue; }
      }

      // What the month actually holds — the useful half of the message.
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const [readings, dist, bacti] = await Promise.all([
        sb(`water_readings?supply_id=eq.${supply.id}&reading_date=gte.${from}&reading_date=lt.${to}&superseded_at=is.null&select=id`),
        sb(`water_dist_samples?supply_id=eq.${supply.id}&sample_date=gte.${from}&sample_date=lt.${to}&superseded_at=is.null&select=id`),
        sb(`water_bacti_samples?supply_id=eq.${supply.id}&collected_date=gte.${from}&collected_date=lt.${to}&select=id`),
      ]);

      /* Recipients are the people ENROLLED for this supply, not a name in a config file. That is
         the point of app_users: adding Sheila to the reminder is the same act as giving her access,
         so the two can never drift into "she can see it but never hears about it". */
      const people = await sb(`app_users?water_wssn=eq.${encodeURIComponent(supply.wssn)}&active=eq.true` +
        `&select=email,name,role&order=role`);
      const to_ = (people || []).map((p) => p.email).filter(Boolean);

      const link = `${SITE}/water/review?wssn=${encodeURIComponent(supply.wssn)}&m=${y}-${String(m).padStart(2, '0')}`;
      const msg = body({
        supply, y, m, link,
        wellDays: (readings || []).length, dist: (dist || []).length, bacti: (bacti || []).length,
      });

      if (!to_.length) {
        /* Nobody is enrolled for this supply. That is a broken reminder, and the only way it becomes
           visible is if it says so out loud to somebody who can fix it. */
        if (!dry) {
          await sendMail({
            to: [OPS_MAILBOX],
            subject: `⚠ ${supply.name}: the ${MN[m]} ${y} MOR reminder had nobody to send to`,
            html: `<p>The ${esc(MN[m])} ${y} MOR reminder for <strong>${esc(supply.name)}</strong> (WSSN ${esc(supply.wssn)})
                   could not be sent: no active <code>app_users</code> row carries <code>water_wssn = ${esc(supply.wssn)}</code>.</p>
                   <p>Enrol the operator-in-charge and the reminder will go out on the next run — this period is
                   deliberately left open for a retry.</p>`,
            text: `No active app_users row carries water_wssn = ${supply.wssn}, so the ${MN[m]} ${y} MOR reminder was not sent.`,
          });
          await sb('water_mor_reminders', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{
              supply_id: supply.id, report_year: y, report_month: m, kind: 'due-soon',
              recipients: [], outcome: 'no_recipient', subject: msg.subject,
              detail: 'no active app_users row for this wssn',
            }]),
          });
        }
        out.push({ ...step, outcome: 'no_recipient' });
        continue;
      }

      if (dry) { out.push({ ...step, outcome: 'would send', to: to_, subject: msg.subject, link }); continue; }

      let providerId = null, outcome = 'sent', detail = null;
      try {
        providerId = await sendMail({ to: to_, subject: msg.subject, html: msg.html, text: msg.text });
      } catch (e) {
        outcome = 'failed';
        detail = String(e.message || e).slice(0, 400);
      }
      await sb('water_mor_reminders', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          supply_id: supply.id, report_year: y, report_month: m, kind: 'due-soon',
          recipients: to_, provider_id: providerId, subject: msg.subject, outcome, detail,
        }]),
      });
      out.push({ ...step, outcome, to: to_, provider_id: providerId, ...(detail ? { detail } : {}) });
    }

    /* A failure inside the loop is reported with a non-2xx so a scheduler's own error handling can
       see it — the run still completed every other supply first. */
    const failed = out.some((o) => o.outcome === 'failed' || o.outcome === 'no_recipient');
    return res.status(failed ? 502 : 200).json({ ver: VER, dry, period: `${y}-${String(m).padStart(2, '0')}`, results: out });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
