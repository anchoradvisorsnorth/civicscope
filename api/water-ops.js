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

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OPS_CODE = process.env.WATER_OPS_CODE || '';

export const VER = '1.0.0-waterops';

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

const bad = (res, code, msg) => res.status(code).json({ error: msg });

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.ver) return res.status(200).json({ ver: VER });
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  if (!SB_URL || !SB_KEY) return bad(res, 500, 'storage not configured');

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const action = body.action;
  const READ_ONLY = new Set(['profile', 'month', 'preview']);

  // Fail closed. An unset access code must not mean an open plant record.
  if (!READ_ONLY.has(action)) {
    if (!OPS_CODE) return bad(res, 503, 'WATER_OPS_CODE is not configured — writes are disabled.');
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
          if (operator.pin && String(body.pin || '') !== String(operator.pin)) return bad(res, 403, 'Wrong PIN.');
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

        return res.status(200).json({
          ver: VER, supply: p.supply, entryPoints: p.entryPoints, sites: p.sites,
          year: y, month: m, readings, dist, bacti,
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
