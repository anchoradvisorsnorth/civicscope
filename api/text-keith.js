// api/text-keith.js — "text me": one SMS to the OWNER's own handset, from his own tooling.
//
// WHY THIS EXISTS (2026-10-21): the first "text me the route" went out through pool-sms's
// send_test, which meant typing the pool's commissioner code (FOOTBALL_POOL_CODE) into a chat.
// That code also opens save_players, lock_slate and the message log (players' PINs). Keith sits
// above the commissioner and should not need the commissioner's key to text himself — so this
// route has its own key and its own pinned recipient, and the pool code never travels for it.
//
// WHY NOT api/alert-sms.js: its recipient (ALERT_SMS_TO) is a friend's handset for an outside
// down-detector. Different recipient, different holder, different lifecycle — same shape as this.
//
// THE KEY IS NEVER TYPED. It lives in Vercel (KEITH_SMS_KEY) and as a Windows User env var on
// Keith's PC, where Cowork's `/textme` command reads it. The recipient is pinned server-side
// (KEITH_SMS_TO) — there is no recipient parameter, so a leaked key can text exactly one phone.
// There is deliberately no keyless mode: this repo is PUBLIC, and an open route to a fixed phone
// is a way for anyone to spam it and burn the pool's carrier caps.
//
// ⚠ THIS SHARES THE POOL'S A2P CAMPAIGN (sole-prop STARTER, low daily carrier caps) with the
// slate-lock and PIN texts. It is for an occasional personal text, never bulk or a loop — the
// limits below read Twilio's own log, exactly as alert-sms does, and refuse to send blind.
//
// Actions:
//   GET  ?ver=1                       — the live build's VER. Ungated, sends nothing.
//   POST {action:'status', key}       — config + budget used. Sends nothing.
//   POST {action:'send', key, text}   — one SMS to KEITH_SMS_TO. Costs money.
const VER = '1.0.0-textkeith';

const MAX_PER_HOUR = Number(process.env.KEITH_SMS_MAX_PER_HOUR || 10);
const MAX_PER_DAY = Number(process.env.KEITH_SMS_MAX_PER_DAY || 30);
// Re-running a command by accident should not text the same thing twice.
const DEDUPE_MINUTES = Number(process.env.KEITH_SMS_DEDUPE_MINUTES || 10);
// Four SMS segments. A route link with nine stops ran 298 characters; a cut URL is a dead link,
// so an over-length text is REFUSED, never truncated (pool-sms's send_test truncates silently).
const MAX_LEN = 600;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query.ver) return res.status(200).json({ ver: VER });

  const KEY_SID = process.env.TWILIO_API_KEY_SID;
  const KEY_SEC = process.env.TWILIO_API_KEY_SECRET;
  const ACCT = process.env.TWILIO_ACCOUNT_SID;
  const MSVC = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const KEY = process.env.KEITH_SMS_KEY;
  const TO = process.env.KEITH_SMS_TO;

  // Report which vars are MISSING by name — never their values.
  const missing = Object.entries({
    TWILIO_API_KEY_SID: KEY_SID, TWILIO_API_KEY_SECRET: KEY_SEC, TWILIO_ACCOUNT_SID: ACCT,
    TWILIO_MESSAGING_SERVICE_SID: MSVC, KEITH_SMS_KEY: KEY, KEITH_SMS_TO: TO,
  }).filter(([, v]) => !v).map(([k]) => k);

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const action = req.body?.action || '';
  if (!action) return res.status(400).json({ error: 'action required' });

  // Config BEFORE the key: an unset KEITH_SMS_KEY must never compare equal to an empty one.
  if (missing.length) return res.status(500).json({ error: 'not configured', missing });
  if ((req.body?.key || '') !== KEY) return res.status(403).json({ error: 'key required' });
  if (!/^\+1\d{10}$/.test(TO)) {
    return res.status(500).json({ error: 'KEITH_SMS_TO is not a valid E.164 US number' });
  }

  const auth = 'Basic ' + Buffer.from(`${KEY_SID}:${KEY_SEC}`).toString('base64');
  const tw = async (url, init) => {
    const r = await fetch(url, { ...init, headers: { Authorization: auth, ...(init?.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  };

  // Budget from Twilio's own log — a serverless function has no memory, so a counter would
  // reset on every cold start. Same reasoning as api/alert-sms.js.
  const recentTo = async () => {
    const r = await tw(`https://api.twilio.com/2010-04-01/Accounts/${ACCT}/Messages.json`
      + `?To=${encodeURIComponent(TO)}&PageSize=100`);
    if (!r.ok) return { ok: false, status: r.status };
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
      // A failed send must stay retryable, so only delivered-or-in-flight texts count as dupes.
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
        to: TO.slice(0, 2) + '••••••' + TO.slice(-4),
        limits: { perHour: MAX_PER_HOUR, perDay: MAX_PER_DAY, dedupeMinutes: DEDUPE_MINUTES, maxLength: MAX_LEN },
        used: seen.ok ? { lastHour: seen.lastHour, lastDay: seen.lastDay } : null,
        twilioReadable: seen.ok,
      });
    }

    if (action === 'send') {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ sent: false, error: 'text required' });
      if (text.length > MAX_LEN) {
        return res.status(400).json({ sent: false, error: 'text too long', length: text.length, max: MAX_LEN });
      }

      const seen = await recentTo();
      if (!seen.ok) {
        return res.status(503).json({ sent: false, reason: 'rate-limit-unreadable',
          message: `could not read the Twilio message log (${seen.status}) — refusing to send blind` });
      }
      if (seen.dupe(text)) {
        return res.status(200).json({ sent: false, reason: 'duplicate',
          message: `identical text already sent within ${DEDUPE_MINUTES} min` });
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
      // Never swallowed: "sent" and "silently failed" must not look alike (Pools, 2026-09-14).
      if (!r.ok) {
        return res.status(502).json({ sent: false, reason: 'twilio-rejected', status: r.status,
          twilioCode: r.body?.code, message: r.body?.message });
      }
      return res.status(200).json({ sent: true, sid: r.body.sid, status: r.body.status,
        length: text.length, used: { lastHour: seen.lastHour + 1, lastDay: seen.lastDay + 1 } });
    }

    return res.status(400).json({ error: `unknown action '${action}'` });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
}
