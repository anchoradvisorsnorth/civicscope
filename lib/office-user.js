// lib/office-user.js — "which enrolled office person is behind this request".
//
// 2026-11-18 (Well Testing town-admin page). api/water-town.js has to answer the same question
// api/water-ops.js answers before an office write: is there a signed session on this request, and
// does it still belong to an ACTIVE enrolment bound to the same Google account. The rule is written
// here so a new route does not grow its own version of it.
//
// ⚠ api/water-ops.js still carries its own `signedInUser()` — the original of this function, kept
// where it is because that file is the crew's write path and this change deliberately does not touch
// it. The two are the same rule, and this one is stricter in two small ways (a malformed cookie
// reads as signed out here, and a session with no Google subject is refused for a bound row). When
// api/water-ops.js is next released, point its `signedInUser()` here and delete the copy.
//
// ⚠ THIS FILE IS SERVED PUBLICLY, like lib/session.js. There is no secret in it.

import { sessionOf } from './session.js';

/**
 * The enrolled, ACTIVE `app_users` row behind the session cookie, or null.
 *
 * Re-read from the database on every call rather than trusted from the cookie's own claims:
 * turning somebody off has to take effect when it is done, not when their 30-day session lapses.
 * `sb` is the caller's own Supabase helper (path-and-query in, parsed JSON out).
 */
export async function officeUserOf(req, sb) {
  try {
    /* Reading the cookie is inside the try (independent review, 2026-11-18): a cookie value that is
       not valid percent-encoding makes the decoder throw, and that must read as "not signed in",
       not as a server error on every request until the cookie is cleared. */
    const s = sessionOf(req);
    if (!s || !s.uid) return null;
    // the uid comes from a signed cookie, but it is still read from the request: encoded, never raw
    const rows = await sb(`app_users?id=eq.${encodeURIComponent(s.uid)}&active=eq.true&select=*&limit=1`);
    const u = (rows && rows[0]) || null;
    /* The session must still belong to the Google account the enrolment is bound to. A row re-bound
       to a new subject leaves the previous holder's unexpired cookie naming the same uid. A session
       that names no subject at all is refused for a bound row too — every session this product
       mints carries one. */
    if (u && u.google_sub && u.google_sub !== s.sub) return null;
    return u;
  } catch { return null; }
}
