// api/alert-sms.js — a single-destination SMS relay for an OUTSIDE monitoring system.
//
// WHY THIS IS NOT A NEW ACTION IN api/pool-sms.js: it shares Twilio transport with the pool and
// NOTHING else. Different credential, different recipient, different owner, different lifecycle.
// Bolting it into pool-sms.js would mean the pool's commissioner code (FOOTBALL_POOL_CODE) is the
// credential a third party holds — and that code also gates save_players, lock_slate and the
// message log, which carries players' PINs in plain text. It stays out.
//
// WHAT IT DOES: accepts a short text from a caller holding ALERT_SMS_CODE and sends it to ONE
// number, ALERT_SMS_TO, which is fixed server-side. There is no recipient parameter. A caller who
// steals the code can text exactly one handset — the one belonging to the person who holds it.
//
// ⚠ THIS SHARES THE POOL'S A2P CAMPAIGN AND THEREFORE THE POOL'S CARRIER THROUGHPUT.
// The campaign (CM4c0956…) is a sole-prop STARTER registration with low per-day carrier caps. A
// monitor that flaps can send hundreds of messages in an hour, and the pool's slate-lock texts,
// PIN texts and all-picks-in texts would start failing with no obvious cause. THAT is the real
// risk here, not compliance — so the limits below are not decoration and must not be raised to
// make a noisy monitor quieter. Fix the monitor.
//
// Actions:
//   GET  ?ver=1                     — the live build's VER. Ungated, sends nothing.
//   POST {action:'status', pw}      — config + how much of the budget is spent. Sends nothing.
//   POST {action:'alert', pw, text} — one SMS to ALERT_SMS_TO. Costs money.
const VER = '1.0.0-alert';

// Budget. Deliberately low: this is an outage alerter, not a feed.
const MAX_PER_HOUR = Number(process.env.ALERT_SMS_MAX_PER_HOUR || 6);
const MAX_PER_DAY = Number(process.env.ALERT_SMS_MAX_PER_DAY || 24);
// A flapping monitor re-sends the SAME line every cycle. Identical text inside this window is
// suppressed and reported as suppressed — NOT silently dropped, and NOT counted as sent.
const DEDUPE_MINUTES = Number(process.env.ALERT_SMS_DEDUPE_MINUTES || 15);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Safe contract for the deploy gate: proves THIS build is live without sending anything.
  if (req.method === 'GET' && req.query.ver) return res.status(200).json({ ver: VER });

  const KEY_SID = process.env.TWILIO_API_KEY_SID;
  const KEY_SEC = process.env.TWILIO_API_KEY_SECRET;
  const ACCT = process.env.TWILIO_ACCOUNT_SID;
  const MSVC = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const CODE = process.env.ALERT_SMS_CODE;
  const TO = process.env.ALERT_SMS_TO;

  // Report which vars are MISSING by name — never their values.
  const missing = Object.entries({
    TWILIO_API_KEY_SID: KEY_SID, TWILIO_API_KEY_SECRET: KEY_SEC, TWILIO_ACCOUNT_SID: ACCT,
    TWILIO_MESSAGING_SERVICE_SID: MSVC, ALERT_SMS_CODE: CODE, ALERT_SMS_TO: TO,
  }).filter(([, v]) => !v).map(([k]) => k);

  const action = req.method === 'POST' ? (req.body?.action || '') : (req.query.action || '');
  if (!action) return res.status(400).json({ error: 'action required' });

  // ORDER MATTERS. Check the config BEFORE the code, or an unset ALERT_SMS_CODE compares against
  // an empty string and the relay opens to the world the moment someone forgets an env var.
  if (missing.length) return res.status(500).json({ error: 'not configured', missing });

  const pw = req.method === 'POST' ? (req.body?.pw || '') : (req.query.pw || '');
  if (pw !== CODE) return res.status(403).json({ error: 'alert code required' });

  // ALERT_SMS_TO is validated here rather than trusted: a typo in a Vercel env var would otherwise
  // send someone else's phone an outage alert forever, and nobody would be told.
  if (!/^\+1\d{10}$/.test(TO)) {
    return res.status(500).json({ error: 'ALERT_SMS_TO is not a valid E.164 US number' });
  }

  const auth = 'Basic ' + Buffer.from(`${KEY_SID}:${KEY_SEC}`).toString('base64');
  const tw = async (url, init) => {
    const r = await fetch(url, { ...init, headers: { Authorization: auth, ...(init?.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  };

  /* THE RATE LIMIT READS TWILIO'S OWN MESSAGE LOG — there is no counter table anywhere.
     A serverless function has no memory between invocations, so a local counter would reset on
     every cold start and enforce nothing. Twilio already knows exactly what it sent to this
     number; asking it is the only answer that cannot drift from reality. Costs one API read. */
  const recentTo = async () => {
    const r = await tw(`https://api.twilio.com/2010-04-01/Accounts/${ACCT}/Messages.json`
      + `?To=${encodeURIComponent(TO)}&PageSize=100`);
    if (!r.ok) return { ok: false, status: r.status, message: r.body?.message };
    const now = Date.now();
    const msgs = (r.body?.messages || []).map(m => ({
      at: Date.parse(m.date_sent || m.date_created || 0) || 0,
      body: String(m.body || ''),
      status: m.status,
    })).filter(m => m.at > 0);
    return {
      ok: true,
      lastHour: msgs.filter(m => now - m.at < 3600e3).length,
      lastDay: msgs.filter(m => now - m.at < 86400e3).length,
      // Only messages we actually handed to a carrier count as a duplicate. A failed send must be
      // retryable — suppressing a retry because the FAILED attempt "already said that" would turn
      // one lost alert into permanent silence about an outage.
      dupe: (text) => msgs.some(m =>
        m.body === text
        && now - m.at < DEDUPE_MINUTES * 60e3
        && !['failed', 'undelivered'].includes(String(m.status))),
    };
  };

  try {
    if (action === 'status') {
      const seen = await recentTo();
      return res.status(200).json({
        ver: VER,
        // The destination is echoed MASKED. The caller already knows the number — it is his own —
        // but this response is the thing most likely to end up pasted into a log or a chat.
        to: TO.slice(0, 2) + '••••••' + TO.slice(-4),
        limits: { perHour: MAX_PER_HOUR, perDay: MAX_PER_DAY, dedupeMinutes: DEDUPE_MINUTES },
        used: seen.ok ? { lastHour: seen.lastHour, lastDay: seen.lastDay } : null,
        twilioReadable: seen.ok,
        note: seen.ok ? undefined : `could not read Twilio message log (${seen.status})`,
      });
    }

    if (action === 'alert') {
      const raw = String(req.body?.text || '').trim();
      if (!raw) return res.status(400).json({ error: 'text required' });
      // 280 is two SMS segments plus the opt-out line. An alert that needs more than that is a
      // report, and a report does not belong in a text message.
      if (raw.length > 280) {
        return res.status(400).json({ error: 'text too long', length: raw.length, max: 280 });
      }
      const text = `${raw} Reply STOP to opt out.`;

      const seen = await recentTo();
      // A budget we cannot read is a budget we cannot enforce. Refusing is the safe direction:
      // the failure this protects against is the pool losing its texts to someone else's flap.
      if (!seen.ok) {
        return res.status(503).json({ sent: false, reason: 'rate-limit-unreadable',
          message: `could not read the Twilio message log (${seen.status}) — refusing to send blind` });
      }
      if (seen.dupe(text)) {
        return res.status(200).json({ sent: false, reason: 'duplicate',
          message: `identical text already sent within ${DEDUPE_MINUTES} min`,
          used: { lastHour: seen.lastHour, lastDay: seen.lastDay } });
      }
      if (seen.lastHour >= MAX_PER_HOUR || seen.lastDay >= MAX_PER_DAY) {
        return res.status(429).json({ sent: false, reason: 'rate-limited',
          used: { lastHour: seen.lastHour, lastDay: seen.lastDay },
          limits: { perHour: MAX_PER_HOUR, perDay: MAX_PER_DAY } });
      }

      const r = await tw(`https://api.twilio.com/2010-04-01/Accounts/${ACCT}/Messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: TO, MessagingServiceSid: MSVC, Body: text }),
      });
      // Never a swallowed catch. The caller is a monitoring system: if it cannot tell a delivered
      // alert from a dropped one, it is not a monitoring system. (Pools/CLAUDE.md 2026-08-13 —
      // "the group was texted" and "every text failed" left identical evidence: none.)
      if (!r.ok) {
        return res.status(502).json({ sent: false, reason: 'twilio-rejected', status: r.status,
          twilioCode: r.body?.code, message: r.body?.message, moreInfo: r.body?.more_info });
      }
      return res.status(200).json({ sent: true, sid: r.body.sid, status: r.body.status,
        used: { lastHour: seen.lastHour + 1, lastDay: seen.lastDay + 1 } });
    }

    return res.status(400).json({ error: `unknown action '${action}'` });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
}
