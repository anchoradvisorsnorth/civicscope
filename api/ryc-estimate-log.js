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

  /* ===== PURSUIT ENTITY (Codex round-3 finding #2, 2026-08-01) =======================
     A pursuit is the immutable identity from opportunity → won/lost; estimate runs are its
     revisions (ryc_estimates.pursuit_id). Pursuit-level state — stage, checklist, due date,
     award, quotes, coverage — lives in ryc_pursuits.workflow. Revision-level state (parse
     validation) stays on the run row. Renames update pursuit.name without splitting identity
     (norm_name is the CREATION-time find-or-create key only, never re-derived). */
  const UUID = /^[0-9a-f-]{36}$/i;
  const normName = s => String(s || '').trim().toLowerCase();
  const getPursuit = async (pid) => {
    const r = await sb(`ryc_pursuits?id=eq.${pid}&tenant=eq.ryc&limit=1`);
    if (!r.ok) return null;
    const rows = await r.json();
    return rows.length ? rows[0] : null;
  };
  const patchPursuit = (pid, patch) => sb(`ryc_pursuits?id=eq.${pid}&tenant=eq.ryc`, {
    method: 'PATCH', headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patch)),
  });
  // Find-or-create the pursuit an incoming run belongs to. Explicit pursuit_id wins (an open
  // pursuit being re-run — even under a NEW name, which is a rename, not a new pursuit).
  const resolvePursuit = async (rec, pursuitId) => {
    if (pursuitId && UUID.test(pursuitId)) {
      const p = await getPursuit(pursuitId);
      if (p) {
        // the latest revision's descriptors become the pursuit's current descriptors
        await patchPursuit(p.id, { name: rec.project_name, location: rec.location || p.location, client_type: rec.client_type || p.client_type, work_type: rec.work_type || p.work_type });
        return p.id;
      }
    }
    const nn = normName(rec.project_name);
    const rf = await sb(`ryc_pursuits?tenant=eq.ryc&norm_name=eq.${encodeURIComponent(nn)}&select=id&limit=1`);
    if (rf.ok) { const rows = await rf.json(); if (rows.length) return rows[0].id; }
    const rc = await sb('ryc_pursuits', {
      method: 'POST', headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ tenant: 'ryc', name: rec.project_name, norm_name: nn, location: rec.location || null, client_type: rec.client_type || null, work_type: rec.work_type || null }),
    });
    if (!rc.ok) return null;
    const created = await rc.json();
    return created[0] && created[0].id;
  };

  try {
    if (action === 'save') {
      const rec = { tenant: 'ryc' };
      const src = req.body.record || {};
      for (const f of SAVE_FIELDS) if (src[f] !== undefined && src[f] !== null) rec[f] = src[f];
      if (!rec.project_name) return res.status(400).json({ error: 'project_name required' });
      if (typeof rec.estimator === 'string') rec.estimator = rec.estimator.slice(0, 40);
      // Every run belongs to a pursuit: the open one (revision — survives renames), an existing
      // one with the same normalized name, or a freshly created one. Best-effort: a pursuit
      // failure never blocks saving the run itself.
      let pursuitId = null;
      try { pursuitId = await resolvePursuit(rec, String(req.body.pursuit_id || '')); } catch {}
      if (pursuitId) rec.pursuit_id = pursuitId;
      const r = await sb('ryc_estimates', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(rec),
      });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      // Return the pursuit's stored workflow: when a fresh generation lands on an EXISTING
      // pursuit (same name), the client must adopt its state (stage, due date, award) instead
      // of showing a blank pursuit card over a pursuit that already has history.
      let pursuitWf = null;
      if (pursuitId) { try { const p = await getPursuit(pursuitId); pursuitWf = p && p.workflow; } catch {} }
      return res.status(200).json({ ok: true, id: rows[0] && rows[0].id, pursuit_id: pursuitId, pursuit_workflow: pursuitWf });
    }

    if (action === 'list') {
      const limit = Math.min(Number(req.body.limit) || 200, 500);
      let r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS},pursuit_id&order=created_at.desc&limit=${limit}`);
      if (!r.ok) {
        const txt = await r.text();
        if (/pursuit_id|workflow/.test(txt)) r = await sb(`ryc_estimates?tenant=eq.ryc&select=${LIST_COLS_BASE}&order=created_at.desc&limit=${limit}`);
        if (!r.ok) return res.status(r.status).json({ error: r.ok ? '' : txt });
      }
      const runs = await r.json();
      let pursuits = [];
      try {
        const rp = await sb(`ryc_pursuits?tenant=eq.ryc&order=created_at.desc&limit=${limit}`);
        if (rp.ok) pursuits = await rp.json();
      } catch {}
      return res.status(200).json({ ok: true, runs, pursuits });
    }

    if (action === 'get') {
      const id = String(req.body.id || '');
      if (!UUID.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r = await sb(`ryc_estimates?id=eq.${id}&limit=1`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      let pursuit = null;
      if (rows[0].pursuit_id) { try { pursuit = await getPursuit(rows[0].pursuit_id); } catch {} }
      return res.status(200).json({ ok: true, run: rows[0], pursuit });
    }

    // Persist pursuit workflow state (stage + typed checklist) onto an estimate row.
    // Isolated from `save` so the core estimate log never depends on the workflow column:
    // returns a soft 200 {ok:false, needs_migration:true} if the column isn't there yet.
    if (action === 'set_workflow') {
      const pid = String(req.body.pursuit_id || '');
      const id = String(req.body.id || '');
      const onPursuit = UUID.test(pid);
      if (!onPursuit && !UUID.test(id)) return res.status(400).json({ error: 'Bad id' });
      const wf = req.body.workflow;
      if (wf === undefined || wf === null || typeof wf !== 'object') return res.status(400).json({ error: 'workflow object required' });
      // Read-merge-write (Codex #8): the award link and its audit trail are server-owned facts
      // written only by link_award. A stale client object (quote typing racing a link) must not
      // erase them — if the stored row carries an award the incoming object lacks, keep the
      // stored award (and the won stage it implies, since the stale object also predates it).
      try {
        const r0 = onPursuit
          ? await sb(`ryc_pursuits?id=eq.${pid}&tenant=eq.ryc&select=workflow&limit=1`)
          : await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc&select=workflow&limit=1`);
        if (r0.ok) {
          const rows0 = await r0.json();
          const cur = rows0.length && rows0[0].workflow && typeof rows0[0].workflow === 'object' ? rows0[0].workflow : null;
          if (cur) {
            if (cur.award && !wf.award) { wf.award = cur.award; if (cur.stage === 'won') wf.stage = 'won'; }
            if (cur.award_events && !wf.award_events) wf.award_events = cur.award_events;
          }
        }
      } catch { /* merge is best-effort — a failed read falls back to plain replace */ }
      const r = onPursuit
        ? await patchPursuit(pid, { workflow: wf })
        : await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
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
      const pid = String(req.body.pursuit_id || '');
      if (!UUID.test(id) && !UUID.test(pid)) return res.status(400).json({ error: 'Bad id' });
      const patch = {};
      if (req.body.bc_url !== undefined) patch.bc_url = req.body.bc_url ? String(req.body.bc_url).slice(0, 500) : null;
      if (req.body.bc_project_id !== undefined) patch.bc_project_id = req.body.bc_project_id ? String(req.body.bc_project_id).slice(0, 120) : null;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to patch' });
      // BC linkage is a PURSUIT fact (the draft belongs to the pursuit, whichever revision
      // triggered it); the run row is also stamped for the history badge when an id is given.
      if (UUID.test(pid)) { const rp = await patchPursuit(pid, patch); if (!rp.ok) return res.status(rp.status).json({ error: await rp.text() }); }
      if (UUID.test(id)) {
        const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, {
          method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify(patch),
        });
        if (!r.ok && !UUID.test(pid)) return res.status(r.status).json({ error: await r.text() });
      }
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
      // Awards attach to the PURSUIT (immutable identity). A legacy call with only a run id
      // resolves through the run's pursuit_id so old clients can't write to the wrong place.
      let pid = String(req.body.pursuit_id || '');
      if (!UUID.test(pid)) {
        const id = String(req.body.id || '');
        if (!UUID.test(id)) return res.status(400).json({ error: 'Bad id' });
        const rr = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc&select=pursuit_id&limit=1`);
        if (!rr.ok) return res.status(rr.status).json({ error: await rr.text() });
        const rrows = await rr.json();
        if (!rrows.length || !rrows[0].pursuit_id) return res.status(404).json({ error: 'No pursuit for this run — run the pursuit migration first' });
        pid = rrows[0].pursuit_id;
      }
      const p0 = await getPursuit(pid);
      if (!p0) return res.status(404).json({ error: 'Not found' });
      const wf = p0.workflow && typeof p0.workflow === 'object' ? p0.workflow : { stage: 'takeoff', checklist: {} };

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
        // One Foundation job belongs to one pursuit — checked here for a friendly error, and
        // enforced by the DB (unique partial index on workflow->award->>job_no) as backstop.
        try {
          const rq = await sb(`ryc_pursuits?tenant=eq.ryc&select=id,name&workflow->award->>job_no=eq.${encodeURIComponent(jobNo)}&limit=5`);
          if (rq.ok) {
            const taken = (await rq.json()).filter(x => x.id !== pid);
            if (taken.length) return res.status(409).json({ error: `Job ${jobNo} is already linked to pursuit "${taken[0].name}" — unlink it there first.` });
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
      const r = await patchPursuit(pid, { workflow: wf });
      if (!r.ok) {
        const txt = await r.text();
        // 23505 = the DB's unique award index caught a concurrent duplicate the check missed
        if (/23505|duplicate key/i.test(txt)) return res.status(409).json({ error: 'That Foundation job is already linked to another pursuit.' });
        return res.status(r.status).json({ error: txt });
      }
      return res.status(200).json({ ok: true, pursuit_id: pid, workflow: wf });
    }

    /* Reverse lookup for Command: given a Foundation job number, return the pursuit that was
       estimated for it. This is what lets an awarded job show what RYC bid it at, and is the
       first half of the conceptual→actual calibration loop. */
    if (action === 'by_job') {
      const jobNo = String(req.body.job_no || '').trim();
      if (!jobNo) return res.status(400).json({ error: 'job_no required' });
      // Pursuit-first: the award lives on the pursuit; its revisions are joined so Command can
      // answer "what did we bid this at" from the latest revision's canonical figures.
      const rp = await sb(`ryc_pursuits?tenant=eq.ryc&workflow->award->>job_no=eq.${encodeURIComponent(jobNo)}&limit=5`);
      if (!rp.ok) return res.status(rp.status).json({ error: await rp.text() });
      const ps = await rp.json();
      const out = [];
      for (const p of ps) {
        let revisions = [];
        try {
          const rr = await sb(`ryc_estimates?pursuit_id=eq.${p.id}&select=id,created_at,estimator,cost_low,cost_high,cost_mid,confidence,version&order=created_at.desc&limit=50`);
          if (rr.ok) revisions = await rr.json();
        } catch {}
        out.push(Object.assign({}, p, { revisions, latest: revisions[0] || null }));
      }
      return res.status(200).json({ ok: true, job_no: jobNo, pursuits: out });
    }

    /* One-time (idempotent) migration: attach every orphan run to a pursuit, grouping by the
       normalized project name (the old board's grouping rule, applied one final time — from
       here on identity is the pursuit id, not the name). The name-group's newest run donates
       descriptors, its workflow (minus revision-scoped validation), and any BC linkage. */
    if (action === 'migrate_pursuits') {
      const dry = !!req.body.dry_run;
      const r = await sb(`ryc_estimates?tenant=eq.ryc&pursuit_id=is.null&select=id,created_at,project_name,location,client_type,work_type,workflow,bc_project_id,bc_url&order=created_at.desc&limit=500`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const orphans = await r.json();
      const groups = {};
      for (const run of orphans) (groups[normName(run.project_name)] = groups[normName(run.project_name)] || []).push(run);
      const report = [];
      for (const nn of Object.keys(groups)) {
        const runs = groups[nn]; // newest first
        const latest = runs[0];
        const entry = { norm_name: nn, name: latest.project_name, runs: runs.length, dry };
        if (!dry) {
          // reuse an existing pursuit with this norm_name if one exists (idempotency)
          let pid = null;
          const rf = await sb(`ryc_pursuits?tenant=eq.ryc&norm_name=eq.${encodeURIComponent(nn)}&select=id&limit=1`);
          if (rf.ok) { const rows = await rf.json(); if (rows.length) pid = rows[0].id; }
          if (!pid) {
            const wf = latest.workflow && typeof latest.workflow === 'object' ? JSON.parse(JSON.stringify(latest.workflow)) : { stage: 'takeoff', checklist: {} };
            delete wf.validation;   // revision-scoped — stays on the run row
            const bcRun = runs.find(x => x.bc_url || x.bc_project_id) || {};
            const rc = await sb('ryc_pursuits', {
              method: 'POST', headers: { 'Prefer': 'return=representation' },
              body: JSON.stringify({ tenant: 'ryc', name: latest.project_name, norm_name: nn, location: latest.location || null, client_type: latest.client_type || null, work_type: latest.work_type || null, workflow: wf, bc_project_id: bcRun.bc_project_id || null, bc_url: bcRun.bc_url || null }),
            });
            if (!rc.ok) return res.status(rc.status).json({ error: await rc.text(), partial: report });
            pid = (await rc.json())[0].id;
          }
          for (const run of runs) {
            const rr = await sb(`ryc_estimates?id=eq.${run.id}&tenant=eq.ryc`, {
              method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ pursuit_id: pid }),
            });
            if (!rr.ok) return res.status(rr.status).json({ error: await rr.text(), partial: report });
          }
          entry.pursuit_id = pid;
        }
        report.push(entry);
      }
      return res.status(200).json({ ok: true, dry_run: dry, orphan_runs: orphans.length, pursuits: report.length, report });
    }

    if (action === 'delete') {
      const id = String(req.body.id || '');
      if (!UUID.test(id)) return res.status(400).json({ error: 'Bad id' });
      const r = await sb(`ryc_estimates?id=eq.${id}&tenant=eq.ryc`, { method: 'DELETE' });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    // Deletes an EMPTY pursuit only (no revisions referencing it) — used for cleanup; a
    // pursuit with history is never deletable through this API.
    if (action === 'delete_pursuit') {
      const pid = String(req.body.pursuit_id || '');
      if (!UUID.test(pid)) return res.status(400).json({ error: 'Bad id' });
      const rr = await sb(`ryc_estimates?pursuit_id=eq.${pid}&select=id&limit=1`);
      if (rr.ok && (await rr.json()).length) return res.status(409).json({ error: 'Pursuit still has revisions — delete them first.' });
      const r = await sb(`ryc_pursuits?id=eq.${pid}&tenant=eq.ryc`, { method: 'DELETE' });
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
