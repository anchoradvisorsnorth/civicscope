// api/water-ops.js — daily operator records for a community water supply.
//
// WHAT THIS IS
// The operator walks a round: at each well he reads a meter, reads the chlorine and phosphate tank
// levels, and pulls a plant-tap sample. Today that goes on a paper Well and Pump Record and gets
// retyped into EGLE's Monthly Operation Report at month end. This is the endpoint behind the
// tablet that replaces the clipboard.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: THE OPERATOR ENTERS READINGS, NEVER CALCULATIONS.
// Reading Centreville's July 2026 paperwork by hand is what settled that. Every handwritten dose
// in the CL ppm / PH ppm columns was 3-5% off the EGLE workbook's own formula — on essentially
// every row of all three wells, for the whole month. Nobody was careless; the operator reads a
// dose chart and the state's spreadsheet divides. But it means the plant's daily log and the
// report the village files have never agreed, and there was no way to notice. Derive the number
// once, here, and the two are the same number by construction.
//
// `derive()` is a pure function and is exported for exactly that reason: the July backfill and
// `scripts/verify-water-derivation.mjs` run the same code the tablet runs, against the paper, so
// "the engine reproduces the sheet" is a test and not a claim. (Same pattern as `__matcher` in
// api/ryc-invoices.js — the piece with real logic and no I/O is the piece worth testing
// exhaustively.)
//
// THE ARITHMETIC (EGLE Class D template, verbatim)
//   million_gallons = gallons_pumped / 1e6
//   million_lbs     = million_gallons * 8.34
//   solution_lbs    = (previous refill_to ?? previous tank_level) - tank_level
//   avail_lbs       = solution_lbs * feed.avail_fraction
//   dose_mg_l       = avail_lbs / million_lbs
//   ortho_mg_l      = dose_mg_l * feed.ortho_factor
//
// WHAT THE PAPER COULD NOT SAY, AND THE TABLET MUST
//   * A REFILL. Well 3's chlorine went 25 -> 303 on 7/15, Well 4's 12 -> 315 on 7/20. On paper the
//     operator circles the new number. Subtract naively and the next day reads -278 lbs, so a
//     rising tank is refused unless the previous visit recorded what it was filled TO.
//   * A WELL THAT DID NOT RUN. Well 1's meter was unchanged 7/6 -> 7/7. Zero is a real reading;
//     no row at all means nobody visited. Those are different facts and stay different facts.
//   * FREE > TOTAL. Well 1's tap on 7/9 reads free 0.77 / total 0.69, which is impossible. Caught
//     here at the sink, while the sample is still in the operator's hand.
//
// SECURITY POSTURE, STATED HONESTLY. This repo is PUBLIC, so no credential appears here: the
// value behind WATER_OPS_CODE lives in Vercel env and per-operator PINs live in Supabase and are
// returned by no action.
//
// ⛔ BUT THERE IS NO PLANT ACCESS CODE (Keith, 2026-08-21, asked directly whether Michelle holds
// one: *"there is no plant access code"*). WATER_OPS_CODE is an environment variable, not
// something any person at the village has ever been given. That makes it a credential only a
// script can present, which is fine for administration and useless as a gate on the people who
// operate the plant. Everything an operator does — entering a round, recording that a report was
// filed — is therefore OPEN, and says so, rather than sitting behind a lock with no key.
// This is the same judgement already made about the field PIN, which was enforced for exactly one
// of four operators while implying every entry was authenticated. A gate that stops nobody but
// the legitimate user is worse than no gate, because it reads as security.
// Google sign-in is what actually closes this, for the crew's tablet and the OIC page at once.

export const config = { maxDuration: 30 };

import crypto from 'node:crypto';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OPS_CODE = process.env.WATER_OPS_CODE || '';

// Private bucket holding the exact .xls workbooks that were submitted to EGLE. Never public: it is
// reached only through short-lived signed URLs minted per request, same posture as
// `ryc-invoice-scans`.
const MOR_BUCKET = 'water-mor-filings';

export const VER = '1.5.0-waterops';

import { derive, normalOf, outOfFamily, DOSE_OUT_OF_FAMILY, LBS_PER_MILLION_GALLONS } from '../civicscope-water/derive.js';
/* Re-exported so a gate importing "what the server uses" gets the server's own copy, not a second
   import of derive.js that could drift from it. */
export { derive, normalOf, outOfFamily, DOSE_OUT_OF_FAMILY };

/* Google sign-in, shared with api/auth-google.js through the ONE copy of the session rule. Reading
   the cookie here rather than re-implementing it is the same discipline derive.js enforces on the
   arithmetic: two copies of "is this browser signed in" drift, and the one that drifts is the one
   nobody is watching. */
import { sessionOf } from '../lib/session.js';

// ---------------------------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------------------------
async function sb(pathAndQuery, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

async function loadProfile(wssn) {
  const supplies = await sb(`water_supplies?wssn=eq.${encodeURIComponent(wssn)}&select=*`);
  const supply = supplies && supplies[0];
  if (!supply) return null;
  const eps = await sb(`water_entry_points?supply_id=eq.${supply.id}&active=eq.true&select=*&order=sort_order`);
  const feeds = await sb(`water_feeds?active=eq.true&select=*&order=sort_order`);
  const sites = await sb(`water_sites?supply_id=eq.${supply.id}&active=eq.true&select=*&order=sort_order`);
  const ops = await sb(`water_operators?supply_id=eq.${supply.id}&active=eq.true&select=id,name,initials,is_oic&order=name`);
  const epIds = new Set(eps.map((e) => e.id));
  for (const ep of eps) ep.feeds = feeds.filter((f) => f.entry_point_id === ep.id);
  return { supply, entryPoints: eps, sites, operators: ops, _epIds: epIds };
}

// the last live reading for an entry point strictly before `date` — the baseline every derived
// number hangs off. Ordered by date DESC so a backfill inserted out of order still resolves.
async function previousReading(entryPointId, date) {
  const rows = await sb(
    `water_readings?entry_point_id=eq.${entryPointId}&reading_date=lt.${date}&superseded_at=is.null` +
      `&select=id,reading_date,meter_reading&order=reading_date.desc&limit=1`
  );
  const prev = rows && rows[0];
  if (!prev) return null;
  const fr = await sb(`water_feed_readings?reading_id=eq.${prev.id}&select=feed_id,tank_level,refill_to`);
  const feeds = {};
  for (const f of fr || []) feeds[f.feed_id] = { tank_level: f.tank_level, refill_to: f.refill_to };
  return { id: prev.id, reading_date: prev.reading_date, meter_reading: prev.meter_reading, feeds };
}

/* THIS PLANT'S OWN NORMALS — the only thing that can answer "is this like every other day".
   Computed ONCE, server-side, and handed to every derive() call including the tablet's, because
   the well house and the office must not answer that question with two different numbers.

   Three deliberate choices, each of which was wrong the obvious way round:
   - MEDIAN, NOT MEAN. The outlier this exists to catch is precisely what drags a mean toward
     itself and raises the threshold meant to trip on it.
   - DAYS THE WELL DID NOT RUN ARE EXCLUDED. A recorded 0 is a real fact, but a well idle half the
     month would halve its own "normal" and turn ordinary days into warnings. Not hypothetical
     here: April 2026 ran only Well 3 while the tower was down for repair.
   - TOO LITTLE HISTORY RETURNS NULL, NEVER A GUESS. A threshold computed from three days is
     noise, and a false warning at a well house is how an operator learns to ignore warnings. */
const NORMALS_WINDOW_DAYS = 120;
async function plantNormals(ep, beforeDate) {
  const since = new Date(`${beforeDate}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - NORMALS_WINDOW_DAYS);
  const from = since.toISOString().slice(0, 10);
  try {
    const rows = await sb(
      `water_readings?entry_point_id=eq.${ep.id}&reading_date=lt.${beforeDate}&reading_date=gte.${from}` +
        `&superseded_at=is.null&select=id,gallons_pumped&order=reading_date.desc&limit=200`
    );
    const live = rows || [];
    const typicalGallons = normalOf(live.map((r) => r.gallons_pumped));
    const typicalDose = {};
    if (live.length) {
      const ids = live.map((r) => r.id).join(',');
      const fr = await sb(`water_feed_readings?reading_id=in.(${ids})&select=feed_id,dose_mg_l`);
      const byFeed = {};
      for (const f of fr || []) (byFeed[f.feed_id] ||= []).push(f.dose_mg_l);
      for (const [fid, series] of Object.entries(byFeed)) {
        const m = normalOf(series);
        if (m !== null) typicalDose[fid] = m;
      }
    }
    return { typicalGallons, typicalDose };
  } catch {
    // A normals lookup that fails must never block a reading. No normals = those flags do not
    // fire, which is the behaviour every reading before 2026-09-02 already had.
    return { typicalGallons: null, typicalDose: {} };
  }
}

// every derive() in this file builds its context here, so a check can never be live on one route
// and dead on another — which is exactly how typicalGallons stayed unreachable for a month.
const contextFor = (supply, normals) => ({
  minFreeCl: supply.min_free_cl,
  typicalGallons: normals ? normals.typicalGallons : null,
  typicalDose: normals ? normals.typicalDose : {},
});

/* ⛔ THE DAY AFTER A CORRECTION IS ALSO WRONG, AND NOTHING USED TO RE-DERIVE IT.
   Every derived number hangs off the previous live reading: gallons are this meter minus the
   last one, chemical usage is this tank level against the last baseline. So editing or inserting
   a HISTORICAL day silently invalidates the day that follows it, which keeps the interval it
   computed against the row that is no longer there.

   Worked example, and it is not an edge case: day 1 meter 100, day 2 150, day 3 200 — days 2 and
   3 each store 50. Correct day 2 to 120 and day 2 becomes 20, but day 3 still says 50 instead of
   80. The month totals 70 against a true 100, and `build-mor.py` copies those stored values
   straight into the filing.

   This is Michelle's ORDINARY workflow, not a corner: Keith, 2026-08-26 — *"if a reading is
   missing, she will add it before running the report"*, and lab results for bacteria come back a
   day later and get entered then. Inserting into the middle of a month is the normal case.

   So a write re-derives its SUCCESSOR from the same shared derive(), in place, keeping the
   successor's own row id — this is a recomputation of stored arithmetic, not a correction, so it
   supersedes nothing and needs no reason. It walks exactly ONE day forward on purpose: that day's
   own successor only depends on IT through its meter and tank levels, which this does not touch.
*/
async function planSuccessor(supply, ep, afterDate, newRow, newFeeds) {
  const rows = await sb(
    `water_readings?entry_point_id=eq.${ep.id}&reading_date=gt.${afterDate}&superseded_at=is.null`
      + '&select=id,reading_date&order=reading_date.asc&limit=1'
  );
  const next = rows && rows[0];
  if (!next) return null;

  /* ⛔ THIS FUNCTION HAD NEVER RE-DERIVED A SINGLE DAY (found 2026-09-02). Written to stop a
     corrected day leaving a stale interval behind it, it carried three defects that between them
     made it either inert or destructive — in the one path that exists to protect a record behind a
     report signed under 1976 PA 399.

     1. `feeds` was built as an ARRAY. derive() indexes it by feed id (`input.feeds[f.id]`), which
        on an array is undefined — so every feed looked like a missing tank level, derive() raised
        "tank level is required", `out.ok` was false and it returned before writing anything. On an
        ordinary day it therefore did nothing at all, silently.
     2. The residuals were read as `free_cl` / `total_cl` / `ortho`. Those columns do not exist —
        water_readings stores `tap_free` / `tap_total` / `tap_ortho` — and pressure and temp were
        not carried at all. So on the one day defect 1 did NOT block (a zero-flow successor, where
        the tank level is legitimately absent) the PATCH wrote `{...out.reading}` with every one of
        those fields null and ERASED the operator's plant-tap sample, pressure and temperature.
     3. The feed PATCH wrote `dose_mgl: fd.dose_mgl` — wrong on both sides. derive() returns
        `dose_mg_l` so the value was undefined, and `dose_mgl` is not a column, so the write would
        have been rejected anyway. A successor's solution_lbs could move while its dose stayed as
        computed against a baseline that no longer exists — and build-mor.py copies stored values
        straight into the filing.

     ⛔ IT NO LONGER WRITES ANYTHING (migration 064, 2026-09-02). It PLANS the successor and hands
     the result to `water_submit_reading()`, which commits this day and the recomputed one in a
     single transaction. That is what closes Codex finding 1: there is no longer a boundary between
     the two writes for a process to die in.

     ⚠ The baseline it derives against is the row that is ABOUT TO BE INSERTED, not one read back
     from the database — which is the whole reason this can be planned before the write. `prev` is
     assembled from the caller's own derived values; a well's next day depends on this one only
     through its meter reading and its tank levels, all of which are already known here. */
  const [full] = await sb(`water_readings?id=eq.${next.id}&select=*`);
  if (!full) return null;
  const fr = await sb(`water_feed_readings?reading_id=eq.${next.id}&select=*`);
  const input = {
    meter_reading: full.meter_reading,
    tap_free: full.tap_free, tap_total: full.tap_total,
    tap_ortho: full.tap_ortho, tap_fluoride: full.tap_fluoride,
    pressure_psi: full.pressure_psi, temp_f: full.temp_f,
    feeds: Object.fromEntries(
      (fr || []).map((x) => [x.feed_id, { tank_level: x.tank_level, refill_to: x.refill_to }])
    ),
  };
  const prev = {
    meter_reading: newRow.meter_reading,
    feeds: Object.fromEntries(
      (newFeeds || []).map((f) => [f.feed_id, { tank_level: f.tank_level, refill_to: f.refill_to }])
    ),
  };
  const normals = await plantNormals(ep, next.reading_date);
  const out = derive({ entryPoint: ep, feeds: ep.feeds, prev, input,
    context: contextFor(supply, normals) });

  /* A successor that will not re-derive is REPORTED, never silently left stale. It means the edit
     made the following day impossible (a meter that now runs backwards, say), and the person
     making the edit is the only one who can resolve it. Reported BEFORE anything is written, so
     the caller can refuse the whole submit rather than commit half of it. */
  if (!out.ok) return { id: next.id, date: next.reading_date, ok: false, errors: out.errors };

  /* ⛔ RE-DERIVING MUST NOT ERASE WHAT THE OPERATOR WAS SHOWN (Codex finding 6, 2026-09-02).
     This replaced `flags` outright, so a later backfill that moved the trailing median could
     silently delete a `dose_high` from a day nobody had reopened — destroying the only evidence
     used to decide whether a value is fit to file. The current flags still have to be current (a
     `no_flow` genuinely stops being true when the baseline moves), so the row keeps the freshly
     computed set AND an audit entry carrying what it replaced. */
  const priorFlags = Array.isArray(full.flags) ? full.flags : [];
  const changed = JSON.stringify(priorFlags.map((f) => f.code).sort())
               !== JSON.stringify(out.flags.map((f) => f.code).sort());
  const flags = [...out.flags];
  if (changed) {
    flags.push({
      level: 'info', code: 'rederived',
      msg: `Recomputed after ${afterDate} was entered or corrected — the baseline this day measures from changed.`,
      at: new Date().toISOString(), after: afterDate, superseded_flags: priorFlags,
    });
  }

  return {
    id: next.id, date: next.reading_date, ok: true,
    reading: out.reading, feeds: out.feeds, flags,
  };
}

/* WHO IS ASKING. Returns the enrolled, ACTIVE app_users row behind the session cookie, or null.
   Re-read on every call rather than trusted from the cookie's own claims, because deactivating
   somebody has to take effect when it is done — not when their 30-day session happens to lapse.
   A null here is never an error: most calls into this file come from a crew tablet that has no
   session and is never going to have one. */
async function signedInUser(req) {
  const s = sessionOf(req);
  if (!s || !s.uid) return null;
  try {
    const rows = await sb(`app_users?id=eq.${s.uid}&active=eq.true&select=*&limit=1`);
    return (rows && rows[0]) || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Supabase Storage — the submitted workbooks themselves
// ---------------------------------------------------------------------------------------------
const sbStorage = (p, init = {}) =>
  fetch(`${SB_URL}/storage/v1/${p}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...(init.headers || {}) },
  });

/* The bucket is created on first use rather than by hand. A manual console step is a step that
   does not exist for the next supply and is invisible when it is missing — the failure would
   surface as a filing that recorded fine and pointed at nothing. Creating it is idempotent (409
   when it already exists) and costs one request on the first upload ever. */
async function putWorkbook(path, bytes) {
  const send = async () => {
    const r = await sbStorage(`object/${MOR_BUCKET}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.ms-excel', 'cache-control': 'max-age=31536000' },
      body: bytes,
    });
    return { status: r.status, ok: r.ok, body: await r.text() };
  };
  let r = await send();
  /* ⚠ A MISSING BUCKET DOES NOT COME BACK AS AN HTTP 404. Supabase Storage answers the upload with
     HTTP **400** and puts the real condition in the body (`"code":"NoSuchBucket"`, `"statusCode":
     "404"` as a STRING). Keying the create-on-missing off `r.status === 404` therefore never fired
     — the first real run failed all seven workbooks with "Bucket not found" while the code that
     existed to prevent exactly that sat unreachable. Match on the condition the service reports,
     not on the transport code you expected it to use. */
  if (!r.ok && /NoSuchBucket|Bucket not found/i.test(r.body || '')) {
    await sbStorage('bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: MOR_BUCKET, name: MOR_BUCKET, public: false }),
    });
    r = await send();
  }
  // The path carries the content hash, so an identical object at the same path IS the same bytes.
  if (r.status === 409 || /Duplicate|already exists/i.test(r.body || '')) return { ok: true, existed: true };
  if (!r.ok) return { ok: false, status: r.status, msg: (r.body || '').slice(0, 200) };
  return { ok: true };
}

async function signWorkbook(path, seconds = 900) {
  const r = await sbStorage(`object/sign/${MOR_BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && j.signedURL ? `${SB_URL}/storage/v1${j.signedURL}` : null;
}

// ---------------------------------------------------------------------------------------------
// WHAT WE SENT vs WHAT WE HOLD
// ---------------------------------------------------------------------------------------------
/* ⛔ THIS IS A DIFF, NOT A DERIVATION — it must never recompute anything.
   `filed` is what the submitted workbook literally says, read out of its cells. `readings` is what
   the plant observed and derive() turned into numbers. Comparing them is the only way to answer
   "does what we sent EGLE still match our records", and it is the question that surfaces the 14
   days where Centreville's paper and its filings already disagree — including two days where a
   well ran and the state was told it produced nothing.

   Recomputing either side here would destroy the finding: a diff of the stored records against
   themselves is always clean. The comparison is therefore deliberately dumb, and it is exported so
   it can be exercised against the seven real 2026 filings rather than trusted.

   TOLERANCES ARE SET BY THE FORM, not by taste. EGLE's Pumpage and EntryPoint cells carry metered
   million gallons at three decimals, so anything under half of the last printed digit is the
   form's own rounding and not a disagreement. Solution pounds are whole or half pounds off a tank
   gauge. Widening either one to make a month go green would be hiding the thing this exists for. */
const MG_TOLERANCE = 0.0005;
const LBS_TOLERANCE = 0.01;

export function diffFiling({ filed, entryPoints, readings, dist, bacti }) {
  const rows = [];
  const eps = entryPoints || [];
  const filedEps = (filed && filed.entry_points) || {};
  const pumpage = (filed && filed.pumpage) || {};
  const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;

  for (const ep of eps) {
    const sheet = ep.mor_sheet ? `EntryPoint${ep.mor_sheet}` : null;
    const days = (sheet && filedEps[sheet]) || {};
    const ours = {};
    for (const r of readings || []) {
      if (r.entry_point_id === ep.id) ours[String(Number(String(r.reading_date).slice(8, 10)))] = r;
    }
    const kindOf = {};
    for (const f of ep.feeds || []) kindOf[f.id] = f.kind;

    const allDays = new Set([...Object.keys(days), ...Object.keys(ours)]);
    for (const d of [...allDays].sort((a, b) => Number(a) - Number(b))) {
      const fd = days[d] || {};
      const r = ours[d];
      // The EntryPoint tab is the primary source; a supply that filled only the Pumpage tab for a
      // well still told the state a number, so fall back to it rather than reading "not filed".
      const fMg = fd.mg != null ? Number(fd.mg)
                : (ep.well_no != null && pumpage[d] && pumpage[d][String(ep.well_no)] != null
                    ? Number(pumpage[d][String(ep.well_no)]) : null);
      const oMg = r && r.million_gallons != null ? Number(r.million_gallons) : null;

      /* ⛔ A BLANK CELL AND A ZERO SAY THE SAME THING ON THIS FORM, AND TREATING THEM AS A
         DISAGREEMENT BURIES THE REAL ONES. EGLE's own Pumpage instruction is "do not put 0 in a
         cell if the pumpage was not checked" — so a well that genuinely did not run is a 0 in our
         records and a blank on the MOR, by design on both sides. The first run of this comparison
         reported 55 such "differences" for May and 24 for April — April's Cover explains them in
         the operator's own words: *"The water tower is currently down for repair so we are only
         running well #3."* Two wells sat idle all month, correctly recorded as 0 here and
         correctly left blank there.
         So only a NON-ZERO figure on one side and silence on the other is a finding. That is what
         leaves Feb 23 (Well 4 ran 0.007 MG and the state was told nothing) standing where it
         belongs, instead of as one line in fifty-five. */
      const zeroish = (v) => v != null && Math.abs(v) <= MG_TOLERANCE;
      if (fMg == null && oMg == null) { /* neither side has the day — nothing to say */ }
      else if (oMg == null) {
        if (!zeroish(fMg)) rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: 'million_gallons',
          kind: 'filed_only', filed: fMg, ours: null,
          msg: `${fMg} MG was filed for ${ep.label} on day ${d}, but there is no reading on file for that day.` });
      } else if (fMg == null) {
        if (!zeroish(oMg)) rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: 'million_gallons',
          kind: 'ours_only', filed: null, ours: oMg,
          msg: `${ep.label} is recorded as pumping ${oMg} MG on day ${d}, and the filed report shows nothing for it.` });
      } else if (!near(fMg, oMg, MG_TOLERANCE)) {
        rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: 'million_gallons',
          kind: 'differs', filed: fMg, ours: oMg,
          msg: `${ep.label} day ${d}: the report says ${fMg} MG, the records say ${oMg} MG.` });
      }

      if (!r) continue;
      /* Same reasoning one level down: on a day both sides agree the well produced nothing, a
         pound of chemical on the form against none in the records is bookkeeping on an idle well,
         not a treatment discrepancy — there is no flow for it to dose. Comparing it added 14 rows
         to April, a month in which two of the three wells never ran. */
      if ((fMg == null || zeroish(fMg)) && (oMg == null || zeroish(oMg))) continue;
      for (const [col, kind, label] of [['cl_lbs', 'chlorine', 'chlorine'], ['po4_lbs', 'phosphate', 'phosphate']]) {
        const fl = fd[col] != null ? Number(fd[col]) : null;
        const fr = (r.feeds || []).find((x) => kindOf[x.feed_id] === kind);
        const ol = fr && fr.solution_lbs != null ? Number(fr.solution_lbs) : null;
        if (fl == null || ol == null) continue;          // one side silent is not a disagreement
        if (!near(fl, ol, LBS_TOLERANCE)) {
          rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: `${kind}_lbs`,
            kind: 'differs', filed: fl, ours: ol,
            msg: `${ep.label} day ${d}: the report says ${fl} lbs of ${label}, the records say ${ol}.` });
        }
      }
    }
  }

  /* ⛔ SAMPLES WERE COMPARED BY COUNT ALONE, WHICH HIDES THE ONE THING THIS EXISTS TO CATCH.
     Distribution and bacti agreement was `filed.length === ours.length`. No date, no site, no
     residual, no result. So a filed free residual of 0.70 against a held 0.20 reported a clean
     match as long as the number of samples was the same.

     Keith, 2026-08-26: Michelle *"sometimes changes numbers slightly in the actual EGLE
     report"*. That makes this comparison the RECORD OF WHERE SHE DEVIATED -- the single most
     valuable thing it can show -- and a same-count/changed-value edit is exactly the shape of
     her edits. Counting rows was blind to her entire workflow.

     Matched by regulatory identity (date, and site where the form carries one), never by
     position: a sample added or removed shifts every later row, and position matching would
     turn one insertion into a page of false differences. */
  /* ⚠ THE TWO SIDES DO NOT USE THE SAME FIELD NAMES, and assuming they did produced a comparison
     that reported EVERY sample of every filed month as a mismatch. Measured before shipping:
     26 phantom differences on January alone, with empty keys on the filed side.
     A filed row is what was transcribed out of the workbook:
         distribution  { date, free, total, ortho }          -- no site; the form has no column for one
         bacti         { date, location, free, total, result }
     Our rows are the database's own:
         distribution  { sample_date, free, total, ortho, site_name }
         bacti         { collected_date, site_name, free, total, result }
     So identity is extracted per side, never by a shared field name. */
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const txt = (v) => String(v == null ? '' : v).trim().toLowerCase();

  const compareSamples = (label, filedRows, ourRows, filedKey, ourKey, valueFields, textFields) => {
    /* Keyed by regulatory identity, never by position: one added sample shifts every later row,
       and position matching would turn a single insertion into a page of false differences.
       A repeated key keeps its rows in order and compares them pairwise. */
    const group = (list, keyOf) => {
      const m = new Map();
      for (const x of list || []) {
        const k = keyOf(x);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(x);
      }
      return m;
    };
    const fMap = group(filedRows, filedKey);
    const oMap = group(ourRows, ourKey);
    const dayOf = (k) => Number(String(k).slice(8, 10)) || 0;

    for (const [k, ours] of oMap) {
      const theirs = fMap.get(k) || [];
      for (let i = 0; i < Math.max(ours.length, theirs.length); i++) {
        const o = ours[i];
        const fr = theirs[i];
        if (o && !fr) {
          rows.push({ day: dayOf(k), ep: label, field: label, kind: 'ours_only',
            msg: `${label}: ${k.replace(/\|/g, ' ')} is in the records but not in the filed report.` });
          continue;
        }
        if (!o && fr) {
          rows.push({ day: dayOf(k), ep: label, field: label, kind: 'filed_only',
            msg: `${label}: ${k.replace(/\|/g, ' ')} is in the filed report but not in the records.` });
          continue;
        }
        for (const vf of valueFields) {
          const fv = num(fr[vf]);
          const ov = num(o[vf]);
          if (fv == null && ov == null) continue;
          if (fv == null || ov == null || !near(fv, ov, 0.001)) {
            rows.push({ day: dayOf(k), ep: label, field: `${label}_${vf}`, kind: 'differs',
              filed: fv, ours: ov,
              msg: `${label} ${k.replace(/\|/g, ' ')}: the report says ${fv == null ? 'nothing' : fv} for ${vf}, the records say ${ov == null ? 'nothing' : ov}.` });
          }
        }
        for (const tf of textFields || []) {
          if (txt(fr[tf]) !== txt(o[tf])) {
            rows.push({ day: dayOf(k), ep: label, field: `${label}_${tf}`, kind: 'differs',
              filed: fr[tf], ours: o[tf],
              msg: `${label} ${k.replace(/\|/g, ' ')}: the report says ${fr[tf] || 'nothing'} for ${tf}, the records say ${o[tf] || 'nothing'}.` });
          }
        }
      }
    }
    for (const [k, theirs] of fMap) {
      if (oMap.has(k)) continue;
      for (let i = 0; i < theirs.length; i++) {
        rows.push({ day: dayOf(k), ep: label, field: label, kind: 'filed_only',
          msg: `${label}: ${k.replace(/\|/g, ' ')} is in the filed report but not in the records.` });
      }
    }
  };

  compareSamples('distribution', (filed && filed.distribution) || [], dist || [],
    (x) => txt(x.date), (x) => txt(x.sample_date), ['free', 'total', 'ortho'], []);
  compareSamples('bacti', (filed && filed.bacti) || [], bacti || [],
    (x) => `${txt(x.date)}|${txt(x.location)}`, (x) => `${txt(x.collected_date)}|${txt(x.site_name)}`,
    ['free', 'total'], ['result']);

  rows.sort((a, b) => a.day - b.day || String(a.ep).localeCompare(String(b.ep)));
  const mg = rows.filter((r) => r.field === 'million_gallons');
  const counts = {
    pumpage_differs: mg.filter((r) => r.kind === 'differs').length,
    filed_only: mg.filter((r) => r.kind === 'filed_only').length,
    ours_only: mg.filter((r) => r.kind === 'ours_only').length,
    chemical_differs: rows.length - mg.length,
    dist_filed: ((filed && filed.distribution) || []).length,
    dist_ours: (dist || []).length,
    bacti_filed: ((filed && filed.bacti) || []).length,
    bacti_ours: (bacti || []).length,
  };
  return {
    rows,
    counts,
    /* `rows` now carries sample differences too, so the count equality that used to stand in for
       agreement is redundant -- and was never sufficient. Kept in `counts` for the card. */
    matches: rows.length === 0,
  };
}

// The filing row as the review page wants it: everything except the `filed` blob, which can run to
// tens of kilobytes and is only ever needed to build the diff — which the server has already done.
const filingCard = (f) => ({
  id: f.id, year: f.report_year, month: f.report_month,
  submitted_date: f.submitted_date, signed_by: f.signed_by, oic_cert: f.oic_cert,
  submitted_to: f.submitted_to, comments: f.comments,
  workbook_name: f.workbook_name, workbook_sha256: f.workbook_sha256, workbook_bytes: f.workbook_bytes,
  source: f.source, notes: f.notes, recorded_at: f.created_at,
  correction_reason: f.correction_reason,
  summary: f.filed_summary || {},
});

const bad = (res, code, msg) => res.status(code).json({ error: msg });

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.ver) return res.status(200).json({ ver: VER });
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!SB_URL || !SB_KEY) return bad(res, 500, 'storage not configured');

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const action = body.action;
  /* `filings` and `filing_workbook` join the ungated reads deliberately. An MOR is a public record
     that a public water supply files with the State of Michigan, and every number in it is already
     served by `month` on this same open path — the workbook adds the OIC's name, which is printed
     on the form and already in `water_supplies`. Gating the report behind a code while serving its
     contents without one would be a lock on the door of a room with no wall. Recording a filing is
     a different matter and stays gated: it asserts something was submitted to a regulator. */
  const READ_ONLY = new Set(['profile', 'month', 'preview', 'filings', 'filing_workbook']);
  /* ⛔ THE CREW NEVER LOG IN (Keith, 2026-08-19: "this is the wellhouse app - it need to be super
     simple - pick a well - no login").
     Entering a reading is the crew's whole job, done one-handed in a concrete well house, and an
     access-code screen in front of it is a login however it is labelled. So the three submit
     actions are open, exactly like the reads.
     ADMIN IS NOT. Adding or deactivating an operator changes who the record can be attributed to,
     which is not a field task and is not something a bookmarked link should be able to do — those
     still require the code.
     ⚠ Stated plainly, and still true: anyone holding the /water URL can write a NEW reading into a
     record that sits behind a report signed under 1976 PA 399. Google sign-in (2026-08-25) did not
     change that and was never going to — the crew have no email logins by design. What it changed
     is that AMENDING one now requires an identified person; see the office-writes rule below. */
  /* `record_filing` was moved out of the gated set on 2026-08-21, on the reasoning that gating it
     on a code nobody holds made it unreachable by Michelle and by everyone else while the actions
     that write the DATA a future report is built from stayed open. That was right at the time and
     is superseded now, because there is finally a credential a PERSON can hold — see below. */
  const OPERATOR_WRITES = new Set(['submit_reading', 'submit_dist', 'submit_bacti']);

  /* ── GOOGLE SIGN-IN IS WHAT THIS FILE HAS BEEN WAITING FOR (2026-08-25) ──────────────────────
     Keith: *"Michelle wants to log in using the oauth on her account… She has an assistant that
     wants to do the same."* Until today the only credential this route understood was
     `WATER_OPS_CODE`, which — Keith, 2026-08-21 — *"there is no plant access code"*: an environment
     variable a script presents, held by no person at the village. So every action was either open
     or unreachable, and there was no third state.

     There is now. The rules below draw the line where the JOB draws it, not where the technology
     does:

       READS            open. An MOR is a public record and its contents are already served here.
       CREW WRITES      open, and must stay open. Keith, 2026-08-19: *"this is the wellhouse app -
                        it need to be super simple - pick a well - no login"*, and 2026-08-25 of
                        Mark Major and Jeff Derrikson: *"they wont have email logins."* Entering a
                        round is the crew's whole job, done one-handed in a concrete room.
       OFFICE WRITES    identity required — a signed-in person enrolled for THIS supply, or the ops
                        code for a script. Two actions qualify and they have the same character:
                        recording that a report was filed with the State of Michigan, and CORRECTING
                        a day that is already on the record. Both are assertions about the record
                        rather than observations of the plant, and both are desk work.
       ADMIN            unchanged (ops code), plus a signed-in CivicScope admin. Adding an operator
                        or switching a supply live is never a field task.

     ⛔ THE CORRECTION RULE IS ABOUT THE PAYLOAD, NOT THE ACTION NAME. `submit_reading` is an open
     crew write when it records a new day and an office write when it carries a
     `correction_reason`, because that second case supersedes a row sitting under a report signed
     under 1976 PA 399. Keying this on the action alone would have left the correction path open
     while locking the filing path — which is the same inversion that was fixed on 2026-08-21, in
     the other direction. */
  const OFFICE_WRITES = new Set(['record_filing']);
  const wssn = String(body.wssn || '').trim();
  if (!wssn) return bad(res, 400, 'wssn required');

  const codeOk = Boolean(OPS_CODE) && body.code === OPS_CODE;
  const isCorrection = Boolean(body.correction_reason);

  /* ⛔ A MONTH THAT HAS BEEN FILED IS CLOSED, WHETHER OR NOT THE DAY ALREADY EXISTS.
     The office boundary was decided entirely by the presence of `correction_reason`, and a
     reason is only demanded when a row for that same date is already there. So a date with NO
     row was an open crew write even inside a month already submitted to EGLE: an unauthenticated
     POST could add Well 3 on July 14 to a July filed weeks ago, and `submit_bacti` had no
     correction path at all. The workbook that went is unchanged, but the regulatory source
     record moves after the fact and nothing records who moved it.

     This does not narrow the crew's job by a day: the round they enter is today's, in a month
     nobody has filed yet. It closes an anonymous write into a CLOSED period, which is desk work
     by definition -- and Michelle, who does that work, is signed in (Keith, 2026-08-26: she has
     oversight, adds missing readings, and enters lab results a day later). */
  const writeDate = OPERATOR_WRITES.has(action)
    ? String(body.reading_date || body.sample_date || body.collected_date || '').slice(0, 10)
    : '';
  let intoFiledMonth = false;
  if (writeDate.length === 10) {
    try {
      const y = Number(writeDate.slice(0, 4));
      const mo = Number(writeDate.slice(5, 7));
      const sup = await sb(`water_supplies?wssn=eq.${encodeURIComponent(wssn)}&select=id&limit=1`);
      if (sup && sup[0]) {
        const filed = await sb(`water_mor_filings?supply_id=eq.${sup[0].id}&report_year=eq.${y}`
          + `&report_month=eq.${mo}&superseded_at=is.null&select=id&limit=1`);
        intoFiledMonth = Boolean(filed && filed[0]);
      }
    } catch { /* if the filing state cannot be read, fall back to the pre-existing rule */ }
  }

  const needsOffice = OFFICE_WRITES.has(action)
    || (OPERATOR_WRITES.has(action) && (isCorrection || intoFiledMonth));
  const needsAdmin = !READ_ONLY.has(action) && !OPERATOR_WRITES.has(action) && !OFFICE_WRITES.has(action);

  /* Resolved once, and only when a decision actually depends on it — a crew tablet submitting a
     round must not pay for a Supabase read that can only ever return null for it. */
  let actor = null;
  if (needsOffice || needsAdmin) actor = await signedInUser(req);

  if (needsAdmin) {
    if (!codeOk && !(actor && actor.role === 'admin')) {
      if (!OPS_CODE && !actor) return bad(res, 503, 'WATER_OPS_CODE is not configured and you are not signed in — the admin actions are disabled.');
      return bad(res, 403, 'That action needs a CivicScope admin sign-in or the supply access code.');
    }
  } else if (needsOffice) {
    /* Scoped to the supply, not merely signed in. Somebody enrolled for a different village must
       not be able to record a filing against this one, and an allowlist that grants "signed in"
       rather than "signed in FOR THIS SUPPLY" is not an allowlist. */
    const scoped = Boolean(actor) && (actor.role === 'admin' || actor.water_wssn === wssn);
    if (!codeOk && !scoped) {
      return res.status(403).json({
        error: actor
          ? 'Your sign-in is not enrolled for this water supply.'
          : (intoFiledMonth
              ? 'That month has already been filed with EGLE. Changing what sits behind a submitted report needs you to be signed in.'
              : isCorrection
              ? 'Correcting a recorded day needs you to be signed in — it supersedes a record behind a report signed under 1976 PA 399.'
              : 'Recording a filing needs you to be signed in.'),
        needsSignIn: !actor,
      });
    }
  }

  try {

    switch (action) {
      // ---- who am I talking to, and what does this plant look like ---------------------------
      case 'profile': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const today = String(body.date || '').slice(0, 10);
        let done = [];
        if (today) {
          done = await sb(
            `water_readings?supply_id=eq.${p.supply.id}&reading_date=eq.${today}&superseded_at=is.null&select=entry_point_id,reading_time,operator_initials`
          );
        }
        return res.status(200).json({
          ver: VER,
          supply: {
            wssn: p.supply.wssn, name: p.supply.name, county: p.supply.county,
            classification: p.supply.classification, oic_name: p.supply.oic_name,
            min_free_cl: p.supply.min_free_cl, active: p.supply.active,
          },
          entryPoints: p.entryPoints,
          sites: p.sites,
          operators: p.operators,
          doneToday: done || [],
        });
      }

      // ---- run the arithmetic without storing anything (what the tablet shows live) ----------
      case 'preview': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const ep = p.entryPoints.find((e) => e.id === body.entry_point_id);
        if (!ep) return bad(res, 404, 'unknown entry point');
        const prev = await previousReading(ep.id, body.reading_date);
        const normals = await plantNormals(ep, body.reading_date);
        const out = derive({
          entryPoint: ep, feeds: ep.feeds, prev, input: body.input || {},
          context: contextFor(p.supply, normals),
        });
        /* `normals` goes back to the tablet so its live derive() runs the same context this route
           did. The page must never compute them itself: the well house and the server would then
           be answering "is this normal" from two different windows of history. */
        return res.status(200).json({ ...out, previous: prev, normals });
      }

      // ---- commit a visit ---------------------------------------------------------------------
      case 'submit_reading': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const ep = p.entryPoints.find((e) => e.id === body.entry_point_id);
        if (!ep) return bad(res, 404, 'unknown entry point');

        let operator = null;
        if (body.operator_id) {
          const ops = await sb(`water_operators?id=eq.${body.operator_id}&supply_id=eq.${p.supply.id}&select=*`);
          operator = ops && ops[0];
          if (!operator) return bad(res, 404, 'unknown operator');
          /* ⛔ THE FIELD ROUND NO LONGER ASKS FOR A PIN (Keith 2026-08-19: "each inspector should
             just need to add their initials one time before submitting"), so one must not be
             demanded here either. This line would otherwise have broken the product for exactly
             one person — MICHELLE, the Operator-In-Charge, because she is the only operator with a
             PIN on file. Every round she walked would have 403'd while JD's and SD's went through,
             since a null PIN was never enforced.
             Her stored PIN is deliberately NOT deleted: it is the beginning of a real identity for
             the OIC environment, where it belongs. What is asserted at a well house is who says
             they took the reading — the same guarantee the paper's "Done by" column gives — and
             what makes the record trustworthy is her review and signature under 1976 PA 399.
             A PIN is still honoured when one is actually supplied, so a caller that wants to prove
             identity still can. */
          if (operator.pin && body.pin != null && body.pin !== '' && String(body.pin) !== String(operator.pin)) {
            return bad(res, 403, 'Wrong PIN.');
          }
        }

        const date = String(body.reading_date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 400, 'reading_date required (YYYY-MM-DD)');

        const prev = await previousReading(ep.id, date);
        const normals = await plantNormals(ep, date);
        const out = derive({
          entryPoint: ep, feeds: ep.feeds, prev, input: body.input || {},
          context: contextFor(p.supply, normals),
        });
        if (!out.ok) return res.status(422).json({ error: 'validation', errors: out.errors, flags: out.flags });

        // a correction supersedes rather than overwrites — this is a record behind a signed report
        const existing = await sb(
          `water_readings?entry_point_id=eq.${ep.id}&reading_date=eq.${date}&superseded_at=is.null&select=id`
        );
        const supersedes = existing && existing[0];
        if (supersedes && !body.correction_reason) {
          return res.status(409).json({ error: 'exists', msg: 'This day is already recorded. Send correction_reason to replace it.' });
        }

        /* ⛔ A CORRECTION COULD NEVER BE SAVED (found 2026-08-19 while seeding January–June).
           The old row was superseded AFTER the new one was inserted, so for the length of that
           insert BOTH rows had superseded_at null — and the unique index on
           (entry_point_id, reading_date) is partial exactly on `where superseded_at is null`.
           Every correction therefore died on a 23505 unique violation surfaced as a 500. The
           feature was implemented, documented and reachable, and had never once worked; nothing
           detected it because correcting a day is the one path no smoke test walks.
           The old row is now stood down FIRST. If the insert then fails the correction is put back,
           because a superseded day with nothing replacing it would silently delete a record that
           is behind a report signed under 1976 PA 399. */
        /* ⛔ ONE VISIT IS ONE WRITE (migration 064, 2026-09-02).
           This used to be FOUR PostgREST calls with no transaction between them — supersede,
           insert reading, insert feeds, recompute the next day — and every boundary was somewhere
           the record could be left half-made. Codex measured both halves of that (findings 1 and
           2): a failed feed insert left a live reading carrying pumpage and no chemical usage while
           the complete row it superseded stayed stood down; a half-updated successor ended up with
           chlorine on the new baseline and phosphate on the old one, and build-mor.py copies stored
           values straight into the filing. A compensating rollback in JS narrowed that window; it
           could not close it, because a lambda that dies mid-sequence leaves nobody to compensate.

           `water_submit_reading()` does all four in one transaction and asserts an affected-row
           count on every statement. It performs NO arithmetic — everything below is derived here
           first, by the one derive() both ends import, and handed over as values. Putting the dose
           formula in PL/pgSQL to win atomicity would recreate the exact defect this product exists
           to remove, in the last place anyone would look for it. */
        const successor = await planSuccessor(p.supply, ep, date, out.reading, out.feeds)
          .catch((e) => ({ ok: false, threw: String((e && e.message) || e) }));

        /* A successor that cannot be recomputed is refused BEFORE anything is written, rather than
           committed and reported afterwards. The edit has made the following day impossible — a
           meter that now runs backwards, say — and writing this day anyway would leave the month
           inconsistent in a way only a person can resolve. */
        if (successor && successor.ok === false) {
          return res.status(409).json({
            error: 'successor_blocked', saved: false,
            msg: `Saving this day would make ${successor.date || 'the day after it'} impossible to recompute, so nothing was written. `
               + `That day has to be corrected first.`,
            successor,
          });
        }

        let result;
        try {
          result = await sb('rpc/water_submit_reading', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              p_supersedes: supersedes ? supersedes.id : null,
              p_reading: {
                supply_id: p.supply.id,
                entry_point_id: ep.id,
                reading_date: date,
                reading_time: body.reading_time || null,
                operator_id: operator ? operator.id : null,
                operator_initials: operator ? operator.initials : (body.operator_initials || null),
                ...out.reading,
                notes: body.notes || null,
                flags: out.flags,
                source: body.source === 'backfill' ? 'backfill' : 'tablet',
                corrects: supersedes ? supersedes.id : null,
                correction_reason: body.correction_reason || null,
              },
              // `kind` is derive()'s label for the caller, not a column. The function REFUSES any
              // key that is not a real column rather than dropping it silently, so it must go.
              p_feeds: out.feeds.map(({ kind, ...f }) => f),
              p_successor: successor
                ? { id: successor.id, reading: successor.reading, feeds: successor.feeds, flags: successor.flags }
                : null,
            }),
          });
        } catch (e) {
          /* The transaction rolled back, so there is nothing to undo and nothing was half-written.
             `saved: false` is what tells the tablet's offline queue this one may be re-sent. */
          return res.status(500).json({
            error: 'write_failed', saved: false,
            msg: 'Nothing was written — the whole day was rolled back. Try again.',
            detail: String((e && e.message) || e).slice(0, 300),
          });
        }

        const written = Array.isArray(result) ? result[0] : result;
        return res.status(200).json({
          ok: true, saved: true,
          id: written && written.id, derived: out.reading, feeds: out.feeds, flags: out.flags,
          ...(supersedes ? { corrected: supersedes.id } : {}),
          ...(successor ? { rederived: { id: successor.id, date: successor.date, ok: true } } : {}),
        });
      }

      // ---- distribution sample -----------------------------------------------------------------
      case 'submit_dist': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const i = body.input || {};
        const free = i.free == null || i.free === '' ? null : Number(i.free);
        const total = i.total == null || i.total === '' ? null : Number(i.total);
        const flags = [];
        if (free !== null && total !== null && free > total) {
          return res.status(422).json({ error: 'validation', errors: [{ field: 'total', msg: `Free (${free}) cannot exceed total (${total}).` }] });
        }
        if (p.supply.min_free_cl != null && free !== null && free < p.supply.min_free_cl) {
          flags.push({ level: 'warn', code: 'low_free_cl', msg: `Free chlorine ${free.toFixed(2)} mg/L is below ${p.supply.min_free_cl} mg/L.` });
        }
        const site = (p.sites || []).find((s) => s.id === body.site_id) || null;
        const date = String(body.sample_date || '').slice(0, 10);
        const existing = await sb(
          `water_dist_samples?supply_id=eq.${p.supply.id}&site_name=eq.${encodeURIComponent(site ? site.name : body.site_name)}` +
            `&sample_date=eq.${date}&superseded_at=is.null&select=id`
        );
        const supersedes = existing && existing[0];
        if (supersedes && !body.correction_reason) {
          return res.status(409).json({ error: 'exists', msg: 'That site already has a sample on this date.' });
        }
        // Same defect, same fix as submit_reading above: stand the old sample down BEFORE inserting
        // its replacement, or the partial unique index rejects the correction.
        if (supersedes) {
          await sb(`water_dist_samples?id=eq.${supersedes.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ superseded_at: new Date().toISOString() }),
          });
        }
        let ins;
        try {
          ins = await sb('water_dist_samples', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify([{
            supply_id: p.supply.id,
            site_id: site ? site.id : null,
            site_name: site ? site.name : body.site_name,
            sample_date: date,
            sample_time: body.sample_time || null,
            operator_id: body.operator_id || null,
            operator_initials: body.operator_initials || null,
            free, total,
            ortho: i.ortho == null || i.ortho === '' ? null : Number(i.ortho),
            fluoride: i.fluoride == null || i.fluoride === '' ? null : Number(i.fluoride),
            notes: body.notes || null,
            flags,
            source: body.source === 'backfill' ? 'backfill' : 'tablet',
            corrects: supersedes ? supersedes.id : null,
            correction_reason: body.correction_reason || null,
          }]),
          });
        } catch (e) {
          if (supersedes) {
            await sb(`water_dist_samples?id=eq.${supersedes.id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ superseded_at: null }),
            });
          }
          throw e;
        }
        return res.status(200).json({ ok: true, id: ins[0].id, flags, ...(supersedes ? { corrected: supersedes.id } : {}) });
      }

      // ---- bacteriological sample. The residual is REQUIRED: July 2026's packet reached the
      //      state with no bacti dates and no residuals at all, and nothing stopped it.
      case 'submit_bacti': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const i = body.input || {};
        if (i.free == null || i.free === '') {
          return res.status(422).json({ error: 'validation', errors: [{ field: 'free', msg: 'A bacti sample needs the free chlorine residual taken with it.' }] });
        }
        const site = (p.sites || []).find((s) => s.id === body.site_id) || null;
        /* ⛔ THIS WAS THE ONLY WRITE PATH WITH NO ALREADY-RECORDED GUARD, and it cost five copies
           of every bacti sample in 2026 when the backfill was re-run five times (2026-08-19).
           submit_reading and submit_dist both refuse a day that is already on file; this one
           inserted blindly, so a re-run — the most ordinary thing anyone does with a seeding
           script — silently multiplied the compliance record. A monthly report built from that
           would have shown 70 samples where the village took 14.
           Same contract as its neighbours: refuse, and say what would replace what. */
        const dupeSite = site ? site.name : String(body.site_name || '');
        const already = await sb(
          `water_bacti_samples?supply_id=eq.${p.supply.id}&site_name=eq.${encodeURIComponent(dupeSite)}` +
            `&collected_date=eq.${String(body.collected_date || '').slice(0, 10)}&superseded_at=is.null&select=id`
        );
        const supersedes = already && already[0];
        /* ⛔ AND IT NEEDED A WAY THROUGH, not only a guard. The refusal above was right and
           incomplete: this was the one table with no correction path (migration 051 gave it the
           supersede trio its neighbours have), and it is the table that most needs one. Keith,
           2026-08-26: Michelle sends the samples to the lab herself and the RESULTS COME BACK BY
           EMAIL ABOUT 24 HOURS LATER. A sample is routinely recorded before its result exists,
           so completing the row the next day is the normal case, not an amendment of a mistake. */
        if (supersedes && !body.correction_reason) {
          return res.status(409).json({ error: 'exists', msg: 'That site already has a bacti sample on this date. Send correction_reason to replace it.', id: supersedes.id });
        }
        // Stand the old row down FIRST — the partial unique index (051) is on live rows, and
        // inserting the replacement first is what made corrections impossible on the other two
        // tables until 2026-08-19.
        if (supersedes) {
          await sb(`water_bacti_samples?id=eq.${supersedes.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ superseded_at: new Date().toISOString() }),
          });
        }
        const ins = await sb('water_bacti_samples', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify([{
            supply_id: p.supply.id,
            site_id: site ? site.id : null,
            site_name: site ? site.name : body.site_name,
            sample_kind: body.sample_kind || 'routine',
            collected_date: String(body.collected_date || '').slice(0, 10),
            collected_time: body.collected_time || null,
            operator_id: body.operator_id || null,
            lab_name: body.lab_name || p.supply.lab_name || null,
            method: body.method || null,
            result: body.result || null,
            free: Number(i.free),
            total: i.total == null || i.total === '' ? null : Number(i.total),
            notes: body.notes || null,
            corrects: supersedes ? supersedes.id : null,
            correction_reason: body.correction_reason || null,
          }]),
        }).catch(async (e) => {
          // Put the sample back. A superseded row with nothing replacing it deletes a record.
          if (supersedes) {
            await sb(`water_bacti_samples?id=eq.${supersedes.id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ superseded_at: null }),
            });
          }
          throw e;
        });
        return res.status(200).json({ ok: true, id: ins[0].id, ...(supersedes ? { corrected: supersedes.id } : {}) });
      }

      // ---- the repository: everything recorded in one month, shaped like the paper sheets -----
      case 'month': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const y = Number(body.year), m = Number(body.month);
        if (!(y > 2000 && m >= 1 && m <= 12)) return bad(res, 400, 'year/month required');
        const from = `${y}-${String(m).padStart(2, '0')}-01`;
        const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

        const readings = await sb(
          `water_readings?supply_id=eq.${p.supply.id}&reading_date=gte.${from}&reading_date=lt.${to}` +
            `&superseded_at=is.null&select=*&order=reading_date`
        );
        let feedReadings = [];
        if (readings.length) {
          const ids = readings.map((r) => r.id).join(',');
          feedReadings = await sb(`water_feed_readings?reading_id=in.(${ids})&select=*`);
        }
        const dist = await sb(
          `water_dist_samples?supply_id=eq.${p.supply.id}&sample_date=gte.${from}&sample_date=lt.${to}` +
            `&superseded_at=is.null&select=*&order=sample_date`
        );
        const bacti = await sb(
          `water_bacti_samples?supply_id=eq.${p.supply.id}&collected_date=gte.${from}&collected_date=lt.${to}` +
            `&superseded_at=is.null&select=*&order=collected_date`
        );
        const byReading = {};
        for (const f of feedReadings) (byReading[f.reading_id] ||= []).push(f);
        for (const r of readings) r.feeds = byReading[r.id] || [];

        /* ── the report that actually went to EGLE for this month.
           The `filed` blob is read here and used here; only the card and the diff go over the
           wire, because the page needs the ANSWER ("3 days differ") and not the workbook's cells.
           Computing the diff server-side also keeps it in one place: the page must never grow its
           own copy of this comparison, for the same reason it never recomputes a dose. */
        const filings = await sb(
          `water_mor_filings?supply_id=eq.${p.supply.id}&report_year=eq.${y}&report_month=eq.${m}` +
            `&superseded_at=is.null&select=*&limit=1`
        );
        const filing = filings && filings[0];
        let filedCard = null;
        if (filing) {
          filedCard = filingCard(filing);
          filedCard.diff = diffFiling({
            filed: filing.filed || {}, entryPoints: p.entryPoints, readings, dist, bacti,
          });
        }

        return res.status(200).json({
          ver: VER, supply: p.supply, entryPoints: p.entryPoints, sites: p.sites,
          year: y, month: m, readings, dist, bacti, filing: filedCard,
        });
      }

      // ---- every report this supply has on file ------------------------------------------------
      case 'filings': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const rows = await sb(
          `water_mor_filings?supply_id=eq.${p.supply.id}&superseded_at=is.null` +
            `&select=*&order=report_year.desc,report_month.desc`
        );
        return res.status(200).json({ ver: VER, filings: (rows || []).map(filingCard) });
      }

      // ---- hand back the exact workbook that was submitted --------------------------------------
      case 'filing_workbook': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const y = Number(body.year), m = Number(body.month);
        const rows = await sb(
          `water_mor_filings?supply_id=eq.${p.supply.id}&report_year=eq.${y}&report_month=eq.${m}` +
            `&superseded_at=is.null&select=id,workbook_name,workbook_path,workbook_sha256&limit=1`
        );
        const f = rows && rows[0];
        if (!f) return bad(res, 404, 'no filing on record for that month');
        if (!f.workbook_path) return bad(res, 404, 'that filing was recorded without its workbook');
        const url = await signWorkbook(f.workbook_path, 900);
        if (!url) return bad(res, 502, 'could not sign the workbook');
        return res.status(200).json({ ok: true, name: f.workbook_name, sha256: f.workbook_sha256, url, expires_in: 900 });
      }

      /* ---- record that a month was filed --------------------------------------------------------
         Keith, 2026-08-20: *"why are we not showing EGLE report that she filed the old way"*. This
         is the door those seven workbooks come in through.

         Two properties matter more than anything else here:
         1. RE-RUNNING IS FREE AND SAFE. The path in storage carries the content hash, and a request
            whose bytes already match the live filing returns `unchanged` without writing. The bacti
            table learned this the expensive way — it was the one write path with no already-recorded
            guard and a re-run put five copies of every 2026 sample in the compliance record.
         2. AN AMENDED MOR SUPERSEDES, IT DOES NOT OVERWRITE. Different bytes for a month already on
            file are refused unless a `correction_reason` is supplied, and then the old row is stood
            down FIRST (the partial unique index is on `where superseded_at is null`) and put back if
            the insert fails. Both workbooks stay in storage under their own hashes, because "what
            did we send, and when" has to stay answerable for the version that was actually sent. */
      case 'record_filing': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const y = Number(body.year), m = Number(body.month);
        if (!(y > 2000 && m >= 1 && m <= 12)) return bad(res, 400, 'year/month required');
        if (!body.workbook_b64) return bad(res, 400, 'workbook_b64 required — the filing IS the file');

        let bytes;
        try { bytes = Buffer.from(String(body.workbook_b64), 'base64'); }
        catch { return bad(res, 400, 'workbook_b64 is not valid base64'); }
        if (!bytes.length) return bad(res, 400, 'workbook_b64 decoded to nothing');
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');

        const existing = await sb(
          `water_mor_filings?supply_id=eq.${p.supply.id}&report_year=eq.${y}&report_month=eq.${m}` +
            `&superseded_at=is.null&select=id,workbook_sha256&limit=1`
        );
        const supersedes = existing && existing[0];
        if (supersedes && supersedes.workbook_sha256 === sha) {
          return res.status(200).json({ ok: true, unchanged: true, id: supersedes.id, sha256: sha });
        }
        if (supersedes && !body.correction_reason) {
          return res.status(409).json({
            error: 'exists',
            msg: `${y}-${String(m).padStart(2, '0')} is already recorded as filed, with different bytes. Send correction_reason to record an amended report.`,
            id: supersedes.id,
          });
        }

        const path = `${wssn}/${y}-${String(m).padStart(2, '0')}-${sha.slice(0, 8)}.xls`;
        const up = await putWorkbook(path, bytes);
        if (!up.ok) return bad(res, 502, `could not store the workbook (${up.status}): ${up.msg}`);

        const cover = body.cover || {};
        const filed = body.filed || {};
        const summary = {
          pumpage_days: Object.keys(filed.pumpage || {}).length,
          entry_points: Object.keys(filed.entry_points || {}).length,
          distribution: (filed.distribution || []).length,
          bacti: (filed.bacti || []).length,
          bacti_required: filed.bacti_required ?? null,
          lab_name: filed.lab_name ?? null,
        };

        if (supersedes) {
          await sb(`water_mor_filings?id=eq.${supersedes.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ superseded_at: new Date().toISOString() }),
          });
        }
        let ins;
        try {
          ins = await sb('water_mor_filings', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
              supply_id: p.supply.id,
              report_year: y, report_month: m,
              submitted_date: cover.submitted_date || null,
              signed_by: cover.signed_by || cover.oic_name || null,
              oic_cert: cover.oic_cert || null,
              submitted_to: cover.submitted_to || null,
              comments: cover.comments || null,
              workbook_name: String(body.workbook_name || `${y}-${String(m).padStart(2, '0')}.xls`),
              workbook_bucket: MOR_BUCKET,
              workbook_path: path,
              workbook_sha256: sha,
              workbook_bytes: bytes.length,
              filed,
              filed_summary: summary,
              source: ['backfill', 'product', 'import'].includes(body.source) ? body.source : 'backfill',
              /* Who recorded the filing. A signed-in person wins over anything the caller
                 asserts about itself: the whole point of requiring identity for this action is
                 that the answer stops being self-reported. A script authenticating with the ops
                 code still supplies its own label, because there is no person behind it to name. */
              recorded_by: (actor ? (actor.name || actor.email) : null) || body.recorded_by || null,
              notes: body.notes || null,
              corrects: supersedes ? supersedes.id : null,
              correction_reason: body.correction_reason || null,
            }]),
          });
        } catch (e) {
          // A superseded filing with nothing replacing it would erase the record that a month was
          // ever sent to the state. Put it back exactly as it was.
          if (supersedes) {
            await sb(`water_mor_filings?id=eq.${supersedes.id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ superseded_at: null }),
            });
          }
          throw e;
        }
        return res.status(200).json({
          ok: true, id: ins[0].id, sha256: sha, bytes: bytes.length, summary,
          ...(supersedes ? { superseded: supersedes.id } : {}),
        });
      }

      // ---- setup: add an operator (gated by the supply access code) ---------------------------
      case 'add_operator': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        if (!/^\d{4}$/.test(String(body.pin || ''))) return bad(res, 400, 'pin must be 4 digits');
        const ins = await sb('water_operators', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify([{
            supply_id: p.supply.id,
            name: String(body.name || '').trim(),
            initials: String(body.initials || '').trim().toUpperCase(),
            pin: String(body.pin),
            is_oic: Boolean(body.is_oic),
          }]),
        });
        return res.status(200).json({ ok: true, id: ins[0].id, name: ins[0].name, initials: ins[0].initials });
      }

      case 'set_active': {
        await sb(`water_supplies?wssn=eq.${encodeURIComponent(wssn)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ active: Boolean(body.active) }),
        });
        return res.status(200).json({ ok: true, active: Boolean(body.active) });
      }

      default:
        return bad(res, 400, `unknown action: ${action}`);
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
