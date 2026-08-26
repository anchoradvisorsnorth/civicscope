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
const CONTEXT_CHARS = 30000;  // ceiling on what reaches the model.
// Raised from 24,000 on 2026-08-25. A printed table is now ONE chunk — Centreville's Table 4-4 is
// 3,265 characters on its own — so the old ceiling was being reached by the ranked hits alone
// (26,621 for a single setback question) and anything guaranteed afterwards was silently dropped.

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
  the page already tells the reader that. Just answer the question from the documents.

FIRST LINE — A MARKER, NOT PROSE
Begin your reply with exactly one of these on its own first line. It is stripped before the reader
sees anything, and it is how the village learns which questions its documents cannot answer:
  ANSWERED   the passages settle the question and you have said so.
  PARTIAL    you answered part of it and a material part is missing from the passages.
  REFERRED   the passages do not carry the fact BECAUSE THIS GOVERNMENT DOES NOT HOLD IT, and you
             have named the one that does — a county treasurer who issues the licences, a county
             plan commission the town delegated its zoning to, a state agency. Use this only when
             you actually named the responsible body; "ask the Village office" alone is DECLINED.
  DECLINED   passages were retrieved but none of them answers the question, and you cannot say who
             would. This is the one that means something is broken.
Judge only whether the PASSAGES settled it. Do not soften a DECLINED into a PARTIAL because you
found something adjacent and useful to say — the whole value of this line is that it goes red.

REFERRED and DECLINED both mean "I could not give the number", and they are still opposites, so
keep them apart. REFERRED is the correct answer to a question this government has no say in —
Michigan counties issue dog licences, and Bristol handed its zoning to Elkhart County outright.
DECLINED says the documents should have carried it and did not, which sends someone looking for a
defect. Calling a good referral DECLINED wastes that trip; calling a real gap REFERRED hides it.`;

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
        + '&select=slug,label,short_label,site_url,blurb,active,doc_count,last_ingest_at,water_wssn,unit_noun,logo_url,sample_questions');
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
    [tenant] = await sb(`muni_tenants?slug=eq.${encodeURIComponent(slug)}&select=slug,label,active,anthropic_key_env,unit_noun,shares_corpus_with`);
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

  /* ⛔ THE MUNICIPALITY'S OWN NAME IS NOISE IN ITS OWN CORPUS, AND ON BRISTOL IT WAS FATAL.
     People write "In Bristol, what is the front setback in the R-1 district?" — naming the place is
     the most natural way to ask. But every document in this tenant is already about that place, so
     the word carries no information and enormous term frequency. Measured 2026-08-25, that one word
     decided the whole answer:

       with "Bristol"     the town's top 12 were the Farmers' Market (×5), Parks, the Fire Station,
                          Water Bill Information and two history pages — 143 website pages carry the
                          town's name, and ts_rank_cd rewards that without bound.
       without "Bristol"  the top hits are ordinance sections, and the R-1 dimensional table ranks.

     Worse across the shared corpus: the Elkhart County ordinance never says "Bristol", so including
     it broke the strict all-terms pass and dropped the county to the OR fallback, where the R-1
     Building Placement page loses to whatever repeats the common words most.

     Stripped for RETRIEVAL only. The model still receives the question exactly as it was typed —
     the reader's phrasing is theirs, and "In Bristol" may matter to how the answer reads. If
     removal would leave almost nothing (somebody asking only about the name), the original stands. */
  const placeName = String(tenant.label || '').split(',')[0]
    .replace(new RegExp('^\\s*(Village|Town|City|County|Township)\\s+of\\s+', 'i'), '').trim();
  let searchQuery = question;
  if (placeName.length > 2) {
    const stripped = question
      .replace(new RegExp('\\b' + placeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), ' ')
      .replace(/\s{2,}/g, ' ').trim();
    if (stripped.split(/\s+/).filter(Boolean).length >= 3) searchQuery = stripped;
  }

  // ---- retrieval -----------------------------------------------------------------------
  let hits;
  try {
    hits = await sb('rpc/muni_search', {
      method: 'POST',
      body: JSON.stringify({ p_tenant: slug, p_query: searchQuery, p_limit: RETRIEVE }),
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
  /* ⛔ THE COUNTY THAT ACTUALLY ZONES THIS TOWN (migration 040).
     Bristol adopted the Elkhart County Development Ordinance by reference and handed its plan
     commission to the county, keeping only the district map. So a zoning question asked of Bristol
     is answered by a county document, and searching only Bristol returns a confident silence that
     looks exactly like "the town has no rule about that".
     A second retrieval against the shared tenant, merged — the same mechanism already proven for
     the village website and for printed tables. The town keeps every seat it won; the county is
     added. Passages carry their own citation, so the reader can see which government said it. */
  if (tenant.shares_corpus_with) {
    try {
      const shared = await sb('rpc/muni_search', {
        method: 'POST',
        body: JSON.stringify({ p_tenant: tenant.shares_corpus_with, p_query: searchQuery, p_limit: 6 }),
      });
      /* ⛔ INTERLEAVED, NOT APPENDED — "the county is added" meant "added where the context budget
         throws it away". The same failure the table guarantee documents below, one level up, and it
         hid the R-1 setback for a week: the town's twelve own hits filled 25,292 of the 30,000-char
         budget, so the loop broke before ANY county passage, and Bristol's zoning answer was
         assembled from the Farmers' Market page.

         ⚠ And they cannot simply be sorted by rank: the two arrays come from separate muni_search
         calls that may have taken different passes, so the numbers are not on one scale. Measured
         on the same question: the town's hits scored 2.5–7.5 (strict pass) while the county's
         scored 0.015–0.05 (OR fallback) — sorting would have buried the county even deeper, and on
         the previous phrasing it would have buried the town. Comparing them looks principled and is
         not. Interleaving needs no such comparison: each corpus keeps its own ordering and is
         guaranteed seats at the front, which is all this has ever needed. */
      if (shared && shared.length) {
        const own = hits || [];
        const merged = [];
        for (let i = 0; i < Math.max(own.length, shared.length); i++) {
          if (own[i]) merged.push(own[i]);
          if (shared[i]) merged.push(shared[i]);
        }
        hits = merged;
      }
    } catch { /* the town's own corpus still answers */ }
  }

  /* ⛔ AND THE SAME GUARANTEE FOR A PRINTED TABLE, FOR THE SAME REASON (migration 038).
     A table states each term once; the prose discussing that table repeats them, and ts_rank_cd
     rewards repetition without bound. So the footnotes to Centreville's Table 4-4 beat the table
     itself on every natural phrasing of "what are the R-1 setbacks" — the numbers were in the
     corpus, whole and correctly headed, and the tool still answered "I don't have that table".
     Measured: #9, #10, and outside the top 12, while "site development requirements table" put it
     at #1 — findable only by somebody who already knew its name.

     Tables are a structurally small, high-value minority that cannot win a term-frequency race, and
     dimensional standards are the single most common thing a village is asked for. So the best
     matching table is ADDED when the main retrieval missed it. It never displaces prose. */
  /* ⚠ THE TRIGGER IS "IS THE BEST TABLE HERE", NOT "IS A TABLE HERE" — and getting that wrong once
     produced a perfect illustration of why. Gated on "no table in the results", the guarantee never
     fired for the setback question, because Table 4-1 (which merely states the PURPOSE of each
     district) had won a seat on its own. A table was present, the right table was not, and the
     answer was still "I don't have the dimensional table". */
  // Hoisted: the logging site below needs to know which passages were GUARANTEED rather than
  // ranked, so used_table cannot under-report a table that arrived through the guarantee.
  let tbl = null;
  if (hits && hits.length) {
    try {
      tbl = await sb('rpc/muni_search_tables', {
        method: 'POST',
        /* TWO, not one. Asked how tall a building may be in R-2, the best-matching table is
           Table 4-1 — which states what each district is FOR and carries no dimensions — and the
           dimensional table is second. Guaranteeing only the top table hands the model a passage
           that mentions R-2 and answers nothing. */
        body: JSON.stringify({ p_tenant: slug, p_query: searchQuery, p_limit: 2 }),
      });
      /* ⛔ AND AGAINST THE COUNTY, when a town delegated its zoning there. Bristol is told what its
         setbacks are by the Elkhart County ordinance; guaranteeing a table only from Bristol s own
         corpus guarantees the wrong corpus. Measured: without this the answer was "the only
         building placement table here is for the R-3 district" while R-1 s sat in the county book. */
      if (tenant.shares_corpus_with) {
        const shTbl = await sb('rpc/muni_search_tables', {
          method: 'POST',
          /* THREE from the county, not two. A county ordinance carries a table per district plus
             overlays and general provisions, so the specific one a question is about routinely sits
             third — R-1 Building Placement ranked #2 and #3 with the actual dimensional row at #3.
             The town own-corpus guarantee stays at two; a county book is simply a bigger haystack. */
          body: JSON.stringify({ p_tenant: tenant.shares_corpus_with, p_query: searchQuery, p_limit: 3 }),
        }).catch(() => null);
        if (shTbl && shTbl.length) tbl.push(...shTbl);
      }
      const have = new Set(hits.map((h) => h.chunk_id));
      tbl = tbl || [];
      const add = tbl.filter((t) => !have.has(t.chunk_id));
      /* ⛔ PREPEND, NEVER APPEND. A guaranteed passage that goes on the end is the first thing the
         context budget throws away: the twelve ranked hits for this very question total 26,621
         characters against a 24,000 ceiling, so the loop below breaks before reaching anything
         added after them. The guarantee fired correctly, the table was in , and it still
         never reached the model. A seat at the back of a full room is not a seat. */
      if (add.length) hits = add.concat(hits);
    } catch { /* the corpus still answers without it */ }
  }

  // Village / Town / City / County — this tenant own noun (047).
  const websiteCollection = `${tenant.unit_noun || 'Village'} Website`;
  /* ⛔ "IS THE BEST WEBSITE PASSAGE HERE", NOT "IS ANY WEB PASSAGE HERE" — the identical mistake the
     table guarantee above already documents, left standing one block later. This was gated on
     `!hits.some(h => h.text_source === 'web')`, so a SINGLE unrelated web page anywhere in the top
     twelve suppressed the collection search entirely. Asked for town hall hours, a stray events page
     in the ranked hits is enough to keep the contact page — the one that answers — out of the
     context, and the reader is told the hours are not published.

     Presence of a source TYPE is not evidence that the best passage of that type survived ranking.
     So the small collection is always consulted and merged by chunk id; ranking still decides what
     the model reads first. */
  if (hits && hits.length) {
    try {
      const web = await sb('rpc/muni_search_collection', {
        method: 'POST',
        /* ⚠ The collection carries the tenant's own unit noun (047) — Centreville files under
           'Village Website', Bristol under 'Town Website'. Hardcoding 'Village' here would make
           this guarantee silently do nothing for every tenant that is not a village, and the
           only symptom would be worse answers. */
        body: JSON.stringify({ p_tenant: slug, p_query: searchQuery, p_collection: websiteCollection, p_limit: 2 }),
      });
      const seen = new Set(hits.map((h) => h.chunk_id));
      const add = (web || []).filter((w) => !seen.has(w.chunk_id));
      // Prepended for the same reason as the table above: the context budget truncates the tail.
      if (add.length) hits = add.concat(hits);
    } catch { /* the corpus still answers without it; never fail the question over an extra read */ }
  }

  /* ⛔ WHAT ACTUALLY HAPPENED, not whether the model produced prose. Until 2026-08-25 this recorded
      for every reply, so a question that retrieved twelve passages and was told
     "I do not have that table" counted as answered — and the village's "what can we not answer"
     list showed 68 of 68 fine while the most-asked zoning question had been broken for a week. */
  const logQuestion = async (hitCount, answered, extra = {}) => {
    try {
      await sb('muni_questions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          tenant: slug, question, hit_count: hitCount, answered,
          duration_ms: Date.now() - started,
          ...extra,
        }]),
      });
    } catch { /* logging must never fail the answer */ }
  };

  if (!hits || !hits.length) {
    // A genuine corpus gap, recorded as one. These rows are the village's own
    // "what are we not able to answer" list.
    await logQuestion(0, false, { outcome: 'no_corpus' });
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
      await logQuestion(used.length, false, { outcome: 'error' });
      return res.status(503).json({ error: `Answering service is not configured for this municipality (${tenant.anthropic_key_env} is not set).` });
    }
    key = own;
  }
  if (!key) return res.status(503).json({ error: 'Answering service is not configured.' });

  let answer;   // reassigned when the outcome marker is stripped
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
      await logQuestion(used.length, false, { outcome: 'error' });
      // Status only — the body echoes the prompt.
      return res.status(502).json({ error: `Answering service returned ${r.status}.` });
    }
    const d = await r.json();
    if (d.stop_reason === 'refusal') {
      await logQuestion(used.length, false, { outcome: 'error' });
      return res.status(200).json({
        ok: true, found: false, sources: [],
        answer: 'I am not able to answer that one. Try rephrasing it as a question about the '
          + 'Village’s ordinances or procedures.',
      });
    }
    answer = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch {
    await logQuestion(used.length, false, { outcome: 'error' });
    return res.status(503).json({ error: 'Answering service unreachable.' });
  }

  /* Strip the marker before the reader ever sees it, and record what it said.

     ⛔ NO MARKER IS `unknown`, NOT `answered`. This recorded `answered` when the model omitted or
     malformed its first line — the same optimistic default 045 was written to abolish, surviving one
     layer down. The reader would see "the passages do not contain the setback table", the report
     would count a success, and the question would never reach the repair queue.

     `unknown` is also NOT counted as a failure: a missing marker is a defect in our instrumentation,
     not evidence about the village s documents, and filing it under `declined` would send somebody
     to debug retrieval for a formatting slip (migration 050). */
  let outcome = null;
  const mark = String(answer || '').match(/^\s*(ANSWERED|PARTIAL|REFERRED|DECLINED)\b[ \t]*\n+/);
  if (mark) {
    outcome = mark[1].toLowerCase();
    answer = answer.slice(mark[0].length).trim();
  }

  /* ⛔ A REFERRAL TO A GOVERNMENT WHOSE DOCUMENTS WE ALREADY HOLD IS NOT A REFERRAL.
     The model cannot know which corpora we ingested, so it will politely point at the Elkhart
     County Development Ordinance — which is sitting in this very database, reachable through
     `shares_corpus_with`, and was merged into the passages for this exact question. Measured
     2026-08-25, minutes after REFERRED shipped: Bristol's R-1 front setback logged `referred`
     while naming section 158.03(B)(3) at page 3-8, a page we ingested. Left alone, the new
     outcome would have quietly absorbed the one open retrieval defect it was built to expose —
     the same disappearing act as the old `answered` flag, one layer up.

     So the SERVER overrides the model here, because only the server knows what was ingested. If
     the answer refers the reader to the government whose corpus this tenant already shares, that
     is a retrieval failure wearing a referral's clothes: record it as `declined`.

     Deliberately narrow — it fires only on the shared tenant's own name. A genuine referral out
     to a state agency, or to a county we have NOT ingested, stays `referred`, which is the whole
     point of having the outcome at all. */
  if (outcome === 'referred' && tenant.shares_corpus_with) {
    let sharedLabel = '';
    try {
      const [st] = await sb(`muni_tenants?slug=eq.${encodeURIComponent(tenant.shares_corpus_with)}&select=label`);
      /* The distinctive part only. Labels are stored qualified — 'Elkhart County, Indiana' — while
         an answer writes 'the Elkhart County Development Ordinance', so matching the whole label
         would make this override dead code that always looked like it was working. */
      sharedLabel = String((st && st.label) || '').split(',')[0].trim();
    } catch { /* naming the override is a nicety; never fail an answered request over it */ }
    if (sharedLabel && answer.toLowerCase().includes(sharedLabel.toLowerCase())) outcome = 'declined';
  }
  // Which collections the answer actually leaned on, and whether a whole table reached it. Both are
  // measures of whether the machinery built this month is doing anything for a real question.
  const cited = [...new Set(used.map((h) => h.collection).filter(Boolean))];
  /* ⚠ A METRIC THAT UNDER-REPORTS IS THE THING THIS WHOLE MIGRATION EXISTS TO STOP, so this does
     not rely on the heading alone:  does not return , so a table that
     arrived through ordinary retrieval would look like prose. The guaranteed set is known here by
     chunk id, and the heading test catches the rest. */
  const guaranteedIds = new Set((tbl || []).map((x) => x.chunk_id));
  const usedTable = used.some((h) => guaranteedIds.has(h.chunk_id)
    || /^Tables/i.test(String(h.heading || '')) || h.is_table === true);

  await logQuestion(used.length, !!outcome && outcome !== 'declined' && outcome !== 'no_corpus', {
    outcome: outcome || 'unknown',
    cited_collections: cited,
    used_table: usedTable,
  });

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
      authority: (['Code of Ordinances', 'Zoning & Planning Commission',
        'Applications and Permits'].includes(h.collection)
        // Any unit noun: 'Village Website', 'Town Website', 'City Website', 'County Website'.
        || /Website$/.test(String(h.collection || '')))
        ? 'primary' : 'secondary',
    })),
  });
}
