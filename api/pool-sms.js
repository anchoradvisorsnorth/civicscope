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
const VER = '1.1.1-inbound';   // title-case multi-word names in the JOIN reply

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
    /* ============ INBOUND: the member texts IN, and THAT is the consent ============
       Keith 2026-08-07: Mike texts the invite from his own phone, the member texts JOIN to the pool
       number, and we marry the inbound number back to a participant.

       WHY THIS SHAPE AND NOT AN OUTBOUND "reply YES" — you cannot text someone to ask permission
       to text them; that first message is itself unsolicited and is exactly A2P rejection 30923.
       A MOBILE-ORIGINATED opt-in inverts it: the member initiates, so consent is unambiguous,
       self-documenting (their own message is the record) and needs no web form.

       THE JOIN KEY IS THE MOBILE ON THE ROSTER. The commissioner types the number in as
       contact/identity — which by itself never permits a text — and when that same number texts
       in, the two halves marry: identity from the roster, permission from the member. An unknown
       number is never guessed at; it is told to ask Mike. */
    const isInbound = (req.query.action === 'inbound') || (req.body && req.body.From && req.body.Body !== undefined);
    if (isInbound) {
      const twiml = (msg) => {
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${
          msg ? `<Message>${String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</Message>` : ''
        }</Response>`);
      };
      /* Twilio signature validation needs the ACCOUNT AUTH TOKEN, which this app deliberately does
         not hold (it uses a revocable API key instead). So the webhook URL carries a shared secret
         instead. Weaker than a signature, honestly stated: worst case someone who learned the URL
         could forge an opt-in for a number already on the roster. For a seven-person private pool
         that is an acceptable trade; if this ever grows, add TWILIO_AUTH_TOKEN and validate
         X-Twilio-Signature properly. */
      const wantSecret = process.env.TWILIO_INBOUND_SECRET;
      if (wantSecret && req.query.s !== wantSecret) return res.status(403).send('forbidden');

      const digits = String(req.body.From || '').replace(/\D/g, '');
      const from = digits.length === 11 && digits[0] === '1' ? '+' + digits : (digits.length === 10 ? '+1' + digits : '');
      const text = String(req.body.Body || '').trim().toUpperCase();
      if (!from) return twiml('');

      const sb = async (path, init) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', ...(init?.headers || {}),
        },
      });
      const found = await sb(`pool_people?phone=eq.${encodeURIComponent(from)}&select=id,name,pin,sms_consent`);
      const person = found.ok ? (await found.json())[0] : null;

      if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(text)) {
        // Twilio blocks further sends itself; mirror it so our own UI stops claiming they'll be texted.
        if (person) await sb(`pool_people?id=eq.${person.id}`, { method: 'PATCH',
          body: JSON.stringify({ sms_opted_out: true, updated_at: new Date().toISOString() }) });
        return twiml('');   // Twilio sends its own STOP confirmation; a second one is spam.
      }
      if (/^HELP$/.test(text)) {
        return twiml('The Pool: weekly pick reminders, deadlines and results. Reply JOIN to turn texts on, STOP to turn them off. Questions: Mike.');
      }
      if (!person) {
        return twiml('The Pool: this number is not on the roster yet. Ask Mike to add your mobile, then text JOIN again.');
      }
      if (/^(JOIN|START|YES|UNSTOP)$/.test(text)) {
        await sb(`pool_people?id=eq.${person.id}`, { method: 'PATCH',
          body: JSON.stringify({
            sms_consent: true, sms_opted_out: false,
            sms_consent_at: new Date().toISOString(),
            // The member's OWN inbound message, stored verbatim — the consent record is the
            // artifact itself, not a checkbox we ticked on their behalf.
            sms_consent_text: `Mobile-originated opt-in. Inbound SMS from ${from}: "${String(req.body.Body || '').slice(0, 200)}"`,
            updated_at: new Date().toISOString(),
          }) });
        // Title-case per WORD. Lower-casing everything after the first letter turned "KEITH T1"
        // into "Keith t1" — rosters are stored upper-case, so names are frequently multi-word.
        const nm = String(person.name || '').toLowerCase()
          .replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
        return twiml(`You're in, ${nm}. Your PIN is ${person.pin}. Picks: app.civicscope.io/pool/football/picks — Reply STOP any time to turn texts off.`);
      }
      return twiml('The Pool: reply JOIN to turn on text alerts, STOP to turn them off, HELP for info.');
    }

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

      // readyToSend is decided by the three checks above. Everything below is INFORMATIONAL.
      out.readyToSend = ['credentials', 'numberAttached', 'campaign'].every(k => out.checks[k].pass);

      /* 4. Account metadata — INFORMATIONAL ONLY, and expected to fail.
         A **Standard** API key is deliberately not authorized for the Account resource, so this
         returns 401. That is the key type working as intended, NOT a credential problem, and it
         must never gate readyToSend — the first version of this file did, and reported
         readyToSend:false while all three real checks passed.
         The thing this was trying to prove (account upgraded, not trial) is better proven by an
         actual send: a trial account rejects unverified recipients with error 21608. */
      const acct = await tw(`https://api.twilio.com/2010-04-01/Accounts/${ACCT}.json`);
      out.accountInfo = acct.ok
        ? { readable: true, type: acct.body?.type, status: acct.body?.status }
        : { readable: false, status: acct.status,
            note: 'Expected for a Standard API key — not authorized for the Account resource. Not a credential fault.' };

      return res.status(200).json(out);
    }

    /* Points Twilio's inbound webhook at this endpoint. It lives here for the same reason `verify`
       does: the TWILIO_* vars are Sensitive in Vercel, so they are readable ONLY inside the
       deployed runtime — a laptop cannot make this call. The secret is composed server-side and
       never travels in a response. */
    if (action === 'set_inbound_webhook') {
      const secret = process.env.TWILIO_INBOUND_SECRET;
      if (!secret) return res.status(500).json({ error: 'TWILIO_INBOUND_SECRET not set' });
      const target = `https://app.civicscope.io/api/pool-sms?action=inbound&s=${encodeURIComponent(secret)}`;
      const form = new URLSearchParams({ InboundRequestUrl: target, InboundMethod: 'POST' });
      const r = await tw(`https://messaging.twilio.com/v1/Services/${MSVC}`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      if (!r.ok) return res.status(200).json({ set: false, status: r.status, message: r.body?.message });
      return res.status(200).json({
        set: true,
        inboundMethod: r.body.inbound_method,
        // Echo the URL with the secret masked — enough to confirm it landed, nothing leaked.
        inboundUrl: String(r.body.inbound_request_url || '').replace(/([?&]s=)[^&]*/, '$1<secret>'),
      });
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
