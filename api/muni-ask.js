// api/muni-ask.js — answer a question from a municipality's own published documents.
//
// WHAT THIS IS
// Centreville publishes its entire code of ordinances, its zoning book, and years of planning and
// council minutes as hundreds of PDFs in a public Google Drive tree. They are public and complete
// and effectively unusable: they are scans, so they carry no text layer at all — a clerk asked
// whether golf carts are street-legal cannot even Ctrl+F for "golf cart". They have to already
// know which of twenty subject folders holds the answer, then read a 90-page photograph of paper.
//
// This endpoint closes that gap: retrieve the passages that actually bear on the question, and let
// Claude draft an answer that cites them, with a link back to the source PDF every time.
//
// THE DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE
// This tool speaks about what a village's law says. Being confidently wrong is worse than being
// unhelpful, because a clerk may repeat the answer to a resident who then acts on it. So:
//
//   1. RETRIEVAL IS SERVER-SIDE. The browser sends a question, not a query and not a document
//      set. It cannot widen retrieval, cannot inject passages, and cannot ask the model to answer
//      from anything but this village's corpus.
//   2. NO CORPUS, NO ANSWER. If retrieval returns nothing, this returns "not found" and never
//      reaches the model. A plausible answer assembled from general knowledge of municipal law is
//      the single worst output this product could produce.
//   3. EVERY CLAIM CARRIES ITS SOURCE. Passages are numbered and the model must cite them; the
//      response ships the matching source list so every citation resolves to a real PDF.
//   4. TRANSCRIPTION UNCERTAINTY IS VISIBLE. Text from a scan can misread a digit. Passages are
//      labelled with their provenance and the model is told to flag a figure it is relying on
//      from a transcription. A wrong setback stated confidently is the failure mode to avoid.
//
// Anthropic only — no OpenAI fallback. `api/claude.js` has one for the public estimators, where a
// second provider is a reasonable transport-resilience trade. Here the model is answering
// questions about a specific municipality's law; if Anthropic is unavailable this degrades to
// unavailable, which is the correct failure.

export const config = { maxDuration: 120 };

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const MODEL = 'claude-opus-5';
const MAX_QUESTION = 500;
const RETRIEVE = 12;          // passages pulled from Postgres
const CONTEXT_CHARS = 24000;  // ceiling on what reaches the model

async function sb(pathAndQuery, init = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  const body = await r.text();
  return body ? JSON.parse(body) : null;
}

const SYSTEM = `You answer questions for people working in or living in a small municipality, using
only that municipality's own published documents. Your reader is often a village clerk or a
resident, not a lawyer.

WHAT YOU ARE GIVEN
Numbered passages retrieved from the village's ordinances, zoning rules, permit materials and
meeting records. Each carries its source document and, where the document names one, its section
heading. Each is also labelled with how its text was obtained:
  [text]  the document's own text — verbatim and reliable
  [scan]  a transcription of a scanned page — accurate in the main, but a digit or a
          punctuation mark can be misread

HOW TO ANSWER
- Answer ONLY from the passages. If they do not settle the question, say so plainly and say what
  the village would need to look at. Never fill a gap with general knowledge of how municipalities
  usually work — a plausible answer about the wrong village's rules is worse than no answer.
- Cite the passages you relied on as [1], [2] inline, at the point of the claim.
- Lead with the answer. One or two sentences, then the supporting detail. If the answer is a
  number, a deadline, a fee or a dimension, put it in the first sentence.
- Quote the operative language when the exact wording carries the meaning, and give the section
  number when a passage has one — that is the citation the reader needs to look it up or repeat it.
- When a specific figure you are relying on comes from a [scan] passage, say that it should be
  confirmed against the source document. Do this for figures, not for every sentence.
- If passages conflict, or an ordinance appears amended by a later one, say so rather than
  silently picking one.
- Meeting minutes record what a board discussed; ordinances are what was adopted. Do not present
  a discussion as if it were the rule.
- Plain language. No preamble, no restating the question, no markdown headers. Prose, short
  paragraphs.
- You are not giving legal advice, and you should not say that you are not giving legal advice —
  the page already tells the reader that. Just answer the question from the documents.`;

export default async function handler(req, res) {
  // ---- safe, read-only tenant lookup ---------------------------------------------------
  // Also the deploy gate's contract for this route: it exercises the real credential
  // resolution and Supabase read path without costing anything or writing anything.
  if (req.method === 'GET') {
    const slug = String(req.query.tenant || '').trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: 'tenant is required' });
    if (!SB_URL || !SB_KEY) return res.status(503).json({ error: 'Corpus is not configured.' });
    try {
      // `water_wssn` is here because the village hub needs to know which products this village
      // has, and this GET is already "tell me about this tenant". Naming wart acknowledged: the
      // endpoint is `muni-ask` but this branch is a village lookup, not an ask. Renaming it would
      // break the deploy contract and the live page for no reader benefit.
      const [t] = await sb(`muni_tenants?slug=eq.${encodeURIComponent(slug)}`
        + '&select=slug,label,short_label,site_url,blurb,active,doc_count,last_ingest_at,water_wssn');
      if (!t) return res.status(404).json({ error: 'Unknown municipality.' });
      const docs = await sb(`muni_docs?tenant=eq.${encodeURIComponent(slug)}`
        + '&select=collection,text_source,chunk_count');
      const collections = {};
      let chunks = 0, scanned = 0;
      for (const d of docs || []) {
        collections[d.collection || 'Other'] = (collections[d.collection || 'Other'] || 0) + 1;
        chunks += d.chunk_count || 0;
        if (d.text_source === 'ocr') scanned++;
      }
      return res.status(200).json({
        ok: true,
        tenant: t,
        corpus: { documents: (docs || []).length, passages: chunks, transcribed: scanned, collections },
      });
    } catch {
      return res.status(503).json({ error: 'Corpus is unavailable.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: 'Corpus is not configured.' });

  const body = req.body || {};
  const slug = String(body.tenant || '').trim().toLowerCase();
  const question = String(body.question || '').trim();

  if (!slug) return res.status(400).json({ error: 'A municipality is required.' });
  if (!question) return res.status(400).json({ error: 'A question is required.' });
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: `Question is too long (max ${MAX_QUESTION} characters).` });
  }

  const started = Date.now();
  let tenant;
  try {
    [tenant] = await sb(`muni_tenants?slug=eq.${encodeURIComponent(slug)}&select=slug,label,active`);
  } catch {
    return res.status(503).json({ error: 'Corpus is unavailable.' });
  }
  if (!tenant) return res.status(404).json({ error: 'Unknown municipality.' });
  // A corpus that is still being built answers nothing. The flag is checked HERE, on the
  // server, because the page is cached in browsers that may already be open.
  if (!tenant.active) {
    return res.status(403).json({
      error: 'This municipality’s document library is still being prepared and is not answering questions yet.',
      pending: true,
    });
  }

  // ---- retrieval -----------------------------------------------------------------------
  let hits;
  try {
    hits = await sb('rpc/muni_search', {
      method: 'POST',
      body: JSON.stringify({ p_tenant: slug, p_query: question, p_limit: RETRIEVE }),
    });
  } catch {
    return res.status(503).json({ error: 'Search is unavailable.' });
  }

  const logQuestion = async (hitCount, answered) => {
    try {
      await sb('muni_questions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          tenant: slug, question, hit_count: hitCount, answered,
          duration_ms: Date.now() - started,
        }]),
      });
    } catch { /* logging must never fail the answer */ }
  };

  if (!hits || !hits.length) {
    // A genuine corpus gap, recorded as one. These rows are the village's own
    // "what are we not able to answer" list.
    await logQuestion(0, false);
    return res.status(200).json({
      ok: true, found: false, sources: [],
      answer: 'I could not find anything in ' + tenant.label + '’s published documents that '
        + 'addresses that. It may be worded differently in the ordinances, or it may not be '
        + 'covered by them — try naming the specific thing you are asking about (for example '
        + '"fence height", "golf cart", "sidewalk repair"), or contact the Village office.',
    });
  }

  // Build the passage block, bounded so a broad question cannot send an unbounded prompt.
  const used = [];
  let context = '';
  for (const h of hits) {
    const label = h.text_source === 'ocr' ? 'scan' : 'text';
    const where = [h.heading, h.citation].filter(Boolean).join(' — ');
    const block = `[${used.length + 1}] (${label}) ${where}\n${h.content}\n\n`;
    if (context.length + block.length > CONTEXT_CHARS) break;
    context += block;
    used.push(h);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'Answering service is not configured.' });

  let answer;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `MUNICIPALITY: ${tenant.label}\n\nPASSAGES:\n${context}\nQUESTION: ${question}`,
        }],
      }),
    });
    if (!r.ok) {
      await logQuestion(used.length, false);
      // Status only — the body echoes the prompt.
      return res.status(502).json({ error: `Answering service returned ${r.status}.` });
    }
    const d = await r.json();
    if (d.stop_reason === 'refusal') {
      await logQuestion(used.length, false);
      return res.status(200).json({
        ok: true, found: false, sources: [],
        answer: 'I am not able to answer that one. Try rephrasing it as a question about the '
          + 'Village’s ordinances or procedures.',
      });
    }
    answer = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch {
    await logQuestion(used.length, false);
    return res.status(503).json({ error: 'Answering service unreachable.' });
  }

  await logQuestion(used.length, true);

  return res.status(200).json({
    ok: true,
    found: true,
    answer,
    // One entry per numbered passage, in the same order, so [3] in the prose resolves to
    // sources[2] in the UI without the client re-deriving anything.
    sources: used.map((h, i) => ({
      n: i + 1,
      title: h.title,
      collection: h.collection,
      heading: h.heading,
      citation: h.citation,
      url: h.source_url,
      transcribed: h.text_source === 'ocr',
    })),
  });
}
