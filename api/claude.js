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
// renovation scenarios) can generate ~1,300 output tokens / ~20s. 120s on
// Vercel Pro (max 300s) — the cap is free; billing is on actual execution time.
export const config = { maxDuration: 120 };

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
  const body = req.body;
  const size = (() => { try { return JSON.stringify(body || '').length; } catch { return 0; } })();
  if (size > 200 * 1024) {
    return res.status(413).json({ error: { message: 'Request too large' } });
  }
  if (body && Number(body.max_tokens) > 4000) body.max_tokens = 4000;

  let last = { status: 502, data: { error: { message: 'No upstream response' } } };

  // 1) Anthropic, with bounded retry on transient failures.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (response.ok) return res.status(200).json(data);

      last = { status: response.status, data };
      if (!RETRIABLE.has(response.status)) break; // 4xx (bad request, auth) — don't retry/fallback
    } catch (err) {
      // Network/timeout — treat as transient.
      last = { status: 503, data: { error: { message: `Anthropic request failed: ${err.message || 'unknown'}` } } };
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(BACKOFF_MS[attempt] + Math.floor(Math.random() * 250));
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
