// lib/pin.js — the one copy of "is this the operator's PIN".
//
// 2026-11-17 (Well Testing new-town build, part B). A supply may now require each operator to type a
// PIN at the well. The PIN is stored HASHED (`water_operators.pin_hash`), never as text, and every
// place that checks one comes here — the same discipline as lib/session.js: two copies of a
// credential rule drift, and the one that drifts is the one nobody is watching.
//
// ⚠ THIS FILE IS SERVED PUBLICLY (the repo is public). There is no secret in it: a hash format is
// not a secret, and the salt for each PIN is random and stored beside its key.
//
// FORMAT: `scrypt$<N>$<r>$<p>$<salt base64>$<key base64>`. Pure functions, no I/O.
//
// LEGACY: the old plain `water_operators.pin` column may still hold a value until the owner runs the
// one-off hashing script. `verifyPin` accepts either form, and compares both in constant time.

import crypto from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32, SALT_BYTES = 16;
// bounds on parameters READ from a stored hash, so a corrupt row cannot make a check hang or exhaust memory
const MAX_N = 1 << 17, MAX_R = 16, MAX_P = 4;

/** A PIN is 4 to 8 digits, as text. */
export function isPinFormat(pin) {
  if (typeof pin !== 'string' && typeof pin !== 'number') return false;
  return /^\d{4,8}$/.test(String(pin));
}

const maxmemFor = (n, r) => 128 * n * r + 1024 * 1024;

/** Hash a PIN for storage. Throws on a PIN that is not 4 to 8 digits. */
export function hashPin(pin) {
  if (!isPinFormat(pin)) throw new Error('a PIN is 4 to 8 digits');
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(String(pin), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmemFor(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/** True when `pin` matches `stored` (a hash in the format above, or a legacy plain string). */
export function verifyPin(pin, stored) {
  if (pin == null || stored == null) return false;
  const given = String(pin);
  const s = String(stored);
  if (!given || !s) return false;
  if (s.startsWith('scrypt$')) {
    const parts = s.split('$');
    if (parts.length !== 6) return false;
    const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    if (![n, r, p].every(Number.isInteger) || n < 2 || (n & (n - 1)) !== 0 || n > MAX_N
        || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const key = Buffer.from(parts[5], 'base64');
    if (!salt.length || !key.length || key.length > 64) return false;
    let got;
    try { got = crypto.scryptSync(given, salt, key.length, { N: n, r, p, maxmem: maxmemFor(n, r) }); } catch { return false; }
    return sameBytes(got, key);
  }
  // legacy plain value: compare fixed-length digests so the comparison time does not depend on the text
  const h = (x) => crypto.createHash('sha256').update(x, 'utf8').digest();
  return sameBytes(h(given), h(s));
}
