// lib/session.js — the one copy of "is this browser signed in, and as whom".
//
// WHY THIS IS ITS OWN FILE, IN THE SAME SPIRIT AS civicscope-water/derive.js AND pool/scoring.js.
// Two places need to answer the question: api/auth-google.js, which mints a session after Google
// has vouched for someone, and api/water-ops.js, which has to decide whether the caller may correct
// a record that sits under a report signed under 1976 PA 399. The moment that rule exists twice,
// the two copies drift and the one that drifts is the one nobody is looking at.
//
// ⚠ THIS FILE IS SERVED PUBLICLY, exactly like derive.js — the repo is public and Vercel serves the
// tree. That is fine and deliberate: there is no secret in here. The secret is AUTH_SESSION_SECRET,
// which lives in Vercel's environment and is passed in by the caller. Never inline one here.
//
// THE TOKEN. `v1.<base64url(payload json)>.<base64url(hmac-sha256)>`. Deliberately not a JWT: a JWT
// carries an algorithm field that a verifier is then tempted to trust, and the whole class of
// alg=none / alg-confusion bugs comes from reading the attacker's opinion about how to check the
// attacker's token. There is one algorithm here and it is not negotiable.

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

/** Mint a session. `ttlSeconds` is absolute — there is no refresh, so a stolen token dies on its own. */
export function signSession(payload, secret, ttlSeconds = 30 * 24 * 3600) {
  if (!secret) throw new Error('AUTH_SESSION_SECRET is not configured');
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const p = b64u(JSON.stringify(body));
  return `v1.${p}.${b64u(mac(secret, `v1.${p}`))}`;
}

/**
 * Verify a session token. Returns the payload, or null for ANY defect — bad shape, bad signature,
 * expired, unparseable. Never throws and never explains which, because a verifier that reports why
 * it refused is a verifier that helps somebody tune their next attempt.
 */
export function verifySession(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const signed = `v1.${parts[1]}`;
  const want = mac(secret, signed);
  const got = unb64u(parts[2]);
  // Constant-time, and length-checked first because timingSafeEqual throws on a length mismatch —
  // which would turn a forged token into a 500 instead of a clean "not signed in".
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let payload;
  try { payload = JSON.parse(unb64u(parts[1]).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!(Number(payload.exp) > Math.floor(Date.now() / 1000))) return null;
  return payload;
}

export const SESSION_COOKIE = 'cs_session';

/** Read one cookie off a request. Vercel does not parse them for plain Node functions. */
export function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * ⚠ THE COOKIE DOMAIN IS THE WHOLE REASON ONE SIGN-IN COVERS BOTH PRODUCTS. The village hub is
 * served from `civicscope.io` / `www.civicscope.io` and the plant log from `app.civicscope.io` —
 * three hosts, one Vercel project. A host-only cookie would make Michelle sign in again when she
 * followed the hub's own link to Well Testing, which is precisely the friction that makes people
 * stop using a tool.
 *
 * The domain is derived from the request rather than hardcoded, because a preview deployment lives
 * on `*.vercel.app`, and a cookie scoped to a domain the browser is not on is silently DROPPED —
 * sign-in would appear to succeed and then not exist, with nothing in any log to say why.
 */
export function sessionCookie(value, { req, maxAge }) {
  const host = String((req && req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
  const onProd = host === 'civicscope.io' || host.endsWith('.civicscope.io');
  const bits = [
    `${SESSION_COOKIE}=${value ? encodeURIComponent(value) : ''}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${value ? maxAge : 0}`,
  ];
  if (onProd) bits.push('Domain=.civicscope.io');
  return bits.join('; ');
}

/** The signed-in identity on a request, or null. The single entry point every other route uses. */
export function sessionOf(req) {
  return verifySession(readCookie(req, SESSION_COOKIE), process.env.AUTH_SESSION_SECRET || '');
}
