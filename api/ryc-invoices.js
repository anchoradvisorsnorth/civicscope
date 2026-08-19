// api/ryc-invoices.js — AP invoice register + PM daily reconciliation (RYC Command, 2026-08-11)
//
// WHY THIS IS ITS OWN ENDPOINT
// It is not bolted onto ryc-estimate-log.js for two reasons. (1) This surface carries vendor
// pricing, subcontract values and job cost — a different data class from estimating drafts, and
// it wants its own bounded blast radius. (2) The AP module is separable on purpose: it is the
// natural second module in the dashboard-license conversation and should not be entangled with
// the estimating kernel.
//
// ===== THE SILO =====================================================================
// Per-user authentication does not exist yet (contract §5 defers Entra to ~Sep 2026) and Keith's
// call was not to let that block this. So the PM is siloed by CREDENTIAL rather than by filter:
//
//   THE SERVER DERIVES THE PM FROM THE CREDENTIAL AND NEVER FROM THE REQUEST BODY.
//
// There is deliberately no `pm` parameter a browser can send to widen its own scope. A PM
// credential resolves to exactly one name and every query is bound to it server-side; only an
// explicit admin credential resolves to scope 'all'. That is a real boundary today.
//
// What it is NOT is authentication. A forwarded link is a forwarded credential, and this module
// says so rather than implying otherwise: every approval records identity_verified=false, and the
// fact event carries the reviewer as a CLAIM. When Entra lands, this one function is replaced and
// the existing approval records upgrade — instead of turning out to have been worthless.
// ====================================================================================

import crypto from 'node:crypto';

export const config = { maxDuration: 300 };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Reader kill switch. Authorized by Keith 2026-08-11 ("consider that matter handled"), and
// consistent with RYC CLAUDE.md: the Ask R. Yoder pause is scoped to Ask R. Yoder alone, all
// other Anthropic use remains authorized. Kept as a switch because a capability that reads
// confidential documents should always have one, not because it is expected to be used.
const READ_ENABLED = process.env.RYC_INVOICE_READ_DISABLED !== '1';

// Images: same bounds api/claude.js learned the hard way on 2026-08-02 — one rendered page is
// 70-220KB of base64, so a flat text-shaped cap 413s every real batch.
// Private bucket holding the scanned pages. Never public: these documents carry vendor
// pricing, subcontract values and lien waivers. Reads go out as short-lived signed URLs.
const SCAN_BUCKET = 'ryc-invoice-scans';

const MAX_IMAGES = 16;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/* ===================== credentials ===================================================
   RYC_INVOICE_PMS — JSON: { "<code>": { "pm": "Kenny Frauhiger", "email": "..." }, ... }
   RYC_INVOICE_ADMIN_CODE — front office / Keith; scope 'all'.
   RYC_INVOICE_LINK_SECRET — HMAC key for the emailed one-click links.
   Falls back to the shared gate ONLY for scope 'all', so the module is usable before the
   per-PM codes are provisioned without ever silently granting a PM someone else's queue. */
function pmDirectory() {
  try { return JSON.parse(process.env.RYC_INVOICE_PMS || '{}'); } catch { return {}; }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const b64u = s => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url').toString('utf8');

function signLink(pm, expMs) {
  const secret = process.env.RYC_INVOICE_LINK_SECRET;
  if (!secret) return null;
  const payload = `${pm}|${expMs}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `v1.${b64u(pm)}.${expMs}.${sig}`;
}

function verifyLink(token) {
  const secret = process.env.RYC_INVOICE_LINK_SECRET;
  if (!secret) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  let pm;
  try { pm = unb64u(parts[1]); } catch { return null; }
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp)) return null;
  const expect = crypto.createHmac('sha256', secret).update(`${pm}|${exp}`).digest('base64url');
  if (!safeEqual(parts[3], expect)) return null;      // constant-time; a bad sig is not a hint
  if (Date.now() > exp) return { expired: true };
  return { pm };
}

/* Resolve WHO is asking. Returns { scope:'pm', pm } | { scope:'all' } | null.
   Order matters: a signed link and a PM code both bind to one name; only the admin code and
   the legacy shared gate open scope 'all'. */
function identify(body) {
  if (body.k) {
    const v = verifyLink(body.k);
    if (v && v.expired) return { error: 'This link has expired. Open today\'s email, or sign in with your code.' };
    if (v && v.pm) return { scope: 'pm', pm: v.pm, via: 'link' };
    return { error: 'That link is not valid.' };
  }
  const code = String(body.code || body.pw || '').trim();
  if (!code) return null;

  const admin = process.env.RYC_INVOICE_ADMIN_CODE;
  if (admin && safeEqual(code, admin)) return { scope: 'all', via: 'admin' };

  /* THE FILING WORKER. A machine, not a person — it holds its own token and is confined to the
     two filing actions (see the gate in the handler). It is deliberately NOT scope 'all': the
     filer has no business reading a PM's queue, minting links or closing a batch, and giving a
     long-lived unattended credential front-office scope would be the widest thing in this
     module. Its fact events record actor.type='service', so a filing is never mistaken in the
     audit trail for something a human did. */
  const filer = process.env.RYC_INVOICE_FILER_TOKEN;
  if (filer && safeEqual(code, filer)) {
    return { scope: 'service', service: 'invoice-filer', via: 'service_token' };
  }

  /* THE MAILBOX INGEST. Separate token from the filer on purpose: they run at different times,
     touch different things, and a single "service" credential that could both intake and file
     would be the widest key in the module. Each is confined to its own action set below. */
  const ingest = process.env.RYC_INVOICE_INGEST_TOKEN;
  if (ingest && safeEqual(code, ingest)) {
    return { scope: 'service', service: 'invoice-ingest', via: 'service_token' };
  }

  const dir = pmDirectory();
  for (const [c, rec] of Object.entries(dir)) {
    if (safeEqual(code, c) && rec && rec.pm) return { scope: 'pm', pm: rec.pm, via: 'code' };
  }
  // Shared workspace gate → front-office scope only. It can never resolve to a PM identity,
  // so it cannot be used to impersonate one.
  const gate = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';
  if (safeEqual(code, gate)) return { scope: 'all', via: 'shared_gate' };
  return { error: 'Unauthorized' };
}

/* ===================== supabase ==================================================== */
const sb = (path, opts) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...opts,
  headers: {
    'Content-Type': 'application/json',
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    ...(opts && opts.headers),
  },
});

// Same error contract as the estimating kernel, extended with this module's two codes.
const RPC_STATUS = {
  RY404: 404, RY409: 409, RY400: 400,
  RY40G: 409,   // invalid state transition / approval precondition
  RY40H: 409,   // coded lines do not foot to the invoice total
};

async function rpc(fn, args) {
  const r = await sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = { message: txt }; }
  if (!r.ok) {
    const code = body && body.code;
    return { status: RPC_STATUS[code] || r.status, body: { error: (body && body.message) || String(txt).slice(0, 300) } };
  }
  return { status: 200, body };
}

const reqId = (body) => String(body.request_id || '').slice(0, 80)
  || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(36).slice(2)}`);

// The actor recorded on every fact event. `shared_gate` stays honest about what the credential
// actually proves; the display name is what the reviewer CLAIMED to be.
const actorFor = (who) => (who.scope === 'service'
  ? { type: 'service', service_id: who.service, display: who.service,
      capability: 'invoice_file', channel: 'service' }
  : {
      type: 'shared_gate',
      display: who.scope === 'pm' ? who.pm : 'front office',
      capability: who.scope === 'pm' ? 'invoice_review' : 'invoice_admin',
      channel: 'command',
    });

/* ===================== the reader ==================================================
   Extracts the register fields off scanned pages. Anthropic only and NOT through
   api/claude.js: that proxy is a deliberate open passthrough for the public estimators and
   can fall back to a second provider — correct for marketing tools, wrong for AP documents.
   Nothing here logs the images, the prompt or the reply. */
const READER_SYSTEM = `You are reading scanned accounts-payable documents for a general contractor.

Return ONE JSON object: { "documents": [ ... ] }. Nothing else — no prose, no code fence.

A DOCUMENT IS NOT A PAGE. Group consecutive pages that belong to one invoice into one entry
(a 5-page invoice with the same invoice number is ONE document spanning those pages).

Each document:
{
  "page_from": <1-based page in this batch>,
  "page_to": <1-based>,
  "page_label_of": <total pages the document says it has, e.g. 2 from "Page 1 of 2"; else null>,
  "doc_type": "invoice" | "credit_memo" | "pay_application" | "lien_waiver" | "statement" | "receipt" | "packing_slip" | "unknown",
  "vendor_name": <who is billing US>,
  "invoice_no": <as printed>,
  "invoice_date": "YYYY-MM-DD" | null,
  "received_stamp": <the date in the RECEIVED stamp the office inks onto the paper, "YYYY-MM-DD"; null if there is no stamp or it is not legible>,
  "amount": <number; NEGATIVE for a credit memo>,
  "terms": <e.g. "Net 30"> | null,
  "due_date": "YYYY-MM-DD" | null,
  "discount_amount": <number> | null,
  "discount_by": "YYYY-MM-DD" | null,
  "job_text": <the job/project EXACTLY as the vendor printed it — do not normalise or correct it>,
  "vendor_marked_dup": <true if the page carries DUPLICATE / REPRINT / COPY as a document marker>,
  "multi_job": <true if this one document bills more than one job/site>,
  "job_splits": [ { "job_text": ..., "amount": <number> } ],
  "notes": <anything a reviewer should see: overbilling summary, missing pages, hand-written marks>
}

RULES
- Copy what is printed. Never infer, correct or normalise a vendor's job name — four spellings
  of one job is a fact the register needs to see.
- received_stamp is the RUBBER STAMP, usually blue or red and often rotated, reading RECEIVED with
  a date (e.g. "RECEIVED AUG 10 2026"). It is NOT the invoice date, the due date, the service
  date, or any date the vendor printed. Only read it off an actual stamp; null if there is none.
- A credit memo / "Jobsite Pickup Request" with parenthesised figures is NEGATIVE.
- A customer-copy credit-card slip is "receipt" — it is already paid, not a payable.
- Set vendor_marked_dup only for a DOCUMENT marker, never for the word appearing in line items.
- amount is the document's grand total, not a subtotal or a page continuation.
- If a field is not legible or not present, use null. Do not guess.`;

async function readPages(images) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: 503, body: { error: 'Reader is not configured.' } };

  const content = images.map(im => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data },
  }));
  content.push({ type: 'text', text: `These are pages 1..${images.length} of one intake batch, in order. Return the documents JSON.` });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      temperature: 0,
      system: READER_SYSTEM,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!r.ok) return { status: 502, body: { error: `Reader returned ${r.status}.` } };   // status only
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  // Same hardening the estimators needed: strict parse, then outermost {...}, so occasional
  // model prose does not 500 the whole batch.
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a > -1 && b > a) { try { parsed = JSON.parse(text.slice(a, b + 1)); } catch {} }
  }
  if (!parsed || !Array.isArray(parsed.documents)) {
    return { status: 502, body: { error: 'Reader returned an unusable response.' } };
  }
  return { status: 200, body: { documents: parsed.documents } };
}

/* ===================== THE RECONCILER =============================================
   Keith, 2026-08-19: "The front office does not want to manually reconcile the batch — they
   just want the files, similar to how when I ask you to do a batch here on the backend."

   ⛔ THAT IS NOT THE SAME THING AS FILING WHAT THE READER PROPOSED, and the measured record is
   unambiguous about it. Across four real batches the reader has invented a $4,444.75 payable out
   of a contract billed-to-date line, split one invoice into a $0.00 document and a $1,917.30 one,
   filed a $63,450.50 pay application beside its own lien waiver as two payables, read one $43,875
   payable as three, and — on 2026-08-17 — proposed 41 documents where 29 was the truth, a
   $994,689.84 gap that included a $130,575.60 pay application the office had already superseded
   IN ITS OWN HANDWRITING. Run unattended without this pass, the tool files that.

   So the confirm step does not disappear; it stops being the front office's job. This is the
   reading-and-merging that was being done on the confirm screen, done here instead, in the one
   place that can see the WHOLE batch at once. It never invents a document and never drops a page:
   its only output is a MERGE PLAN — which proposed documents are really one document — and every
   page in a merged group stays in the filed PDF, in order.

   WHY THE READER CANNOT DO THIS ITSELF: it reads a sliding window, so it can never see that p45
   carries the office's "See revised" sticky note about p41, or that the same Alpha invoice was
   photocopied twice sixty pages apart. Those are whole-batch facts. */
const RECONCILE_SYSTEM = `You are the second pass over a scanned accounts-payable batch for a
general contractor. A first pass read the pages through a sliding window and proposed where each
document starts and ends. It sees a few pages at a time; you see the whole batch at once.

Your ONLY job is to decide which proposed documents are really ONE payable.

Return ONE JSON object, nothing else, no prose, no code fence:
{ "merges": [ { "keep": <idx>, "absorb": [<idx>, ...], "reason": "<short, concrete>",
                "confidence": "high" | "low" } ] }

- Indices are the "idx" values given to you. Every index appears at most once across the whole
  plan, in exactly one group, as either a keep or an absorb.
- "keep" is the document whose VENDOR, AMOUNT and INVOICE NUMBER are correct for the combined
  payable — the bill itself, not its cover sheet, waiver, or superseded copy.
- A group must be CONTIGUOUS in page order unless you are merging duplicate copies of one document
  that were scanned apart; say so in the reason when they are not adjacent.
- Return an empty "merges" array if every proposed document is genuinely its own payable.

MERGE these — each one has actually happened in this archive:
1. A CONTINUATION. "Page 1 of 5" on the first page and the total landing pages later; every total
   line reading "Continued". One invoice, one payable.
2. A NULL OR ZERO AMOUNT next to a priced document of the same vendor. A document the reader could
   not price is almost always a continuation page of the one before it. Keep the priced one.
3. A SUPPORTING-DETAIL page read as its own document. An "Invoice Supporting Detail" or an Invoice
   Summary table whose figure is the contract BILLED-TO-DATE, not a bill. Keep the invoice.
4. A PAY APPLICATION PACKAGE. A pay application, its own invoice and/or its lien waiver, same
   vendor, same amount, same batch. ONE payable. Keep the invoice if there is one, else the pay
   application. (A LONE pay application with no matching invoice is itself the bill — do not merge
   it into anything.)
5. A LIEN WAIVER, PACKING SLIP, STATEMENT, DELIVERY TICKET or REMITTANCE STUB stapled to the
   invoice it belongs to. Never a payable on its own. Keep the invoice.
6. A SUPERSEDED REVISION. Two pay applications or invoices for the same contract and period at
   different amounts, where a note, sticky or handwriting says "revised", "see revised", "void"
   or similar. Keep the CURRENT one; the superseded copy is filed behind it.
7. A DUPLICATE COPY inside this same batch — same vendor, same invoice number, same amount, same
   date, photocopied twice. Keep the first.

DO NOT MERGE:
- Two different invoices from one vendor that carry DIFFERENT invoice numbers and are both real
  bills, however similar the amounts.
- A credit memo into the invoice it credits. It is its own document and its amount is negative.
- Anything you are merging only because it "looks related". If you cannot name the concrete
  evidence on the page, leave it alone — a wrongly merged payable is money that never gets paid.

Set "confidence":"low" whenever the evidence is a resemblance rather than something printed
(a matching amount with no matching invoice number, an inferred continuation with no "Page N of M",
a suspected revision with no note saying so). Low-confidence groups get looked at again with the
actual page images before anything is filed, so marking one costs nothing and guessing costs
money.`;

const ADJUDICATE_SYSTEM = `You are settling ONE question about a scanned accounts-payable batch,
with the actual page images in front of you: are these pages ONE payable document, or more than
one?

A first pass proposed boundaries from a sliding window and a second pass suspected they are one
document but could not prove it from the extracted fields alone. You can see the pages. Decide.

Return ONE JSON object, nothing else, no prose, no code fence:
{ "one_document": true | false,
  "keep": <the idx whose vendor/amount/invoice number is correct for the combined payable>,
  "amount": <the combined payable's grand total as a number, or null if you cannot read it>,
  "invoice_no": <as printed, or null>,
  "vendor_name": <as printed, or null>,
  "received_stamp": "YYYY-MM-DD" | null,
  "reason": "<what is printed on the page that settles it>" }

Decide from what is PRINTED: a "Page 1 of N" label, a total line reading "Continued", a running
invoice number across pages, a lien waiver or pay application naming the same amount, a handwritten
"see revised", a DUPLICATE stamp. If nothing on the pages settles it, answer false — two payables
that should have been one is a visible duplicate on a PM's desk, while one payable that should have
been two is a bill that silently never gets paid.`;

async function claudeJson(system, content, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: 503, body: { error: 'Reader is not configured.' } };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens, temperature: 0,
      system, messages: [{ role: 'user', content }],
    }),
  });
  if (!r.ok) return { status: 502, body: { error: `Reader returned ${r.status}.` } };
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a > -1 && b > a) { try { parsed = JSON.parse(text.slice(a, b + 1)); } catch { /* below */ } }
  }
  if (!parsed) return { status: 502, body: { error: 'Reader returned an unusable response.' } };
  return { status: 200, body: parsed };
}

/* THE RECONCILER SEES FIELDS, NOT IMAGES — on purpose. 129 pages is past the per-request image
   limit, and every merge rule above is decidable from what the reader already extracted plus its
   notes. The cases that genuinely need eyes are the ones it marks `low`, and those go to
   `adjudicate` with just their own pages. */
async function reconcileBatch(documents) {
  const compact = documents.map((d, i) => ({
    idx: i,
    pages: d.page_from === d.page_to ? `p${d.page_from}` : `p${d.page_from}-${d.page_to}`,
    doc_type: d.doc_type || 'unknown',
    vendor: d.vendor_canonical || d.vendor_name || null,
    invoice_no: d.invoice_no || null,
    amount: (d.amount === null || d.amount === undefined || d.amount === '') ? null : Number(d.amount),
    invoice_date: d.invoice_date || null,
    received_stamp: d.received_stamp || null,
    page_label_of: d.page_label_of || null,
    job_text: d.job_text || null,
    notes: d.notes || null,
  }));
  const out = await claudeJson(RECONCILE_SYSTEM, [{
    type: 'text',
    text: `The batch has ${documents.length} proposed documents, in page order:\n`
      + `${JSON.stringify(compact, null, 1)}\n\nReturn the merge plan JSON.`,
  }], 8000);
  if (out.status !== 200) return out;
  if (!Array.isArray(out.body.merges)) {
    return { status: 502, body: { error: 'Reconciler returned an unusable response.' } };
  }
  return { status: 200, body: { merges: out.body.merges } };
}

async function adjudicateGroup(images, docs) {
  const content = images.map(im => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data },
  }));
  content.push({
    type: 'text',
    text: `The images above are the pages of this candidate group, in order.\n`
      + `The first pass read them as these separate documents:\n${JSON.stringify(docs, null, 1)}\n\n`
      + 'Return the ruling JSON.',
  });
  const out = await claudeJson(ADJUDICATE_SYSTEM, content, 1500);
  if (out.status !== 200) return out;
  if (typeof out.body.one_document !== 'boolean') {
    return { status: 502, body: { error: 'Adjudicator returned an unusable response.' } };
  }
  return { status: 200, body: out.body };
}

/* THE COVERAGE RULE, EXPRESSED ONCE. `batch_confirm` (a person) and `batch_autoconfirm` (the
   reconciler) must enforce IDENTICALLY — a page claimed twice is a payable filed twice, and a page
   claimed by nothing is a payable that vanishes between the scanner and the archive, undetectable
   afterwards because the batch PDF is deleted. This module has already been bitten three times by
   one rule written in two places (the PM-desk precedence, twice, and then again inside the test
   meant to guard it). Both callers call this; neither restates it. */
function validateManifest(manifest, pageCount) {
  const seen = new Set();
  for (const d of manifest) {
    const a = parseInt(d.page_from, 10), b = parseInt(d.page_to, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a) {
      return `Bad page range: ${JSON.stringify(d.page_from)}-${JSON.stringify(d.page_to)}.`;
    }
    if (pageCount && b > pageCount) return `Page ${b} is past the end of a ${pageCount}-page scan.`;
    for (let p = a; p <= b; p++) {
      if (seen.has(p)) return `Page ${p} is claimed by two documents.`;
      seen.add(p);
    }
    if (!String(d.vendor_canonical || d.vendor_name || '').trim()) {
      return `A document covering p${a}-${b} has no vendor name.`;
    }
    /* `Number(null)` is 0 and `Number.isFinite(0)` is true, so a null amount used to sail through
       and file as `Vendor  0.00  date.pdf` — a payable-shaped file for a document the reader could
       not read at all. Caught on the first real batch: p17 came back `unknown` with a null amount,
       and it is a continuation page that belongs merged into p16. Require the number. */
    if (d.amount === null || d.amount === undefined || d.amount === ''
        || !Number.isFinite(Number(d.amount))) {
      return `The document on p${a}-${b} has no amount — merge it into the document it continues, `
        + 'or give it one.';
    }
  }
  if (pageCount) {
    const missing = [];
    for (let p = 1; p <= pageCount; p++) if (!seen.has(p)) missing.push(p);
    if (missing.length) return `Pages claimed by no document: ${missing.join(', ')}.`;
  }
  return null;
}

/* ===================== STAGING: READ THE JOB OFF THE INVOICE =======================
   Keith, 2026-08-13: "the way the system will know is reading the invoice and looking for the
   job name" — and "job name tells you who the PM is".

   So the primary signal is `job_text`: what the VENDOR PRINTED. Measured on the first real
   mailbox pull, 9 of 13 invoices carry one. Vendor billing history is a fallback, not the
   method — a vendor who has always billed one job can bill a new one tomorrow, and treating
   history as truth would confidently misfile exactly the invoices nobody re-checks.

   ⛔ IT REFUSES RATHER THAN GUESSES — but refusing something obvious is its own failure.
   The first cut required 2+ distinctive words and a clear winner, which was too blunt in both
   directions and left every one of the first 16 real emailed invoices unplaced. What it
   actually got wrong (measured against the live 53-job feed, 2026-08-13):

     · "WAKARUSA" was refused for matching one word — but exactly ONE job in the feed carries
       that word. A word that belongs to a single job IS a clear winner; the reason the old
       rule looked safe is that it was written against a hypothetical feed with three Wakarusa
       jobs in it, not the one RYC has.
     · "Ashley WWTP" and "helix orchard" both matched two words cleanly. Nothing ran.
     · "Shipshe Waste Water" — the vendor's own abbreviation for Shipshewana — scored zero,
       because tokens were compared only for equality.
     · Digits were thrown away, and 24 of the 53 active jobs are Greencroft units distinguished
       by NOTHING BUT their number ("Greencroft 2026 WPC" vs "Greencroft 2021 WPC").
     · A printed JOB NUMBER — the least ambiguous signal there is — was not looked at at all.

   So the rule is now about DISTINCTIVENESS rather than word count. A word unique to one job is
   evidence; a word twenty jobs share is not, however many of them you stack up. The traps that
   motivated the old rule still refuse, and there is a regression sweep proving it:
   "South Bend" → too weak (this is the Monreaux trap), "WWTP" / "PHM" / "Greencroft WPC" →
   shared words only, and every one of the 53 job names resolves to its own job. */
const JOB_FILLER = new Set(['the','of','and','a','an','at','in','on','for','llc','inc','co',
  'corp','project','projects','phase','rebid','bid','new','addition','renovation','reno',
  'improvements','improvement','building','bldg','construction','center','centre','north',
  'south','east','west','no','site','work','works','replacement','upgrade','upgrades',
  'remodel','expansion','town','city','county','school','corporation','unit']);
/* Numbers are KEPT — see the Greencroft note above. */
const jobTokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/).filter(w => w.length > 2 && !JOB_FILLER.has(w)));
const jobNoKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const MIN_LONE = 6;      // a lone matching word must be long enough to not be a coincidence
const PREFIX_MIN = 5;    // "Shipshe" is an abbreviation; "New" is not
const PREFIX_RATIO = 0.6;

/* Which jobs own each word. A word owned by exactly one job is what "distinctive" means here —
   measured against the feed RYC actually has, not assumed. */
function tokenIndex(jobs) {
  const idx = new Map();
  for (const j of jobs) for (const t of jobTokens(j.name)) {
    if (!idx.has(t)) idx.set(t, new Set());
    idx.get(t).add(j.no);
  }
  return idx;
}

/* An invoice writes "Shipshe" for Shipshewana. A real abbreviation keeps most of the word,
   which is exactly what separates it from a coincidental compound: "waste" is a 50% prefix of
   "wastewater" and means something else entirely. */
function matchedTokens(want, have) {
  const hits = [];
  for (const w of want) {
    if (have.has(w)) { hits.push(w); continue; }
    for (const h of have) {
      const [short, long] = w.length <= h.length ? [w, h] : [h, w];
      if (short.length < PREFIX_MIN) continue;
      if (!long.startsWith(short)) continue;
      if (short.length / long.length < PREFIX_RATIO) continue;
      hits.push(h); break;
    }
  }
  return hits;
}

/* job_text -> a job, or null WITH A REASON. The reason is not decoration: "nothing was printed"
   and "two jobs match equally" call for completely different actions from the front office. */
function matchJob(jobText, jobs, idx, numberOnly) {
  const raw = String(jobText || '');

  /* A PRINTED JOB NUMBER beats every heuristic — it is the thing itself, not a resemblance.
     Candidates are checked against the feed's OWN numbers rather than a guessed pattern, so a
     ZIP code or a vendor's order number cannot short-circuit the name match below.

     `numberOnly` carries jobs that exist in Foundation but NOT in the active Procore feed — 46 of
     them. They are reachable by an EXACTLY PRINTED NUMBER and by nothing else, deliberately: an
     invoice printing "26X004" is unambiguous evidence, whereas letting those names into the token
     matcher would put "TEST JOB - Project HQ", "Nate Yoder Driveway" and
     "Brad - Misc Work at Residence" into the candidate pool — and an Alpha invoice whose job field
     reads "Brad Yoder" would match the last of those confidently and wrongly. */
  const byNo = new Map([...(numberOnly || []), ...jobs].map(j => [jobNoKey(j.no), j]));
  let orphanNo = null;
  for (const w of (raw.toUpperCase().match(/[A-Z0-9][A-Z0-9-]{3,}/g) || [])) {
    const k = jobNoKey(w);
    if (k.length < 5) continue;
    const hit = byNo.get(k);
    if (hit) return { job: hit, hits: [w], conf: 0.95, why: `job number ${hit.no} is printed on the invoice` };
    if (/[A-Z]/.test(k) && /[0-9]/.test(k)) orphanNo = orphanNo || w;   // job-number SHAPE, unknown
  }
  const noJob = (why) => ({ job: null, why: orphanNo
    ? `the invoice prints job ${orphanNo}, which is not in the Procore feed` : why });

  const want = jobTokens(raw);
  if (!want.size) return noJob('nothing distinctive printed');

  const scored = [];
  for (const j of jobs) {
    const hits = matchedTokens(want, jobTokens(j.name));
    if (!hits.length) continue;
    let distinct = 0, longest = 0;
    for (const h of hits) {
      const owners = idx.get(h);
      if (owners && owners.size === 1) { distinct++; longest = Math.max(longest, h.length); }
    }
    scored.push({ job: j, hits, distinct, longest, total: hits.length });
  }
  if (!scored.length) return noJob('no job resembles what the invoice printed');

  scored.sort((a, b) => (b.distinct - a.distinct) || (b.total - a.total) || (b.longest - a.longest));
  const best = scored[0], next = scored[1] || null;
  const same = (s) => s.distinct === best.distinct && s.total === best.total && s.longest === best.longest;
  const say = (h) => `"${h}"`;

  if (best.distinct > 0) {
    if (next && same(next)) {
      return { job: null, why: `${scored.filter(same).length} jobs match ${best.hits.map(say).join(' + ')} equally well` };
    }
    if (best.total === 1 && best.longest < MIN_LONE) {
      return { job: null, why: `only the short word ${say(best.hits[0])} matched "${best.job.name}" — too weak to place` };
    }
    return { job: best.job, hits: best.hits,
      conf: best.distinct >= 2 ? 0.90 : (best.total >= 2 ? 0.80 : 0.65),
      why: `matched ${best.hits.map(say).join(' + ')} to ${best.job.name}` };
  }

  /* No word is unique to one job — but one job can still win outright on how much of what the
     invoice printed it accounts for. This is the Greencroft case: every word is shared and only
     the combination identifies the unit. */
  if (best.total >= 2 && (!next || next.total < best.total)) {
    return { job: best.job, hits: best.hits, conf: 0.70,
      why: `matched ${best.hits.map(say).join(' + ')} to ${best.job.name}` };
  }
  return { job: null, why: `only shared words matched (${best.hits.map(say).join(', ')}) — too weak to place` };
}

/* ===== WHOSE DESK — THE ONE EXPRESSION OF THE RULE ON THIS SIDE ======================
   Lifted out of `jobDirectory()` and made module-level 2026-08-13 for one reason: the harness
   that is supposed to protect this rule had **re-implemented it** (`procorePm || foundationPm`,
   the pre-reversal order) instead of calling it, so it asserted its own copy and passed 85/85
   both before and after the rule was reversed. A test that re-derives the thing it guards
   guards nothing.

   MUST STAY IDENTICAL TO `ryc-command/core.js` → `pmName()`:
       (job.foundation && job.foundation.pmName) || (job.pm && job.pm.name) || null
   Foundation is the desk of record (`ryc_foundation_latest.pmName`, the Supabase table Command
   reads); Procore fills the blanks. `scripts/verify-ryc-invoice-matcher.mjs` asserts both halves
   of that sentence — that this function agrees with Command's rule on every job, and that
   Command's rule still reads the way this comment says it does. */
function resolveJobPm(procorePm, foundationPm) {
  return foundationPm || procorePm || null;
}
function resolveJobPmSource(procorePm, foundationPm) {
  return foundationPm ? 'foundation' : (procorePm ? 'procore' : null);
}

/* ===== ONE PAYABLE, NOT THREE — THE SUPPORTING-DOCUMENT SPLIT ========================
   ⛔ FOUND 2026-08-13. HRP Construction arrived on 2402GP09 as THREE rows of $145,300.60 on Ken
   Wright's desk — same batch, same vendor, same amount, same date, differing only by `doc_type`:
   `invoice`, `pay_application`, `lien_waiver`. It is ONE payable that arrived as a package, and
   the register turned each document in the package into money someone could approve. The desk
   overstated by $290,601.20. The same shape had already been caught by hand that morning on a
   M. W. Chupp pay-application package, so it is a class, not an incident.

   `doc_type` was being read correctly by the reader all along and NOTHING CONSUMED IT.

   TWO RULES, and the line between them is "certain" vs "inferred":
     · NEVER_PAYABLE — true by what the document IS, regardless of anything else in the batch.
     · the pay-application pair — an invoice and a pay application from the same vendor for the
       same amount in the same batch are one payable billed twice over. A G702 IS the billing
       document on a subcontract, so a LONE pay_application stays payable; it is only supporting
       when the invoice it restates is sitting next to it.

   ⚠ NOTHING IS DROPPED, EVER. A supporting document is still registered, still stored, still
   filed with the job — it is marked `not_ap` with the reason, which is a state a human can
   reverse from the desk. A dropped payable is invisible; a duplicate is merely wrong on a screen.
   Anything not covered here — `unknown` included — stays payable and goes to a person. */
const NEVER_PAYABLE = {
  lien_waiver:  'a lien waiver is a release against payment, not a bill',
  packing_slip: 'a packing slip is a delivery record, not a bill',
  receipt:      'a receipt is proof of a payment already made',
};

/* ⛔ `statement` WAS IN THE LIST ABOVE AND HAD TO COME OUT (2026-08-14). It looked obviously
   right — a vendor statement summarises invoices already registered, so paying it pays them
   twice. Then the 2026-08-13 PM paper batch produced a **NIPSCO utility bill**, which the reader
   correctly typed `statement` (the document says "Statement Date" and nothing else), carrying
   "Current Charges Due by 08/28/2026 $1,978.50" with the prior balance already paid off. **For a
   utility the statement IS the bill** — there is no other invoice, and demoting it would have
   dropped a real $1,978.50 payable out of sight.
   So `statement` is now conditional in exactly the way `pay_application` already was: supporting
   ONLY when the same vendor's invoice is sitting in the same batch. A lone statement stays
   payable and goes to a person. Same principle both times — a document type alone is not enough
   to prove something is not a bill; the batch has to show you the bill it duplicates. */
const PAIRED_ONLY = {
  pay_application: 'the same vendor\'s invoice for this exact amount is in this batch — one payable, billed twice',
  statement:       'the same vendor\'s invoice for this exact amount is in this batch — a statement of it, not a second bill',
};

/* Vendor names arrive as printed: "HRP Construction" and "HRP Construction Inc." are one vendor.
   Deliberately blunt — this only has to hold WITHIN one batch, where the alternative to a match
   is leaving a known duplicate on a desk. */
function vendorKey(name) {
  return String(name || '').toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|company|incorporated)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const amountKey = (a) => (Number.isFinite(Number(a)) ? Math.round(Number(a) * 100) : null);

/* Pure. Takes the batch's rows, returns only those that should NOT stand as payables.
   No I/O, so scripts/verify-ryc-invoice-matcher.mjs asserts it directly. */
function supportingDocuments(rows) {
  const out = [];
  const invoiceKeys = new Set();
  for (const r of rows) {
    if (r.doc_type === 'invoice') {
      const ak = amountKey(r.amount);
      if (ak !== null) invoiceKeys.add(`${vendorKey(r.vendor_name)}|${ak}`);
    }
  }
  for (const r of rows) {
    if (NEVER_PAYABLE[r.doc_type]) {
      out.push({ id: r.id, version: r.version, doc_type: r.doc_type, reason: NEVER_PAYABLE[r.doc_type] });
      continue;
    }
    if (PAIRED_ONLY[r.doc_type]) {
      const ak = amountKey(r.amount);
      if (ak !== null && invoiceKeys.has(`${vendorKey(r.vendor_name)}|${ak}`)) {
        out.push({ id: r.id, version: r.version, doc_type: r.doc_type,
          reason: PAIRED_ONLY[r.doc_type] });
      }
    }
  }
  return out;
}

/* Exported for the regression harness (scripts/verify-ryc-invoice-matcher.mjs). Not a route.
   The matcher, the desk rule and the payable classifier are the pieces of this module with real
   logic and no I/O, so they are the pieces that can be tested exhaustively without touching
   production. */
export const __matcher = { matchJob, tokenIndex, jobTokens, jobNoKey };
export const __pm = { resolveJobPm, resolveJobPmSource };
export const __payable = { supportingDocuments, vendorKey, NEVER_PAYABLE };
/* The batch coverage rule. `batch_confirm` (a person confirmed these boundaries) and
   `batch_autoconfirm` (the reconciler resolved them) both call this ONE function, so the machine
   route can never reach SharePoint through a laxer door than the human one. Exported so the gate
   asserts the rule itself rather than a copy of it — this module has been bitten three times by one
   rule written twice, once inside the test meant to catch it. */
export const __manifest = { validateManifest };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Server misconfigured' });

  const body = req.body || {};
  const who = identify(body);
  if (!who) return res.status(401).json({ error: 'Unauthorized' });
  if (who.error) return res.status(401).json({ error: who.error });

  const action = String(body.action || '');
  const actor = actorFor(who);
  const rid = reqId(body);

  // A PM may only ever act within their own name. This is the one line that makes the module
  // a silo rather than a filter — everything downstream reads `pm`, never body.pm.
  const pm = (who.scope === 'pm') ? who.pm
    : (who.scope === 'service') ? null
    : (body.pm ? String(body.pm).slice(0, 120) : null);

  /* Two-way gate, now per SERVICE. Each machine credential may call exactly its own actions and
     nothing else, and the filing actions remain unreachable from any browser credential — a page
     must never be able to assert that a document was filed. */
  const SERVICE_ACTIONS = {
    /* The batch worker is the FILER because it ends in the same place: a delegated SharePoint
       upload. It is NOT given `register` or `open_batch` — a paper batch was worked on paper and
       never enters the register, which is the whole distinction between this and
       file_approved_invoices.py.
       `read` is granted here rather than handing the worker the INGEST token as well. Both routes
       let it OCR a page; only one of them also lets it write invoices into the register. The
       narrower grant is the one that cannot create a payable. */
    'invoice-filer': new Set(['filing_queue', 'mark_filed', 'read',
      'reconcile', 'adjudicate', 'batch_autoconfirm',
      'batch_claim', 'batch_progress']),
    'invoice-ingest': new Set(['open_batch', 'read', 'register']),
  };
  /* ⚠ THESE TWO SETS ARE DIFFERENT QUESTIONS AND MUST NOT BE DERIVED FROM EACH OTHER.
     SERVICE_ACTIONS answers "may this machine call it"; MACHINE_ONLY answers "is a browser
     forbidden". FILING_ACTIONS used to be an alias of the filer's allowlist, which coupled them:
     granting the batch worker `read` would silently have BANNED THE BROWSER from `read` and
     broken Inbound's intake — caught in this feature's own end-to-end test, one deploy before it
     would have shipped. A page must never be able to assert that a document was filed; a page
     must still be able to read a page image. */
  const MACHINE_ONLY = new Set(['filing_queue', 'mark_filed', 'batch_claim', 'batch_progress',
    /* A browser must not be able to skip the confirm screen by posting the reconciler's action —
       `batch_confirm` is the front office's route and it is the one that says a PERSON approved
       these boundaries. `reconcile` and `adjudicate` are deliberately NOT here: they only read and
       propose, exactly like `read`, and the page is free to use them. */
    'batch_autoconfirm']);
  if (who.scope === 'service') {
    const allowed = SERVICE_ACTIONS[who.service] || new Set();
    if (!allowed.has(action)) {
      return res.status(403).json({ error: `The ${who.service} service may not call this action.` });
    }
  }
  if (MACHINE_ONLY.has(action) && who.scope !== 'service') {
    return res.status(403).json({ error: 'That action requires a service token.' });
  }
  // The intake pipeline is front office OR the ingest service — nothing else.
  const canIntake = who.scope === 'all'
    || (who.scope === 'service' && who.service === 'invoice-ingest');

  /* The READER is a narrower question than "may you run intake", and it needs its own answer.
     `read` turns page images into proposed fields; it writes no invoice and creates no payable.
     The front office uses it from Inbound and the batch worker uses it from the VM.
     Deliberately NOT `who.service === 'invoice-ingest' || who.service === 'invoice-filer'` —
     SERVICE_ACTIONS above already decides which machines may call `read`, and naming them again
     here is a second copy of one rule that can drift from the first. It already did: adding the
     batch worker to the allowlist left this gate still saying "ingest only", so the worker was
     authorised and refused in the same request. */
  const canRead = who.scope === 'all' || who.scope === 'service';

  try {
    /* ---------- who am I (the page boots from this) ---------- */
    if (action === 'whoami') {
      return res.status(200).json({
        ok: true, scope: who.scope, pm: who.scope === 'pm' ? who.pm : null,
        via: who.via, identity_verified: false,
        readerEnabled: READ_ENABLED,
        pms: who.scope === 'all'
          ? [...new Set(Object.values(pmDirectory()).map(r => r && r.pm).filter(Boolean))]
          : [],
      });
    }

    /* ---------- RYC's own cost-code vocabulary (served, never shipped) ----------
       280 codes / 29 divisions, from RYC's Estimate Spreadsheet. Deliberately not a static
       asset: this repo is PUBLIC, and RYC's internal cost vocabulary does not belong in a
       public git history. Serving it also lets RYC maintain the list without a deploy. */
    if (action === 'cost_codes') {
      const r = await sb('ryc_cost_codes?company_id=eq.ryc&active=is.true'
        + '&select=code,division,division_name,description&order=code.asc');
      if (!r.ok) return res.status(502).json({ error: `Cost codes unavailable (${r.status}).` });
      return res.status(200).json({ ok: true, codes: await r.json() });
    }

    /* ---------- the scan itself ------------------------------------------------
       Returns SHORT-LIVED SIGNED URLs for the pages of one document, so clicking View opens
       the actual invoice in the browser's own image viewer.

       The bucket is PRIVATE and these are RYC financial documents — vendor pricing, subcontract
       values, a notarized lien waiver. So the bytes are never public and never proxied through
       a guessable path: the caller must already hold a valid credential to get a URL at all,
       and the URL expires. `document_uri` on the batch carries a `storage:<bucket>/<prefix>`
       marker rather than a link, so a batch whose scans live somewhere else (SharePoint, Drive)
       can still carry a plain URL and this action simply declines. */
    if (action === 'pages') {
      const r = await sb(`ryc_invoices?id=eq.${encodeURIComponent(String(body.id || ''))}`
        + `&company_id=eq.ryc&select=page_from,page_to,batch_id,assigned_pm`);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the document.' });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Document not found.' });
      const inv = rows[0];
      // A PM may only open scans from their own queue.
      if (who.scope === 'pm' && inv.assigned_pm !== who.pm) {
        return res.status(404).json({ error: 'Document not found.' });
      }
      const br = await sb(`ryc_invoice_batches?id=eq.${inv.batch_id}&select=document_uri`);
      const batch = br.ok ? (await br.json())[0] : null;
      const uri = batch && batch.document_uri;
      const m = /^storage:([^/]+)\/(.+)$/.exec(uri || '');
      if (!m) {
        return res.status(200).json({ ok: true, stored: false, uri: uri || null,
          note: 'This batch has no stored scan; its document_uri is a plain link.' });
      }
      const [, bucket, prefix] = m;
      const from = inv.page_from || 1, to = inv.page_to || inv.page_from || 1;
      const paths = [];
      for (let p = from; p <= to; p++) paths.push(`${prefix}/p${String(p).padStart(2, '0')}.jpg`);

      const sign = await fetch(`${SB_URL}/storage/v1/object/sign/${bucket}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        body: JSON.stringify({ expiresIn: 900, paths }),   // 15 minutes
      });
      if (!sign.ok) return res.status(502).json({ error: `Could not sign the scan (${sign.status}).` });
      const signed = await sign.json();
      const pages = (Array.isArray(signed) ? signed : []).map((s, i) => ({
        page: from + i,
        url: s.signedURL ? `${SB_URL}/storage/v1${s.signedURL}` : null,
        error: s.error || null,
      })).filter(p => p.url);
      return res.status(200).json({ ok: true, stored: true, pages });
    }

    /* ===== WHO OWNS A JOB — ONE RULE, AND IT IS COMMAND'S =============================
       ⛔ SETTLED 2026-08-13 (third pass). Keith, on new Wakarusa invoices landing on Logan Moore
       again: *"I know that COMMAND WAS BUILT ON PROCORE PROJECT MANAGER — WE SHOULD BE USING THE
       SAME TABLE IN SUPABASE FOR SOMETHING LIKE THIS."*

       The instruction is right and the premise it rests on is not, so both are recorded. **Command
       does not read Procore's project manager.** It has exactly ONE PM derivation —
       `ryc-command/core.js:49` — and it is Foundation first:

           function pmName(job){ return (job.foundation && job.foundation.pmName)
                                     || (job.pm && job.pm.name) || null; }

       Every PM label in Command flows through it: PM Load, Margin & Risk, AR-by-PM, the job
       drawers, the WOH F-lines. So the PM Keith reads on Command is `ryc_foundation_latest.pmName`
       — a Supabase table, served by `crm.jbkdevelopment.com/api/ryc-foundation`, which is the SAME
       endpoint this module already fetches. The two tools were never reading different tables.
       They differed on ONE LINE of precedence, and that line is now identical to Command's.

       WHY FOUNDATION AND NOT PROCORE, in the data rather than in the argument — across the 53
       active jobs:
         Procore `pm.name`  Logan Moore 33 (titled PROJECT ENGINEER) · Erik Parcell 15 · Troy
                            Jennings 2 · Chris Crothers 1 (PE) · blank 2
         Foundation pmName  Logan Moore 28 · Erik Parcell 7 · Bill Emmons 5 · Troy Jennings 4 ·
                            Ken Wright 4 · John Emmons 3 · Brad Yoder 1
       Procore's PM field carries a project ENGINEER on 34 of 53 jobs and puts three names on all
       53 — it is the project-record administrator, not the desk. Foundation spreads the work across
       the real seven-PM roster and agrees with every PM fact recorded in RYC/CLAUDE.md.

       ⚠ THIS REVERSES "PROCORE WINS" (decided earlier the same day, twice). It is reversed on
       Keith's own instruction to match Command, and the record above is why. Procore is still
       consulted — it fills the blanks, which is what fixed Helix Orchard. Do not re-litigate.

       Foundation is fetched from CRM. If it cannot be read, Procore still answers and `pm_source`
       says so, rather than silently degrading.

       ⛔ THE ORIGINAL BUG, KEPT FOR THE RECORD: this module read PROCORE ALONE and called a job
       deskless when Procore was simply blank (2026-08-13). Keith, on Helix Orchard reading "no
       desk" in Inbound while Command showed John Emmons on the same job: *"Helix absolutely has a
       desk and therefore a PM."* Correct — Foundation had the answer all along and nothing here
       was asking it. That is still what the fallback below fixes. */
    const FOUNDATION_URL = (process.env.RYC_CRM_ORIGIN || 'https://crm.jbkdevelopment.com')
      + '/api/ryc-foundation';

    async function foundationPms() {
      try {
        const r = await fetch(FOUNDATION_URL, {
          headers: { 'User-Agent': 'ryc-invoices/1.0' }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return {};
        const body = await r.json();
        const out = {};
        for (const [no, f] of Object.entries((body && body.jobs) || {})) {
          const pm = f && f.pmName ? String(f.pmName).trim() : '';
          if (pm) out[String(no).trim()] = { pm, desc: (f.description || '').trim() };
        }
        return out;
      } catch { return {}; }
    }

    /* The one place a job number becomes a name, a desk and the reason that desk was chosen.
       ACTIVE only for the picklist — an inbound invoice for a closed job is an exception a human
       should look at, not an option to pick by accident out of hundreds. */
    async function jobDirectory() {
      const origin = process.env.RYC_DATA_ORIGIN || 'https://app.civicscope.io';
      const [cache, fnd] = await Promise.all([
        fetch(`${origin}/ryc-data/procore-cache.json`, {
          headers: { 'User-Agent': 'ryc-invoices/1.0' }, signal: AbortSignal.timeout(15000),
        }).then(r => (r.ok ? r.json() : null)).catch(() => null),
        foundationPms(),
      ]);
      const jobs = [];
      const names = {};
      const seen = new Set();
      for (const j of ((cache && cache.jobs) || [])) {
        const no = String(j.projectNumber || '').trim();
        if (!no || !j.name) continue;
        names[no] = j.name;
        seen.add(no);
        const procorePm = j.pm && j.pm.name ? String(j.pm.name).trim() : null;
        const foundationPm = fnd[no] ? fnd[no].pm : null;
        jobs.push({
          no, name: j.name, active: j.active !== false,
          // The rule lives in ONE place — resolveJobPm() above, which the harness calls too.
          pm: resolveJobPm(procorePm, foundationPm),
          pm_source: resolveJobPmSource(procorePm, foundationPm),
          // Kept so a disagreement is visible rather than silently resolved. 17 of 53 disagree.
          pm_procore: procorePm, pm_foundation: foundationPm,
        });
      }

      /* JOBS FOUNDATION KNOWS AND PROCORE DOES NOT — 46 of them, and an invoice arrived for one.
         `26X004` printed on an Alpha Building Center invoice is "Ryan Fire Prot - Valpo", a real
         RYC job owned by Ken Wright; the tool could only say "not in the Procore feed", which
         reads as *that number is wrong* rather than *that job is not in the feed I read*. They
         are returned SEPARATELY and are never in the picklist: the same list holds warranty work,
         three test jobs and two PMs' own driveways. */
      const foundationOnly = [];
      for (const [no, f] of Object.entries(fnd)) {
        if (seen.has(no)) continue;
        const pm = f.pm;
        /* THE NAME SHIPS EVEN THOUGH THE JOB DOES NOT (2026-08-13). `names` was built from the
           Procore cache alone while `pm` was already Procore-or-Foundation, so a Foundation-only
           job arrived on a desk correctly and then rendered as a bare number: Ken's card read
           `26X004 · 2 · $25,499` with no name, which reads as *the tool does not know this job*
           when in fact it knew the job, the PM and the customer. Keith, on that card: *"are the
           two under kens name not with a project - i dont see a project name."*
           This adds ONLY the name. These jobs stay out of `jobs`, so they remain absent from the
           picklist for the reason recorded above — a name on a card a PM is already looking at is
           not the same thing as an option to pick out of hundreds. Guarded on a real description
           so a blank one can never render as `26X004 · 26X004`. */
        if (f.desc) names[no] = f.desc;
        foundationOnly.push({ no, name: f.desc || no, pm, pm_source: 'foundation',
          pm_procore: null, pm_foundation: pm, active: false, in_procore: false });
      }

      jobs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { jobs, foundationOnly, names, asOf: (cache && cache.refreshed) || null,
        foundation_read: Object.keys(fnd).length > 0 };
    }

    /* Job number -> the PM whose desk it is. This is what makes routing automatic without a
       classifier: the invoice's job is already resolved at REGISTER time by
       ryc_invoice_job_hints — (vendor, printed job text) -> job number, learned only from a PM's
       own correction — so the remaining step is a lookup, not a guess.
       Returns an empty map on total failure: no suggestion is a fine outcome, a wrong one is not. */
    async function jobPmMap() {
      try {
        const dir = await jobDirectory();
        const map = {};
        /* Foundation-only jobs are INCLUDED here even though they are not in the picklist.
           The staging pass can already place one from a printed number (26X004 "Ryan Fire Prot -
           Valpo"), and a map that refused the same job number would mean the machine could route
           an invoice a person was then forbidden to confirm or correct. */
        for (const j of [...dir.jobs, ...(dir.foundationOnly || [])]) if (j.pm) map[j.no] = j.pm;
        return map;
      } catch { return {}; }
    }

    /* ---------- job names ---------------------------------------------------------------
       "2510GP04" is not what anyone calls that job. Command resolves names from its Procore
       feed, but the tool deliberately does not load that whole feed just to decorate a header
       — so the server hands back the one thing it needs: a number → name map. Small payload,
       one call, and it degrades to bare numbers rather than failing. */
    if (action === 'jobs') {
      try {
        const dir = await jobDirectory();
        return res.status(200).json({
          ok: true, names: dir.names, asOf: dir.asOf, foundation_read: dir.foundation_read,
          jobs: dir.jobs.filter(j => j.active).map(j => ({
            no: j.no, name: j.name, pm: j.pm, pm_source: j.pm_source,
            pm_procore: j.pm_procore, pm_foundation: j.pm_foundation,
          })),
        });
      } catch {
        return res.status(200).json({ ok: true, names: {}, jobs: [] });
      }
    }

    /* ---------- budget lines for a job ------------------------------------------------
       The number a PM currently opens Procore to read: how much is left on the line they are
       about to code an invoice against.

       WHICH FIGURE IS "LEFT" IS A CHOICE, so it is named and switchable rather than baked in.
       Keith 2026-08-11: `over_under` — Procore's OWN projected over/under, carried verbatim
       from the nightly so the tool shows the same number that appears on the PM's screen
       rather than a lookalike derived a slightly different way. `uncommitted` is the other
       reading (revised − committed − direct: not yet reserved or spent) and differs materially
       on a job with work committed but not yet invoiced. Set RYC_BUDGET_REMAINING to switch;
       the response always says which one it used, so a number can never be misread. */
    if (action === 'budget') {
      const jobNo = String(body.job_no || '').trim();
      if (!jobNo) return res.status(400).json({ error: 'job_no is required.' });
      const basis = process.env.RYC_BUDGET_REMAINING === 'uncommitted' ? 'uncommitted' : 'over_under';

      const origin = process.env.RYC_DATA_ORIGIN || 'https://app.civicscope.io';
      let cache = null;
      try {
        const r = await fetch(`${origin}/ryc-data/procore-cache.json`, {
          headers: { 'User-Agent': 'ryc-invoices/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) cache = await r.json();
      } catch { /* fall through to unavailable */ }

      // Unavailable is never zero. A missing feed must not render as "nothing left in the
      // budget" — that would be an alarming number manufactured from an outage.
      if (!cache || !Array.isArray(cache.jobs)) {
        return res.status(200).json({ ok: true, available: false,
          reason: 'The Procore budget feed could not be read just now.' });
      }
      const job = cache.jobs.find(j => String(j.projectNumber || '').trim() === jobNo);
      const bud = (job && job.budget) || null;
      const lines = (bud && Array.isArray(bud.lines)) ? bud.lines : null;
      /* ONLY the ERP budget view. Probed 2026-08-11: for Div 1-01-001.L the standard
         budget_line_items endpoint reports projected_over_under = 0.00 while the ERP view —
         the one on the PM's screen — reports 84,466.33. Showing a PM a number that disagrees
         with what Procore shows them is worse than showing nothing, so an unstamped or
         differently-sourced payload is treated as unavailable rather than displayed. */
      if (!lines || bud.linesSource !== 'erp_detail_rows') {
        return res.status(200).json({ ok: true, available: false, asOf: cache.refreshed || null,
          reason: lines
            ? 'Budget lines in this pull are not from the ERP view a PM reads — not shown.'
            : 'This job has no budget lines in the current Procore pull.' });
      }
      const out = lines.map(l => ({
        code: l.code, name: l.name, division: l.division,
        revised: l.revised, committed: l.committed, direct: l.direct,
        projectedCost: l.projectedCost,
        remaining: basis === 'uncommitted'
          ? Math.round(((l.revised || 0) - (l.committed || 0) - (l.direct || 0)) * 100) / 100
          : (l.overUnder || 0),
      }));
      return res.status(200).json({ ok: true, available: true, basis, job_no: jobNo,
        asOf: cache.refreshed || null, lines: out });
    }

    /* ---------- the queue: "my batch for the day" ---------- */
    if (action === 'queue') {
      const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 365);
      const out = await rpc('ryc_invoice_queue', { p_pm: pm, p_days: days });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      const rows = Array.isArray(out.body) ? out.body : [];
      // Filing state lives on columns added after ryc_invoice_queue()'s explicit column list was
      // written. Read them alongside and merge rather than altering a function three other call
      // sites depend on. A failure here must not blank the queue — filing status is decoration
      // on a screen whose job is reviewing invoices.
      if (rows.length) {
        try {
          const ids = rows.map(r => r.id).filter(Boolean);
          const fr = await sb('ryc_invoices?company_id=eq.ryc'
            + `&id=in.(${ids.join(',')})`
            + '&select=id,file_state,filed_name,filed_url,filed_at,filed_intended_folder,file_error');
          if (fr.ok) {
            const byId = new Map((await fr.json()).map(x => [x.id, x]));
            for (const r of rows) Object.assign(r, byId.get(r.id) || {});
          }
        } catch { /* leave the rows as they are */ }
      }
      /* ROUTING SUGGESTION — front office only, and only for what has not been pushed yet.
         A PM never sees this: their queue is what was sent to them, and offering them a
         "suggested desk" would invite them to hand work sideways, which is the front office's
         call. Derived per request so a corrected hint or a PM change in Procore is reflected
         immediately rather than at whatever time a stored value was written. */
      let unrouted = 0;
      if (who.scope === 'all') {
        const pending = rows.filter(r => !r.assigned_pm);
        if (pending.length) {
          const pmByJob = await jobPmMap();
          for (const r of pending) {
            const s = r.job_no ? pmByJob[String(r.job_no).trim()] : null;
            if (s) { r.suggested_pm = s; r.suggested_via = 'job'; }
            else { r.suggested_pm = null; r.suggested_via = r.job_no ? 'job has no PM in Procore' : 'no job resolved'; }
          }
        }
        unrouted = pending.length;
      }
      // Summary computed here rather than in the view, so the count a PM sees and the count the
      // front office sees come from one place.
      const openHigh = rows.filter(r => Number(r.open_high) > 0).length;
      const outstanding = rows.filter(r => r.review_state === 'new' || r.review_state === 'ready').length;
      return res.status(200).json({
        ok: true, scope: who.scope, pm, rows,
        summary: { documents: rows.length, outstanding, flagged: openHigh, unrouted },
      });
    }

    /* ===================== BATCH PROCESS =============================================
       The paper-batch pipeline as a button. A scan of invoices the front office already worked
       ON PAPER goes in; one named PDF per payable, filed to a dated SharePoint folder, comes out.

       WHY IT IS A JOB AND NOT A REQUEST. None of the work can happen here. Rendering needs
       pymupdf, the filed vendor spellings need the 2,968-invoice archive index, and the upload
       needs the delegated SharePoint credential — all three live on keith-agent-01, and that
       credential deliberately does not exist on Vercel. So this endpoint owns the STATE and the
       VM owns the WORK, exactly as the filing worker already does.

       WHY THE BROWSER UPLOADS STRAIGHT TO STORAGE. Vercel caps a request body at ~4.5MB and a
       44-page colour scan is 6MB+. Posting the PDF through here would fail on the real input and
       work on every test. So `batch_start` mints a SIGNED UPLOAD URL and the file never touches
       this function.

       WHY IT STOPS IN THE MIDDLE. `proposed` is what the reader saw; `manifest` is what a person
       confirmed. Only the second is ever filed. Three real batches say why: a billed-to-date
       summary line read as a $4,444.75 payable that does not exist, one invoice split into a
       $0.00 document and a $1,917.30 one, and a $63,450.50 pay application filed alongside its
       own lien waiver as two payables. */
    const BATCH_STATES = ['new', 'uploaded', 'rendering', 'reading', 'reconciling', 'proposed',
      'confirmed', 'filing', 'filed', 'failed'];

    if (action === 'batch_start') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const filename = String(body.filename || '').trim();
      if (!filename) return res.status(400).json({ error: 'filename is required.' });
      /* The folder is a real path segment in SharePoint. Refuse anything that could climb out of
         the staging root rather than sanitising it silently — the operator should see the name
         they are going to get. */
      const folder = String(body.folder || '').trim();
      if (!folder) return res.status(400).json({ error: 'A destination folder name is required.' });
      if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(folder)) {
        return res.status(400).json({ error: 'Folder name: letters, numbers, spaces, dot, dash and underscore only.' });
      }

      const ins = await sb('ryc_batch_jobs', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          company_id: 'ryc', filename, folder,
          received_date: body.received_date || null,
          status: 'new', phase_note: 'waiting for the file',
        }),
      });
      if (ins.status === 409) {
        return res.status(409).json({ error: `A batch is already in flight for folder "${folder}". Finish or cancel it first.` });
      }
      if (!ins.ok) return res.status(502).json({ error: `Could not open a batch job (${ins.status}).` });
      const job = (await ins.json())[0];

      const path = `batches/${job.id}/source.pdf`;
      const sign = await fetch(`${SB_URL}/storage/v1/object/upload/sign/${SCAN_BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!sign.ok) {
        await sb(`ryc_batch_jobs?id=eq.${job.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'failed', error: `could not mint an upload URL (${sign.status})` }) });
        return res.status(502).json({ error: `Could not prepare the upload (${sign.status}).` });
      }
      const signed = await sign.json();
      await sb(`ryc_batch_jobs?id=eq.${job.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ source_path: path }) });
      return res.status(200).json({ ok: true, job: { ...job, source_path: path },
        upload_url: `${SB_URL}/storage/v1${signed.url}` });
    }

    if (action === 'batch_uploaded') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const r = await sb(`ryc_batch_jobs?id=eq.${String(body.id || '')}&status=eq.new`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'uploaded', phase_note: 'queued for the worker', updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not mark the upload complete.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That job is not waiting for a file.' });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    if (action === 'batch_status') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      const q = id
        ? `ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=*`
        : 'ryc_batch_jobs?company_id=eq.ryc&select=id,filename,folder,status,phase_note,page_count,pages_read,folder_url,error,created_at&order=created_at.desc&limit=8';
      const r = await sb(q);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the batch.' });
      const rows = await r.json();
      return res.status(200).json(id ? { ok: true, job: rows[0] || null } : { ok: true, jobs: rows });
    }

    if (action === 'batch_confirm') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      const manifest = Array.isArray(body.manifest) ? body.manifest : null;
      if (!id || !manifest || !manifest.length) {
        return res.status(400).json({ error: 'A job id and a non-empty manifest are required.' });
      }
      /* COVERAGE IS CHECKED HERE TOO, not only in the VM script. The client also checks, so this
         is the second of two — the one a browser cannot skip by posting directly. The rule itself
         lives in `validateManifest()` because `batch_autoconfirm` must enforce exactly the same
         one; see the note there. */
      const cur = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=page_count,status`);
      const job = cur.ok ? (await cur.json())[0] : null;
      if (!job) return res.status(404).json({ error: 'No such batch.' });
      if (job.status !== 'proposed') {
        return res.status(409).json({ error: `That batch is "${job.status}" — only a proposed batch can be confirmed.` });
      }
      const bad = validateManifest(manifest, job.page_count);
      if (bad) return res.status(400).json({ error: bad });
      const r = await sb(`ryc_batch_jobs?id=eq.${id}&status=eq.proposed`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ manifest, status: 'confirmed',
          phase_note: `${manifest.length} document(s) confirmed — queued for filing`,
          updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not confirm the batch.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That batch moved on before the confirmation landed.' });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    /* A job that never received its file — the browser tab closed mid-upload, the network went —
       sits in `new` forever AND holds its folder name, because the uniqueness index deliberately
       stops two live jobs aiming at one SharePoint folder. Without this the only way to reuse that
       name is a database edit. Found the honest way: it happened during this feature's own first
       end-to-end test. Refuses once filing has started — that is not a state a button may abandon. */
    if (action === 'batch_cancel') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required.' });
      const r = await sb(`ryc_batch_jobs?id=eq.${id}&status=in.(new,uploaded,proposed,failed)`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'failed', error: 'cancelled', phase_note: 'cancelled',
          updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not cancel.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That batch is already filing or filed.' });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    /* ---- the worker's two actions. Service token only (see SERVICE_ACTIONS). ---- */
    if (action === 'batch_claim') {
      /* Claim by PATCHing a row that is still in a claimable state, and let PostgREST return
         what it actually changed. Two workers racing therefore cannot both win: the second one
         matches zero rows. A stale lease is visible in `claimed_at` rather than invented here —
         a worker that dies leaves a row a human can see, not one that silently re-runs. */
      const want = String(body.state || '') === 'confirmed' ? 'confirmed' : 'uploaded';
      const next = want === 'confirmed' ? 'filing' : 'rendering';
      const r = await sb(`ryc_batch_jobs?company_id=eq.ryc&status=eq.${want}&order=created_at.asc&limit=1`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: next, claimed_at: new Date().toISOString(),
          phase_note: next === 'filing' ? 'filing to SharePoint' : 'rendering pages',
          updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'claim failed' });
      const rows = await r.json();
      const job = rows[0] || null;

      /* HAND THE WORKER A SIGNED URL, NOT A KEY. The scan is in a private bucket and stays there;
         the worker gets a 30-minute read link for one object and never holds a Supabase
         credential. That is one fewer secret on the VM than the obvious design, and it is the
         same thing the `pages` action already does for the browser. */
      if (job && job.source_path) {
        try {
          const sign = await fetch(`${SB_URL}/storage/v1/object/sign/${SCAN_BUCKET}/${job.source_path}`, {
            method: 'POST',
            headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expiresIn: 1800 }),
          });
          if (sign.ok) {
            const s = await sign.json();
            if (s.signedURL) job.source_url = `${SB_URL}/storage/v1${s.signedURL}`;
          }
        } catch { /* the worker reports "no readable source" rather than half-running */ }
      }
      return res.status(200).json({ ok: true, job });
    }

    if (action === 'batch_progress') {
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required.' });
      const patch = { updated_at: new Date().toISOString() };
      if (body.status) {
        if (!BATCH_STATES.includes(String(body.status))) {
          return res.status(400).json({ error: `Unknown state ${body.status}.` });
        }
        patch.status = body.status;
      }
      for (const k of ['phase_note', 'page_count', 'pages_read', 'proposed', 'filed', 'folder_url', 'error']) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      const r = await sb(`ryc_batch_jobs?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(502).json({ error: 'progress update failed' });
      return res.status(200).json({ ok: true, job: (await r.json())[0] || null });
    }

    /* ---------- the filing worker (service token only) -------------------------------
       The VM holds the delegated SharePoint credential; Vercel does not and should not. So the
       split is: this endpoint decides WHAT is eligible and records WHAT HAPPENED, and the worker
       on keith-agent-01 does the stamping and the upload. Same shape as procore-refresh and
       bc-readback — the machine with the credential does the external work. */
    if (action === 'filing_queue') {
      const limit = Math.min(Math.max(parseInt(body.limit, 10) || 25, 1), 200);
      const out = await rpc('ryc_invoice_filing_queue', {
        p_limit: limit,
        p_max_attempts: Math.min(Math.max(parseInt(body.max_attempts, 10) || 4, 1), 20),
      });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      const rows = Array.isArray(out.body) ? out.body : [];

      /* WHAT A PREVIOUS ATTEMPT ALREADY DID. Without this the worker recomputes a name, and
         build_filename's collision-avoidance renames around the file the worker itself uploaded
         — producing a second copy of one invoice instead of converging. Proven 2026-08-12 by the
         crash-recovery test. Carried on the row so the retry lands on the SAME path and 409s. */
      if (rows.length) {
        try {
          const ids = rows.map(r => r.id).filter(Boolean);
          const pr = await sb('ryc_invoices?company_id=eq.ryc'
            + `&id=in.(${ids.join(',')})`
            + '&select=id,filed_name,filed_path,filed_url');
          if (pr.ok) {
            const byId = new Map((await pr.json()).map(x => [x.id, x]));
            for (const r of rows) Object.assign(r, byId.get(r.id) || {});
          }
        } catch { /* the worker falls back to computing a name */ }
      }

      /* Sign the scan pages HERE. The worker then never needs the Supabase service key — it
         holds one narrow token and receives short-lived URLs for exactly the pages of exactly
         the documents it was handed. The bucket stays private. */
      for (const r of rows) {
        r.pages = [];
        const m = /^storage:([^/]+)\/(.+)$/.exec(r.document_uri || '');
        if (!m) { r.pages_note = 'this batch has no stored scan'; continue; }
        const [, bucket, prefix] = m;
        const from = r.page_from || 1, to = r.page_to || r.page_from || 1;
        const paths = [];
        for (let p = from; p <= to; p++) paths.push(`${prefix}/p${String(p).padStart(2, '0')}.jpg`);
        try {
          const sign = await fetch(`${SB_URL}/storage/v1/object/sign/${bucket}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
            body: JSON.stringify({ expiresIn: 1800, paths }),
          });
          if (sign.ok) {
            const signed = await sign.json();
            r.pages = (Array.isArray(signed) ? signed : [])
              .map((s, i) => ({ page: from + i, url: s.signedURL ? `${SB_URL}/storage/v1${s.signedURL}` : null }))
              .filter(p => p.url);
          } else {
            r.pages_note = `could not sign the scan (${sign.status})`;
          }
        } catch { r.pages_note = 'could not sign the scan'; }
      }
      return res.status(200).json({ ok: true, count: rows.length, rows });
    }

    if (action === 'mark_filed') {
      const state = String(body.state || '');
      const out = await rpc('ryc_mark_invoice_filed', {
        p_id: body.id,
        p_state: state,
        p_name: body.name || null,
        p_path: body.path || null,
        p_url: body.url || null,
        p_intended_folder: body.intended_folder || null,
        p_error: body.error || null,
        p_expected_version: body.version == null ? null : parseInt(body.version, 10),
        p_request_id: rid,
        p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    /* ---------- THE INBOUND QUEUE (front office's own screen) ---------- */
    if (action === 'inbound_queue') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const out = await rpc('ryc_inbound_queue', { p_days: Math.min(Math.max(parseInt(body.days, 10) || 60, 1), 365) });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      const rows = Array.isArray(out.body) ? out.body : [];
      return res.status(200).json({
        ok: true, rows,
        summary: {
          documents: rows.length,
          staged: rows.filter(r => r.staged_pm).length,
          // A job identified but no desk to send it to — one click from ready, and a different
          // problem from an invoice nothing could be read off.
          no_desk: rows.filter(r => !r.staged_pm && r.staged_job_no).length,
          unplaced: rows.filter(r => !r.staged_pm && !r.staged_job_no).length,
          flagged: rows.filter(r => Number(r.open_high) > 0).length,
          value: rows.reduce((a, r) => a + (Number(r.amount) || 0), 0),
        },
      });
    }

    /* ===== THE STAGING PASS ============================================================
       Resolve what can be resolved, and RECORD plainly what could not.

       It runs ON ARRIVAL (at the end of `register`, which is what the mailbox ingest calls) and
       not only when somebody presses a button. Keith's motion is "the invoice hits the ap inbox,
       AUTO MOVES to the queue where the SYSTEM STAGES IT" — a screen that reads "0 placed by the
       system" because nothing ever tried is indistinguishable, to the person looking at it, from a
       system that tried and could not, and it puts the front office back to doing all of it.

       Two more things it does deliberately:
       · A JOB WITH NO DESK IS STILL WORTH RECORDING. 2513CO04 Helix Orchard has no PM in the
         Procore feed, and two of the first 16 invoices belong to it. Refusing to stage the job
         because the desk is unknown threw away the half we DID know and made the front office
         find the job by hand. Now the job is staged and the desk is left open; release still
         holds anything with no desk, so nothing lands nowhere.
       · THE REASON IS WRITTEN DOWN. `staged_note` carries the refusal, so the screen can say
         "only shared words matched" or "the invoice prints job 26X004, which is not in the
         Procore feed" instead of leaving a blank the front office has to re-derive per invoice. */
    async function stagingPass(opts) {
      const force = !!(opts && opts.force);
      const q = await rpc('ryc_inbound_queue', { p_days: 90 });
      if (q.status !== 200) return { error: (q.body && q.body.error) || 'could not read the inbound queue' };
      const all = Array.isArray(q.body) ? q.body : [];
      /* A PERSON'S ANSWER IS NEVER OVERWRITTEN — not even by an explicit re-run. Otherwise the
         front office corrects a wrong guess, presses "Re-read and place", and the machine puts its
         own guess straight back. Everything else is fair game on a re-run: that is the point of
         re-reading after a hint is taught or a job gains a PM in Procore. */
      const rows = all.filter(r => r.staged_source !== 'manual'
        && (force || (!r.staged_pm && !r.staged_job_no)));
      if (!rows.length) return { staged: 0, unplaced: 0, note: 'nothing waiting to be staged' };

      /* The job list and each job's desk come from `jobDirectory()` — the SAME resolution
         Command uses (Foundation first, Procore second). It used to read the Procore cache
         directly here, which is how a third of the portfolio got staged to a desk RYC's
         accounting system does not consider the owner. */
      let jobs = [], foundationOnly = [];
      try {
        const dir = await jobDirectory();
        jobs = dir.jobs;
        foundationOnly = dir.foundationOnly || [];
      } catch { /* no feed -> nothing is staged, which is honest */ }
      if (!jobs.length) {
        return { staged: 0, unplaced: rows.length,
          note: 'the Procore job feed could not be read — nothing staged rather than guessed' };
      }
      const idx = tokenIndex(jobs);
      const byNo = new Map(jobs.map(j => [j.no, j]));

      const staged = [], unplaced = [];
      for (const r of rows) {
        /* A job resolved at REGISTER time — from ryc_invoice_job_hints, the alias a PM taught
           once — is already a human's answer. Re-deriving it from the printed text would be
           strictly worse than using it. */
        const known = r.job_no ? byNo.get(String(r.job_no).trim()) : null;
        const m = known
          ? { job: known, conf: 1.0, why: `job ${known.no} was already resolved on this invoice`, source: 'hint' }
          : { ...matchJob(r.job_text, jobs, idx, foundationOnly), source: 'job_text' };

        if (!m.job) {
          // Record WHY, once. Rewriting an unchanged note every pass would churn the version and
          // bury the real history under identical events.
          if (r.staged_note !== m.why) {
            await rpc('ryc_stage_invoice', {
              p_id: r.id, p_staged_pm: null, p_staged_job_no: null,
              p_source: 'none', p_confidence: null, p_note: m.why,
              p_expected_version: r.version, p_request_id: `${rid}:why:${r.id}`, p_actor: actor,
            });
          }
          unplaced.push({ id: r.id, vendor: r.vendor_name, job_text: r.job_text, why: m.why });
          continue;
        }

        const note = m.job.pm ? m.why
          : `${m.why} — that job has no PM in Procore, so pick a desk`;

        /* Re-reading is not re-writing. "Look again" on a queue the system already answered
           correctly must be a no-op, or every press bumps the version and buries the real
           history under a run of identical events. */
        if (r.staged_job_no === m.job.no && (r.staged_pm || null) === (m.job.pm || null)
            && r.staged_note === note) {
          if (m.job.pm) staged.push({ id: r.id, vendor: r.vendor_name, job: m.job.no, pm: m.job.pm, why: m.why, unchanged: true });
          else unplaced.push({ id: r.id, vendor: r.vendor_name, job: m.job.no, why: note, unchanged: true });
          continue;
        }

        const s = await rpc('ryc_stage_invoice', {
          p_id: r.id, p_staged_pm: m.job.pm || null, p_staged_job_no: m.job.no,
          p_source: m.source, p_confidence: m.conf, p_note: note,
          p_expected_version: r.version, p_request_id: `${rid}:${r.id}`, p_actor: actor,
        });
        if (s.status !== 200) {
          unplaced.push({ id: r.id, vendor: r.vendor_name, why: (s.body && s.body.error) || 'stage failed' });
        } else if (m.job.pm) {
          staged.push({ id: r.id, vendor: r.vendor_name, job: m.job.no, pm: m.job.pm, why: m.why });
        } else {
          // The job is known, the desk is not. It is NOT placed — release would hold it anyway.
          unplaced.push({ id: r.id, vendor: r.vendor_name, job: m.job.no, why: note });
        }
      }
      return { staged: staged.length, unplaced: unplaced.length, staged_rows: staged, unplaced_rows: unplaced };
    }

    if (action === 'stage_inbound') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      // The button means "look again" — a hint was taught, or a job gained a PM in Procore — so it
      // re-reads everything that has not yet been released, including the system's own guesses.
      const out = await stagingPass({ force: body.force !== false });
      if (out.error) return res.status(502).json({ error: out.error });
      return res.status(200).json({ ok: true, ...out });
    }

    /* The front office's correction. THEY PICK A JOB; the desk follows from it — a PM chosen by
       hand goes stale the moment Procore reassigns the job, and asking someone to remember which
       PM owns which of 53 jobs is work the feed already does. An explicit staged_pm is still
       honoured for the rare case where the two genuinely differ. */
    if (action === 'stage') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const jobNo = String(body.job_no || '').trim();
      let pm = body.staged_pm || null;
      let note = body.note || null;
      if (jobNo && !pm) {
        const map = await jobPmMap();
        pm = map[jobNo] || null;
        if (!pm) {
          return res.status(409).json({
            error: `Job ${jobNo} has no PM in Procore or Foundation, so there is no desk to send `
              + 'it to. Pick another job, or set the PM in Procore first.',
          });
        }
        note = note || `desk follows job ${jobNo}`;
      }
      /* UN-STAGING IS A REAL ACTION. Without it a wrong guess is unfixable except by choosing a
         different wrong job: the front office could never put an invoice back to "needs a human",
         which is exactly what they should do when they are not sure. Explicit, so it can never
         happen by an empty form submitting itself. */
      if (body.clear === true) { pm = null; note = note || 'cleared — back to unplaced'; }
      else if (!jobNo && !pm) {
        return res.status(400).json({ error: 'Pick a job (or a desk) before staging.' });
      }
      const out = await rpc('ryc_stage_invoice', {
        p_id: body.id, p_staged_pm: pm, p_staged_job_no: jobNo || null,
        p_source: body.source || 'manual', p_confidence: body.confidence ?? 1.0,
        p_note: note,
        p_expected_version: body.version ?? null, p_request_id: rid, p_actor: actor,
      });
      if (out.status === 200) out.body = { ...out.body, staged_pm: pm, staged_job_no: jobNo || null };
      return res.status(out.status).json(out.body);
    }

    /* RELEASE THE BATCH — the act that puts work on a PM's page. */
    if (action === 'release') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'No invoices selected to release.' });
      const out = await rpc('ryc_release_invoices', {
        p_ids: ids, p_released_by: (who.scope === 'pm' ? who.pm : 'front office'),
        p_request_id: rid, p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    /* ---------- PM actions ---------- */
    if (action === 'assign') {
      const out = await rpc('ryc_assign_invoice', {
        p_id: body.id, p_job_no: body.job_no || null,
        p_assigned_pm: body.assigned_pm || pm || null,
        p_source: body.source || 'manual',
        p_expected_version: body.version ?? null, p_request_id: rid, p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    if (action === 'code') {
      const out = await rpc('ryc_code_invoice', {
        p_id: body.id, p_month: body.month || null, p_cost_code: body.cost_code || null,
        p_mat_or_sub: body.mat_or_sub || null, p_lines: body.lines || null,
        p_expected_version: body.version ?? null, p_request_id: rid, p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    if (action === 'review') {
      // The reviewer is the CREDENTIAL's name for a PM. Only the front office may name someone
      // else, and that is recorded as such.
      const reviewer = who.scope === 'pm' ? who.pm : (body.reviewer || 'front office');
      const out = await rpc('ryc_review_invoice', {
        p_id: body.id, p_decision: String(body.decision || ''), p_reviewer: reviewer,
        p_note: body.note || null, p_duplicate_of: body.duplicate_of || null,
        p_identity_verified: false,        // no per-user auth yet — never claim otherwise
        p_expected_version: body.version ?? null, p_request_id: rid, p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    if (action === 'resolve_flag') {
      const reviewer = who.scope === 'pm' ? who.pm : (body.reviewer || 'front office');
      // `flag_code`, NOT `code`: `code` is the CREDENTIAL field read by identify(), so naming
      // the finding `code` meant the client's own credential overwrote it and this action
      // could never resolve anything. Caught by an end-to-end test, not by a unit test —
      // both halves looked correct in isolation.
      const out = await rpc('ryc_resolve_invoice_flag', {
        p_id: body.id, p_code: String(body.flag_code || ''), p_note: body.note || null,
        p_reviewer: reviewer,
        p_expected_version: body.version ?? null, p_request_id: rid, p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    /* ---------- the summary back to the front office ---------- */
    if (action === 'close_batch') {
      if (!pm) return res.status(400).json({ error: 'A PM is required to close a batch.' });
      const out = await rpc('ryc_close_invoice_batch', {
        p_pm: pm, p_received_date: body.received_date || new Date().toISOString().slice(0, 10),
        p_request_id: rid, p_actor: actor,
      });
      return res.status(out.status).json(out.body);
    }

    /* ---------- intake (front office scope only) ---------- */
    if (action === 'open_batch') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });

      /* ONE EMAIL, ONE BATCH, EVER. The ingest is a poll, so it will see the same message again
         on the next run and after any partial failure. `source_message_id` carries the mail
         system's own immutable id and a partial unique index refuses the second insert, so
         re-ingesting is a no-op rather than the duplicate this whole module exists to catch.
         Checked here first so the normal path returns the existing batch instead of an error. */
      const msgId = String(body.source_message_id || '').trim() || null;
      if (msgId) {
        const ex = await sb(`ryc_invoice_batches?company_id=eq.ryc`
          + `&source_message_id=eq.${encodeURIComponent(msgId)}&select=*`);
        if (ex.ok) {
          const found = await ex.json();
          if (found.length) return res.status(200).json({ ok: true, batch: found[0], already: true });
        }
      }

      const r = await sb('ryc_invoice_batches', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          received_date: body.received_date || new Date().toISOString().slice(0, 10),
          source: body.source || 'manual', label: body.label || null,
          page_count: body.page_count || 0, document_uri: body.document_uri || null,
          ...(msgId ? { source_message_id: msgId } : {}),
        }),
      });
      if (r.status === 409) {
        // lost a race with a concurrent run — the other one won, which is the correct outcome
        const ex = await sb(`ryc_invoice_batches?company_id=eq.ryc`
          + `&source_message_id=eq.${encodeURIComponent(msgId || '')}&select=*`);
        const found = ex.ok ? await ex.json() : [];
        if (found.length) return res.status(200).json({ ok: true, batch: found[0], already: true });
      }
      if (!r.ok) return res.status(502).json({ error: `Could not open batch (${r.status}).` });
      const rows = await r.json();
      return res.status(200).json({ ok: true, batch: rows[0] });
    }

    /* ---- the reconciler: the confirm screen's judgement, done by the machine ----
       Reads and proposes only. It cannot move a batch, file anything, or create a payable —
       `batch_autoconfirm` is the only action that acts on its output, and that one is service-only
       AND re-validates coverage from scratch. */
    if (action === 'reconcile') {
      if (!canRead) return res.status(403).json({ error: 'Front office only.' });
      if (!READ_ENABLED) {
        return res.status(503).json({ error: 'The document reader is switched off on this deployment.' });
      }
      const docs = Array.isArray(body.documents) ? body.documents : [];
      if (!docs.length) return res.status(400).json({ error: 'No documents supplied.' });
      if (docs.length > 400) {
        return res.status(413).json({ error: `${docs.length} documents sent; this endpoint reconciles up to 400.` });
      }
      const out = await reconcileBatch(docs);
      return res.status(out.status).json(out.status === 200 ? { ok: true, ...out.body } : out.body);
    }

    if (action === 'adjudicate') {
      if (!canRead) return res.status(403).json({ error: 'Front office only.' });
      if (!READ_ENABLED) {
        return res.status(503).json({ error: 'The document reader is switched off on this deployment.' });
      }
      const imgs = Array.isArray(body.images) ? body.images : [];
      const docs = Array.isArray(body.documents) ? body.documents : [];
      if (!imgs.length || !docs.length) {
        return res.status(400).json({ error: 'Pages and the candidate documents are both required.' });
      }
      if (imgs.length > MAX_IMAGES) {
        return res.status(413).json({ error: `${imgs.length} pages sent; this endpoint reads up to ${MAX_IMAGES} at a time.` });
      }
      const abytes = imgs.reduce((n, im) => n + String(im.data || '').length, 0);
      if (abytes > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: `Pages total ${Math.round(abytes / 1024)}KB, over the ${MAX_IMAGE_BYTES / 1024}KB limit.` });
      }
      const out = await adjudicateGroup(imgs, docs);
      return res.status(out.status).json(out.status === 200 ? { ok: true, ...out.body } : out.body);
    }

    /* THE RECONCILER'S OWN CONFIRM. Separate from `batch_confirm` for one reason: that action says
       "a person approved these boundaries", and it must keep meaning that. This one says "the
       reconciler resolved them", records HOW in `reconciliation`, and is reachable only by the
       filer service. It enforces the identical coverage rule — same function, not a copy — so
       nothing reaches SharePoint through a laxer door than the one a human uses. */
    if (action === 'batch_autoconfirm') {
      const id = String(body.id || '').trim();
      const manifest = Array.isArray(body.manifest) ? body.manifest : null;
      if (!id || !manifest || !manifest.length) {
        return res.status(400).json({ error: 'A job id and a non-empty manifest are required.' });
      }
      const cur = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=page_count,status`);
      const job = cur.ok ? (await cur.json())[0] : null;
      if (!job) return res.status(404).json({ error: 'No such batch.' });
      if (job.status !== 'reconciling') {
        return res.status(409).json({ error: `That batch is "${job.status}" — only a reconciling batch can be auto-confirmed.` });
      }
      const bad = validateManifest(manifest, job.page_count);
      if (bad) return res.status(400).json({ error: bad });
      /* `proposed` stays EXACTLY what the reader said — the page renders it as an array and it is
         the only record of what was seen before anything merged it. What the reconciler DECIDED is
         parked in `filed` now and carried into the verification the worker writes there when the
         folder is proven, so the finished card can say what was merged and why. Two different
         questions, two different columns, and the reader's version is never overwritten. */
      const r = await sb(`ryc_batch_jobs?id=eq.${id}&status=eq.reconciling`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ manifest, status: 'confirmed',
          filed: body.reconciliation ? { reconciliation: body.reconciliation } : null,
          phase_note: `${manifest.length} document(s) reconciled — queued for filing`,
          updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not confirm the batch.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That batch moved on before the confirmation landed.' });
      return res.status(200).json({ ok: true, job: rows[0] });
    }

    if (action === 'read') {
      if (!canRead) return res.status(403).json({ error: 'Front office only.' });
      if (!READ_ENABLED) {
        return res.status(503).json({ error: 'The document reader is switched off on this deployment.' });
      }
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) return res.status(400).json({ error: 'No pages supplied.' });
      if (images.length > MAX_IMAGES) {
        return res.status(413).json({ error: `${images.length} pages sent; this endpoint reads up to ${MAX_IMAGES} at a time.` });
      }
      const bytes = images.reduce((n, im) => n + String(im.data || '').length, 0);
      if (bytes > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: `Pages total ${Math.round(bytes / 1024)}KB, over the ${MAX_IMAGE_BYTES / 1024}KB limit.` });
      }
      /* STORE THE SCAN AS PART OF READING IT. The reader is the only moment the pages are
         ever in hand, so storing them here is what makes View work with no separate step and
         no manual upload. Pass batch_id (and page_offset for a chunked batch) and the pages
         land in the private bucket at <batch_id>/pNN.jpg, the batch is marked `storage:`, and
         the returned page numbers are already in BATCH coordinates — so the caller registers
         what it gets back without doing arithmetic. */
      const batchId = String(body.batch_id || '').trim();
      const offset = Math.max(parseInt(body.page_offset, 10) || 0, 0);
      let stored = 0;
      if (batchId) {
        for (let i = 0; i < images.length; i++) {
          const n = offset + i + 1;
          const key = `${batchId}/p${String(n).padStart(2, '0')}.jpg`;
          const up = await fetch(`${SB_URL}/storage/v1/object/${SCAN_BUCKET}/${key}`, {
            method: 'POST',
            headers: {
              apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
              'Content-Type': images[i].media_type || 'image/jpeg', 'x-upsert': 'true',
            },
            body: Buffer.from(String(images[i].data || ''), 'base64'),
          });
          if (up.ok) stored++;
        }
        // Mark the batch as carrying a stored scan. Idempotent; a re-read just re-marks it.
        await sb(`ryc_invoice_batches?id=eq.${batchId}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ document_uri: `storage:${SCAN_BUCKET}/${batchId}` }),
        });
      }

      const out = await readPages(images);
      if (out.status === 200 && offset) {
        // Shift chunk-relative page numbers into batch coordinates so the caller never has to.
        for (const d of out.body.documents) {
          if (d.page_from) d.page_from += offset;
          if (d.page_to) d.page_to += offset;
        }
      }
      if (out.status === 200) out.body.stored_pages = stored;
      return res.status(out.status).json(out.body);
    }

    if (action === 'register') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const docs = Array.isArray(body.documents) ? body.documents : [];
      if (!docs.length) return res.status(400).json({ error: 'No documents supplied.' });
      if (!body.batch_id) return res.status(400).json({ error: 'batch_id is required.' });

      /* Snapshot the batch BEFORE registering so the supporting-document pass below can act on
         exactly the rows THIS call created. `ryc_register_invoice` predates the migration wrapper
         and its return shape is not something to assume; an id diff needs no assumption and is
         replay-safe — a retried registration creates nothing new, so it re-marks nothing, and a
         row a human has since restored to payable is never touched again. */
      const preexisting = new Set();
      try {
        const r0 = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${body.batch_id}&select=id`);
        if (r0.ok) for (const x of await r0.json()) preexisting.add(x.id);
      } catch { /* an empty set is the safe default: the pass below simply does less */ }

      const results = [];
      for (let i = 0; i < docs.length; i++) {
        // Per-document request id, derived from the batch id — so a retried batch registration
        // replays instead of duplicating the very thing this module exists to catch.
        const out = await rpc('ryc_register_invoice', {
          p_batch_id: body.batch_id, p_rec: docs[i],
          p_request_id: `${rid}:${i}`, p_actor: actor,
        });
        results.push(out.status === 200
          ? { ok: true, ...out.body }
          : { ok: false, error: out.body.error, index: i });
      }
      const flagged = results.filter(r => r.ok && Array.isArray(r.flags) && r.flags.length).length;

      /* THE PACKAGE PASS. Marks this batch's supporting documents `not_ap` so one payable that
         arrived as invoice + pay application + lien waiver stands as ONE amount on a desk instead
         of three. Runs through `ryc_review_invoice` like any other decision, so it lands in the
         fact-event trail as a machine decision with its reason — never a silent PATCH, and always
         reversible from the desk. It must never fail the registration: the invoices are in the
         register either way, and a classification problem is not an intake problem. */
      let supporting = null;
      try {
        const rn = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${body.batch_id}`
          + '&select=id,version,doc_type,amount,vendor_name,review_state');
        if (rn.ok) {
          const fresh = (await rn.json()).filter(r => !preexisting.has(r.id));
          const marks = supportingDocuments(fresh)
            // A human decision already on the row outranks this pass, always.
            .filter(m => { const r = fresh.find(x => x.id === m.id); return r && (r.review_state === 'new' || r.review_state === 'ready'); });
          const done = [];
          for (const m of marks) {
            const out = await rpc('ryc_review_invoice', {
              p_id: m.id, p_decision: 'not_ap', p_reviewer: 'system',
              p_note: `Supporting document (${m.doc_type}) — ${m.reason}. Registered and filed; not a payable. Reverse from the desk if this is wrong.`,
              p_duplicate_of: null, p_identity_verified: false,
              p_expected_version: m.version, p_request_id: `${rid}:sup:${m.id}`, p_actor: actor,
            });
            if (out.status === 200) done.push({ id: m.id, doc_type: m.doc_type, reason: m.reason });
          }
          supporting = { marked: done.length, of: fresh.length, documents: done };
        }
      } catch (e) {
        supporting = { error: (e && e.message) || 'supporting-document pass failed' };
      }

      /* STAGE ON ARRIVAL. This is the "auto moves to the queue where the system stages it" half of
         the motion — the mailbox ingest calls `register`, so this is the moment the front office's
         screen either answers itself or records why it could not. It never fails the registration:
         the invoices are already in the register and a staging problem must not look like an
         intake problem. */
      let placement = null;
      try {
        const p = await stagingPass({ force: false });
        placement = p.error ? { error: p.error } : { staged: p.staged, unplaced: p.unplaced, note: p.note || null };
      } catch (e) {
        placement = { error: (e && e.message) || 'staging failed' };
      }

      return res.status(200).json({
        ok: true, registered: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length, flagged, results, placement, supporting,
      });
    }

    /* ---------- notification links (front office scope only) ---------- */
    if (action === 'mint_links') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      if (!process.env.RYC_INVOICE_LINK_SECRET) {
        return res.status(503).json({ error: 'RYC_INVOICE_LINK_SECRET is not set — links cannot be signed.' });
      }
      const hours = Math.min(Math.max(parseInt(body.hours, 10) || 72, 1), 24 * 14);
      const exp = Date.now() + hours * 3600 * 1000;
      const dir = pmDirectory();
      const seen = new Set();
      const links = [];
      for (const rec of Object.values(dir)) {
        if (!rec || !rec.pm || seen.has(rec.pm)) continue;
        seen.add(rec.pm);
        links.push({ pm: rec.pm, email: rec.email || null, token: signLink(rec.pm, exp) });
      }
      return res.status(200).json({ ok: true, expires_at: new Date(exp).toISOString(), links });
    }

    /* ---------- notify the PMs their batch is ready (front office scope only) ----------
       The email IS the front door: the signed link in it is the credential that binds the PM
       to their own queue. One mechanism does notification and siloing, which is why neither
       needs an account system to exist first. */
    if (action === 'notify') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const vmUrl = process.env.M365_VM_URL, vmKey = process.env.M365_VM_API_KEY;
      if (!vmUrl || !vmKey) return res.status(503).json({ error: 'M365 send is not configured.' });
      if (!process.env.RYC_INVOICE_LINK_SECRET) {
        return res.status(503).json({ error: 'RYC_INVOICE_LINK_SECRET is not set — links cannot be signed.' });
      }
      const base = String(body.base_url || 'https://app.civicscope.io').replace(/\/$/, '');
      const hours = Math.min(Math.max(parseInt(body.hours, 10) || 72, 1), 24 * 14);
      const exp = Date.now() + hours * 3600 * 1000;

      const dir = pmDirectory();
      const targets = new Map();
      for (const rec of Object.values(dir)) {
        if (rec && rec.pm && rec.email && !targets.has(rec.pm)) targets.set(rec.pm, rec.email);
      }
      if (!targets.size) {
        return res.status(400).json({
          error: 'No PM directory is configured. Set RYC_INVOICE_PMS to {"<code>":{"pm":"Name","email":"..."}}.',
        });
      }

      const sent = [];
      for (const [name, email] of targets) {
        const q = await rpc('ryc_invoice_queue', { p_pm: name, p_days: 30 });
        const rows = q.status === 200 && Array.isArray(q.body) ? q.body : [];
        const open = rows.filter(r => r.review_state === 'new' || r.review_state === 'ready');
        // Silence must mean "nothing waiting", never "the notifier broke". A PM with an empty
        // queue is simply skipped, and the response says how many were skipped and why.
        if (!open.length) { sent.push({ pm: name, skipped: 'nothing outstanding' }); continue; }
        const flagged = open.filter(r => Number(r.open_high) > 0).length;
        const value = open.reduce((a, r) => a + (Number(r.amount) || 0), 0);
        const link = `${base}/command/invoices?k=${encodeURIComponent(signLink(name, exp))}`;
        const html =
          `<p>${open.length} invoice${open.length === 1 ? '' : 's'} are waiting for your review`
          + ` (${value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}).</p>`
          + (flagged ? `<p><b>${flagged} need a decision before they can be approved.</b></p>` : '')
          + `<p><a href="${link}">Open your batch</a></p>`
          + `<p style="color:#666;font-size:12px">This link is personal to you and expires in ${hours} hours.`
          + ` Per-user sign-in is not live yet, so please do not forward it.</p>`;
        const r = await fetch(`${vmUrl}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': vmKey },
          body: JSON.stringify({
            to: email,
            subject: `${open.length} invoice${open.length === 1 ? '' : 's'} to review`,
            body: html,
            from_address: 'schedule@ryoderconstruction.com',
            from_name: 'RYC Invoices',
          }),
        });
        sent.push({ pm: name, ok: r.ok, status: r.status, outstanding: open.length, flagged });
      }
      return res.status(200).json({ ok: true, expires_at: new Date(exp).toISOString(), sent });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    // Ours only. Nothing from the request or the upstream reply reaches the log — this endpoint
    // carries confidential AP data.
    console.error('ryc-invoices: handler failed');
    return res.status(500).json({ error: 'Request failed.' });
  }
}
