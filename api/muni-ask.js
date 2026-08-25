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
Numbered passages retrieved from the village's ordinances, zoning rules, permit materials, meeting
records and its own official website. Each carries its source document and, where the document names
one, its section heading. Each is also labelled with how its text was obtained:
  [text]  the document's own text — verbatim and reliable
  [scan]  a transcription of a scanned page — accurate in the main, but a digit or a
          punctuation mark can be misread
  [web, read <date>]  a page from the village's own website, as it read on that date. Official
          and current for things like office hours, phone numbers, who sits on the council or a
          committee, payment links, and events. It is NOT adopted law.

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
- A [web] passage is the village describing itself, not the law. For hours, phone numbers, staff,
  council and committee membership, payment links and events it is the best source you have and you
  should use it plainly. But where a [web] page and an ordinance disagree about a RULE, the
  ordinance governs and you should say so.
- [web] information can go out of date in a way an ordinance does not. When the answer is a DATE,
  an event, a meeting time or a cancellation, say when the page was read — for example "as the
  Village website read on 25 August 2026" — and suggest confirming with the Village office if it
  matters. Do this for dated and scheduled things, not for a street address.
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
        if (d.text_source === 'ocr' || d.text_source === 'mixed') scanned++;
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
    /* ⚠ NAMED COLUMNS, NEVER `select=*`, and that is load-bearing on this table now: muni_tenants
       carries auth_client_id and anthropic_key_env, and this handler's GET branch returns tenant
       fields straight to the browser. A widening edit here is the one mistake that would publish
       configuration nobody meant to publish. */
    [tenant] = await sb(`muni_tenants?slug=eq.${encodeURIComponent(slug)}&select=slug,label,active,anthropic_key_env`);
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

  /* ⛔ THE VILLAGE'S OWN WEBSITE IS GUARANTEED A SEAT, BECAUSE IT CANNOT WIN ITS OWN.
     Centreville's corpus is ~2,800 passages of minutes, zoning and ordinances against ~26 pages of
     website. `ts_rank_cd` rewards a term repeated many times, without bound and without length
     normalisation, so a zoning section that says "Village Council" eight times while granting it
     authority outranks the roster that says it once and then lists seven names. Measured
     2026-08-25: "who is on the village council" did not return the roster in the top TWENTY.

     That is not fixable with a collection weight — migration 031 assumed it was, and migration 032
     records the measurements that disproved it. It is a structural consequence of one collection
     being a hundred times smaller than the other, and the honest fix is not to re-rank the corpus
     but to stop the small source being invisible: if the website matched the question at all and
     nothing from it survived the global cut, its best two passages are ADDED.

     ⚠ This adds, it never displaces. The ordinances keep every seat they won, so a legal question
     still leads with the law — and the model is separately told that a [web] passage is not law and
     that an ordinance governs where the two disagree about a rule. */
  if (hits && hits.length && !hits.some((h) => h.text_source === 'web')) {
    try {
      const web = await sb('rpc/muni_search_collection', {
        method: 'POST',
        body: JSON.stringify({ p_tenant: slug, p_query: question, p_collection: 'Village Website', p_limit: 2 }),
      });
      if (web && web.length) hits = hits.concat(web);
    } catch { /* the corpus still answers without it; never fail the question over an extra read */ }
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

  /* WHEN A WEBSITE PASSAGE WAS READ. `muni_search` does not return `modified_at`, and widening its
     signature is the one change in this system that has repeatedly gone wrong (018–021: a rewrite
     that silently drops an existing ranking arm). One extra read, only when the website actually
     matched, is the cheaper and far safer way to get it.

     ⚠ THE DATE IS NOT DECORATION. An ordinance from 2019 is still the ordinance; a meeting
     cancellation is wrong the moment it is superseded. Without the date the model cannot tell the
     reader how much to trust a scheduled thing, and an undated stale answer about a meeting is
     worse than no answer at all. */
  const webIds = [...new Set(hits.filter((h) => h.text_source === 'web').map((h) => h.doc_id))];
  const readAt = {};
  if (webIds.length) {
    try {
      const rows = await sb(`muni_docs?id=in.(${webIds.join(',')})&select=id,modified_at`);
      for (const r of rows || []) readAt[r.id] = r.modified_at;
    } catch { /* the label degrades to a bare [web]; never fail the answer over it */ }
  }
  const fmtDay = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d) ? null : d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Detroit' });
  };

  // Build the passage block, bounded so a broad question cannot send an unbounded prompt.
  const used = [];
  let context = '';
  for (const h of hits) {
    const day = h.text_source === 'web' ? fmtDay(readAt[h.doc_id]) : null;
    /* ⛔ 'mixed' MUST READ AS A SCAN, NOT AS TEXT. A mixed document has a real text layer plus
       pages that were transcribed because pdftotext could not read them — and on the Centreville
       zoning book those pages are the SETBACK TABLE. Labelling that [text] would present a
       transcribed grid to the model as verbatim and reliable, which is precisely the wrong
       direction on the one document where a misread digit changes what somebody builds. */
    const label = (h.text_source === 'ocr' || h.text_source === 'mixed') ? 'scan'
      : h.text_source === 'web' ? (day ? `web, read ${day}` : 'web')
      : 'text';
    const where = [h.heading, h.citation].filter(Boolean).join(' — ');
    const block = `[${used.length + 1}] (${label}) ${where}\n${h.content}\n\n`;
    if (context.length + block.length > CONTEXT_CHARS) break;
    context += block;
    used.push(h);
  }

  /* ── WHOSE ANTHROPIC BILL THIS LANDS ON (migration 035, 2026-08-25) ──────────────────────────
     Keith: *"I would like the civicscope - centreville to be wired to its own Claude API key."*
     One key has run every business in this stack, and on 2026-08-18 the Centreville corpus ingest
     exhausted the ORGANISATION's monthly limit mid-run — every other product in the stack started
     refusing until the cap was raised. A village on its own key, in its own workspace with its own
     spend limit, cannot do that to anything else, and its cost becomes a number that can be shown
     to that village.

     ⛔ THE TENANT ROW NAMES AN ENVIRONMENT VARIABLE; IT NEVER HOLDS THE KEY. And the name is
     re-validated HERE, not merely constrained in the database, because a value that indexes
     process.env can otherwise reach ANY environment variable — SUPABASE_SERVICE_KEY included — if
     whatever wrote that row was ever wrong. A CHECK on a table is not a check on the value that
     arrives at a function. Anything that fails the pattern falls back to the shared key rather than
     being looked up. */
  let key = process.env.ANTHROPIC_API_KEY;
  if (tenant.anthropic_key_env && /^ANTHROPIC_API_KEY_[A-Z0-9_]+$/.test(tenant.anthropic_key_env)) {
    /* A village configured for its own key that cannot find it must NOT quietly bill the shared one:
       that is how an isolation guarantee becomes a comment. It fails, and says which variable is
       missing so the fix is one step. */
    const own = process.env[tenant.anthropic_key_env];
    if (!own) {
      await logQuestion(used.length, false);
      return res.status(503).json({ error: `Answering service is not configured for this municipality (${tenant.anthropic_key_env} is not set).` });
    }
    key = own;
  }
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
      transcribed: h.text_source === 'ocr' || h.text_source === 'mixed',
      // A website source opens a live page, not a PDF — and the reader needs to know it is looking
      // at a snapshot, because the page may have changed since. The date travels with the source.
      web: h.text_source === 'web',
      readAt: h.text_source === 'web' ? (fmtDay(readAt[h.doc_id]) || null) : null,
      /* ⛔ WHAT KIND OF THING THIS IS, DECIDED SERVER-SIDE. A reader needs to know whether an answer
         rests on what the Village ENACTED or on what a board once discussed — those are not the same
         claim, and the page must not have to guess. The split is the same judgement already encoded
         in muni_search's weight table (migration 031): adopted law and the Village's own current
         statements score 1.10 and above; minutes, plans and the newsletter score 1.00 because they
         record discussion rather than authority.
         ⚠ If that table changes, change this with it — it is deliberately the only other place the
         judgement appears, and it lives here rather than in the page so there is one copy per rule
         rather than one per surface. */
      authority: ['Code of Ordinances', 'Zoning & Planning Commission',
        'Applications and Permits', 'Village Website'].includes(h.collection)
        ? 'primary' : 'secondary',
    })),
  });
}
