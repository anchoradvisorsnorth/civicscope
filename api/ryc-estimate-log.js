// api/ryc-estimate-log.js — run log for /ryc/estimate (Phase A, 2026-07-23)
// Gate password verified SERVER-side; service key never ships to the browser.
// Actions: save (insert one run), list (recent runs, light columns), get (full row).

const LIST_COLS_BASE = 'id,created_at,estimator,project_name,location,client_type,work_type,cost_low,cost_high,cost_mid,confidence,version,files,bc_project_id,bc_url';
const LIST_COLS = LIST_COLS_BASE + ',workflow'; // workflow may not exist yet — list falls back to BASE if the column is absent

const SAVE_FIELDS = [
  'estimator', 'project_name', 'location', 'client_type', 'work_type', 'size_sf',
  'target_budget', 'scope_notes', 'files', 'scope_constraints', 'cost_low', 'cost_high',
  'cost_mid', 'confidence', 'narrative', 'divisions', 'assumptions', 'gaps',
  'version', 'batches', 'duration_ms', 'quotes',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GATE_PW = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Server misconfigured' });

  const { pw, action } = req.body || {};
  if (pw !== GATE_PW) return res.status(401).json({ error: 'Unauthorized' });

  const sb = (path, opts) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      ...(opts && opts.headers),
    },
  });

  try {
    if (action === 'save') {
      const rec = { tenant: 'ryc' };
      const src = req.body.record || {};
      for (const f of SAVE_FIELDS) if (src[f] !== undefined && src[f] !== null) rec[f] = src[f];
      if (!rec.project_name) return res.status(400).json({ error: 'project_name required' });
      if (typeof rec.estimator === 'string') rec.estimator = rec.estimator.slice(0, 40);
      const r = await sb('ryc_estimates', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(rec),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      return res.status(200).json({ ok: true, id: rows[0] && rows[0].id });
    }

    if (action === 'list') {
      const limit = Math.min(Number(req.body.limit) || 200, 500);
      let r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS}&order=created_at.desc&limit=${limit}`);
      if (!r.ok) {
        // workflow column not migrated yet → retry without it so the board still loads
        const txt = await r.text();
        if (/workflow/.test(txt)) r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS_BASE}&order=created_at.desc&limit=${limit}`);
        if (!r.ok) return res.status(r.status).json({ error: r.ok ? '' : txt });
      }
      return res.status(200).json({ ok: true, runs: await r.json() });
    }

    if (action === 'get') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r = await sb(`ryc_estimates?id=eq.${id}&limit=1`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ ok: true, run: rows[0] });
    }

    // Persist pursuit workflow state (stage + typed checklist) onto an estimate row.
    // Isolated from `save` so the core estimate log never depends on the workflow column:
    // returns a soft 200 {ok:false, needs_migration:true} if the column isn't there yet.
    if (action === 'set_workflow') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const wf = req.body.workflow;
      if (wf === undefined || wf === null || typeof wf !== 'object') return res.status(400).json({ error: 'workflow object required' });
      // Read-merge-write (Codex #8): the award link and its audit trail are server-owned facts
      // written only by link_award. A stale client object (quote typing racing a link) must not
      // erase them — if the stored row carries an award the incoming object lacks, keep the
      // stored award (and the won stage it implies, since the stale object also predates it).
      try {
        const r0 = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc&select=workflow&limit=1`);
        if (r0.ok) {
          const rows0 = await r0.json();
          const cur = rows0.length && rows0[0].workflow && typeof rows0[0].workflow === 'object' ? rows0[0].workflow : null;
          if (cur) {
            if (cur.award && !wf.award) { wf.award = cur.award; if (cur.stage === 'won') wf.stage = 'won'; }
            if (cur.award_events && !wf.award_events) wf.award_events = cur.award_events;
          }
        }
      } catch { /* merge is best-effort — a failed read falls back to plain replace */ }
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
        method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ workflow: wf }),
      });
      if (!r.ok) {
        const txt = await r.text();
        if (/workflow/.test(txt) && /column|schema|does not exist|PGRST204/i.test(txt)) {
          return res.status(200).json({ ok: false, needs_migration: true, detail: 'workflow column not present — run the Phase C migration' });
        }
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ ok: true });
    }

    // Stamp a BC draft-project linkage onto an existing estimate row so the tool
    // knows it was already loaded and can hard-block a duplicate BC create.
    if (action === 'link_bc') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const patch = {};
      if (req.body.bc_url !== undefined) patch.bc_url = req.body.bc_url ? String(req.body.bc_url).slice(0, 500) : null;
      if (req.body.bc_project_id !== undefined) patch.bc_project_id = req.body.bc_project_id ? String(req.body.bc_project_id).slice(0, 120) : null;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to patch' });
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
        method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    /* One-time (idempotent) reconciliation of legacy rows saved before v1.10.0.
       Runs saved earlier stored the MODEL'S stated COST_MIDPOINT, which the model generated
       independently of its own DIVISIONS breakdown and never reconciled — the live DeMotte row
       carried a $2,485,000 midpoint over a $2,585,000 package rollup. The rollup is canonical
       (every division is a subcontract placeholder, so their sum is the bottom-up number), so
       this rewrites cost_mid to the rollup and rescales cost_low/high around it, preserving the
       band's relative width. Rows already in agreement are left untouched.
       Pass {dry_run:true} to preview. */
    if (action === 'reconcile_totals') {
      const dry = !!req.body.dry_run;
      const r = await sb(`ryc_estimates?tenant=eq.ryc&select=id,project_name,cost_low,cost_high,cost_mid,divisions&limit=500`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      const changed = [];
      for (const row of rows) {
        const divTot = (row.divisions || []).reduce((s, d) => s + (Number(d && d.amount) || 0), 0);
        const stated = Number(row.cost_mid) || 0;
        if (!divTot || !stated || divTot === stated) continue;
        const k = divTot / stated;
        const patch = {
          cost_mid: divTot,
          cost_low: row.cost_low != null ? Math.round(Number(row.cost_low) * k) : null,
          cost_high: row.cost_high != null ? Math.round(Number(row.cost_high) * k) : null,
        };
        changed.push({ id: row.id, project_name: row.project_name, from: stated, to: divTot, drift: divTot - stated });
        if (!dry) {
          const pr = await sb(`ryc_estimates?id=eq.${row.id}&tenant=eq.ryc`, {
            method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(patch),
          });
          if (!pr.ok) return res.status(pr.status).json({ error: await pr.text(), partial: changed });
        }
      }
      return res.status(200).json({ ok: true, dry_run: dry, scanned: rows.length, reconciled: changed.length, rows: changed });
    }

    /* ===== IDENTITY SPINE: award link (2026-08-01) ==================================
       The Desk and Command are one system split at contract award. A pursuit is born in the
       Desk with its own immutable id and may never become a job (a lost pursuit still has to
       exist — losses are the most valuable calibration data). At award it GAINS a link to the
       operational job number; the job number never becomes the pursuit's primary identity.

       Per Keith: the award event is **the job being opened in Foundation**, which then does a
       one-time push to Procore. So Foundation originates `job_no` and Procore's projectNumber
       is a copy — there is exactly one authoritative key post-award, and the link is captured
       as a side effect of work accounting already performs rather than as admin entry.

       Storage is workflow.award (jsonb, no DDL); this API is the stable contract, so the
       backing store can be promoted to a real column later without breaking callers. */
    if (action === 'link_award') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r0 = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc&select=id,workflow&limit=1`);
      if (!r0.ok) return res.status(r0.status).json({ error: await r0.text() });
      const rows0 = await r0.json();
      if (!rows0.length) return res.status(404).json({ error: 'Not found' });
      const wf = rows0[0].workflow && typeof rows0[0].workflow === 'object' ? rows0[0].workflow : { stage: 'takeoff', checklist: {} };

      const audit = (action2, jobNo2) => {
        wf.award_events = (Array.isArray(wf.award_events) ? wf.award_events : [])
          .concat([{ action: action2, job_no: jobNo2 || null, at: new Date().toISOString() }]).slice(-20);
      };
      if (req.body.unlink) {
        const prev = wf.award || {};
        audit('unlink', prev.job_no);
        delete wf.award;
        // Restore the stage the pursuit held before the link (Codex #7) — a mistaken link
        // corrected here must not leave a phantom win. Links made before prev_stage tracking
        // have nothing recorded; don't guess between Submitted/Lost — tell the client to ask.
        if (wf.stage === 'won') {
          if (prev.prev_stage) { wf.stage = prev.prev_stage; delete wf.stage_unresolved; }
          else wf.stage_unresolved = true;
        }
      } else {
        const jobNo = String(req.body.job_no || '').trim();
        if (!jobNo) return res.status(400).json({ error: 'job_no required' });
        // One Foundation job belongs to one pursuit — enforced here, not just in the picker UI.
        try {
          const rq = await sb(`ryc_estimates?tenant=eq.ryc&select=id,project_name&workflow->award->>job_no=eq.${encodeURIComponent(jobNo)}&limit=5`);
          if (rq.ok) {
            const taken = (await rq.json()).filter(x => x.id !== id);
            if (taken.length) return res.status(409).json({ error: `Job ${jobNo} is already linked to pursuit "${taken[0].project_name}" — unlink it there first.` });
          }
        } catch { /* uniqueness check is best-effort if the query itself fails */ }
        wf.award = {
          job_no: jobNo.slice(0, 40),
          description: String(req.body.description || '').slice(0, 200) || null,
          customer: String(req.body.customer || '').slice(0, 200) || null,
          source: 'foundation',
          linked_at: new Date().toISOString(),
          // remember what the pursuit was before the win so unlink can restore it
          prev_stage: wf.stage !== 'won' ? (wf.stage || 'takeoff') : ((wf.award && wf.award.prev_stage) || null),
        };
        audit('link', jobNo);
        delete wf.stage_unresolved;
        // Linking a pursuit to a real Foundation job IS the win capture — don't ask twice.
        if (wf.stage !== 'won') wf.stage = 'won';
      }
      wf.updated_at = new Date().toISOString();
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
        method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ workflow: wf }),
      });
      if (!r.ok) {
        const txt = await r.text();
        if (/workflow/.test(txt) && /column|schema|does not exist|PGRST204/i.test(txt)) {
          return res.status(200).json({ ok: false, needs_migration: true });
        }
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ ok: true, workflow: wf });
    }

    /* Reverse lookup for Command: given a Foundation job number, return the pursuit that was
       estimated for it. This is what lets an awarded job show what RYC bid it at, and is the
       first half of the conceptual→actual calibration loop. */
    if (action === 'by_job') {
      const jobNo = String(req.body.job_no || '').trim();
      if (!jobNo) return res.status(400).json({ error: 'job_no required' });
      const sel = 'id,created_at,estimator,project_name,location,client_type,work_type,cost_low,cost_high,cost_mid,confidence,version,workflow,bc_url';
      const r = await sb(`ryc_estimates?tenant=eq.ryc&select=${sel}&order=created_at.desc&limit=500`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      const hit = rows.filter(x => x.workflow && x.workflow.award && String(x.workflow.award.job_no) === jobNo);
      return res.status(200).json({ ok: true, job_no: jobNo, pursuits: hit });
    }

    if (action === 'delete') {
      const id = String(req.body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, { method: 'DELETE' });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
