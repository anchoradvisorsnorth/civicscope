// civicscope-water/derive.js — THE arithmetic of a water plant's daily record. One copy.
//
// This module is imported by BOTH api/water-ops.js (which re-derives authoritatively at submit)
// and the tablet page (which shows the operator the numbers live, offline, as he types). That is
// deliberate and it is the whole point: the moment the rule exists twice, the screen and the
// filed report can disagree, and the operator has no way to tell which one lied. Centreville's
// paper log and its MOR have disagreed on every dose for years for exactly that reason.
//
// Pure: no network, no clock, no environment. Everything here is testable, and
// scripts/verify-water-derivation.mjs replays a real month through it against the scans.
//
// The formulas are EGLE's Class D template, verbatim:
//   million_gallons = gallons_pumped / 1e6
//   million_lbs     = million_gallons * 8.34
//   solution_lbs    = (previous refill_to ?? previous tank_level) - tank_level
//   avail_lbs       = solution_lbs * feed.avail_fraction
//   dose_mg_l       = avail_lbs / million_lbs
//   ortho_mg_l      = dose_mg_l * feed.ortho_factor

export const LBS_PER_MILLION_GALLONS = 8.34;

/* ⛔ OUT OF FAMILY FOR THIS PLANT IS A DIFFERENT QUESTION FROM OUT OF BOUNDS FOR THE REGULATION,
   AND UNTIL NOW ONLY THE OFFICE ASKED IT.
   `nsf_max_dose` answers "is this illegal" and `warn_max_dose` answers "is this above the ceiling
   somebody configured". Neither fires on a dose that is merely NINE TIMES this plant's normal:
   1 March 2026 recorded Aquadine at 11.53 mg/L against a median of about 1.25 and went into the
   record silently. `/water/review` grew a check for it on 2026-08-20 — but that is the OIC's page,
   read at month end, and by then the operator who could still walk back to the tank is long gone.

   The rule now lives HERE, in the one module both ends import, and `review.html` imports it too
   rather than keeping its own copy. Two copies of "is this normal" is the same defect class as two
   copies of the dose formula: the screen and the report disagree and nobody can tell which lied. */
export const DOSE_OUT_OF_FAMILY = 4;
export const DOSE_NORMAL_MIN_SAMPLES = 8;

/* The median of a plant's own history, or null when there is not enough of it to call anything
   normal. MEDIAN, NEVER MEAN — the outlier this exists to catch is exactly what drags a mean up
   toward itself, raising the very threshold that is supposed to trip on it. */
export function normalOf(series) {
  const v = (series || []).map(Number).filter((n) => isFinite(n) && n > 0).sort((a, b) => a - b);
  if (v.length < DOSE_NORMAL_MIN_SAMPLES) return null;
  return v[Math.floor(v.length / 2)];
}

/* Shared by derive() and by review.html so one multiplier governs both. Returns the multiple
   (e.g. 9) when the value is out of family, otherwise null. */
export function outOfFamily(value, normal) {
  if (value == null || !(normal > 0)) return null;
  const n = Number(value);
  if (!isFinite(n) || n <= normal * DOSE_OUT_OF_FAMILY) return null;
  return n / normal;
}

// ---------------------------------------------------------------------------------------------
// derive() — pure. No network, no dates, no environment. Everything above depends on it.
//
//   entryPoint  { meter_gallons_per_unit, tap_free, tap_total, tap_ortho, tap_fluoride }
//   feeds       [{ id, kind, avail_fraction, ortho_factor, nsf_max_dose, warn_min_dose, warn_max_dose }]
//   prev        { meter_reading, feeds: { [feed_id]: { tank_level, refill_to } } }  (null on day one)
//   input       { meter_reading, tap_free, tap_total, tap_ortho, tap_fluoride,
//                 feeds: { [feed_id]: { tank_level, refill_to } } }
//   context     { minFreeCl, typicalGallons, typicalDose: { [feed_id]: median } }   all optional
//               `typical*` are THIS plant's own medians, computed once in api/water-ops.js and
//               handed to both ends so the well house and the office answer "is this normal"
//               with the same number. Absent, those checks simply do not fire — which is exactly
//               what happened for the whole life of the product until 2026-09-02.
//
// Returns { ok, errors[], flags[], reading{}, feeds[] }. `errors` block the submit; `flags` are
// shown to the operator and stored on the row.
//
// ⚠ THEY ARE NOT ACKNOWLEDGED, AND THIS COMMENT USED TO SAY THEY WERE (Codex finding 4,
// 2026-09-02). `ok` depends only on `errors`, so the Submit button is live the moment the form is
// valid however loud the warning is, and nothing records that the operator read it, reread the
// tank, or accepted it deliberately. A mistyped tank level giving a dose nine times the plant
// median is therefore warned about and filed with equal ease.
// Whether a high-consequence flag should REQUIRE an "I reread and confirm" — and be stored with
// the actor and the time — is a live product decision for Keith, not something to slip in: turning
// every advisory into a hard stop at a well house is how an operator learns to defeat the app.
// Tracked in `Civicscope/CLAUDE.md` → `## Open Action Items`. Until then this comment tells the
// truth about what the flag does, which is: it is displayed, and it is stored.
// ---------------------------------------------------------------------------------------------
export function derive({ entryPoint, feeds = [], prev = null, input = {}, context = {} }) {
  const errors = [];
  const flags = [];
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const round = (v, d) => (v === null || !isFinite(v) ? null : Number(v.toFixed(d)));

  // ---- pumpage -------------------------------------------------------------------------------
  const meter = num(input.meter_reading);
  let gallons = null;
  if (entryPoint.has_meter !== false) {
    if (meter === null || !isFinite(meter)) {
      errors.push({ field: 'meter_reading', msg: 'Meter reading is required.' });
    } else if (prev && prev.meter_reading !== null && prev.meter_reading !== undefined) {
      const units = meter - Number(prev.meter_reading);
      if (units < 0) {
        errors.push({
          field: 'meter_reading',
          msg: `Meter reads lower than last visit (${prev.meter_reading}). Check the digits — a meter does not run backwards.`,
        });
      } else {
        gallons = units * Number(entryPoint.meter_gallons_per_unit || 1);
      }
    }
  }

  const mg = gallons === null ? null : gallons / 1e6;
  const mlbs = mg === null ? null : mg * LBS_PER_MILLION_GALLONS;

  if (gallons === 0) {
    flags.push({ level: 'info', code: 'no_flow', msg: 'Meter unchanged — recording this well as not having run.' });
  }
  /* ⚠ THIS CHECK EXISTED FROM DAY ONE AND HAD NEVER ONCE FIRED IN THE FIELD (found 2026-09-02).
     Nothing supplied `context.typicalGallons` — not the tablet, not api/water-ops.js, not the
     preview route — so `undefined > 0` was false on every reading ever taken and the branch was
     unreachable code wearing the clothes of a safeguard. `api/water-ops.js` now computes the
     plant's own normals once, server-side, and hands them to both ends.
     The tablet's analogue of July's wrong-well defect is typing one well's meter into another
     well's form; totalizers differ by orders of magnitude, so the interval it produces is either
     negative (already a hard error above) or very large — which is what this catches. */
  const flowMultiple = context.typicalGallons > 0 && gallons !== null && gallons > 0
    ? gallons / Number(context.typicalGallons) : null;
  if (flowMultiple !== null && flowMultiple > 3) {
    flags.push({
      level: 'warn', code: 'flow_high',
      msg: `${gallons.toLocaleString()} gal is about ${Math.round(flowMultiple)}x this well's normal day (${Math.round(Number(context.typicalGallons)).toLocaleString()} gal). Re-read the meter — check you are on the right well's screen.`,
    });
  }

  // ---- residuals -----------------------------------------------------------------------------
  const free = num(input.tap_free);
  const total = num(input.tap_total);
  const ortho = num(input.tap_ortho);
  const fluoride = num(input.tap_fluoride);

  if (free !== null && total !== null && free > total) {
    errors.push({
      field: 'tap_total',
      msg: `Free (${free}) cannot exceed total (${total}) — free chlorine is part of the total. Re-read one of them.`,
    });
  }
  if (context.minFreeCl != null && free !== null && free < context.minFreeCl) {
    flags.push({
      level: 'warn', code: 'low_free_cl',
      msg: `Free chlorine ${free.toFixed(2)} mg/L is below the ${context.minFreeCl} mg/L this supply watches.`,
    });
  }

  // ---- chemical feeds ------------------------------------------------------------------------
  const feedRows = [];
  for (const f of feeds) {
    const inF = (input.feeds || {})[f.id] || {};
    const level = num(inF.tank_level);
    const refillTo = num(inF.refill_to);
    const prevF = ((prev && prev.feeds) || {})[f.id] || null;
    // the baseline is what the tank held when the operator walked away last time — which is the
    // level he filled it TO if he filled it, otherwise the level he read.
    const baseline = prevF
      ? (prevF.refill_to !== null && prevF.refill_to !== undefined ? Number(prevF.refill_to) : num(prevF.tank_level))
      : null;

    let solution = null;
    if (f.tank_tracked !== false) {
      if (level === null) {
        // a feed with no level on a day the well did not run is normal, not an omission
        if (gallons !== 0) errors.push({ field: `feed:${f.id}`, msg: `${labelOf(f)} tank level is required.` });
      } else if (baseline !== null) {
        solution = baseline - level;
        if (solution < 0) {
          errors.push({
            field: `feed:${f.id}`,
            msg: `${labelOf(f)} tank reads ${level}, higher than the ${baseline} it held last visit. If it was refilled, record the refill on that visit.`,
          });
          solution = null;
        }
      }
    } else {
      solution = num(inF.solution_lbs);
    }

    if (refillTo !== null && level !== null && refillTo < level) {
      errors.push({ field: `feed:${f.id}`, msg: `Refilled-to (${refillTo}) is below the level you just read (${level}).` });
    }

    const avail = solution === null ? null : solution * Number(f.avail_fraction);
    const dose = avail === null || !mlbs ? null : avail / mlbs;
    const orthoApplied = dose === null || f.ortho_factor == null ? null : dose * Number(f.ortho_factor);

    // "is this like every other day here" — answered from the plant's own history, quantified.
    const familyMultiple = outOfFamily(dose, (context.typicalDose || {})[f.id]);

    if (dose !== null) {
      if (f.nsf_max_dose != null && dose > Number(f.nsf_max_dose)) {
        errors.push({ field: `feed:${f.id}`, msg: `${labelOf(f)} dose ${dose.toFixed(2)} mg/L exceeds the NSF maximum of ${f.nsf_max_dose} mg/L.` });
      } else if (familyMultiple !== null) {
        /* Deliberately ahead of the configured ceiling in this chain, and never alongside it: a
           quantified "about 9x normal" tells the operator what to go and re-read, where "above the
           normal range" does not. Reporting both would say one thing twice — the same
           double-reporting /water/review already suppresses. */
        flags.push({
          level: 'warn', code: 'dose_out_of_family',
          msg: `${labelOf(f)} dose ${dose.toFixed(2)} mg/L is about ${Math.round(familyMultiple)}x this plant's normal (${Number((context.typicalDose || {})[f.id]).toFixed(2)} mg/L). Re-read the tank level before you leave — usually it is this level or the one from last visit.`,
        });
      } else if (f.warn_max_dose != null && dose > Number(f.warn_max_dose)) {
        flags.push({ level: 'warn', code: 'dose_high', msg: `${labelOf(f)} dose ${dose.toFixed(2)} mg/L is above this plant's normal range.` });
      } else if (f.warn_min_dose != null && solution > 0 && dose < Number(f.warn_min_dose)) {
        flags.push({ level: 'warn', code: 'dose_low', msg: `${labelOf(f)} dose ${dose.toFixed(2)} mg/L is below this plant's normal range.` });
      }
    }

    feedRows.push({
      feed_id: f.id,
      kind: f.kind,
      tank_level: level,
      refill_to: refillTo,
      solution_lbs: round(solution, 3),
      avail_lbs: round(avail, 4),
      dose_mg_l: round(dose, 2),
      ortho_mg_l: round(orthoApplied, 3),
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    flags,
    reading: {
      meter_reading: meter,
      gallons_pumped: gallons,
      million_gallons: round(mg, 6),
      million_lbs: round(mlbs, 4),
      tap_free: entryPoint.tap_free ? free : null,
      tap_total: entryPoint.tap_total ? total : null,
      tap_ortho: entryPoint.tap_ortho ? ortho : null,
      tap_fluoride: entryPoint.tap_fluoride ? fluoride : null,
      pressure_psi: entryPoint.records_pressure ? num(input.pressure_psi) : null,
      temp_f: entryPoint.records_temp ? num(input.temp_f) : null,
    },
    feeds: feedRows,
  };
}

function labelOf(f) {
  return f.product_name || ({ chlorine: 'Chlorine', phosphate: 'Phosphate', fluoride: 'Fluoride', ph_adjust: 'pH chemical' }[f.kind] || f.kind);
}

