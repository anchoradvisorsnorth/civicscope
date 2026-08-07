// api/pool-sms.js — Twilio SMS for The Pool. A2P 10DLC campaign approved 2026-08-05
// (CM4c09562b04c9634b6d2fdf05b833c099, brand BN76355c81d41f007b60437f19a8d3c5fd, use case STARTER).
//
// WHY THIS FILE EXISTS AT ALL: the five TWILIO_* vars are marked **Sensitive** in Vercel, so
// `vercel env pull` returns them empty and the credentials CANNOT be tested from a laptop. The
// only place they are readable is the deployed runtime — so the credential check has to live
// server-side. That is a feature, not a workaround.
//
// Actions (all commissioner-gated by FOOTBALL_POOL_CODE):
//   verify     — proves the credentials authenticate, the number is attached to the messaging
//                service, and the campaign is registered. Sends nothing. Returns NO secrets.
//   send_test  — one real SMS to an explicit number. Costs money; gated and never bulk.
//
// ⚠ CONSENT LAW (this is what four rejections were about): only ever message someone whose
// smsConsent is true from their own /pool/sms registration. Never message a number typed in by
// the commissioner on someone else's behalf — forced/implied consent is rejection 30923 and it
// would put an approved campaign at risk. send_test is for Keith's own handset only.
const CODE = () => process.env.FOOTBALL_POOL_CODE;
// Bump on every change — GET ?ver=1 returns it, so the LIVE function build is verifiable
// (the Vercel webhook has served stale function builds before; CLAUDE.md deploy gotcha 2026-07-16).
const VER = '1.0.0-sms';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET' && req.query.ver) return res.status(200).json({ ver: VER });

  const KEY_SID  = process.env.TWILIO_API_KEY_SID;
  const KEY_SEC  = process.env.TWILIO_API_KEY_SECRET;
  const ACCT     = process.env.TWILIO_ACCOUNT_SID;
  const MSVC     = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const FROM     = process.env.TWILIO_FROM_NUMBER;

  // Report which vars are MISSING by name — never their values.
  const missing = Object.entries({ TWILIO_API_KEY_SID: KEY_SID, TWILIO_API_KEY_SECRET: KEY_SEC,
    TWILIO_ACCOUNT_SID: ACCT, TWILIO_MESSAGING_SERVICE_SID: MSVC, TWILIO_FROM_NUMBER: FROM })
    .filter(([, v]) => !v).map(([k]) => k);

  const auth = 'Basic ' + Buffer.from(`${KEY_SID}:${KEY_SEC}`).toString('base64');
  const tw = async (url, init) => {
    const r = await fetch(url, { ...init, headers: { Authorization: auth, ...(init?.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  };

  try {
    const action = req.method === 'POST' ? (req.body?.action || '') : (req.query.action || '');
    const pw     = req.method === 'POST' ? (req.body?.pw || '') : (req.query.pw || '');
    if (!action) return res.status(400).json({ error: 'action required' });
    if (pw !== CODE()) return res.status(403).json({ error: 'commissioner code required' });
    if (missing.length) return res.status(500).json({ error: 'missing env vars', missing });

    if (action === 'verify') {
      const out = { ver: VER, checks: {} };

      // 1. Do the credentials authenticate at all?
      const svc = await tw(`https://messaging.twilio.com/v1/Services/${MSVC}`);
      out.checks.credentials = svc.ok
        ? { pass: true, messagingService: svc.body.friendly_name }
        : { pass: false, status: svc.status, twilioCode: svc.body?.code, message: svc.body?.message };
      if (!svc.ok) return res.status(200).json(out);

      // 2. Is a number actually attached? An approved campaign with no number still cannot send —
      //    that failure looks like a code bug and isn't one.
      const nums = await tw(`https://messaging.twilio.com/v1/Services/${MSVC}/PhoneNumbers`);
      const list = (nums.body?.phone_numbers || []).map(n => n.phone_number);
      out.checks.numberAttached = {
        pass: list.length > 0 && list.includes(FROM),
        attached: list,
        expected: FROM,
      };

      // 3. Is the A2P campaign registered against THIS messaging service?
      const a2p = await tw(`https://messaging.twilio.com/v1/Services/${MSVC}/Compliance/Usa2p`);
      const comp = a2p.body?.compliance || (a2p.body?.sid ? [a2p.body] : []);
      out.checks.campaign = {
        pass: comp.some(c => String(c.campaign_status || '').toUpperCase() === 'VERIFIED'
                          || String(c.campaign_status || '').toUpperCase() === 'APPROVED'),
        campaigns: comp.map(c => ({ sid: c.sid, status: c.campaign_status, useCase: c.us_app_to_person_usecase })),
      };

      // 4. Account live (not trial) — a trial account silently refuses unverified recipients.
      const acct = await tw(`https://api.twilio.com/2010-04-01/Accounts/${ACCT}.json`);
      out.checks.account = { pass: acct.ok && acct.body?.status === 'active',
        type: acct.body?.type, status: acct.body?.status };

      out.readyToSend = Object.values(out.checks).every(c => c.pass);
      return res.status(200).json(out);
    }

    if (action === 'send_test') {
      const to = String(req.body?.to || '').trim();
      if (!/^\+1\d{10}$/.test(to)) {
        return res.status(400).json({ error: 'to must be E.164, e.g. +15743602630' });
      }
      const body = String(req.body?.body || 'The Pool: SMS is live. Reply STOP to opt out.').slice(0, 300);
      const form = new URLSearchParams({ To: to, MessagingServiceSid: MSVC, Body: body });
      const r = await tw(`https://api.twilio.com/2010-04-01/Accounts/${ACCT}/Messages.json`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      if (!r.ok) {
        return res.status(200).json({ sent: false, status: r.status,
          twilioCode: r.body?.code, message: r.body?.message, moreInfo: r.body?.more_info });
      }
      return res.status(200).json({ sent: true, sid: r.body.sid, status: r.body.status, to: r.body.to });
    }

    return res.status(400).json({ error: `unknown action '${action}'` });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
}
