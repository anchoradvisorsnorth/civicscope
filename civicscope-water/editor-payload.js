// civicscope-water/editor-payload.js — the ONE shape of a well-day the office editor submits.
//
// WHY THIS IS ITS OWN FILE, like derive.js. The OIC's editor (review.html) built its request inline,
// and the 2026-09-11 adversarial review (R4-1) found it had never matched what the API reads:
// feeds went as an ARRAY where derive() indexes an object by feed id, the residuals went as
// `free_cl` / `total_cl` / `ortho` where the API reads `tap_free` / `tap_total` / `tap_ortho`, and
// pressure, temperature, fluoride and direct-usage pounds were dropped. A pumping edit was refused
// for "missing" tank levels that were filled in; an idle-day edit could SAVE, replacing recorded
// observations with nulls. The tablet had the right shape all along; the editor had a second copy.
//
// So the shape lives here, imported by the page AND by scripts/verify-water-write-path.mjs, which
// drives a payload built by this exact function through the real handler. It is served publicly,
// like derive.js; there is nothing secret in it.

/* The editable fields of a well-day, in the order the form shows them. Only OBSERVED values:
   meter, each feed's tank level and refill-to (or its direct usage, for a feed with no tank),
   the plant tap, and pressure / temperature where this entry point records them.
   `row` is the stored reading (with `feeds`) when editing, null when adding. */
/* Fields that are text, not numbers. Everything else the form carries is numeric. */
export const TEXT_FIELDS = new Set(['reading_time', 'operator_initials']);

export function readingFields(ep, row) {
  const out = [
    { k: 'meter_reading', label: 'Meter', v: row ? row.meter_reading : '' },
    // context the record carries and a correction must not lose (R5-2): shown, editable, preserved
    { k: 'reading_time', label: 'Time (HH:MM)', v: row ? (row.reading_time || '').slice(0, 5) : '', text: true },
    { k: 'operator_initials', label: 'Read by (initials)', v: row ? row.operator_initials : '', text: true },
  ];
  for (const fd of (ep && ep.feeds) || []) {
    const fr = row ? ((row.feeds || []).find((x) => x.feed_id === fd.id) || {}) : {};
    const name = fd.product_name || fd.kind;
    if (fd.tank_tracked === false) {
      out.push({ k: `feed:${fd.id}:solution_lbs`, label: `${name} used (lbs)`, v: fr.solution_lbs });
    } else {
      out.push({ k: `feed:${fd.id}:tank_level`, label: `${name} tank`, v: fr.tank_level });
      out.push({ k: `feed:${fd.id}:refill_to`, label: `${name} refill to`, v: fr.refill_to });
    }
  }
  if (!ep || ep.tap_free !== false)  out.push({ k: 'tap_free',  label: 'Tap free',  v: row ? row.tap_free : '' });
  if (!ep || ep.tap_total !== false) out.push({ k: 'tap_total', label: 'Tap total', v: row ? row.tap_total : '' });
  if (!ep || ep.tap_ortho !== false) out.push({ k: 'tap_ortho', label: 'Tap PO4',   v: row ? row.tap_ortho : '' });
  if (ep && ep.tap_fluoride)       out.push({ k: 'tap_fluoride', label: 'Tap fluoride', v: row ? row.tap_fluoride : '' });
  if (ep && ep.records_pressure)   out.push({ k: 'pressure_psi', label: 'Pressure (psi)', v: row ? row.pressure_psi : '' });
  if (ep && ep.records_temp)       out.push({ k: 'temp_f',       label: 'Temp (°F)',      v: row ? row.temp_f : '' });
  return out;
}

/* The request the API reads, built from the form's values (a map of field key → string or null).
   `feeds` is an OBJECT keyed by feed id — derive() reads `input.feeds[f.id]` — and every
   observation the form carried is present, so an edit never drops what it did not change.
   ⛔ `corrects_id` PINS THE REVISION SHE OPENED (R5-1). Two office tabs on one day: the second to
   save used to supersede whatever was live by then, silently discarding the first's correction.
   The server refuses (`target_mismatch`) when the live row is no longer the one this form was
   built from — on the first attempt and on every re-plan. */
export function readingPayload({ wssn, date, ep, vals, why, row = null, source = 'backfill' }) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const txt = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const input = { feeds: {} };
  const top = {};
  for (const [k, v] of Object.entries(vals || {})) {
    if (k.startsWith('feed:')) {
      const [, id, which] = k.split(':');
      (input.feeds[id] ||= {})[which] = num(v);
    } else if (TEXT_FIELDS.has(k)) {
      top[k] = txt(v);            // reading_time / operator_initials ride at the top level, as the API reads them
    } else {
      input[k] = num(v);
    }
  }
  return {
    action: 'submit_reading', wssn, reading_date: date,
    entry_point_id: ep ? ep.id : undefined,
    ...top,
    input, source,
    corrects_id: row && row.id ? row.id : undefined,
    correction_reason: why || null,
  };
}
