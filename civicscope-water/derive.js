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

// ---------------------------------------------------------------------------------------------
// derive() — pure. No network, no dates, no environment. Everything above depends on it.
//
//   entryPoint  { meter_gallons_per_unit, tap_free, tap_total, tap_ortho, tap_fluoride }
//   feeds       [{ id, kind, avail_fraction, ortho_factor, nsf_max_dose, warn_min_dose, warn_max_dose }]
//   prev        { meter_reading, feeds: { [feed_id]: { tank_level, refill_to } } }  (null on day one)
//   input       { meter_reading, tap_free, tap_total, tap_ortho, tap_fluoride,
//                 feeds: { [feed_id]: { tank_level, refill_to } } }
//   context     { minFreeCl, typicalGallons }   both optional
//
// Returns { ok, errors[], flags[], reading{}, feeds[] }. `errors` block the submit; `flags` are
// shown to the operator, acknowledged, and stored on the row.
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
  if (gallons !== null && context.typicalGallons > 0 && gallons > context.typicalGallons * 3) {
    flags.push({
      level: 'warn', code: 'flow_high',
      msg: `${gallons.toLocaleString()} gal is more than 3x this well's normal day. Re-read the meter before submitting.`,
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

    if (dose !== null) {
      if (f.nsf_max_dose != null && dose > Number(f.nsf_max_dose)) {
        errors.push({ field: `feed:${f.id}`, msg: `${labelOf(f)} dose ${dose.toFixed(2)} mg/L exceeds the NSF maximum of ${f.nsf_max_dose} mg/L.` });
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

