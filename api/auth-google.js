// api/auth-google.js — Google sign-in for the village products.
//
// WHAT THIS CLOSES
// Every surface built for the Village of Centreville has been open on its link and has said so in
// plain words rather than pretending otherwise. `WATER_OPS_CODE` was never a gate on a person —
// Keith, asked directly on 2026-08-21: *"there is no plant access code."* It is an environment
// variable a script presents. Both this repo's CLAUDE.md and Centreville's have named Google
// sign-in as the thing that actually closes the OIC surface. Keith, 2026-08-25: *"Michelle wants to
// log in using the oauth on her account… She has an assistant that wants to do the same."*
//
// ⛔ THE CREW DO NOT SIGN IN, AND THIS ROUTE MUST NEVER BE PUT IN FRONT OF THEM.
// Keith, 2026-08-19: *"this is the wellhouse app - it need to be super simple - pick a well - no
// login"*, and 2026-08-25: Mark Major and Jeff Derrikson *"wont have email logins."* The tablet in
// the well house asks for a name and nothing else, which is the paper's own model — a "Done by"
// column holding initials. Sign-in is for the office: Michelle (the OIC, who signs the MOR under
// 1976 PA 399) and her assistant.
//
// ⛔ GOOGLE PROVES AN ADDRESS, NOT AN EMPLOYMENT.
// A verified ID token means Google believes this browser controls that mailbox. It says nothing
// about whether the person works for the village. Collapsing those two claims is how "sign in with
// Google" becomes "anyone with a Gmail account can correct a compliance record". So the token is
// the first of TWO checks and `app_users` is the second: a verified account that is not enrolled
// gets a pending row and no access. Enrolment is a deliberate act by a human.
//
// WHY THE TOKEN IS VERIFIED HERE RATHER THAN AT tokeninfo
// `https://oauth2.googleapis.com/tokeninfo` is a debugging endpoint: it puts an unmetered
// third-party round trip on the critical path of every sign-in and gives up the ability to say
// exactly which claim failed. The verification below is the whole of it — RS256 over Google's
// published keys, then issuer, audience, expiry and email_verified, with the key set cached and
// re-fetched only when a `kid` is unknown (which is what a key rotation looks like from here).
//
// NO CLIENT SECRET EXISTS FOR THIS FLOW. Sign in with Google returns an ID token straight to the
// page; we verify it and mint our own session. There is no code exchange, no refresh token, and
// therefore no long-lived Google credential to store, rotate or leak. The only secret this route
// holds is AUTH_SESSION_SECRET, which signs our own cookie.

export const config = { maxDuration: 15 };

import crypto from 'node:crypto';
import { signSession, sessionCookie, sessionOf, SESSION_COOKIE } from '../lib/session.js';

export const VER = '1.0.0-auth';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SECRET = process.env.AUTH_SESSION_SECRET || '';

/* ⛔ EACH VILLAGE BRINGS ITS OWN SIGN-IN (Keith, 2026-08-25: "this is village specific… There will
   be more villages with different credentials (maybe not even google)").

   This started as one global GOOGLE_SIGNIN_CLIENT_ID, which would not have survived village #2 and
   would have survived a village on Microsoft 365 even less. The client id is now a column on
   `muni_tenants` (migration 033) — configuration, like `water_feeds` and `mor_template`, so a new
   village is a row rather than a release.

   The env var stays as a FALLBACK only: it is what a deployment with a single village, or a preview
   build, resolves to when the tenant carries no client of its own. A tenant value always wins. */
const FALLBACK_CLIENT_ID = process.env.GOOGLE_SIGNIN_CLIENT_ID || '';

/* Resolve one village's sign-in configuration. Returns { provider, clientId, tenant } — `clientId`
   empty means "not configured for this village", which the hub renders as an honest sentence rather
   than a dead button. */
async function authConfig(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { provider: 'google', clientId: FALLBACK_CLIENT_ID, tenant: null };
  let row = null;
  try {
    const rows = await sb(`muni_tenants?slug=eq.${encodeURIComponent(s)}&select=slug,label,auth_provider,auth_client_id`);
    row = rows && rows[0];
  } catch { /* fall through to the fallback below */ }
  if (!row) return { provider: 'google', clientId: FALLBACK_CLIENT_ID, tenant: null };
  return {
    provider: row.auth_provider || 'google',
    clientId: row.auth_client_id || FALLBACK_CLIENT_ID,
    tenant: row.slug,
    label: row.label,
  };
}

const SESSION_TTL = 30 * 24 * 3600;   // 30 days, absolute. No refresh: a session ends by itself.
const SKEW = 120;                     // seconds of clock tolerance on iat/exp

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

// ── Google's signing keys ──────────────────────────────────────────────────────────────────────
// Cached in module scope for the life of a warm lambda. Google rotates these, and a rotation shows
// up here as a `kid` we have never seen — which forces exactly one refetch rather than a wave of
// failed sign-ins. Caching without that escape hatch is how an integration breaks on Google's
// schedule instead of ours.
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwks = { keys: [], fetchedAt: 0 };

async function googleKey(kid, { force = false } = {}) {
  const stale = Date.now() - jwks.fetchedAt > 3600_000;
  if (force || stale || !jwks.keys.length) {
    const r = await fetch(JWKS_URL);
    if (!r.ok) throw new Error(`google jwks ${r.status}`);
    const j = await r.json();
    jwks = { keys: j.keys || [], fetchedAt: Date.now() };
  }
  const hit = jwks.keys.find((k) => k.kid === kid);
  if (hit || force) return hit || null;
  return googleKey(kid, { force: true });
}

const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify a Google ID token. Returns `{ ok:true, claims }` or `{ ok:false, why }`.
 * `why` is for OUR log, never for the caller — see the response builder below.
 */
async function verifyIdToken(token, clientId) {
  if (!clientId) return { ok: false, why: 'no OAuth client is configured for this village' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, why: 'not a JWT' };

  let header, claims;
  try {
    header = JSON.parse(unb64u(parts[0]).toString('utf8'));
    claims = JSON.parse(unb64u(parts[1]).toString('utf8'));
  } catch { return { ok: false, why: 'unparseable' }; }

  /* ⛔ THE ALGORITHM IS OURS TO CHOOSE, NOT THE TOKEN'S. Reading `header.alg` and verifying with
     whatever it names is the alg-confusion bug in its original form — a token claiming `none`, or
     claiming HS256 so the verifier HMACs with a public key it treats as a shared secret. Google
     signs ID tokens with RS256. Anything else is a forgery attempt, full stop. */
  if (header.alg !== 'RS256') return { ok: false, why: `alg ${header.alg}` };
  if (!header.kid) return { ok: false, why: 'no kid' };

  const jwk = await googleKey(header.kid);
  if (!jwk) return { ok: false, why: `unknown kid ${header.kid}` };

  let pub;
  try { pub = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { return { ok: false, why: 'bad jwk' }; }

  const sigOk = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, unb64u(parts[2]));
  if (!sigOk) return { ok: false, why: 'bad signature' };

  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return { ok: false, why: `iss ${claims.iss}` };
  /* ⛔ THE AUDIENCE CHECK IS THE WHOLE SECURITY PROPERTY, AND IT NOW FOLLOWS THE VILLAGE.
     It is what stops a token minted for SOMEBODY ELSE'S Google app — perfectly valid, correctly
     signed by Google — being replayed here as a sign-in. With one client id per village, "somebody
     else's app" includes ANOTHER VILLAGE'S client, so the id compared here must be the one belonging
     to the tenant being signed into, never a global. The caller passes it; there is no ambient
     default that could quietly make this pass. */
  if (claims.aud !== clientId) return { ok: false, why: 'aud mismatch' };
  if (!(Number(claims.exp) > now - SKEW)) return { ok: false, why: 'expired' };
  if (Number(claims.iat) > now + SKEW) return { ok: false, why: 'issued in the future' };
  if (!claims.email) return { ok: false, why: 'no email claim' };
  /* An unverified address is one somebody typed, not one Google has confirmed they control. An
     allowlist keyed on email is worth nothing without this line. */
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, why: 'email not verified' };
  if (!claims.sub) return { ok: false, why: 'no sub' };

  return { ok: true, claims };
}

// ── the record of who tried ────────────────────────────────────────────────────────────────────
// Denials are the interesting half. A run of attempts on an address nobody recognises is the only
// signal this design produces that something is wrong, and it exists only if it is written down.
async function logAttempt(req, row) {
  try {
    await sb('app_sign_ins', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        ...row,
        ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 400) || null,
        host: String(req.headers.host || '') || null,
      }]),
    });
  } catch { /* the audit row must never be the reason a legitimate sign-in fails */ }
}

// What the browser is allowed to know about a signed-in person. Deliberately not `select *`: the
// row carries notes and an invited_by that are ours, not theirs.
const publicUser = (u) => ({
  email: u.email, name: u.name || null, picture: u.picture_url || null,
  role: u.role, muni_tenant: u.muni_tenant || null, water_wssn: u.water_wssn || null,
  water_operator_id: u.water_operator_id || null,
});

async function findUser({ sub, email }) {
  if (sub) {
    const bySub = await sb(`app_users?google_sub=eq.${encodeURIComponent(sub)}&select=*&limit=1`);
    if (bySub && bySub[0]) return bySub[0];
  }
  // `ilike` with no wildcards is case-insensitive equality, matching the unique index on lower(email).
  const byEmail = await sb(`app_users?email=ilike.${encodeURIComponent(email)}&select=*&limit=1`);
  return (byEmail && byEmail[0]) || null;
}

const bad = (res, code, msg, extra = {}) => res.status(code).json({ ok: false, error: msg, ...extra });

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // The version probe the deploy's API-contract registry reads. Also the cheapest possible
    // answer to "did this route even ship".
    // Deployment-level readiness only. Whether a given VILLAGE can sign in is a per-tenant question
    // and is answered by `me` with a tenant — this cannot know which village is asking.
    return res.status(200).json({ ver: VER, sessionsConfigured: Boolean(SECRET) });
  }
  if (req.method !== 'POST') return bad(res, 405, 'POST only');

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const action = body.action;

  try {
    switch (action) {
      /* ---- who is this browser? ------------------------------------------------------------
         Called by every page on load. It answers three things at once: whether sign-in is even
         configured on this deployment, the client id the page needs to render Google's button, and
         who (if anyone) is currently signed in.

         ⚠ `configured:false` IS A REAL ANSWER AND THE PAGES MUST HONOUR IT. Until the OAuth client
         exists, the honest page is one that says sign-in is not switched on yet — not one showing a
         button that opens a Google error. That is the same rule the village hub already followed
         when it described sign-in in words instead of mocking up a control. */
      case 'me': {
        // Which village is asking. The hub knows its own slug from the path; a page that does not
        // send one gets the deployment fallback, which is correct for a single-village build.
        const cfg = await authConfig(body.tenant);
        const usable = cfg.provider === 'google' && Boolean(cfg.clientId) && Boolean(SECRET);
        const s = sessionOf(req);
        if (!s) return res.status(200).json({ ok: true, signedIn: false, configured: usable, client_id: (usable && cfg.clientId) || null, provider: cfg.provider });

        /* The session is re-checked against the allowlist on every call rather than trusted for its
           full 30 days. Deactivating somebody has to take effect when it is done, not when their
           cookie happens to expire — otherwise "remove their access" is a sentence with no
           mechanism behind it. */
        const u = await findUser({ sub: s.sub, email: s.email });
        if (!u || !u.active) {
          res.setHeader('Set-Cookie', sessionCookie('', { req }));
          return res.status(200).json({ ok: true, signedIn: false, revoked: true, configured: usable, client_id: (usable && cfg.clientId) || null, provider: cfg.provider });
        }
        /* ⛔ A SESSION IS NOT A PASS INTO EVERY VILLAGE. Signed in for Centreville must not read as
           signed in on village #2's hub — otherwise the per-village client ids above would be
           decoration, since the session that follows a sign-in is domain-wide by design (one cookie
           across civicscope.io and app.civicscope.io, which is what stops a second prompt). CivicScope
           admins are the deliberate exception. */
        /* ⚠ NULL IS NOT A WILDCARD. This read `u.muni_tenant && u.muni_tenant !== cfg.tenant`, so a
           row with no tenant short-circuited past the check and was admitted by EVERY village. The
           water side enrols people by `water_wssn`, so an active operator row with no `muni_tenant`
           is a perfectly ordinary thing to create — and it would have opened every gated hub. An
           entitlement has to be granted, never inferred from an absent field. */
        if (cfg.tenant && u.role !== 'admin' && u.muni_tenant !== cfg.tenant) {
          return res.status(200).json({
            ok: true, signedIn: false, wrongTenant: true, configured: usable,
            client_id: (usable && cfg.clientId) || null, provider: cfg.provider,
            msg: `${u.email} is signed in, but is not on the access list for ${cfg.label || cfg.tenant}.`,
          });
        }
        return res.status(200).json({ ok: true, signedIn: true, configured: true, client_id: cfg.clientId, provider: cfg.provider, user: publicUser(u) });
      }

      /* ---- exchange Google's ID token for our session --------------------------------------- */
      case 'signin': {
        const cfg = await authConfig(body.tenant);
        /* A provider this route does not implement is REFUSED, never quietly treated as Google.
           A column that falls through to one provider reads as support that does not exist, and the
           failure would surface as an inexplicable "could not be verified" for a whole village. */
        if (cfg.provider !== 'google') {
          return bad(res, 501, cfg.provider === 'none'
            ? 'Sign-in is not switched on for this village.'
            : `This village signs in with ${cfg.provider}, which is not built yet.`);
        }
        if (!cfg.clientId || !SECRET) return bad(res, 503, 'Sign-in is not configured for this village.');
        const v = await verifyIdToken(body.credential, cfg.clientId);
        if (!v.ok) {
          /* The caller is told the credential was not accepted and nothing else. `v.why` —
             "aud mismatch", "expired", "bad signature" — goes to our own log, because a verifier
             that reports exactly which claim failed is a verifier that helps somebody tune their
             next attempt. */
          await logAttempt(req, { outcome: 'rejected', reason: v.why });
          return bad(res, 401, 'That Google sign-in could not be verified.');
        }

        const c = v.claims;
        const email = String(c.email).toLowerCase();
        let u = await findUser({ sub: c.sub, email });

        if (!u) {
          /* ⛔ AN UNKNOWN ACCOUNT GETS A ROW, NOT ACCESS. The row is a request: it captures the
             exact address the person actually used, which is the thing that otherwise turns
             enrolling somebody into a round of "which Gmail did you sign in with?". `active`
             defaults to false in the schema and nothing here overrides it. */
          try {
            const ins = await sb('app_users', {
              method: 'POST', headers: { Prefer: 'return=representation' },
              body: JSON.stringify([{ email, name: c.name || null, picture_url: c.picture || null, google_sub: c.sub }]),
            });
            u = ins && ins[0];
          } catch { /* a race with a concurrent first sign-in — re-read below */ }
          if (!u) u = await findUser({ sub: c.sub, email });
          await logAttempt(req, { outcome: 'pending', email, google_sub: c.sub, user_id: u ? u.id : null, reason: 'not enrolled' });
          return res.status(200).json({
            ok: true, signedIn: false, pending: true, email,
            msg: `${email} is not on the access list for this village yet. Ask the village office or CivicScope to add it — the request has been recorded.`,
          });
        }

        if (!u.active) {
          await logAttempt(req, { outcome: u.sign_in_count > 0 ? 'denied' : 'pending', email, google_sub: c.sub, user_id: u.id, reason: 'account not active' });
          return res.status(200).json({
            ok: true, signedIn: false, pending: true, email,
            msg: `${email} is on file but has not been switched on yet. Ask the village office or CivicScope to enable it.`,
          });
        }

        /* ⛔ THE THIRD CHECK, AND THE ONE THAT IS EASY TO LEAVE OUT. The token verified against THIS
           village's client and the person is enrolled — but enrolled for WHICH village? Without this
           line, somebody legitimately enrolled for village B who signs in on village A's hub (whose
           client accepted them because they hold an account in both, or because A's client id was
           reused) would be handed a session that `me` then honours. Per-village client ids only mean
           something if the allowlist is checked against the same tenant they were verified for. */
        // Same correction as in `me`: an absent muni_tenant is no entitlement, not a universal one.
        if (cfg.tenant && u.role !== 'admin' && u.muni_tenant !== cfg.tenant) {
          await logAttempt(req, { outcome: 'denied', email, google_sub: c.sub, user_id: u.id, reason: `enrolled for ${u.muni_tenant || 'no municipality'}, signing in to ${cfg.tenant}` });
          return res.status(200).json({
            ok: true, signedIn: false, email,
            msg: u.muni_tenant
              ? `${email} is on the access list for ${u.muni_tenant}, not for ${cfg.label || cfg.tenant}.`
              : `${email} is not on the access list for ${cfg.label || cfg.tenant}.`,
          });
        }

        /* First successful sign-in is where `google_sub` gets bound. Enrolment happens against an
           email address because that is what a human knows; the subject is what a session is
           afterwards tied to, because an address can be reassigned and the person is the same
           person. Name and picture are refreshed each time so a changed display name follows. */
        const patch = {
          google_sub: c.sub,
          name: c.name || u.name || null,
          picture_url: c.picture || u.picture_url || null,
          last_seen_at: new Date().toISOString(),
          sign_in_count: (u.sign_in_count || 0) + 1,
          ...(u.first_seen_at ? {} : { first_seen_at: new Date().toISOString() }),
        };
        try {
          const upd = await sb(`app_users?id=eq.${u.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            body: JSON.stringify(patch),
          });
          if (upd && upd[0]) u = upd[0];
        } catch { /* the counters are bookkeeping; never fail a valid sign-in over them */ }

        const token = signSession({ sub: c.sub, email, uid: u.id }, SECRET, SESSION_TTL);
        res.setHeader('Set-Cookie', sessionCookie(token, { req, maxAge: SESSION_TTL }));
        await logAttempt(req, { outcome: 'granted', email, google_sub: c.sub, user_id: u.id });
        return res.status(200).json({ ok: true, signedIn: true, user: publicUser(u) });
      }

      case 'signout': {
        res.setHeader('Set-Cookie', sessionCookie('', { req }));
        return res.status(200).json({ ok: true, signedIn: false });
      }

      default:
        return bad(res, 400, `unknown action: ${action}`);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

// Exported so api/water-ops.js asks the same question the same way, and so the sign-in gate can
// exercise the real verifier rather than a copy of it.
export { verifyIdToken, SESSION_COOKIE };
