// Shared RYC "Data Sources" field-provenance reference.
// Loaded by BOTH the dashboard (/ryc/dashboard) AND the Foundation query tool (/ryc/foundation)
// via <script src="/ryc-dashboard/data-sources.js"> so there is ONE definition — edit here only.
// Full technical version is git-tracked at RYC/work product/RYC_Dashboard_Data_Dictionary.md.
function dataSourcesHTML() {
  return `<div class="ds-head"><div><h2>Data Sources &amp; Field Provenance</h2>`
    + `<div style="color:#6b7280;font-size:12px;margin-top:2px">Where every RYC number comes from — and where it deliberately differs from Foundation. Shared by the dashboard and the Foundation query tool.</div></div>`
    + `<div style="display:flex;gap:6px;flex-shrink:0"><button class="ds-btn" onclick="printDS()">🖨 Print</button><button class="ds-btn" onclick="closeDS()">✕ Close</button></div></div>`
    + `<div class="ds-note"><strong>Two ways to read RYC data, and they can differ:</strong> the <strong>Dashboard</strong> reads a <strong>nightly</strong> snapshot and shows <em>derived/convention</em> numbers (contract incl. COs, gross billings, forecast margins). The <strong>Foundation query tool</strong> hits Foundation <strong>live</strong> and returns <em>raw</em> values. A difference of up to a day, or a raw-vs-derived gap, is usually <strong>by design</strong> — check "Why doesn't it match?" below before assuming an error.</div>`
    + `<h3>How the data flows</h3><table><thead><tr><th>System</th><th>How it's pulled</th><th>Currency</th></tr></thead><tbody>`
    + `<tr><td><strong>Foundation</strong> (read-only ODBC)</td><td>nightly job → CRM database (dashboard) · <strong>live</strong> query (Foundation tool)</td><td>Dashboard = ~4am ET nightly · Query tool = real-time</td></tr>`
    + `<tr><td><strong>Procore</strong> (API)</td><td>daily job → cached file</td><td>~11pm ET daily</td></tr></tbody></table>`
    + `<div style="font-size:11px;color:#6b7280">Foundation is authoritative for money; Procore for schedule / RFIs / stage / forecast cost. Foundation is <strong>read-only by design</strong> — neither tool can write.</div>`
    + `<h3>Where each number comes from</h3><table><thead><tr><th>Field</th><th>Source</th><th>Exact origin</th></tr></thead><tbody>`
    + `<tr><td><strong>Contract Price</strong></td><td>Foundation</td><td><code>currentContract</code> = original contract + executed change-order income. Dashboard overwrites Procore's contract (which ignored COs). <em>Raw Foundation <code>original_contract</code> will be lower.</em></td></tr>`
    + `<tr><td><strong>Cost to Date</strong></td><td>Foundation</td><td>Sum of <code>v_job_history.cost</code>, ALL cost classes, inception-to-date. Posted actuals incl. burden; <strong>no open commitments</strong>.</td></tr>`
    + `<tr><td><strong>Billings to Date</strong></td><td>Foundation</td><td>Sum of <code>v_em_jc_billings.amount_invoiced</code>. <strong>Gross</strong> — retainage NOT netted; not cash received.</td></tr>`
    + `<tr><td>Retainage / Cash received</td><td>Foundation</td><td>Separate columns — kept apart from Billed.</td></tr>`
    + `<tr><td><strong>Total Job Costs / Proj Cost</strong></td><td>Procore</td><td>ERP Budget View "Projected Costs". ⚑ = value inflated (sub costs not flowing through ERP) — verify.</td></tr>`
    + `<tr><td>Overdue / Open AR</td><td>Foundation</td><td>Invoice amount less applied cash/discount/retainage; real balances, open &gt; $1,000.</td></tr>`
    + `<tr><td>Needs invoiced</td><td>Derived</td><td>cost-to-date × OH markup × Profit markup − billed (RYC's hand-keyed markups). Not a Foundation field.</td></tr>`
    + `<tr><td>Projected Margin % (RYC)</td><td>Foundation UDF</td><td>Hand-entered by RYC (<code>v_udf_jobs</code>) — a judgment value, not computed.</td></tr>`
    + `<tr><td>% complete, Earned, Over/(Under), Fcst margin</td><td>Derived</td><td>WIP tab: cost ÷ Procore <strong>revised budget</strong>. Work-on-Hand report: cost ÷ Procore <strong>Projected Cost</strong>. Earned = % × contract.</td></tr>`
    + `<tr><td>Schedule / % complete / RFIs / stage / CO type</td><td>Procore</td><td>Procore is authoritative for these.</td></tr></tbody></table>`
    + `<h3>Why doesn't it match Foundation? (differences by design)</h3><ol style="margin:4px 0 0 18px;padding:0;font-size:12px">`
    + `<li><strong>Contract</strong> = Foundation original + executed COs; a raw Foundation <code>original_contract</code> or Procore-only figure is lower.</li>`
    + `<li><strong>Cost to Date</strong> = posted actuals only, <strong>no open commitments</strong>; a WIP carrying committed cost is higher. Includes burden.</li>`
    + `<li><strong>Billed</strong> = <strong>gross of retainage</strong>; a net-of-retainage report is lower by the retainage (shown separately).</li>`
    + `<li><strong>WIP % complete / earned / over-under</strong> use <strong>Procore's</strong> forecast cost, not Foundation's estimate — so the WIP tab won't match Foundation's canned WIP.</li>`
    + `<li><strong>Projected Cost</strong> — 3 jobs read high (sub costs booked to Direct, not flowing through ERP invoices); flagged ⚑, not an error.</li>`
    + `<li><strong>Timing</strong> — the dashboard is nightly; the query tool is live, so they can differ by up to a day's activity.</li>`
    + `<li><strong>"Needs invoiced"</strong> ≠ any Foundation field — earned-but-unbilled on a cost basis, a different question than the next SOV pay-app.</li></ol>`
    + `<h3>Reconciling a number back to Foundation</h3><table><thead><tr><th>Number</th><th>Where in Foundation</th></tr></thead><tbody>`
    + `<tr><td>Cost to Date</td><td>Job Costing → Job History Detail (<code>v_job_history</code>) — sum all cost classes, inception-to-date</td></tr>`
    + `<tr><td>Billings to Date</td><td>Job billings (<code>v_em_jc_billings</code>) — sum amount invoiced; do NOT net retainage</td></tr>`
    + `<tr><td>Contract</td><td>Original contract + approved change-order income</td></tr>`
    + `<tr><td>AR</td><td>AR invoice less applied cash / discount / retainage</td></tr>`
    + `<tr><td>Projected Cost / EAC</td><td><strong>Procore</strong> (ERP Budget View) — not Foundation</td></tr>`
    + `<tr><td>Projected Margin % (RYC)</td><td>Foundation UDF (hand-entered)</td></tr></tbody></table>`;
}
function openDataSources() {
  let ov = document.getElementById('ds-overlay');
  if (!ov) {
    const st = document.createElement('style');
    st.textContent = '.ds-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2100;display:none;overflow:auto;padding:24px}'
      + '.ds-overlay.open{display:block}.ds-panel{background:#fff;max-width:1000px;margin:0 auto;border-radius:10px;padding:22px 26px;box-shadow:0 10px 40px rgba(0,0,0,.35);font-size:13px;line-height:1.5;color:#1f2937;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}'
      + '.ds-panel h2{margin:0}.ds-panel h3{margin:18px 0 6px;font-size:14px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}'
      + '.ds-panel table{border-collapse:collapse;width:100%;margin:6px 0;font-size:12px}.ds-panel th,.ds-panel td{border:1px solid #e5e7eb;padding:5px 8px;text-align:left;vertical-align:top;white-space:normal}'
      + '.ds-panel th{background:#f9fafb}.ds-panel code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:11px}'
      + '.ds-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1f2937;padding-bottom:10px;margin-bottom:8px}'
      + '.ds-note{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;color:#9a3412;margin:10px 0;font-size:12px}'
      + '.ds-btn{background:#fff;color:#374151;border:1px solid #d1d5db;padding:6px 12px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer}.ds-btn:hover{background:#f3f4f6}';
    document.head.appendChild(st);
    ov = document.createElement('div'); ov.id = 'ds-overlay'; ov.className = 'ds-overlay';
    ov.addEventListener('click', e => { if (e.target === ov) closeDS(); });
    const p = document.createElement('div'); p.id = 'ds-panel'; p.className = 'ds-panel';
    ov.appendChild(p); document.body.appendChild(ov);
  }
  document.getElementById('ds-panel').innerHTML = dataSourcesHTML();
  ov.classList.add('open');
}
function closeDS() { const ov = document.getElementById('ds-overlay'); if (ov) ov.classList.remove('open'); }
function printDS() {
  const html = document.getElementById('ds-panel').innerHTML;
  const w = window.open('', '_blank');
  w.document.write('<html><head><title>RYC — Data Sources</title><style>body{font-family:Arial,sans-serif;font-size:12px;padding:24px;line-height:1.5}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top;font-size:11px}h2{margin:0 0 4px}h3{margin:16px 0 6px}code{background:#f3f4f6;padding:1px 4px}.ds-btn{display:none}.ds-note{border:1px solid #ccc;padding:8px;margin:10px 0}</style></head><body>' + html + '</body></html>');
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}
