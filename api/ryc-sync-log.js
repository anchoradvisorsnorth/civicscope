// api/ryc-sync-log.js — sync-run telemetry (RYC_Admin_Integrations_Design v0.3 §3).
//
// TWO AUDIENCES, TWO AUTH MODES — deliberately not the same credential:
//   · WRITES (open/heartbeat/finish) come from VM wrappers and use a MACHINE credential bound
//     server-side to an allowed service set, so a compromised wrapper cannot impersonate other
//     publishers or poison their run history. Never a human bearer token (contract §2/§4).
//   · READS (status/history) use the existing shared gate until identity lands, then the
//     `admin` capability (contract D8 — accepted interim risk, recorded, not authorization).
//
// The server owns every timestamp: VM clock skew cannot corrupt a duration.
// Error detail is scrubbed HERE, at write time — never trusted to a renderer.

import crypto from 'node:crypto';

const MAX_BODY = 32 * 1024;                 // request-size limit
const REPLAY_WINDOW_MS = 10 * 60 * 1000;    // reject stale/replayed signed calls

// Strip anything that looks like a secret before an error string is ever stored.
function scrub(s) {
  if (!s) return null;
  return String(s)
    .replace(/(sb_secret|sbp_|sk-ant-|ghp_|github_pat_|Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1<redacted>')
    .replace(/([?&](?:token|key|secret|password|pw)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b[A-Za-z0-9._-]{40,}\b/g, '<redacted-long-token>')
    .slice(0, 2000);
}

export default async function handler(req, res) {
  // No CORS: the writers are server-side wrappers, the reader is the same-origin Command page.
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GATE_PW = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Server misconfigured' });

  const raw = JSON.stringify(req.body || {});
  if (raw.length > MAX_BODY) return res.status(413).json({ error: 'Payload too large' });

  const sb = (path, opts) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json', apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`, ...(opts && opts.headers),
    },
  });
  const RPC_STATUS = { RY404: 404, RY400: 400, RY40G: 409 };
  const rpc = async (fn, args) => {
    const r = await sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
    const txt = await r.text();
    let body; try { body = JSON.parse(txt); } catch { body = { message: txt }; }
    if (!r.ok) return { status: RPC_STATUS[body && body.code] || r.status, body: { error: (body && body.message) || txt.slice(0, 300) } };
    return { status: 200, body };
  };

  const { action } = req.body || {};
  const WRITE_ACTIONS = ['open', 'heartbeat', 'finish'];

  try {
    /* ---------- machine-authenticated writes ---------- */
    if (WRITE_ACTIONS.includes(action)) {
      const token = req.headers['x-ryc-sync-token'];
      if (!token) return res.status(401).json({ error: 'Missing sync credential' });
      const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
      const cr = await sb(`ryc_sync_credentials?token_sha256=eq.${hash}&active=is.true&select=id,name,allowed_services,expires_at&limit=1`);
      if (!cr.ok) return res.status(502).json({ error: 'Credential lookup failed' });
      const cred = (await cr.json())[0];
      if (!cred) return res.status(401).json({ error: 'Unknown sync credential' });
      if (cred.expires_at && new Date(cred.expires_at) < new Date()) {
        return res.status(401).json({ error: 'Sync credential expired' });
      }

      // replay resistance: a signed call carries its own clock, and we refuse stale ones
      const ts = Number(req.body.ts);
      if (!ts || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
        return res.status(401).json({ error: 'Stale or missing ts (replay window is 10 minutes)' });
      }

      const actor = { type: 'service', service_id: cred.name };

      if (action === 'open') {
        const service = String(req.body.service || '');
        // the credential's service binding is the authorization, not the caller's claim
        if (!(cred.allowed_services.includes('*') || cred.allowed_services.includes(service))) {
          return res.status(403).json({ error: `Credential "${cred.name}" is not allowed to report for "${service}"` });
        }
        const out = await rpc('ryc_sync_open_run', {
          p_service: service,
          p_trigger: ['cron', 'manual', 'api'].includes(req.body.trigger) ? req.body.trigger : 'cron',
          p_request_id: String(req.body.request_id || '').slice(0, 120) || crypto.randomUUID(),
          p_actor: Object.assign({}, actor, { service_id: cred.name }),
          p_service_version: req.body.service_version ? String(req.body.service_version).slice(0, 40) : null,
          p_start: req.body.start !== false,
        });
        if (out.status === 200) {
          sb(`ryc_sync_credentials?id=eq.${cred.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_used_at: new Date().toISOString() }) }).catch(() => {});
        }
        return res.status(out.status).json(out.body);
      }

      // heartbeat / finish are addressed by run id; the run's service must be in the binding
      const runId = String(req.body.run_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(runId)) return res.status(400).json({ error: 'Bad run_id' });
      const rr = await sb(`ryc_sync_runs?id=eq.${runId}&select=service&limit=1`);
      const runRow = rr.ok ? (await rr.json())[0] : null;
      if (!runRow) return res.status(404).json({ error: 'Run not found' });
      if (!(cred.allowed_services.includes('*') || cred.allowed_services.includes(runRow.service))) {
        return res.status(403).json({ error: `Credential "${cred.name}" is not allowed to report for "${runRow.service}"` });
      }

      if (action === 'heartbeat') {
        const out = await rpc('ryc_sync_heartbeat', { p_run_id: runId, p_actor: actor });
        return res.status(out.status).json(out.body);
      }

      const counts = (req.body.counts && typeof req.body.counts === 'object') ? req.body.counts : {};
      const out = await rpc('ryc_sync_finish_run', {
        p_run_id: runId,
        p_state: String(req.body.state || ''),
        p_counts: counts,
        p_watermark_after: req.body.watermark ? String(req.body.watermark).slice(0, 200) : null,
        p_artifact_hash: req.body.artifact_hash ? String(req.body.artifact_hash).slice(0, 100) : null,
        p_artifact_location: req.body.artifact_location ? String(req.body.artifact_location).slice(0, 300) : null,
        p_deploy_id: req.body.deploy_id ? String(req.body.deploy_id).slice(0, 100) : null,
        p_error_code: req.body.error_code ? String(req.body.error_code).slice(0, 60) : null,
        p_error_detail: scrub(req.body.error_detail),
        p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    /* ---------- gated reads (+ the sweeper) ---------- */
    if (req.body.pw !== GATE_PW) return res.status(401).json({ error: 'Unauthorized' });

    if (action === 'status') {
      const r = await sb('ryc_sync_status_v?order=sort_order');
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true, services: await r.json(), server_time: new Date().toISOString() });
    }

    if (action === 'history') {
      const service = String(req.body.service || '');
      const limit = Math.min(Number(req.body.limit) || 20, 100);
      // service is validated against the registry — never interpolated blind
      const sr = await sb(`ryc_sync_services?key=eq.${encodeURIComponent(service)}&select=key&limit=1`);
      if (!sr.ok || !(await sr.json()).length) return res.status(400).json({ error: 'Unknown service' });
      const r = await sb(`ryc_sync_runs?service=eq.${encodeURIComponent(service)}&order=created_at.desc&limit=${limit}`);
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const runs = await r.json();
      let events = [];
      if (runs.length) {
        const er = await sb(`ryc_sync_run_events?run_id=in.(${runs.map(x => x.id).join(',')})&order=at.desc&limit=200`);
        if (er.ok) events = await er.json();
      }
      return res.status(200).json({ ok: true, runs, events });
    }

    if (action === 'sweep') {
      const out = await rpc('ryc_sync_sweep', {});
      return res.status(out.status).json(out.body);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: scrub(err.message) });
  }
}
