// api/ryc-ask.js — the authorization boundary for Ask R. Yoder.
//
// WHY THIS EXISTS (Codex closure review, 2026-08-02, HIGH #1)
// Ask R. Yoder posted RYC's confidential evidence to /api/claude, which is a deliberate PURE
// PASSTHROUGH for the public CivicScope estimators: it accepts any body from any caller with no
// RYC authorization, and it can fall back to a SECOND provider when Anthropic is unavailable.
// That is correct for public marketing tools and wrong for contract values, vendor spend, AR
// detail and margin projections, which the signed contract classifies as internal/confidential
// (RYC_OS_Shell_Contract.md §8).
//
// This endpoint is the narrow, authorized path for that traffic:
//
//   1. AUTHORIZED. The RYC gate credential is required and checked SERVER-SIDE. The generic
//      proxy stays open for the public tools; confidential traffic no longer uses it.
//   2. ONE PROCESSOR. Anthropic only. The OpenAI fallback is deliberately NOT wired here — a
//      transport-resilience feature must not silently widen who receives confidential data.
//      If Anthropic is unavailable this returns 503 and the feature degrades to unavailable,
//      which is the correct failure for this class of data.
//   3. SHAPE-BOUNDED. The evidence pack must match a declared shape and size. The client
//      minimises; this refuses anything that does not look minimised, so a future client bug
//      cannot quietly re-widen the export.
//   4. NEVER LOGGED. §8: confidential values never appear in application logs or third-party
//      telemetry. Nothing here logs the body, the question or the answer.
//
// STILL OPEN, and recorded rather than implied away: evidence is assembled on the CLIENT and
// posted here. Codex's preferred end state is server-side assembly from server-held sources,
// which removes the client's ability to over-send at all. That is a larger change and is listed
// in the program plan; this endpoint establishes the boundary that change would slot into.

// Same headroom as the shared proxy: a grounded answer over a scoped pack runs ~20s.
export const config = { maxDuration: 120 };

const MAX_BYTES = 120 * 1024;          // a minimised pack is a few KB; 120K is a generous ceiling
const ALLOWED_TOP = new Set(['asOf', 'coverage', 'jobs', 'billing', 'overdueAr', 'topSubs',
  'completed', 'bidboard', 'scope']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const GATE = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';
  const body = req.body || {};
  if (body.pw !== GATE) return res.status(401).json({ error: 'Unauthorized' });

  const question = String(body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'A question is required.' });
  if (question.length > 1000) return res.status(400).json({ error: 'Question too long.' });

  const ev = body.evidence;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return res.status(400).json({ error: 'Evidence pack missing or malformed.' });
  }
  // Shape allowlist: an unknown section means the client changed and this contract did not.
  const unknown = Object.keys(ev).filter(k => !ALLOWED_TOP.has(k));
  if (unknown.length) {
    return res.status(400).json({ error: `Evidence contains undeclared sections: ${unknown.join(', ')}` });
  }
  const raw = JSON.stringify(ev);
  if (raw.length > MAX_BYTES) {
    return res.status(413).json({
      error: `Evidence pack is ${Math.round(raw.length / 1024)}KB, over the ${MAX_BYTES / 1024}KB limit. `
        + 'This endpoint carries confidential data and only accepts a minimised, question-scoped pack.',
    });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'Answering service is not configured.' });

  const system = String(body.system || '');
  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1600,
    temperature: 0.2,
    system,
    messages: [{ role: 'user', content: `QUESTION: ${question}\n\nEVIDENCE (JSON):\n${raw}` }],
  };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      // Status only — never the response body, which echoes the prompt.
      return res.status(502).json({ error: `Answering service returned ${r.status}.` });
    }
    const data = await r.json();
    return res.status(200).json({ ok: true, content: data.content });
  } catch (e) {
    // Message only, and only ours: no request/response content reaches the log.
    console.error('ryc-ask: upstream call failed');
    return res.status(503).json({ error: 'Answering service unreachable.' });
  }
}
