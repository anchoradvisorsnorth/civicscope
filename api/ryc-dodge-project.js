/* /api/ryc-dodge-project — pull one Dodge project for the RYC Desk.
 *
 *   POST { pw, url|id }  ->  { ok, project }
 *
 * Gated behind the shared Desk credential, same as every other RYC route. Proxies to the VM
 * service (ryc-dodge-api) which holds the Dodge login and drives the fetch; nothing about Dodge
 * — credentials, endpoints, tokens — reaches the browser.
 *
 * Read-only by construction: the VM service exposes GET /project only. This endpoint cannot
 * write to Dodge and cannot write to RYC data; the pursuit is created by the normal Desk flow
 * from what the estimator confirms on the review step.
 */
export const config = { maxDuration: 120 };   // a cold fetch drives a browser: ~16s, allow for slow

const GATE = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pw, url, id } = req.body || {};
  if (pw !== GATE) return res.status(401).json({ error: 'unauthorized' });

  const base = process.env.RYC_DODGE_API_URL;
  const key = process.env.RYC_DODGE_API_KEY;
  if (!base || !key) {
    return res.status(503).json({ ok: false, kind: 'not_configured',
      error: 'Dodge lookup is not configured on this deployment.' });
  }

  const raw = String(url || id || '').trim();
  // Accept a full Dodge URL, a bare id, or a downloaded filename like 202600298246__1_A000.pdf —
  // the estimator should never have to work out which part is the id.
  const m = raw.match(/projects\/(\d{6,})/) || raw.match(/(\d{10,})/);
  if (!m) return res.status(400).json({ ok: false, kind: 'bad_input',
    error: 'Paste a Dodge project link or report number.' });

  const target = `${base.replace(/\/$/, '')}/project?id=${encodeURIComponent(m[1])}`;
  try {
    const r = await fetch(target, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(115000) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* fall through to a typed error */ }
    if (!r.ok || !body) {
      // Pass the real reason through. A generic failure here reads to the user as "Dodge has
      // nothing for this project", which is the one thing it almost never means.
      return res.status(r.status === 502 ? 502 : 502).json({
        ok: false,
        kind: (body && body.kind) || 'upstream_failed',
        error: (body && body.error) || `Dodge lookup failed (HTTP ${r.status})`,
      });
    }
    return res.status(200).json(body);
  } catch (e) {
    const aborted = e && /timeout|abort/i.test(e.name || e.message || '');
    return res.status(504).json({ ok: false, kind: aborted ? 'timeout' : 'unreachable',
      error: aborted ? 'Dodge lookup timed out.' : 'Could not reach the Dodge lookup service.' });
  }
}
