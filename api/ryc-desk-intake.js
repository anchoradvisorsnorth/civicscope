/* /api/ryc-desk-intake — drive the Dodge → SharePoint → pursuit → takeoff flow from the Desk.
 *
 *   POST { pw, stage: 'prepare'|'commit'|'status', id, name? }
 *
 * Thin proxy to the VM service, which holds the Dodge login, the SharePoint token and the
 * documents. Nothing about any of that reaches the browser.
 *
 * STAGES ARE SEPARATE REQUESTS ON PURPOSE. prepare downloads ~70MB and commit uploads it; the
 * takeoff is ~10 minutes. None of that fits in one serverless invocation, so commit starts the
 * takeoff detached on the VM and the Desk polls `status`.
 */
export const config = { maxDuration: 300 };

const GATE = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { pw, stage, id, name } = req.body || {};
  if (pw !== GATE) return res.status(401).json({ error: 'unauthorized' });

  const base = process.env.RYC_DODGE_API_URL, key = process.env.RYC_DODGE_API_KEY;
  if (!base || !key) {
    return res.status(503).json({ ok: false, kind: 'not_configured',
      error: 'Document intake is not configured on this deployment.' });
  }
  /* 'auto' runs the whole chain — Dodge record, documents, job folder, takeoff — detached on the
     VM and returns immediately. It is the normal path now: adopting a pursuit should not make the
     estimator drive four steps. prepare/commit stay for the manual/recovery route. */
  /* 'planroom' reads or records where a given ARCHITECT's bid documents actually come from. Dodge
     names the architect but never says how to get on their planholder list — and that is what
     decides whether RYC can bid at all. Recorded once per firm, inherited by every later project. */
  if (!['auto', 'prepare', 'commit', 'status', 'planroom'].includes(String(stage || ''))) {
    return res.status(400).json({ ok: false, error: 'stage must be auto, prepare, commit, status or planroom' });
  }
  const raw = String(id || '').trim();
  const m = raw.match(/projects\/(\d{6,})/) || raw.match(/(\d{10,})/);
  if (!m) return res.status(400).json({ ok: false, error: 'pass a Dodge project id or link' });
  if (stage === 'commit' && !String(name || '').trim()) {
    return res.status(400).json({ ok: false, error: 'a confirmed folder name is required' });
  }

  const qs = new URLSearchParams({ id: m[1] });
  if (stage === 'commit') qs.set('name', String(name).trim());
  if (stage === 'auto' && String(name || '').trim()) qs.set('name', String(name).trim());
  if (stage === 'planroom') {
    if (req.body.firm) qs.set('firm', String(req.body.firm).slice(0, 200));
    if (req.body.set) qs.set('set', JSON.stringify(req.body.set).slice(0, 1200));
  }
  const url = `${base.replace(/\/$/, '')}/intake/${stage}?${qs}`;
  // prepare/commit are minutes long; status and auto both return at once so polling stays cheap.
  const budget = ['status', 'auto', 'planroom'].includes(stage) ? 20000 : 290000;

  try {
    const r = await fetch(url, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(budget) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    // auto answers 202 Accepted — started, not finished. That is success, not an upstream failure.
    if (r.status === 202 && body) return res.status(200).json(body);
    if (!r.ok || !body) {
      return res.status(r.status === 409 ? 409 : 502).json({
        ok: false, kind: (body && body.kind) || 'upstream_failed',
        error: (body && body.error) || `intake ${stage} failed (HTTP ${r.status})`,
        running: body && body.running,
      });
    }
    return res.status(200).json(body);
  } catch (e) {
    const aborted = /timeout|abort/i.test(e.name || e.message || '');
    return res.status(504).json({ ok: false, kind: aborted ? 'timeout' : 'unreachable',
      error: aborted
        ? `The ${stage} step is still running on the server — reopen this pursuit shortly to see it finish.`
        : 'Could not reach the document intake service.' });
  }
}
