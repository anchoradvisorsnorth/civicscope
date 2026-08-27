/*
 * civicscope-admin/usage.js — what people ask a municipality's documents, and where the documents
 * fail. THE ONE COPY OF THAT ARITHMETIC.
 *
 * ⛔ WHY THIS IS A MODULE AND NOT INLINE IN THE PAGE.
 * Three surfaces report these numbers now: the terminal report (`scripts/muni-usage.mjs`), the
 * admin Ask Usage tab, and `api/admin.js` which serves the tab. A dashboard and a terminal report
 * that disagree about how many questions a village could not answer is the same class of fault as
 * a scoreboard that disagrees with the server about who won — and this project has already paid
 * for that lesson twice (`pool/scoring.js`, `civicscope-water/derive.js`). Same shape as derive.js:
 * the arithmetic lives in one file and both the caller and the API import it.
 *
 * ⛔ AND THE BUCKETS ARE NOT COSMETIC — TWO EARLIER VERSIONS OF THIS METRIC TOLD A COMFORTABLE
 * FALSEHOOD. `muni_questions.answered` was true whenever the model produced prose, so a question
 * that retrieved twelve passages and was told "these do not contain the R-1 table" counted as
 * answered: 68 of 68 answered while a real reader could not get setbacks for a week (migration 045).
 * Then `referred` was added for a correct refusal — and immediately ate the one defect it was built
 * to expose (046). Every bucket below exists because folding it into a neighbour hid something.
 *
 *   answered / partial  the documents carried it
 *   referred            the documents did not, and the answer named the government that does.
 *                       A CORRECT outcome. Never a failure, never counted as one.
 *   declined            passages were retrieved and none answered it -> retrieval or chunking,
 *                       OR the municipality genuinely never published it. Both readings are real;
 *                       state the fact, do not assert the cause.
 *   no_corpus           nothing matched at all -> a corpus gap. Go and get the document.
 *   unknown (050)       the model emitted no usable marker. OUR instrumentation failing. It is not
 *                       a success and it is not a village failure; it gets its own bucket because
 *                       folding it either way is how the previous two versions came to lie.
 *   null (pre-045)      no outcome was ever recorded. Counted as unknown, NEVER as answered —
 *                       inventing an outcome for these is precisely what this replaced.
 */

/* Staff and residents type differently, and the shape is the cheapest signal we have about who is
   using this. A resident writes a sentence — "how tall can a fence be?". Staff type keywords —
   "irrigation wells", "what is code 21" — because they are looking for a DOCUMENT, not an answer.
   Not a claim about any individual question; a distribution worth watching. */
export function looksLikeStaff(q) {
  const s = String(q || '').trim();
  const words = s.split(/\s+/).length;
  if (/\?$/.test(s)) return false;
  if (/^(what|how|when|where|who|why|can|is|are|do|does|may|am)\b/i.test(s)) return false;
  return words <= 4;
}

/* declined and no_corpus are the only two anything here calls broken. */
export const FAILURE_OUTCOMES = ['declined', 'no_corpus'];
export const isFailure = (r) => FAILURE_OUTCOMES.includes(r && r.outcome);

const normQuestion = (q) => String(q || '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function emptyBucket() {
  return {
    n: 0, answered: 0, partial: 0, referred: 0, declined: 0, nocorpus: 0,
    nomarker: 0, error: 0, unknown: 0, table: 0, staff: 0,
  };
}

function tally(bucket, r) {
  bucket.n++;
  if (looksLikeStaff(r.question)) bucket.staff++;
  if (r.used_table) bucket.table++;
  switch (r.outcome) {
    case 'answered': bucket.answered++; break;
    case 'partial': bucket.partial++; break;
    case 'referred': bucket.referred++; break;
    case 'unknown': bucket.nomarker++; break;
    case 'declined': bucket.declined++; break;
    case 'no_corpus': bucket.nocorpus++; break;
    case 'error': bucket.error++; break;
    default: bucket.unknown++;
  }
}

/**
 * Roll a set of muni_questions rows into everything any surface reports.
 * Rows are expected already filtered by window / tenant / source — filtering is the caller's
 * job because the caller is the one that knows whether verifier traffic was asked for.
 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = emptyBucket();
  const byTenant = {};

  for (const r of list) {
    tally(total, r);
    tally((byTenant[r.tenant] ||= emptyBucket()), r);
  }

  /* `referred` is deliberately absent from this list. An answer that says "the county treasurer
     issues dog licences, here is the number" is the tool working correctly, and listing it as a
     failure sends the municipality hunting a defect that does not exist — while burying one that
     is real. */
  const failures = list.filter(isFailure).map((r) => ({
    id: r.id,
    tenant: r.tenant,
    question: r.question,
    outcome: r.outcome,
    hit_count: r.hit_count,
    created_at: r.created_at,
    /* ⛔ STATE THE FACT, DO NOT NAME THE CAUSE. This used to read "RETRIEVAL — n passages matched
       and none answered it", which asserts a diagnosis the data cannot support: Bristol's "town
       hall hours" was listed as a retrieval failure and is not one — the Town publishes its counter
       hours nowhere, and the tool answered correctly with the address, the meeting schedule and the
       Clerk's number. Sending somebody to debug ranking for that wastes the trip, which is the same
       failure as calling a good referral a defect. Name both readings; the reader decides. */
    why: r.outcome === 'no_corpus'
      ? 'NOTHING MATCHED — the document is missing from the corpus'
      : `UNANSWERED — ${r.hit_count} passages matched, none carried the answer`
        + ' (retrieval, or the municipality never published it)',
  }));

  const collCounts = {};
  for (const r of list) for (const c of r.cited_collections || []) collCounts[c] = (collCounts[c] || 0) + 1;
  const collections = Object.entries(collCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([collection, n]) => ({ collection, n }));

  /* Asked more than once is the shortlist for whatever the municipality should publish, or for a
     sample chip on the page. It is also how you notice one person retrying a question that keeps
     failing. */
  const seen = {};
  for (const r of list) (seen[normQuestion(r.question)] ||= []).push(r);
  const repeats = Object.entries(seen)
    .filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([question, v]) => ({
      question,
      n: v.length,
      tenants: [...new Set(v.map((x) => x.tenant))],
      outcomes: [...new Set(v.map((x) => x.outcome || 'unknown'))],
    }));

  return {
    total,
    byTenant: Object.entries(byTenant)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([tenant, v]) => ({ tenant, ...v })),
    failures,
    collections,
    repeats,
  };
}

/**
 * Questions per calendar day, oldest first, with empty days present as zeroes.
 * Empty days are the point: a gap is what "nobody used it on Tuesday" looks like, and a series
 * that silently omits them draws a flat busy line over a dead week.
 */
export function dailyCounts(rows, days, endDateIso) {
  const n = Math.max(1, Number(days) || 30);
  const end = endDateIso ? new Date(endDateIso) : new Date();
  const key = (d) => d.toISOString().slice(0, 10);
  const counts = {};
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const k = String(r.created_at || '').slice(0, 10);
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400_000);
    out.push({ date: key(d), n: counts[key(d)] || 0 });
  }
  return out;
}

export const pct = (x, of) => (of ? `${Math.round((x / of) * 100)}%` : '—');
