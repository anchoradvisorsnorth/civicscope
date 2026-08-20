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
// SECURITY POSTURE. This repo is PUBLIC. The supply access code lives in Vercel env
// (WATER_OPS_CODE) and never here; per-operator PINs live in Supabase and are never returned by
// any action. If the code is not configured, every write action REFUSES — a missing credential
// must fail closed, not open.

export const config = { maxDuration: 30 };

import crypto from 'node:crypto';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OPS_CODE = process.env.WATER_OPS_CODE || '';

// Private bucket holding the exact .xls workbooks that were submitted to EGLE. Never public: it is
// reached only through short-lived signed URLs minted per request, same posture as
// `ryc-invoice-scans`.
const MOR_BUCKET = 'water-mor-filings';

export const VER = '1.1.0-waterops';

import { derive, LBS_PER_MILLION_GALLONS } from '../civicscope-water/derive.js';
export { derive };

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

      if (fMg == null && oMg == null) { /* neither side has the day — nothing to say */ }
      else if (oMg == null) {
        rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: 'million_gallons',
          kind: 'filed_only', filed: fMg, ours: null,
          msg: `${fMg} MG was filed for ${ep.label} on day ${d}, but there is no reading on file for that day.` });
      } else if (fMg == null) {
        rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: 'million_gallons',
          kind: 'ours_only', filed: null, ours: oMg,
          msg: `${ep.label} is recorded as pumping ${oMg} MG on day ${d}, and the filed report shows nothing for it.` });
      } else if (!near(fMg, oMg, MG_TOLERANCE)) {
        rows.push({ day: Number(d), ep_id: ep.id, ep: ep.label, field: 'million_gallons',
          kind: 'differs', filed: fMg, ours: oMg,
          msg: `${ep.label} day ${d}: the report says ${fMg} MG, the records say ${oMg} MG.` });
      }

      if (!r) continue;
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
    matches: rows.length === 0 && counts.dist_filed === counts.dist_ours && counts.bacti_filed === counts.bacti_ours,
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
     ⚠ Stated plainly: with this, anyone holding the /water URL can write a reading into a record
     that sits behind a report signed under 1976 PA 399. That is the same posture the village hub
     already describes in words ("open on this link for now") and the same one the OIC review page
     runs under. Google sign-in is what closes it, for both surfaces at once. */
  const FIELD_ENTRY = new Set(['submit_reading', 'submit_dist', 'submit_bacti']);
  if (!READ_ONLY.has(action) && !FIELD_ENTRY.has(action)) {
    if (!OPS_CODE) return bad(res, 503, 'WATER_OPS_CODE is not configured — admin actions are disabled.');
    if (body.code !== OPS_CODE) return bad(res, 403, 'Wrong access code.');
  }

  try {
    const wssn = String(body.wssn || '').trim();
    if (!wssn) return bad(res, 400, 'wssn required');

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
          writesEnabled: Boolean(OPS_CODE),
        });
      }

      // ---- run the arithmetic without storing anything (what the tablet shows live) ----------
      case 'preview': {
        const p = await loadProfile(wssn);
        if (!p) return bad(res, 404, 'unknown supply');
        const ep = p.entryPoints.find((e) => e.id === body.entry_point_id);
        if (!ep) return bad(res, 404, 'unknown entry point');
        const prev = await previousReading(ep.id, body.reading_date);
        const out = derive({
          entryPoint: ep, feeds: ep.feeds, prev, input: body.input || {},
          context: { minFreeCl: p.supply.min_free_cl },
        });
        return res.status(200).json({ ...out, previous: prev });
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
        const out = derive({
          entryPoint: ep, feeds: ep.feeds, prev, input: body.input || {},
          context: { minFreeCl: p.supply.min_free_cl },
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
        if (supersedes) {
          await sb(`water_readings?id=eq.${supersedes.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ superseded_at: new Date().toISOString() }),
          });
        }
        let inserted;
        try {
          inserted = await sb('water_readings', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify([{
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
          }]),
          });
        } catch (e) {
          // Put the day back exactly as it was. A correction that fails must leave the record it
          // was trying to amend still standing.
          if (supersedes) {
            await sb(`water_readings?id=eq.${supersedes.id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ superseded_at: null }),
            });
          }
          throw e;
        }
        const row = inserted[0];

        if (out.feeds.length) {
          await sb('water_feed_readings', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(out.feeds.map((f) => ({ reading_id: row.id, ...f, kind: undefined }))),
          });
        }
        return res.status(200).json({
          ok: true, id: row.id, derived: out.reading, feeds: out.feeds, flags: out.flags,
          ...(supersedes ? { corrected: supersedes.id } : {}),
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
            `&collected_date=eq.${String(body.collected_date || '').slice(0, 10)}&select=id`
        );
        if (already && already[0]) {
          return res.status(409).json({ error: 'exists', msg: 'That site already has a bacti sample on this date.', id: already[0].id });
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
          }]),
        });
        return res.status(200).json({ ok: true, id: ins[0].id });
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
            `&select=*&order=collected_date`
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
              recorded_by: body.recorded_by || null,
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
