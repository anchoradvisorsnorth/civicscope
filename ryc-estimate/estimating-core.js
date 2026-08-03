/* estimating-core.js — THE estimating brain. ONE copy, two callers.
 *
 * The Desk (browser) and the VM takeoff runner both use this file. The VM fetches it from
 * production at runtime rather than vendoring a copy, so there is physically one implementation
 * and drift is impossible rather than merely unlikely. Two estimators that quietly disagree
 * about the same drawings is the worst failure a bid tool has.
 *
 * The bodies below were moved VERBATIM out of ryc-estimate/index.html (2026-08-03), including
 * every transitive helper. They reference portfolio / benchmarks / uploadedFiles / money / pct /
 * CLASS_LABEL as free variables, so rather than rewriting them — which is exactly where a
 * refactor injects bugs — they are enclosed in a scope that supplies those names. Behaviour is
 * identical by construction, and a golden capture of every prompt and parse output taken before
 * the move is diffed after it.
 *
 *   const core = RYCEstimating.core({ portfolio, benchmarks, uploadedFiles, money, pct, scopeC });
 *   core.buildPrompt(inp, bm)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RYCEstimating = factory();
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const _money = (n) => n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
  const _pct = (n) => n == null ? "—" : n.toFixed(1) + "%";

  function core(ctx) {
    ctx = ctx || {};
    const portfolio = ctx.portfolio || null;
    const benchmarks = ctx.benchmarks || null;
    const uploadedFiles = ctx.uploadedFiles || [];
    const money = ctx.money || _money;
    const pct = ctx.pct || _pct;
    // scopeConstraintText reads window._scopeC in the Desk; supplied explicitly so the module
    // never reaches for a global the VM does not have.
    const window = { _scopeC: ctx.scopeC || null };
    const CLASS_LABEL = { SUB: 'Subcontract', MAT: 'GC materials', LAB: 'GC/supervision labor', BUR: 'Labor burden', EQU: 'Equipment', OTH: 'Other', REQ: 'Other' };
    const num = s => parseMoney(s).value;
    const OUT_FORMAT = `Respond in EXACTLY this format:
    COST_LOW: [number, no decimals]
    COST_HIGH: [number, no decimals]
    COST_MIDPOINT: [number, no decimals]
    CONFIDENCE: [High / Medium / Low]
    NARRATIVE: [2-3 sentences, estimator-to-estimator. What drives the range and the key risks, referencing RYC's historical pattern for this work.]
    DIVISIONS:
    - [2-digit CSI division #] [name]: $[amount] — [brief scope]
    - [Use RYC's CSI divisions and START each line with the 2-digit number: 01 General Requirements, 02 Existing Conditions, 03 Concrete, 04 Masonry, 05 Metals, 06 Wood, 07 Thermal & Moisture, 08 Doors & Windows, 09 Finishes, 10 Specialties, 11 Equipment, 12 Furnishings, 13 Special Construction (PEMB), 21 Fire Suppression, 22 Plumbing, 23 Mechanical, 26 Electrical, 31 Earthwork, 32 Exterior Improvements, 33 Utilities. Biggest first. EVERY division is a SUBCONTRACT placeholder pending a real quote — RYC self-performs nothing.]
    ASSUMPTIONS:
    - [assumption]
    - [assumption]
    - [assumption]
    GAP_QUESTIONS:
    - [question]? (±$[impact])
    - [question]? (±$[impact])
    [3-6 questions ordered by dollar impact; if none, write: GAP_QUESTIONS: none]
    
    Rules: This is a CONCEPTUAL bid-assembly draft, NOT a final bid — every division cost is a subcontract placeholder to be confirmed with a live sub quote (RYC self-performs nothing). Current northern-Indiana pricing. Design-Bid-Build. Include GC overhead, general conditions, permitting, design/engineering allowance (3-5%). Exclude land. No proprietary database names (RSMeans, Gordian).`;
    const DISTINCT_CLASSES = ['water_wastewater', 'education'];

    const DRIFT_LIMIT_PCT = 10;
    const PCLASS_LABEL = { water_wastewater: 'water / wastewater', education: 'education', building: 'building' };
function segBenchmarks(inp) {
  const ct = inp.ct, wt = inp.wt, excludeName = inp.name;
  let excluded = 0;
  const jobs = (portfolio?.jobs || []).filter(j => { if (!j.contractFinal) return false; if (excludeName && ciSameJob(excludeName, j.name)) { excluded++; return false; } return true; });

  const cls = subClassFor(inp);
  const clsLabel = PCLASS_LABEL[cls] || cls;
  const inClass = jobs.filter(j => jobProjectClass(j) === cls);
  const distinct = DISTINCT_CLASSES.includes(cls);
  const MIN_CLASS_N = 3;
  // A distinctive class with too thin a completed-job pool has no defensible analogs at all.
  // (Live today: RYC has 0 COMPLETED water/wastewater jobs — Shipshewana, Huntertown, Wakarusa
  // and Ashley are all still active, so they are not in the completed portfolio yet.)
  const weakClass = distinct && inClass.length < MIN_CLASS_N;

  let set, basis;
  if (distinct && !weakClass) {
    // Class is the hard filter; refine within it by work type when the sample supports it.
    const byWt = inClass.filter(j => j.workType === wt);
    if (byWt.length >= MIN_CLASS_N) { set = byWt; basis = `${clsLabel} + work type`; }
    else { set = inClass; basis = clsLabel; }
  } else {
    set = jobs.filter(j => j.clientType === ct && j.workType === wt); basis = 'client type + work type';
    if (set.length < MIN_CLASS_N) { const s = jobs.filter(j => j.clientType === ct); if (s.length > set.length) { set = s; basis = 'client type'; } }
    if (set.length < MIN_CLASS_N) { const s = jobs.filter(j => j.workType === wt); if (s.length > set.length) { set = s; basis = 'work type'; } }
    if (!set.length) { set = jobs; basis = 'full portfolio'; }
    if (weakClass) basis += ' — outside this project class';
  }
  let contract = 0, cost = 0, bidC = 0, bidCost = 0, buy = 0, buySub = 0;
  const comp = {}; let compTot = 0; const psf = [];
  for (const j of set) {
    contract += j.contractFinal || 0; cost += j.directCost || 0;
    bidC += j.contractOriginal || 0; bidCost += j.originalCost || 0;
    if (j.buyout) { buy += j.buyout.total || 0; buySub += j.buyout.sub || 0; }
    for (const c of (j.buyout?.byClass || [])) if ((c.act || 0) > 0) { comp[c.cls] = (comp[c.cls] || 0) + c.act; compTot += c.act; }
    if (j.sqft > 0 && j.contractFinal > 0) psf.push(j.contractFinal / j.sqft);
  }
  psf.sort((a, b) => a - b);
  const compPct = {}; for (const k in comp) compPct[k] = compTot > 0 ? comp[k] / compTot * 100 : 0;
  const bidMargin = bidC > 0 ? (bidC - bidCost) / bidC * 100 : null;
  const actMargin = contract > 0 ? (contract - cost) / contract * 100 : null;
  const contracts = set.map(j => j.contractFinal).filter(Boolean).sort((a, b) => a - b);
  return {
    n: set.length, basis, excluded, bidMargin, actMargin,
    cls, clsLabel, clsN: inClass.length, weakClass,
    gainFade: (bidMargin != null && actMargin != null) ? actMargin - bidMargin : null,
    buy, buySubPct: buy > 0 ? buySub / buy * 100 : null,
    comp: compPct, medianPSF: psf.length ? psf[Math.floor(psf.length / 2)] : null,
    contractMin: contracts[0] || null, contractMax: contracts[contracts.length - 1] || null,
    contractMed: contracts.length ? contracts[Math.floor(contracts.length / 2)] : null,
    analogs: set.slice(0, 10).map(j => ({ name: j.name, contract: j.contractFinal || null, sqft: j.sqft || null, psf: (j.sqft > 0 && j.contractFinal) ? Math.round(j.contractFinal / j.sqft) : null })),
  };
}

function rycGroundingText(inp, bm) {
  const comp = Object.entries(bm.comp).sort((a, b) => b[1] - a[1]).filter(([, v]) => v >= 1).map(([k, v]) => `${CLASS_LABEL[k] || k} ${Math.round(v)}%`).join(', ') || 'n/a';
  const hasPlans = uploadedFiles.length > 0;
  const ratios = `RYC HISTORICAL RATIOS for this segment (RYC's OWN completed jobs, matched on ${bm.basis}, ${bm.n} job(s)) — use these to shape MARGIN and the COST SPLIT, NOT to set the total. RYC self-performs NO trade work — every division is SUBCONTRACTED, so each division cost is a sub-quote placeholder plus GC general conditions/overhead:
- As-bid margin ${pct(bm.bidMargin)} → actually achieved ${pct(bm.actMargin)}${bm.gainFade != null ? ` (RYC typically ${bm.gainFade >= 0 ? 'gains' : 'fades'} ${Math.abs(bm.gainFade).toFixed(1)} pts bid→actual on this work)` : ''}.
- Cost composition (RYC actuals): ${comp}.
- Subcontract buyout: RYC historically lands ${money(bm.buy)} under estimate${bm.buySubPct != null ? ` (${Math.round(bm.buySubPct)}% of it on subs)` : ''}.`;
  if (hasPlans) {
    return `${ratios}
${scopeConstraintText()}
Determine the TOTAL purely BOTTOM-UP from the plan takeoff: measure the real quantities and scope in the drawings, price each division from those quantities at RYC's northern-Indiana subcontract market, then sum. Do NOT reverse-engineer the total from RYC's average job size or from other projects — price THIS building at THIS scale from what the drawings actually show. RYC builds economical municipal / PEMB / light-commercial work: a pre-engineered metal building or bare shell commonly runs far below national institutional $/SF, and generic $400–500/SF benchmarks almost always OVERSTATE this work. Anchor magnitude to the drawings' real square footage and quantities, apply RYC's realistic achieved margin above, and reflect the subcontract-heavy split — nothing else sets the total.
PRICE ONLY THE CONTRACT, NOT THE DRAWINGS: on renovation/replacement work the drawing set typically shows the ENTIRE existing building for context — the contract covers only the new/renovated work. Price the work being ADDED or REPLACED; do not price restoration of everything visible. If equipment is noted as owner-furnished (OFCI) or pre-purchased, price installation only. If the contract boundary is ambiguous from the documents, keep the estimate narrow and raise the ambiguity in GAP_QUESTIONS instead of pricing whole-building scope.`;
  }
  // Anchoring to out-of-class jobs is worse than not anchoring: it pulls a wastewater or other
  // specialty scope toward the magnitude of unrelated building work. When the pursuit's class has
  // no completed history, withhold the anchors and tell the model to price from scope alone.
  if (bm.weakClass) {
    return `${ratios}

No plans were uploaded, and RYC has NO completed ${bm.clsLabel} jobs to anchor magnitude against — the portfolio ratios above are the company's general operating pattern, not comparable work. Do NOT anchor this total to RYC's other project types; they are a different scope class and would mislead. Price bottom-up from the scope notes and normal ${bm.clsLabel} construction cost structure, keep the range WIDE to reflect the missing history, report CONFIDENCE: Low, and put the biggest unknowns in GAP_QUESTIONS. Apply RYC's realistic achieved margin above and the subcontract-heavy split.`;
  }
  const anchorLines = (bm.analogs || []).filter(a => a.contract).map(a => `  • ${a.name}: ${money(a.contract)}${a.psf ? ` (${a.sqft.toLocaleString()} SF, $${a.psf}/SF)` : ''}`).join('\n');
  return `${ratios}${bm.medianPSF ? `\n- Historical $/SF on this work: ~$${Math.round(bm.medianPSF).toLocaleString()}/SF (thin sample — directional).` : ''}

No plans were uploaded, so use these comparable RYC job totals to anchor MAGNITUDE${(bm.contractMin && bm.contractMax) ? ` (range ${money(bm.contractMin)}–${money(bm.contractMax)}, median ${money(bm.contractMed)})` : ''}:
${anchorLines || '  (no comparable contract values available)'}
Price bottom-up from the scope notes where you can, but WITHOUT a takeoff these comparables are your best magnitude reference — land in a defensible relationship to them: a smaller or simpler scope than the analogs should land below the range, a larger or heavier scope above it. Still avoid inflated national institutional $/SF ($400–500/SF) — RYC builds economical work. Apply RYC's realistic achieved margin above and the subcontract-heavy split.`;
}

function buildPrompt(inp, bm) {
  const fileNote = uploadedFiles.length ? `\nUPLOADED: ${uploadedFiles.length} plan/spec page(s). Read thoroughly — extract SF, dimensions, structural/MEP scope, finishes, site work, phasing, special requirements. Where documents are specific, use them over the form inputs.` : '';
  return `You are a senior construction cost estimator working inside R. Yoder Construction's (RYC) estimating team. Estimator-to-estimator tone — precise, direct.${fileNote}

PROJECT:
- Name: ${inp.name}
- Client type: ${inp.ct} · Work type: ${inp.wt}
- Location: ${inp.loc || 'Northern Indiana'}
${inp.sf ? `- Size: ${inp.sf.toLocaleString()} SF` : ''}
${inp.target ? `- Known budget/target: $${inp.target.toLocaleString()}` : ''}
${inp.scope ? `- Scope notes: ${inp.scope}` : ''}

${rycGroundingText(inp, bm)}

${OUT_FORMAT}`;
}

function consolidatePrompt(inp, bm, first, sup) {
  return `You are a senior estimator for RYC. You reviewed a large plan set in batches.

INITIAL ESTIMATE:
${first}

ADDITIONAL FINDINGS:
${sup.join('\n\n---\n\n')}

${rycGroundingText(inp, bm)}

Produce ONE consolidated estimate incorporating ALL findings, still grounded in the RYC benchmarks above.

${OUT_FORMAT}`;
}

function splitIntoBatches(files) {
  const MAX_B64 = 3 * 1024 * 1024, MAX_PAGES = 10, batches = []; let cur = [], size = 0;
  for (const f of files) {
    if ((size + f.base64.length > MAX_B64 || cur.length >= MAX_PAGES) && cur.length) { batches.push(cur); cur = []; size = 0; }
    cur.push(f); size += f.base64.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function parseResponse(raw) {
  const get = k => { const m = raw.match(new RegExp(`${k}:\\s*(.+)`)); return m ? m[1].trim() : ''; };
  const block = (k, next) => { const m = raw.match(new RegExp(`${k}:\\s*([\\s\\S]*?)(?:\\n(?:${next}):|$)`)); return m ? m[1].trim() : ''; };
  const lines = s => s.split('\n').map(l => l.replace(/^[-•]\s*/, '').trim()).filter(Boolean);

  // Rejoin a wrapped row: "03 Concrete:" on one line, its value on the next.
  const rawDiv = lines(block('DIVISIONS', 'ASSUMPTIONS'));
  const merged = [];
  for (let i = 0; i < rawDiv.length; i++) {
    const cur = rawDiv[i], nxt = rawDiv[i + 1], c = splitDivisionRow(cur);
    // Only rejoin when the next line is a bare wrapped VALUE — never when it is itself a
    // numbered CSI row (an unpriced row followed by the next division used to merge into one
    // mangled line, hiding the unpriced row from the fail-closed gate).
    if (c.amount == null && c.div && nxt && /^\$?\s*\d/.test(nxt.trim()) && !splitDivisionRow(nxt.trim()).div) { merged.push(cur.replace(/[\s:]+$/, '') + ': ' + nxt.trim()); i++; }
    else merged.push(cur);
  }

  // Unnumbered rows that carry money are usually real packages ("Concrete — $180,000"), but the
  // model also emits arithmetic commentary that carries money ("Subtotal check: sums to $X").
  // Numbered CSI rows are always real; only unnumbered ones need this discriminator, and it is
  // deliberately narrow so a genuine package like "Total Station Survey" survives.
  const COMMENTARY = /\bsums?\s+to\b|\bsub-?total\b|\bgrand total\b|^total\s*[:=]|^total$|\bsanity check\b|\brounding\b|^check\b|^note\b/i;
  // A numbered row saying N/A / by others / excluded is a SEMANTIC EXCLUSION, not a parse
  // failure — the model is stating contract scope, and blocking the whole estimate on it
  // punished a correct answer (Codex #9). OFCI is NOT here: install-only still needs a carry.
  const EXCLUSION = /\bn\/?a\b|\bnot applicable\b|\bby others\b|\bexcluded\b|\bnot in contract\b|\bnic\b|\bno work\b/i;
  const divisions = [], parseIssues = [], exclusions = [];
  for (const line of merged) {
    const r = splitDivisionRow(line);
    if (r.amount > 0 && !r.div && COMMENTARY.test(r.name)) continue;   // model math commentary
    if (!(r.amount > 0)) {
      if (r.div && EXCLUSION.test(line)) { exclusions.push({ line, name: (r.div ? r.div + ' ' : '') + r.name }); continue; }
      // A numbered CSI row we cannot price is a PARSE FAILURE, never a $0 package — emitting
      // it as $0 is what let a real package silently vanish from the canonical rollup.
      if (r.div) parseIssues.push({ line, reason: 'no_amount' });
      else if (/\$/.test(line)) parseIssues.push({ line, reason: 'dropped' });
      // an unnumbered line with no money is model commentary (subtotal checks, margin
      // musings) — the v1.7.1 behaviour, still correct.
      continue;
    }
    divisions.push({ name: (r.div ? r.div + ' ' : '') + r.name, amount: r.amount, scope: r.scope, div: r.div, flag: r.flag || null });
  }
  const gRaw = block('GAP_QUESTIONS', '[A-Z_]+');
  let gaps = [];
  if (gRaw && gRaw.toLowerCase() !== 'none') gaps = lines(gRaw).map(l => { const m = l.match(/^(.*?)\s*\((.*?)\)\s*$/); return m ? { q: m[1].trim(), impact: m[2].trim() } : { q: l, impact: '' }; });
  return {
    low: get('COST_LOW'), high: get('COST_HIGH'), mid: get('COST_MIDPOINT'),
    confidence: get('CONFIDENCE'), narrative: get('NARRATIVE'),
    divisions, assumptions: lines(block('ASSUMPTIONS', 'GAP_QUESTIONS')), gaps, parseIssues, exclusions,
  };
}

function reconcileTotals(p) {
  const divTot = (p.divisions || []).reduce((s, d) => s + (d.amount || 0), 0);
  const stated = num(p.mid), lo = num(p.low), hi = num(p.high);
  const flat = { total: stated, low: lo, high: hi, stated, drift: 0, driftPct: 0, rescaled: false };
  if (!divTot || !stated) return divTot ? Object.assign({}, flat, { total: divTot }) : flat;
  const k = divTot / stated, drift = divTot - stated;
  return {
    total: divTot,
    low: lo != null ? Math.round(lo * k) : null,
    high: hi != null ? Math.round(hi * k) : null,
    stated, drift, driftPct: drift / stated * 100,
    // Only call it a rescale when it would actually move a displayed figure.
    rescaled: Math.abs(k - 1) > 0.005,
  };
}

function estimateGate(p, recon) {
  const issues = (p && p.parseIssues) || [];
  const blocking = issues.filter(i => i.reason === 'no_amount' || i.reason === 'dropped');
  const drift = recon && recon.stated && Math.abs(recon.driftPct) > DRIFT_LIMIT_PCT;
  const ranges = (p && p.divisions || []).filter(d => d.flag === 'range');
  return { blocking, drift: !!drift, ranges, gated: blocking.length > 0 || !!drift };
}

function ciSameJob(a, b) {
  const na = ciNorm(a).join(' '), nb = ciNorm(b).join(' ');
  if (!na || !nb) return false;
  if (na === nb) return true;
  if ((na.length >= 5 && nb.includes(na)) || (nb.length >= 5 && na.includes(nb))) return true;  // "Fulton" ⊂ "Fulton County Airport Hangar"
  const A = new Set(ciNorm(a)), B = new Set(ciNorm(b)); let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const union = new Set([...A, ...B]).size; return union > 0 && inter / union >= 0.5;
}

function subClassFor(inp) {
  return classifyProjectText((inp.name || '') + ' ' + (inp.scope || '')) || classForCt(inp.ct);
}

function jobProjectClass(j) { return classifyProjectText(j.name) || classForCt(j.clientType); }

function scopeConstraintText() {
  const c = window._scopeC;
  if (!c) return '';
  const L = [];
  if (c.scopeSummary) L.push(`- CONTRACT SCOPE: ${c.scopeSummary}`);
  if (c.inScope && c.inScope.length) L.push(`- IN-SCOPE work: ${c.inScope.join('; ')}`);
  if (c.notApplicable && c.notApplicable.length) L.push(`- NOT APPLICABLE (DO NOT PRICE, even where the drawings show that part of the building): ${c.notApplicable.join('; ')}`);
  if (c.ofci && c.ofci.length) L.push(`- OWNER-FURNISHED / CONTRACTOR-INSTALLED (OFCI): ${c.ofci.join('; ')} — the owner buys this equipment; price INSTALLATION labor, rigging, piping/wiring connections and accessories ONLY, NOT the equipment purchase.`);
  if (c.byOthers && c.byOthers.length) L.push(`- BY OTHERS (separate contracts — exclude entirely): ${c.byOthers.join('; ')}`);
  if (c.alternates && c.alternates.length) L.push(`- ALTERNATES (exclude from the base estimate; note in assumptions): ${c.alternates.join('; ')}`);
  return `\nCONTRACT SCOPE CONSTRAINTS — extracted from the uploaded PROJECT MANUAL. These are HARD boundaries that override anything the drawings appear to show. The drawings may depict the entire existing building; the CONTRACT covers only the work below. Work visible in the drawings but outside these boundaries is existing-to-remain or by others — do not price it.\n${L.join('\n')}\n`;
}

function splitDivisionRow(line) {
  const dm = line.match(/^\s*(\d{2})\b[\s.:)-]*/);
  const div = dm ? dm[1] : null;
  const body = dm ? line.slice(dm[0].length) : line;
  const RE_CUR = /\$\s*\d[\d,]*(?:\.\d+)?\s*(?:mm|m|k|million|thousand)?\b/i;
  const RE_BARE = /\b\d[\d,]*(?:\.\d+)?\s*(?:mm|m|k|million|thousand)\b|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/i;
  const hit = body.match(RE_CUR) || body.match(RE_BARE);
  const clean = t => t.replace(/^[\s:\u2014\u2013-]+/, '').replace(/[\s:\u2014\u2013-]+$/, '').trim();
  if (!hit) return { div, name: clean(body), amount: null, flag: 'unparsed', scope: '' };
  const money = parseMoney(body.slice(hit.index));
  let scope = body.slice(hit.index + hit[0].length);
  // a range consumed a second figure — don't leave it dangling at the head of the scope text
  if (money.flag === 'range') scope = scope.replace(/^\s*[\u2013\u2014-]\s*\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:mm|m|k|million|thousand)?\b/i, '');
  return { div, name: clean(body.slice(0, hit.index)), amount: money.value, flag: money.flag, scope: clean(scope) };
}

function ciNorm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'new'].includes(w)); }

function classifyProjectText(text) {
  const n = (text || '').toLowerCase();
  if (/wwtp|wastewater|water treatment|\bwtp\b|wrrf|lift station|\bsewer\b|water main|well ?field|clarifier|digest|lagoon|\bsludge\b|potable|booster station|water reclamation/i.test(n)) return 'water_wastewater';
  if (/school|elementary|middle school|high school|academy|\bisd\b|\bcsc\b|school corp|college|university|fieldhouse|\bgym\b|classroom|\bk-?12\b/i.test(n)) return 'education';
  return null;  // no strong name signal → let the client type decide
}

function classForCt(ct) {
  if (ct === 'school') return 'education';
  return 'building';  // commercial / industrial / municipal / mixed_use / private
}

function parseMoney(raw) {
  if (raw == null) return { value: null, flag: 'empty' };
  if (typeof raw === 'number') return { value: isFinite(raw) ? Math.round(raw) : null, flag: null };
  const s = String(raw).trim();
  if (!s) return { value: null, flag: 'empty' };
  // Parse one money token. `moneyish` = it reads as a dollar figure on its own ($-prefixed,
  // suffixed, comma-grouped, or >=1000) — the discriminator that keeps a stray digit in the
  // scope text (e.g. "— 2-story") from being mistaken for the far side of a range.
  const one = t => {
    const m = /(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(mm|m|k|million|thousand)?\b/i.exec(t);
    if (!m) return null;
    let v = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(v)) return null;
    const suf = (m[3] || '').toLowerCase();
    if (suf === 'k' || suf === 'thousand') v *= 1e3;
    else if (suf === 'm' || suf === 'mm' || suf === 'million') v *= 1e6;
    return { value: Math.round(v), hadSuffix: !!suf, moneyish: !!m[1] || !!suf || /,\d{3}/.test(m[2]) || v >= 1000 };
  };
  // "$180,000–$220,000" and shorthand ranges "$180k–$220k" / "$1.2M–$1.4M" are genuinely
  // ambiguous — carry the midpoint, flag as a range. BOTH sides must read as money; the old
  // digit-before-dash test missed shorthand ranges (their low endpoint silently became the
  // whole carry) and could pair an amount with a stray digit in the scope text.
  const rm = /(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:mm|m|k|million|thousand)?)\s*[–—-]\s*(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:mm|m|k|million|thousand)?)/i.exec(s);
  if (rm) {
    const a = one(rm[1]), b = one(rm[2]);
    if (a && b && a.moneyish && b.moneyish) return { value: Math.round((a.value + b.value) / 2), flag: 'range' };
  }
  const h = one(s);
  if (!h) return { value: null, flag: 'unparsed' };
  return { value: h.value, flag: h.hadSuffix ? 'shorthand' : null };
}

return { segBenchmarks, rycGroundingText, buildPrompt, consolidatePrompt, splitIntoBatches, parseResponse, reconcileTotals, estimateGate, ciSameJob, subClassFor, jobProjectClass, scopeConstraintText, splitDivisionRow, ciNorm, classifyProjectText, classForCt, parseMoney };
  }

  return { core: core, FUNCTIONS: ["segBenchmarks","rycGroundingText","buildPrompt","consolidatePrompt","splitIntoBatches","parseResponse","reconcileTotals","estimateGate","ciSameJob","subClassFor","jobProjectClass","scopeConstraintText","splitDivisionRow","ciNorm","classifyProjectText","classForCt","parseMoney"] };
}));
