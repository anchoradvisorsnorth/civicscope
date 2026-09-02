// CivicScope LLM proxy.
//
// STILL A PURE PASSTHROUGH for prompts — prompts are built client-side and this
// file NEVER injects or rewrites prompt content. What it adds is transport
// resilience only:
//   1. Retry-with-backoff on transient Anthropic errors (429 / 5xx / 529 overloaded).
//   2. A provider fallback (OpenAI-compatible) when Anthropic stays unavailable,
//      so an Anthropic-side incident (e.g. the 2026-06-23 "elevated error rate"
//      529 outage) degrades gracefully instead of erroring every tool.
//
// The fallback is OFF unless OPENAI_API_KEY is set, so this is safe to deploy
// before the key exists. It translates the Anthropic-shaped request to an
// OpenAI chat-completions call and translates the reply back into Anthropic's
// { content: [{ type:'text', text }] } shape so NO client/tool change is needed.
//
// Give the proxy headroom: a single Sonnet estimate (esp. Schools/Infra
// renovation scenarios) can generate ~1,300 output tokens / ~20s. The cap is
// free; billing is on actual execution time.
//
// RAISED 120 -> 300 (Vercel Pro max) on 2026-09-02. 120s was measured against
// TEXT estimates and never against a plan-set batch: the RYC Desk takeoff posts
// 10 rendered plan pages at up to 4096 output tokens, and one of those alone can
// run past a minute. On 2026-09-02T16:17:28Z an estimator's takeoff died on
// "Vercel Runtime Timeout Error: Task timed out after 120 seconds" — the caller
// gets a bodyless 504, and the Desk's runEstimate() catch kills the entire run,
// losing every batch already paid for. See also the deadline logic below: the
// cap alone was never the whole bug.
export const config = { maxDuration: 300 };

const RETRIABLE = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = Number(process.env.CLAUDE_PROXY_RETRIES || 3); // total Anthropic tries
const BACKOFF_MS = [500, 1500, 3000]; // per-retry wait (+ jitter)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ABUSE CEILING (Codex closure review, 2026-08-02). This endpoint is deliberately open — the
  // public estimators call it from unauthenticated pages, and four automation callers (the VM
  // health monitor, the smoke and e2e checks, the RYC calibration backtests) call it with no
  // browser Origin at all, so an origin allowlist would silently break them. What is capped here
  // instead is the COST of an arbitrary caller: request size and output length. It bounds the
  // bill without changing behaviour for any real caller — the largest genuine prompt is a
  // renovation scenario at ~25KB in / ~1,300 tokens out.
  //
  // NOT the confidentiality fix. RYC's confidential traffic no longer uses this endpoint at all;
  // it goes through the gated single-processor /api/ryc-ask. An identity-bearing allowlist for
  // this proxy is tracked separately because it has to land with the automation callers.
  //
  // THE 200KB FLAT CAP WAS A TRUNCATION BUG (found 2026-08-02, same day it shipped). The audit
  // behind it measured TEXT prompts (~25KB) and never looked at an image caller. One rendered
  // plan page is 70-220KB of base64, and the takeoff deliberately batches up to 3MB / 10 pages
  // (splitIntoBatches). So the flat cap 413'd every multi-page vision request: the RYC
  // estimator's own plan-set takeoff — the product's core function — and the new-pursuit
  // document reader. Single-page requests slipped under it, which is why it looked fine.
  //
  // Text and images are bounded SEPARATELY: an arbitrary text caller stays cheap, while a
  // genuine vision caller is bounded by image count and a ceiling that sits above the largest
  // real batch. Both refusals now report the measured numbers, so this can never again fail
  // silently enough to look like "the document had nothing in it".
  const body = req.body;
  const size = (() => { try { return JSON.stringify(body || '').length; } catch { return 0; } })();
  const imageCount = (() => {
    try {
      return (body.messages || []).reduce((n, m) => n + (Array.isArray(m.content)
        ? m.content.filter(c => c && c.type === 'image').length : 0), 0);
    } catch { return 0; }
  })();
  const TEXT_LIMIT = 200 * 1024;          // unchanged for text-only callers
  const IMAGE_LIMIT = 4 * 1024 * 1024;    // above the 3MB takeoff batch, below Vercel's 4.5MB body limit
  const MAX_IMAGES = 16;                  // splitIntoBatches caps a batch at 10 pages
  if (imageCount > MAX_IMAGES) {
    return res.status(413).json({ error: { message: `Too many images (${imageCount} > ${MAX_IMAGES})` } });
  }
  const limit = imageCount > 0 ? IMAGE_LIMIT : TEXT_LIMIT;
  if (size > limit) {
    return res.status(413).json({ error: { message:
      `Request too large (${Math.round(size / 1024)}KB > ${Math.round(limit / 1024)}KB${imageCount ? `, ${imageCount} images` : ''})` } });
  }
  // The ceiling must sit ABOVE every genuine caller or it is not a guard, it is a truncation bug.
  // Audited 2026-08-02: the largest real request is 4096 (a sketch-attached estimate, and the
  // `maxTokens || 4096` default in the GC estimator); everything else is 1100–2400. 8192 leaves
  // every caller untouched while still refusing a 64K-output request from an arbitrary client.
  // A first cut of this clamped at 4000 — under the 4096 caller — which is exactly the silent
  // clipping this comment exists to stop happening again.
  if (body && Number(body.max_tokens) > 8192) body.max_tokens = 8192;

  let last = { status: 502, data: { error: { message: 'No upstream response' } } };

  /* THE RETRY LOOP HAD NO IDEA HOW MUCH TIME IT HAD (fixed 2026-09-02).
     MAX_ATTEMPTS unbounded fetches plus two backoff sleeps all ran inside ONE function budget,
     so a slow first attempt guaranteed the second would be killed mid-flight. When that happened
     the invocation died and the caller got a 504 with NO BODY — not the upstream error, not a
     retryable signal, nothing the client could act on or resume from. Raising maxDuration alone
     would only have bought a longer walk to the same cliff.

     Now every attempt is bounded by what remains of the budget, and an attempt that cannot
     plausibly finish is never started — the last REAL upstream error is returned instead. */
  const startedAt = Date.now();
  const BUDGET_MS = Number(process.env.CLAUDE_PROXY_BUDGET_MS || 285000); // under maxDuration 300
  const MIN_ATTEMPT_MS = 20000;   // below this an attempt is not worth starting
  const remaining = () => BUDGET_MS - (Date.now() - startedAt);
  let ranOutOfTime = false;

  // 1) Anthropic, with bounded retry on transient failures.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (remaining() < MIN_ATTEMPT_MS) { ranOutOfTime = true; break; }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        // Leave a margin so the abort lands as OUR error with a message, rather than as the
        // platform killing the invocation and erasing the response entirely.
        signal: AbortSignal.timeout(Math.max(MIN_ATTEMPT_MS, remaining() - 3000)),
      });
      const data = await response.json();

      if (response.ok) return res.status(200).json(data);

      last = { status: response.status, data };
      if (!RETRIABLE.has(response.status)) break; // 4xx (bad request, auth) — don't retry/fallback
    } catch (err) {
      // Network/timeout — treat as transient.
      const aborted = /abort|timeout/i.test(err.name || err.message || '');
      if (aborted) ranOutOfTime = true;
      last = { status: aborted ? 504 : 503, data: { error: { message: aborted
        ? `Anthropic did not answer within the time this request had left (${Math.round(BUDGET_MS / 1000)}s). `
          + 'For a plan-set takeoff this usually means the batch is too large — send fewer pages per batch.'
        : `Anthropic request failed: ${err.message || 'unknown'}` } } };
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const wait = BACKOFF_MS[attempt] + Math.floor(Math.random() * 250);
      // Never sleep into the wall: a backoff that leaves no room for the attempt it precedes
      // spends the remaining budget doing nothing.
      if (remaining() - wait < MIN_ATTEMPT_MS) { ranOutOfTime = true; break; }
      await sleep(wait);
    }
  }

  // 2) Anthropic exhausted on a transient error. Try the OpenAI fallback if it's
  //    configured AND the request is text-only (we don't translate image/doc blocks).
  if (RETRIABLE.has(last.status) && process.env.OPENAI_API_KEY && isTextOnly(body)) {
    try {
      const fb = await callOpenAIFallback(body);
      if (fb) {
        console.warn(`CivicScope proxy: Anthropic ${last.status} — served via OpenAI fallback (${fb.model})`);
        return res.status(200).json(fb);
      }
    } catch (err) {
      console.error('OpenAI fallback failed:', err.message || err);
    }
  }

  // 3) Nothing worked — relay the last Anthropic error verbatim (preserves status/body
  //    so the existing tool error handling + cs-health see the true cause).
  //
  //    A budget exhaustion must still answer IN JSON. The whole point of the deadline is that the
  //    client gets a readable cause instead of the platform's bodyless 504, so a run that has
  //    already paid for several batches can report which one died and why.
  if (ranOutOfTime && last.status === 502) {
    return res.status(504).json({ error: { message:
      `The request ran out of time (${Math.round(BUDGET_MS / 1000)}s) before Anthropic answered. `
      + 'For a plan-set takeoff this usually means the batch is too large — send fewer pages per batch.',
      elapsed_ms: Date.now() - startedAt } });
  }
  return res.status(last.status).json(last.data);
}

// --- OpenAI fallback helpers --------------------------------------------------

// Only fall back when every message's content is plain text (string, or an array
// of {type:'text'} blocks). Multimodal requests (GC plan-set image/doc uploads)
// are left to surface the real Anthropic error rather than be mistranslated.
function isTextOnly(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  return body.messages.every((m) => {
    if (typeof m.content === 'string') return true;
    if (Array.isArray(m.content)) return m.content.every((b) => b && b.type === 'text' && typeof b.text === 'string');
    return false;
  });
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => b.text || '').join('\n');
  return '';
}

async function callOpenAIFallback(body) {
  // Rolling/general model by default — NOT Codex (a code model, wrong for cost
  // narratives). Override with OPENAI_FALLBACK_MODEL. Never pin a dated snapshot.
  const model = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o';

  const messages = [];
  if (body.system) messages.push({ role: 'system', content: flattenContent(body.system) });
  for (const m of body.messages) messages.push({ role: m.role, content: flattenContent(m.content) });

  const payload = {
    model,
    messages,
    max_completion_tokens: body.max_tokens || 2400, // forward-compatible across gpt-4o + o-series
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenAI returned empty content');

  // Translate back into Anthropic's response shape so tools parse it unchanged.
  return {
    id: data.id || 'fallback',
    type: 'message',
    role: 'assistant',
    model: `openai-fallback:${data.model || model}`,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    _fallback: 'openai',
  };
}
