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
  "notes": <anything a reviewer should see: overbilling summary, missing pages, hand-written marks>,

  "pay_app": null, OR — only when doc_type is "pay_application" — the figures below, read off THIS
  DOCUMENT and nothing else. Every one of them is optional: null is always a valid answer and is
  ALWAYS better than a number you are not reading off this page.
  {
    "current_payment_due": <number|null>,  the money that will actually be paid on this application,
                                       AFTER retainage and after previous payments. Labelled
                                       "CURRENT PAYMENT DUE", "AMOUNT DUE THIS APPLICATION",
                                       "TOTAL DUE THIS APPLICATION" or "PAYMENT DUE" — usually
                                       line 8 on a G702-style face sheet.
    "work_this_period": <number|null>, the value of work BILLED THIS PERIOD, before retainage.
                                       This is NOT on the G702 face sheet — it is the GRAND TOTAL of
                                       the "WORK COMPLETED THIS PERIOD" column on the G703
                                       continuation sheet (column E, the total row at the bottom),
                                       or a line labelled "WORK COMPLETED THIS PERIOD" /
                                       "THIS PERIOD" / "COMPLETED THIS PERIOD". Read the
                                       continuation sheet to get it. null if this document has no
                                       continuation sheet.
    "completed_and_stored": <number|null>, "TOTAL COMPLETED AND STORED TO DATE" — line 4 on the
                                       G702 face sheet, which is the GRAND TOTAL of column G on the
                                       continuation sheet. Read it whenever the form shows it.
                                       ⚠ THIS IS THE ONLY FIGURE THAT DESCRIBES A PAY APPLICATION
                                       BILLING NOTHING BUT STORED MATERIALS. Midwest Glass on White
                                       Veterinary Clinic reads column E (work this period) as a
                                       TRUE $0.00 because the whole $33,068.10 sits in column F,
                                       Materials Stored — so "work this period" describes it as
                                       zero while $25,051.50 is genuinely due. Without line 4 there
                                       is no honest number to put on that document.
    "eligible_to_date": <number|null>, "AMOUNT ELIGIBLE TO DATE" / "TOTAL EARNED LESS RETAINAGE"
                                       (line 6). null if the form does not show it.
    "less_previous": <number|null>,    "LESS PREVIOUS PAYMENTS" / "LESS PREVIOUS CERTIFICATES FOR
                                       PAYMENT" (line 7). null if the form does not show it.
    "completed_to_date": <number|null>,"TOTAL COMPLETED AND STORED TO DATE" (line 4, column G).
    "retainage": <number|null>         total retainage held (line 5). null if not shown.
  }
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

- ⛔ NEVER COPY A NUMBER OUT OF THESE INSTRUCTIONS. Every figure you return must be one you are
  reading off the pages in front of you. This rule exists because it has already been broken: on
  2026-08-21 a Niblock Excavating pay application came back carrying "eligible_to_date" 458866.44
  and "less_previous" 430578.67 — the two figures that used to appear in this prompt as a worked
  example from a DIFFERENT vendor's document. They were not on the Niblock form. Downstream
  arithmetic then "verified" the payable against them and reported high confidence in a number that
  came from the instructions rather than from the invoice. There are now no example amounts here at
  all. If you cannot read a figure off this document, return null.

- ⛔ IF THE FACE SHEET IS AN APPLICATION FOR PAYMENT, doc_type IS "pay_application". Nothing else
  overrides this — not length, not an invoice number, not the word INVOICE appearing somewhere on
  the page. The signals, any one of which settles it:
    * a title reading "APPLICATION AND CERTIFICATE FOR PAYMENT", "APPLICATION FOR PAYMENT",
      "CONTRACTOR'S APPLICATION FOR PAYMENT" or "CERTIFICATE FOR PAYMENT"
    * an "APPLICATION #" / "APPLICATION NO" / "PAY APP" / "PA<number>" field
    * the numbered G702 ladder — ORIGINAL CONTRACT SUM · NET CHANGE BY CHANGE ORDERS · CONTRACT SUM
      TO DATE · TOTAL COMPLETED AND STORED TO DATE · RETAINAGE · TOTAL EARNED LESS RETAINAGE ·
      LESS PREVIOUS CERTIFICATES · CURRENT PAYMENT DUE · BALANCE TO FINISH
    * a G703 CONTINUATION SHEET with the Work Completed / Materials Stored columns
  ⚠ A SUBCONTRACTOR OFTEN PRINTS THEIR OWN INVOICE NUMBER ON A PAY APPLICATION. Record it in
  "invoice_no" and STILL return "pay_application" — the two are not alternatives.
  This is written down because it was missed on a real document: The Bonilla Group's Application
  #7 on The Orchard on Wallen, **28 pages, $202,066.41**, came back as "invoice" with pay_app null,
  so the office found it in the invoice section and none of the figures below were ever read.

- ⛔ A PAY APPLICATION'S FACE SHEET CARRIES SEVERAL LARGE NUMBERS AND MOST OF THEM ARE NOT A BILL.
  The contract sum, the total completed and stored to date, the amount eligible to date and the
  previous payments are the story of the job so far — RYC has already paid most of that. Two
  figures describe THIS application and you must keep them apart and never swap them:
    * "work_this_period"      what was billed this period, BEFORE retainage (G703 column E total)
    * "current_payment_due"   what will be paid, AFTER retainage and previous payments (line 8)
  Set "amount" to "current_payment_due" when you can read it, otherwise leave "amount" null rather
  than substituting a to-date figure.
  NEVER take "amount" from: original or current contract sum · total completed and stored to date ·
  amount eligible to date · total earned less retainage · less previous payments · balance to
  finish · retainage · a hand-typed "billed to date" summary stapled behind the application.
  ⚠ "TOTAL EARNED LESS RETAINAGE" (line 6) is a TO-DATE figure and is the most common wrong answer,
  because the words "less retainage" make it look like a net payment. It is not. Line 8 is.
- Fill every other figure whenever the form prints it, even though it is not the payable. Line 6
  minus line 7 must equal line 8, and column E minus retainage-this-period must reconcile too, so
  they are how a misread digit gets caught — and a misread digit becomes a filename and then an
  archive entry that nobody re-checks.
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

/* ⛔ THE THIRD FAILURE CLASS: RIGHT PAGE COUNT, RIGHT TOTAL, WRONG OWNER.
   Found 2026-08-26 on the front office's own batch. The yellow Henschen Oil delivery ticket (p7)
   was swept onto the end of the Unum insurance invoice (p1-6), so Unum filed as p1-7 and Henschen
   filed as p8-8 alone. Every one of the 42 pages was claimed exactly once, the amounts were both
   correct, and the coverage rule — the check this whole pipeline leans on — passed cleanly,
   because it asks whether a page is claimed ONCE and never whether it is claimed by the RIGHT
   document. The reconciler could not have fixed it either: it only ever MERGES, and moving one
   page from a document to its neighbour is neither a merge nor a split.

   The cost is not the money — $1,149.77 was printed on both Henschen pages, so nothing was
   double-counted or lost. The cost is that the page carrying the JOB NAME and the COST CODE ended
   up inside an RYC Expense PDF, and the invoice that reached the job folder lost it.

   So this asks the one question nothing else in the pipeline asks. */
const BOUNDARY_SYSTEM = `You are checking ONE page boundary in a scanned accounts-payable batch.

A sliding-window reader has already cut the stack into documents. You are shown the LAST page of
one document — the page in question — with the page before it for context, and then the FIRST page
of the document that follows. One question only: does the page in question belong to the document
that currently claims it, or is it really the first page of the next one?

This exists to catch a specific thing: a one-page delivery ticket, hand-written slip or carbon
invoice sitting between two typed invoices gets swept onto the end of the document above it. Every
page is still claimed exactly once, so no arithmetic and no coverage check can see it. The page is
simply filed inside somebody else's PDF, and the payable it belonged to loses the page carrying its
job name and cost code.

Return ONE JSON object, nothing else, no prose, no code fence:
{ "belongs_to": "current" | "next",
  "vendor_on_page": "<the vendor printed on the page in question, exactly as printed, or null>",
  "reason": "<what is printed on the page that settles it>" }

Decide from what is PRINTED on the page in question:
 - a different company's name, address or logo in its own header, matching the NEXT document's
   vendor -> "next"
 - an invoice or ticket number matching the next document's -> "next"
 - its own grand total, matching the next document's amount rather than the current one's -> "next"
 - "Page N of M", a continued total, a running invoice number, a remittance stub, a signature
   block or a terms-and-conditions back page belonging to the document above -> "current"
 - a grand total equal to the CURRENT document's amount -> "current"

DEFAULT TO "current". Moving a page is only right when the page is visibly a different document.
A genuine continuation page moved onto the next document strands its own invoice in exactly the way
this check exists to prevent — the same damage, mirrored. If the page is blank, illegible, a
separator, or you are weighing a resemblance rather than something printed, answer "current".`;

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

/* One boundary, one answer. Deliberately NOT batched over the whole stack: the reconciler already
   demonstrates that a model shown everything at once reasons about the set, and the only thing
   wanted here is a narrow judgement about one page with its immediate neighbours in view. */
async function auditBoundary(images, current, next) {
  const content = images.map(im => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data },
  }));
  content.push({
    type: 'text',
    text: 'The images above are, in order: the page before the one in question (when there is one),'
      + ' THE PAGE IN QUESTION, then the first page of the next document.\n\n'
      + `The document that currently claims it:\n${JSON.stringify(current, null, 1)}\n\n`
      + `The next document:\n${JSON.stringify(next, null, 1)}\n\n`
      + 'Return the ruling JSON.',
  });
  const out = await claudeJson(BOUNDARY_SYSTEM, content, 700);
  if (out.status !== 200) return out;
  const b = out.body.belongs_to;
  if (b !== 'current' && b !== 'next') {
    return { status: 502, body: { error: 'Boundary check returned an unusable response.' } };
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

/* ===== GREENCROFT: THE COMMUNITY IS PRINTED, THE UNIT IS THE JOB ======================
   ⛔ MEASURED 2026-08-26 against the live 53-job feed, on Logan Moore's real weekly batch
   (10 pages, `G:\My Drive\RYC Dashboard\Invoice Tool\Greencroft`). The matcher placed 3 and
   TWO OF THE THREE WERE WRONG — Miller's Building Supply $5,268.17 and a $670 Beer & Slabaugh
   dumpster both landed on `2502GP12 Goshen WWTP Anaerobic Digester`. One of ten was right, on
   the family that is 29 of the 53 active jobs and the whole of one PM's desk.

   Three separate causes, each measured rather than supposed:

   1. THE WORD THE VENDORS USE FOR THE COMMUNITY EXISTS IN NO JOB NAME. `southfield`, `village`,
      `whispering` and `pine` are owned by ZERO jobs in the feed. Procore calls that South Bend
      street `Chestnut`; every vendor billing it writes "Southfield Village". Same shape as the
      WWTP/WTP contraction: CONTRACT the vendor's phrase to the token RYC's own job names carry.
      Expanding RYC's token into generic words is the move that files one plant into another.

   2. `goshen` IS DISTINCTIVE AND IT BELONGS TO THE WASTEWATER PLANT. Exactly one job in the feed
      carries the word — the anaerobic digester — and not one of the 24 Greencroft Goshen duplexes
      does. So an invoice printing the community AND the city (which is what Miller's prints, and
      what the dumpster ticket prints) scores a distinct hit on a WWTP and nothing at all on the
      street it was delivered to. A city name that is distinctive only by accident of this feed
      must never outrank a community the invoice actually names.

   3. A BARE HOUSE NUMBER WAS DISCARDED FOR BEING SHORT. `MIN_LONE` is 6, so "6516" was refused as
      "too weak" — while being, measured across all 101 jobs Procore and Foundation know between
      them, unique to exactly one. Every Greencroft house number is unique. The ONLY exceptions
      are Middlebury's `525` and `529`, each naming both a Pkwy lot and a Crystal Rg lot, and
      those must stay ambiguous forever.

   ⚠ THE FIX CREATES ITS OWN MIRROR RISK, AND THAT IS WHY A NUMBER MUST BE AN ADDRESS.
   The Beer & Slabaugh ticket reads "Waste Containers 2026" — the YEAR — and `Greencroft 2026 WPC`
   is a real unit on that very street. Accepting any number that happens to name a unit in the
   family would file a shared dumpster confidently onto one resident's duplex: the same
   misattribution as before, arriving through the fix. So a number counts only where it sits
   ADJACENT to the community phrase, which is what makes it a street address rather than a year, a
   ZIP or a quantity. "2048 WHISPERING PINE CT" and "6516 Southfield Village" qualify;
   "Waste Containers 2026" and "Indiana 26001" do not.

   WHAT IT DELIBERATELY CANNOT DO IS ALSO THE POINT. When the community is named and the unit is
   not — five of the ten pages, and the front office had already written "Which units?" on a teal
   sticky on every one of them — this returns a FAMILY instead of a job. That is not a refusal:
   the desk, the customer and a candidate list of 4 to 21 are all known, so the invoice reaches
   the PM already narrowed and the question he answers is one tap rather than a phone call. */

/* The vendor's words on the left; the token RYC's own job names carry on the right. Order
   matters — "southfield village" must be consumed before the bare "southfield". */
const COMMUNITY_ALIASES = [
  [/\bgreen\s+croft\b/g,                       'greencroft'],   // Miller's spells it both ways
  [/\bsouthfield\s+village\b/g,                'chestnut'],
  [/\bsouthfield\b/g,                          'chestnut'],
  [/\bwhispering\s+pines?\s*(?:ct|court)?\b/g, 'wpc'],
  [/\bmiddlebury\b/g,                          'midd'],
];

/* Most specific first; the first signal present in the text wins. `greencroft` is the backstop —
   the community was not identified, but the family and therefore the desk still are.

   `misc` is the job Foundation ALREADY absorbs a genuinely shared Greencroft cost into — one
   dumpster serving five duplexes, a stock buy of door hardware. Those two buckets are not new:
   `2105CO09 Misc jobs-Greencroft` carries $128K of costs and `2518RO06 Greencroft
   Southfield-MiscWork` $8K, both Logan's, both zero-contract. They are FOUNDATION-ONLY, so the
   auto-matcher can reach them only by a printed number, which no invoice ever carries — the
   ending accounting already uses is the one the tool could not offer. Resolved against the live
   feed at read time rather than trusted from here, so a closed or renamed bucket removes the
   button instead of assigning a dead job. */
const FAMILIES = [
  { key: 'greencroft-goshen',     signal: 'wpc',        misc: '2105CO09',
    label: 'Greencroft Goshen (Whispering Pine Ct)' },
  { key: 'greencroft-southbend',  signal: 'chestnut',   misc: '2518RO06',
    label: 'Greencroft South Bend (Southfield Village)' },
  { key: 'greencroft-middlebury', signal: 'midd',       misc: '2105CO09',
    label: 'Greencroft Middlebury' },
  { key: 'greencroft',            signal: 'greencroft', misc: '2105CO09',
    label: 'Greencroft' },
];

function aliasText(s) {
  let t = ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const [re, to] of COMMUNITY_ALIASES) t = t.replace(re, ` ${to} `);
  return t.replace(/\s+/g, ' ').trim();
}

/* THE DESK OF A COMMUNITY. Logan Moore owns every Greencroft unit but one — `2416RO07 Greencroft
   2032 WPC`, where Procore names Erik Parcell and Foundation has no row for the job at all, which
   is the weakest signal the feed can carry and a question for a person rather than something to
   encode around. A community invoice must not be held back over a single dissenting unit: an
   unrouted payable sits unlooked-at, which is the failure `ryc_release_invoices` exists to
   prevent. So the desk is the PM who owns EVERY candidate but at most one. A family split any
   more evenly than that has no desk, and says so. */
function familyDesk(candidates) {
  const tally = new Map();
  for (const c of candidates) if (c.pm) tally.set(c.pm, (tally.get(c.pm) || 0) + 1);
  if (!tally.size) return null;
  const [pm, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return (candidates.length - n) <= 1 ? pm : null;
}

/* Returns a job, a FAMILY, or null to let the ordinary scorer have the text unchanged.
   Candidates always carry `greencroft` as well as the community token, so a future
   "Middlebury Schools" job can never be drawn into a Greencroft community. */
function familyMatch(text, jobs) {
  const seq = aliasText(text).split(' ').filter(Boolean);
  const toks = new Set(seq);
  const fam = FAMILIES.find(f => toks.has(f.signal));
  if (!fam) return null;

  const candidates = jobs.filter(j => {
    const t = jobTokens(j.name);
    return t.has('greencroft') && t.has(fam.signal);
  });
  if (candidates.length < 2) return null;   // not a family here; nothing gained by intercepting

  /* A number is a house number only where it touches the street. See the mirror-risk note. */
  const addresses = new Set();
  seq.forEach((w, i) => {
    if (w !== fam.signal) return;
    for (const k of [i - 1, i + 1]) {
      if (seq[k] && /^[0-9]{2,5}$/.test(seq[k])) addresses.add(seq[k]);
    }
  });

  const hits = [];
  for (const j of candidates) {
    const t = jobTokens(j.name);
    for (const n of addresses) if (t.has(n)) { hits.push({ job: j, n }); break; }
  }
  if (hits.length === 1) {
    return { job: hits[0].job, hits: [hits[0].n, fam.signal], conf: 0.92,
      why: `${hits[0].n} on ${fam.label} is ${hits[0].job.name}` };
  }

  /* Ambiguous by number (Middlebury's 525/529) narrows to the tied units; no number at all
     narrows to the whole community. Both are the same state — the unit is the open question. */
  const pool = hits.length > 1 ? hits.map(h => h.job) : candidates;
  const why = hits.length > 1
    ? `${pool.length} ${fam.label} jobs are numbered ${[...addresses].join('/')} — which unit is not printed`
    : `${fam.label} is named but the unit is not — ${pool.length} to choose from`;
  return {
    job: null, why,
    family: { key: fam.key, label: fam.label, pm: familyDesk(pool),
      candidates: pool.map(j => ({ no: j.no, name: j.name, pm: j.pm || null })) },
  };
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
  /* THE COMMUNITY BRANCH RUNS BEFORE THE GENERAL SCORER, AND THAT ORDER IS THE FIX. Left to the
     scorer, `goshen` wins on distinctiveness against a family whose 24 members share every word
     they have — which is exactly how a duplex invoice reached a wastewater plant. A printed job
     number still beats this, because that is the thing itself rather than a resemblance. */
  const fam = familyMatch(raw, jobs);
  if (fam) return fam;

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

/* An invoice number as an identity: the vendors print `#62371`, `62371`, `INV-62371` for one
   document, and the front office types whichever it sees. */
function invoiceNoKey(no) {
  return String(no || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* ⛔ A RE-SCANNED INVOICE WAS BEING CAUGHT BY SHAREPOINT OR NOT AT ALL, AND BOTH ENDINGS ARE BAD.
   Measured 2026-09-03: the `approved 9326gc` batch re-scanned two Leatherman invoices the
   `approved 82626GC2` batch had already filed on 08-31. #62371 travelled the whole pipeline — read,
   reconciled, filed to the batch folder, routed to a job, submitted — and was stopped only by an
   HTTP 409 forty minutes later, surfaced as "REFUSED — a file already exists" with no mention of
   the batch that put it there. `check_duplicates()` has existed in file_invoice.py the whole time,
   against three years of the archive, and nothing on this path calls it.

   ⛔ AND THE 409 CANNOT BE RELIED ON, BECAUSE IT COMPARES NAMES. The other duplicate in that same
   batch, #62316 for $980.72, had been filed as SIX share-renamed copies (`163.46`, `163.45`…) —
   so re-filing it whole would upload `Leatherman Supply  980.72  08-24-26.pdf`, a name that exists
   in none of those folders, and land silently. The guard that saved the first invoice was
   structurally unable to save the second. This asks the question the filename cannot: is this
   vendor's document already in the register, filed, from another batch.

   A MATCH IS A QUESTION, NEVER A VERDICT — the same doctrine `check_duplicates` is written under.
   `exact` means the invoice numbers agree and is strong enough to withhold the tick; `possible`
   means the vendor, amount and date agree with no invoice number to confirm it, and only warns.
   A vendor genuinely billing the same amount twice is real (recurring dumpster and supply charges
   run to the cent), so refusing outright would be wrong.

   Pure: `documents` is this batch, `prior` is already-reconciled rows from OTHER batches. */
function priorFilings(documents, prior) {
  const byKey = new Map();
  for (const p of prior) {
    if (!p || p.reconciled_at === null || p.reconciled_at === undefined) continue;
    const ak = amountKey(p.amount);
    if (ak === null) continue;
    const k = `${vendorKey(p.vendor)}|${ak}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }
  const out = {};
  for (const d of documents) {
    if (!d || d.reconciled_at) continue;          // a settled row is not being filed again
    const ak = amountKey(d.amount);
    if (ak === null) continue;
    const cands = byKey.get(`${vendorKey(d.vendor)}|${ak}`) || [];
    /* Same batch is not a duplicate: a two-page scan legitimately produces two rows, and the
       split-vs-whole question inside one batch is the reconciler's job, not this one's. */
    const others = cands.filter(p => String(p.batch_id) !== String(d.batch_id));
    if (!others.length) continue;
    const mine = invoiceNoKey(d.invoice_no);
    const exact = mine ? others.find(p => invoiceNoKey(p.invoice_no) === mine) : null;
    /* Without invoice numbers on both sides, the file name's own date is the only other thing the
       archive convention carries. Same vendor + same amount + same date is a question worth asking;
       same vendor + same amount alone is not, and would flag every recurring charge in the batch. */
    const dated = exact ? null : others.find(p => nameDate(p.file_name)
      && nameDate(p.file_name) === nameDate(d.file_name));
    const hit = exact || dated;
    if (!hit) continue;
    const paths = (Array.isArray(hit.copies) ? hit.copies : [])
      .filter(c => c && !c.error && c.path).map(c => c.path);
    out[d.id] = {
      strength: exact ? 'exact' : 'possible',
      invoice_no: hit.invoice_no || null,
      file_name: hit.file_name || null,
      batch_folder: hit.batch_folder || null,
      reconciled_at: hit.reconciled_at || null,
      disposition: hit.disposition || null,
      paths: paths.slice(0, 8),
    };
  }
  return out;
}

/* The `MM-DD-YY` the archive convention puts in every filed name. Read off the name rather than a
   column because it is what the office looks a file up by, and it is stable across the register's
   several date fields (received stamp, batch date, invoice date) which are deliberately not equal. */
function nameDate(name) {
  const m = String(name || '').match(/\b(\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

/* Exported for the regression harness (scripts/verify-ryc-invoice-matcher.mjs). Not a route.
   The matcher, the desk rule and the payable classifier are the pieces of this module with real
   logic and no I/O, so they are the pieces that can be tested exhaustively without touching
   production. */
/* RYC EXPENSE IS AN ANSWER, NOT A BLANK. Keith, 2026-08-19: *"create a fake job RYC Expense for
   those invoices that are not attributed to a specific project."* Plenty of real payables belong to
   no job at all — fleet fuel, finance charges, a card-lock account, capital equipment shipped to
   RYC's own yard; the 2026-08-13 batch alone had six. Before this they sat in the queue looking
   unresolved forever, which is how a reconciliation queue stops being read. It is a LABEL in this
   directory only: nothing is created in Procore or Foundation, and nothing is copied anywhere. */
const RYC_EXPENSE = { no: 'RYC-EXPENSE', name: 'RYC Expense', expense: true };

/* SharePoint rejects these in an item name. Mirrors `sanitise()` in file_invoice.py — the front
   office should be told before the rename is queued, not after the worker refuses it. */
const SP_ILLEGAL = /[\\/:*?"<>|]/;

/* Test jobs are not real work and must never be a filing destination. Everything else in the
   Foundation list IS real — including warranty work and the two PMs' own residences, which the
   AUTO-MATCHER still refuses (an invoice reading "Brad Yoder" would land on one confidently and
   wrongly) but a person may deliberately choose. Those are different acts and get different lists. */
const NOT_A_REAL_JOB = /^\s*TEST\s+JOB\b/i;

function pickableJobs(dir) {
  const out = [];
  const seen = new Set();
  for (const j of [...(dir.jobs || []), ...(dir.foundationOnly || [])]) {
    const no = String(j.no || '').trim();
    const name = String(j.name || '').trim();
    if (!no || seen.has(no) || NOT_A_REAL_JOB.test(name)) continue;
    seen.add(no);
    out.push({ no, name: name || no, pm: j.pm || null, active: j.active !== false,
      in_procore: j.in_procore !== false });
  }
  out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;   // live jobs first; the rest still there
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return [RYC_EXPENSE, ...out];
}

export const __matcher = { matchJob, tokenIndex, jobTokens, jobNoKey };
/* The community rule, exported for the gate. `aliasText` and `familyDesk` are asserted directly
   rather than only through `matchJob`: the alias table is the piece a future community gets added
   to, and the desk rule is the piece whose failure mode is silent (an invoice held back forever
   because one unit in a street disagrees about its PM). */
export const __family = { familyMatch, familyDesk, aliasText, FAMILIES, COMMUNITY_ALIASES };
export const __pm = { resolveJobPm, resolveJobPmSource };
export const __payable = { supportingDocuments, vendorKey, NEVER_PAYABLE };
/* Pure and I/O-free on purpose, so scripts/verify-ryc-duplicate-scan.mjs drives the REAL function
   rather than re-deriving the rule beside it — a test that re-implements what it guards guards
   nothing, which this module has now paid for twice. */
export const __dupes = { priorFilings, invoiceNoKey, nameDate };
/* The batch coverage rule. `batch_confirm` (a person confirmed these boundaries) and
   `batch_autoconfirm` (the reconciler resolved them) both call this ONE function, so the machine
   route can never reach SharePoint through a laxer door than the human one. Exported so the gate
   asserts the rule itself rather than a copy of it — this module has been bitten three times by one
   rule written twice, once inside the test meant to catch it. */
export const __manifest = { validateManifest };
/* The filing destinations a PERSON may choose. Exported because the widening here is deliberate
   and easy to undo by accident: this list is broader than the auto-matcher's on purpose, and the
   only things excluded are the test jobs. A gate that asserts it keeps the two lists from silently
   converging again. */
export const __targets = { pickableJobs, RYC_EXPENSE, NOT_A_REAL_JOB };


export default async function handler(req, res) {
  /* MIGRATION MAINTENANCE SWITCH (2026-09-05). While RYC_MAINTENANCE is set on this Vercel project
     the register on THIS origin refuses every action — including the Storage signing and page
     uploads that a database freeze cannot reach. It is switched on in Phase 0 of the cutover to
     command.ryoderconstruction.com and never switched off: after the cutover this handler is
     retired with the rest of the RYC module. */
  if (process.env.RYC_MAINTENANCE) {
    res.setHeader('Retry-After', '3600');
    return res.status(503).json({ error: 'The RYC invoice register has moved to https://command.ryoderconstruction.com/invoices', moved: 'https://command.ryoderconstruction.com/invoices' });
  }
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
      'reconcile', 'adjudicate', 'boundary', 'batch_autoconfirm', 'batch_documents_register',
      'doc_copy_claim', 'doc_copy_done', 'doc_rename_done',
      /* The stamp queue (migration 060). Same shape and same reasoning as the copy queue: the page
         says WHAT is eligible, the machine holding the SharePoint credential does the work and
         reports what happened. Stamping rewrites a PDF in a live SharePoint folder, so a browser
         must no more be able to claim one than to claim a copy. */
      'doc_stamp_claim', 'doc_stamp_done',
      /* The VM publishes what folders SharePoint holds and reads back the overrides a person set.
         Neither creates a payable; both are the filer's own job. */
      'job_folders_publish', 'job_folder_map',
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
    'batch_autoconfirm',
    /* A page must never be able to assert that a document was filed into a live job folder, nor to
       register what "was filed" in the first place. Both are claims about SharePoint, and only the
       machine holding the SharePoint credential is in a position to make one. */
    'batch_documents_register', 'doc_copy_claim', 'doc_copy_done', 'doc_rename_done',
    /* A page must not be able to assert that a stamp was burned into a file in SharePoint, for the
       same reason it cannot assert a copy: the claim is about a filing system it cannot see. */
    'doc_stamp_claim', 'doc_stamp_done',
    /* WHICH FOLDERS EXIST is a claim about SharePoint. A page asserting it could put destinations
       in the picker that are not there, and the pin would then fail on the copy — relocating the
       failure instead of ending it. Reading the list back (`job_folders`) is the browser's route. */
    'job_folders_publish']);
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
        + `&company_id=eq.ryc&select=page_from,page_to,batch_id,assigned_pm,vendor_name,amount`);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the document.' });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Document not found.' });
      const inv = rows[0];
      // A PM may only open scans from their own queue.
      if (who.scope === 'pm' && inv.assigned_pm !== who.pm) {
        return res.status(404).json({ error: 'Document not found.' });
      }
      const br = await sb(`ryc_invoice_batches?id=eq.${inv.batch_id}`
        + '&select=document_uri,source_message_id');
      const batch = br.ok ? (await br.json())[0] : null;
      const uri = batch && batch.document_uri;
      const m = /^storage:([^/]+)\/(.+)$/.exec(uri || '');
      if (!m) {
        /* ⛔ THE FOLDER IS NOT THE INVOICE. Keith, 2026-08-31, walking Logan through his first
           batch: *"the View button opens the sharepoint folder where the batch lives - it should
           open the actual invoice preview."* A scanned batch's `document_uri` is the Invoice Desk
           FOLDER, so this returned the folder and the desk dutifully opened it — handing a PM
           being asked to approve $670 a directory listing to hunt through, on the one screen
           where the point is looking at the page in front of you.

           The link he wants already exists and always did: every row in `ryc_batch_documents`
           carries `sp_url`, the direct link to its own PDF. Nothing here had ever read it.

           ⚠ AN AMBIGUOUS MATCH OPENS NOTHING. Handing a PM the WRONG invoice while he is
           approving money is worse than handing him the folder, so a document is resolved only
           when exactly one candidate survives: first on the page range, which partitions a batch
           in both shapes (an email PDF split into ranges, and a scan folder numbered 1..n), then
           on this module's own vendor+amount key. Two identical Arctic invoices for $71,620.92
           are sitting in this register right now — that is precisely the collision the second key
           cannot settle, and on a tie this falls back to the folder and says so. */
        let docUrl = null, docName = null, note = null;
        const src = batch && batch.source_message_id;
        const scanId = src && String(src).startsWith('scan:') ? String(src).slice(5) : null;
        if (scanId) {
          const dr = await sb(`ryc_batch_documents?company_id=eq.ryc&batch_id=eq.${scanId}`
            + '&select=seq,page_from,page_to,vendor,amount,sp_name,sp_url&order=seq.asc');
          if (dr.ok) {
            const docs = (await dr.json()).filter(d => d.sp_url);
            let hit = null;
            const byPage = docs.filter(d => d.page_from === inv.page_from
                                         && d.page_to === inv.page_to);
            if (byPage.length === 1) hit = byPage[0];
            if (!hit) {
              const want = `${vendorKey(inv.vendor_name)}|${amountKey(inv.amount)}`;
              const byKey = docs.filter(d => `${vendorKey(d.vendor)}|${amountKey(d.amount)}` === want);
              if (byKey.length === 1) hit = byKey[0];
              else if (byKey.length > 1) {
                note = `${byKey.length} documents in this batch have the same vendor and amount — `
                  + 'opened the batch folder rather than risk the wrong page.';
              }
            }
            if (hit) { docUrl = hit.sp_url; docName = hit.sp_name || null; }
          }
        }
        return res.status(200).json({ ok: true, stored: false,
          uri: docUrl || uri || null,
          is_document: !!docUrl,
          file_name: docName,
          note: note || (docUrl ? null : 'This batch has no stored scan; its document_uri is a plain link.') });
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
      /* WHICH OF THESE BATCHES HAS ALREADY BEEN HANDED OVER (migration 060). Without this the desk
         only knows about a submission it performed in the current tab: a PM who submits, closes the
         browser and comes back is shown a live Submit button on a folder already sitting with the
         front office. Pressing it is harmless — the server answers `already` — but a control that
         offers to do something already done is the same class of lie as the summary button it
         replaced. */
      if (rows.length) {
        try {
          const bids = [...new Set(rows.map(r => r.batch_id).filter(Boolean))];
          if (bids.length) {
            const sr = await sb('ryc_invoice_batch_submissions?company_id=eq.ryc'
              + `&batch_id=in.(${bids.join(',')})&select=batch_id,pm,submitted_at,submitted_by`);
            if (sr.ok) {
              const by = {};
              for (const s of await sr.json()) by[`${s.batch_id}|${s.pm}`] = s;
              for (const r of rows) {
                const s = by[`${r.batch_id}|${r.assigned_pm}`];
                r.batch_submitted_at = s ? s.submitted_at : null;
                r.batch_submitted_by = s ? s.submitted_by : null;
              }
            }
          }
        } catch { /* the desk still works without it; it just cannot say what was handed over */ }
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
      /* The LIST hides dismissed rows; asking for one BY ID still returns it. A dismissed batch is
         off the front office's board, not erased — "what happened to that batch" has to stay
         answerable, and a watch link already in someone's hand must not 404. */
      const q = id
        ? `ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=*`
        : 'ryc_batch_jobs?company_id=eq.ryc&dismissed_at=is.null'
          + '&select=id,filename,folder,status,phase_note,page_count,pages_read,folder_url,error,created_at'
          + '&order=created_at.desc&limit=8';
      const r = await sb(q);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the batch.' });
      const rows = await r.json();

      /* ⛔ "FILED" IS NOT "FINISHED", AND THE BOARD COULD NOT TELL THEM APART (Keith, 2026-08-20):
         *"when a batch is complete it should be labled as such, and set aside from any outstanding
         batches."* `status` only ever describes the FILING half — the documents reached the dated
         archive folder. The second half is human: every payable assigned to a job or marked RYC
         Expense. A batch sitting at `filed` with three unreconciled invoices looked exactly like
         one that was genuinely done, so the front office had to open each row to find out which.
         Counting it here rather than in the page keeps ONE definition of "complete"; deriving it
         a second time in the browser is how the two surfaces start disagreeing. */
      if (!id && rows.length) {
        const ids = rows.map(x => x.id).filter(Boolean);
        const dr = await sb(`ryc_batch_documents?company_id=eq.ryc&batch_id=in.(${ids.join(',')})`
          + '&select=batch_id,reconciled_at,copy_error,stamp_state&limit=5000');
        if (dr.ok) {
          const tally = {};
          for (const d of await dr.json()) {
            const t = tally[d.batch_id]
              || (tally[d.batch_id] = { docs: 0, done: 0, failed: 0, stamping: 0, stamped: 0, stamp_failed: 0 });
            t.docs++;
            if (d.reconciled_at) t.done++;
            else if (d.copy_error && d.copy_error !== 'working') t.failed++;
            /* STAMPING IS PROGRESS, NOT A GATE (migration 060). It is counted here so the board can
               say "stamping 3 of 5" while it happens — Keith, 2026-08-27: *"the user would expect
               something onscreen letting them know the process is running."* Nothing below reads
               these counts to decide whether the batch may be worked on. */
            if (d.stamp_state === 'pending' || d.stamp_state === 'working') t.stamping++;
            else if (d.stamp_state === 'done') t.stamped++;
            else if (d.stamp_state === 'failed') t.stamp_failed++;
          }
          for (const x of rows) {
            const t = tally[x.id] || { docs: 0, done: 0, failed: 0, stamping: 0, stamped: 0, stamp_failed: 0 };
            x.docs = t.docs; x.docs_done = t.done; x.docs_failed = t.failed;
            x.stamping = t.stamping; x.stamped = t.stamped; x.stamp_failed = t.stamp_failed;
            /* A batch with NO registered documents is not complete — it is a run that never got
               that far. Completion is a positive statement about payables, never the absence of
               anything to check. */
            x.reconciled = t.docs > 0 && t.done === t.docs;
          }

          /* ===== THE RETURN HALF: WHAT THE PM HAS DONE WITH IT ==========================
             ⛔ THE BOARD SAID "5 of 5 outstanding" ON A BATCH THAT WAS SITTING ON LOGAN'S DESK, so
             it read as waiting on the front office when it was waiting on him. Keith: *"Approve
             moves it down - what it should do is move it to a batch for erica to reoncile as the
             next step."*

             ⚠ NO WORKER, AND NO SECOND BATCH OBJECT. He asked whether something collects the
             approvals and presents them as a batch — it does not need to. The batch never left her
             screen; it just never knew what was happening to it. Two objects representing one
             folder is how the two sides start disagreeing, and this module has paid for that shape
             three times. So this is a READ: the scan's register batch is found by the same
             `scan:{id}` key `batch_to_desk` writes, and its payables are counted.

             ⛔ THE HANDOFF IS NO LONGER DERIVED FROM THE COUNT (migration 060, 2026-08-27). This
             used to read `awaiting_pm = decided < total`, which meant a batch left the PM's desk
             the instant its last payable happened to acquire a decision — nobody handed it over, it
             simply stopped counting. Keith: *"when all invoices have been approved logan should need
             to press a master submit button for the batch he is on."* So the question this asks is
             now "is there a submission row", and the decided-count survives only to TELL HER how far
             he has got: a batch he has half-worked reads "4 of 5 approved · not submitted" rather
             than sitting under With the PM looking untouched. */
          const keys = rows.map(x => `scan:${x.id}`);
          const rb = await sb('ryc_invoice_batches?company_id=eq.ryc&select=id,source_message_id'
            + `&source_message_id=in.(${keys.map(k => `"${k}"`).join(',')})`);
          if (rb.ok) {
            const regBatches = await rb.json();
            if (regBatches.length) {
              const byScan = {};
              for (const b of regBatches) byScan[String(b.source_message_id).slice(5)] = b.id;
              const ir = await sb('ryc_invoices?company_id=eq.ryc'
                + `&batch_id=in.(${regBatches.map(b => b.id).join(',')})`
                + '&select=batch_id,review_state,assigned_pm,amount&limit=5000');
              if (ir.ok) {
                const per = {};
                for (const i of await ir.json()) {
                  const p = per[i.batch_id] || (per[i.batch_id] = { total: 0, decided: 0, pm: null });
                  p.total++;
                  /* `not_ap` and `rejected` are decisions too — a supporting document nobody has to
                     approve must not hold the batch on his desk forever. */
                  if (['approved', 'rejected', 'not_ap', 'duplicate'].includes(i.review_state)) p.decided++;
                  if (i.assigned_pm && !p.pm) p.pm = i.assigned_pm;
                }
                /* WHO HAS ACTUALLY HANDED IT OVER. Absence of a row is the default and it means
                   "still his", which is what makes migration 060 a no-op for every batch in flight
                   on the day it ships. */
                const sub = {};
                const sr = await sb('ryc_invoice_batch_submissions?company_id=eq.ryc'
                  + `&batch_id=in.(${regBatches.map(b => b.id).join(',')})`
                  + '&select=batch_id,pm,submitted_at,submitted_by&limit=1000');
                if (sr.ok) for (const s of await sr.json()) sub[s.batch_id] = s;
                for (const x of rows) {
                  const p = per[byScan[x.id]];
                  if (!p || !p.total) continue;
                  const s = sub[byScan[x.id]] || null;
                  x.pm = p.pm;
                  x.payables = p.total;
                  x.payables_decided = p.decided;
                  x.submitted_at = s ? s.submitted_at : null;
                  x.submitted_by = s ? s.submitted_by : null;
                  /* The batch is his until HE SAYS it is hers. Then the copy to the job folder — the
                     thing that files it — happens at her reconcile, on a document his submit has
                     already stamped. */
                  x.awaiting_pm = !s;
                }
              }
            }
          }
        }
      }
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

    /* TAKE A FINISHED BATCH OFF THE BOARD. Keith, 2026-08-19, looking at a red Python traceback
       from the previous day sitting directly under the successful re-run of the same PDF: *"still
       broken?"* It was not. The list simply could not forget, so a stale error was indistinguishable
       from a live one — the same defect as `proposed` once painting the "waiting for you" state as a
       moving progress bar. A screen that cannot forget eventually stops being read.

       ⛔ IT REFUSES WHILE THE MACHINE IS WORKING. Hiding a batch mid-render, mid-read or mid-upload
       would take a run that is actively writing into RYC's SharePoint off the only screen that
       shows it. Those states are the worker's, not a button's.

       For a batch that is merely WAITING — `new`, `uploaded`, `proposed` — dismissing also ABANDONS
       it, because a hidden job must never act later. That is one honest meaning ("I am done with
       this") rather than a hidden row that quietly files 129 pages an hour from now. Nothing is
       deleted either way: the row, its manifest, its verification and its error text all remain, and
       `batch_status` by id still returns it. */
    if (action === 'batch_dismiss') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id is required.' });
      const cur = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=status,folder`);
      const job = cur.ok ? (await cur.json())[0] : null;
      if (!job) return res.status(404).json({ error: 'No such batch.' });
      const WORKING = ['rendering', 'reading', 'reconciling', 'filing'];
      if (WORKING.includes(job.status)) {
        return res.status(409).json({
          error: `"${job.folder}" is ${job.status} right now — it is being worked. Let it finish; `
            + 'it can be dismissed once it is done.' });
      }
      const abandon = ['new', 'uploaded', 'proposed'].includes(job.status);
      const patch = { dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      if (abandon) {
        patch.status = 'failed';
        patch.error = 'dismissed before it was confirmed';
        patch.phase_note = 'dismissed';
      }
      const r = await sb(`ryc_batch_jobs?id=eq.${id}&dismissed_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not dismiss the batch.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That batch is already dismissed.' });
      return res.status(200).json({ ok: true, abandoned: abandon, job: rows[0] });
    }

    /* ===================== RECONCILING A FILED BATCH ==============================
       Keith, 2026-08-19: *"this is a reconciliation process for the front office - as part of their
       process each invoice needs to be filed to its proper job folder or assigned as RYC Expense in
       which case it is not filed in jobs folder. Further, we'll need to make sure that
       reconciliation is done and cannot be done again (duplicated)."*

       Filing the batch put every payable in one dated folder. That is the ARCHIVE. Reconciling is
       the second, human half: each document is either copied into its job's Vendor Invoices folder
       or declared RYC Expense — an overhead cost that belongs to no job and is deliberately filed
       nowhere. Both are finished states. The difference is whether a file moved, not whether a
       decision was made.

       ⛔ EVERY WRITE HERE GUARDS ON `reconciled_at is null`, so a second click changes zero rows and
       is told so. A retry after a FAILED copy is still allowed — that is the difference between
       "not done yet" and "done" — but nothing can be reconciled twice. See migration 013. */
    /* ===== LOOK AT THE SCAN WHILE CONFIRMING IT ==================================
       Keith, 2026-09-01, on the confirm screen: *"I clicked view and see this - but no way to
       actually view the scan..."* The screen asks the one question only the paper can answer —
       where does each document start and end — and offered no way to see the paper. Every other
       screen in this module has a View: the PM desk opens the page, the reconcile board opens the
       filed PDF. The screen whose entire job is a boundary decision had none.

       ⚠ THE RENDERED PAGES DO NOT EXIST TO SERVE. `do_render` rasterises in memory, ships the
       images to the reader and drops them — nothing is stored per page, so there is no `pages`
       equivalent here. What IS stored is the source PDF, in the same private bucket, which is
       better for this purpose anyway: she needs to see pages either side of a proposed boundary,
       not one page in isolation.

       Same shape as the link minted for the worker: a short-lived signed URL for ONE object,
       front office only, and the bucket stays private. */
    if (action === 'batch_scan') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'A batch id is required.' });
      const r = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=source_path,filename,page_count`);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the batch.' });
      const job = (await r.json())[0];
      if (!job) return res.status(404).json({ error: 'No such batch.' });
      if (!job.source_path) {
        return res.status(404).json({ error: 'This batch has no stored scan to open.' });
      }
      const sign = await fetch(`${SB_URL}/storage/v1/object/sign/${SCAN_BUCKET}/${job.source_path}`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 900 }),          // 15 minutes
      });
      if (!sign.ok) return res.status(502).json({ error: `Could not sign the scan (${sign.status}).` });
      const s = await sign.json();
      if (!s.signedURL) return res.status(502).json({ error: 'The scan could not be signed.' });
      return res.status(200).json({ ok: true, url: `${SB_URL}/storage/v1${s.signedURL}`,
        filename: job.filename || null, page_count: job.page_count || null });
    }

    if (action === 'batch_documents') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'A batch id is required.' });
      const r = await sb(`ryc_batch_documents?company_id=eq.ryc&batch_id=eq.${id}`
        + '&select=*&order=seq.asc');
      if (!r.ok) return res.status(502).json({ error: 'Could not read the batch documents.' });
      const documents = await r.json();

      /* ===== WHICH OF THESE ARE ON A PM's DESK RIGHT NOW ============================
         ⛔ Twelve of Erica's thirty-four were Logan's, and her screen offered to reconcile every
         one of them. The batch row cannot say so on its own — the payable lives in the register —
         so the two are joined here, by the same `scan:{id}` key `batch_to_desk` writes. Matched on
         (vendor, amount) because that is the pair `ryc_register_invoice` itself dedupes on; there
         is no foreign key from a batch document to its payable, and inventing one now would be a
         migration for a lookup that already has a natural key. */
      try {
        const rb = await sb('ryc_invoice_batches?company_id=eq.ryc&select=id'
          + `&source_message_id=eq.${encodeURIComponent('scan:' + id)}`);
        const regB = rb.ok ? (await rb.json())[0] : null;
        if (regB) {
          /* ⚠ NO `job_name` HERE. It is a column on `ryc_batch_documents`, NOT on `ryc_invoices` —
             the register stores the number and resolves the name from the job directory. Selecting
             it made PostgREST reject the whole request, and because this block is wrapped in a
             try/catch whose whole point is that the batch screen still works without it, the failure
             was SILENT: every row came back with `pm_desk`, `pm_state` and `pm_awaiting` undefined,
             which reads as "no PM is involved" — the exact opposite of the truth. Caught in the
             post-deploy end-to-end, not by any gate. */
          const ir = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${regB.id}`
            + '&select=vendor_name,amount,review_state,assigned_pm,job_no,'
            + 'cost_code,mat_or_sub,cost_month,reviewed_by,reviewed_at&limit=1000');
          /* Absence of a row means the batch is still his — see migration 060. */
          const sr = await sb('ryc_invoice_batch_submissions?company_id=eq.ryc'
            + `&batch_id=eq.${regB.id}&select=pm,submitted_at,submitted_by&limit=10`);
          const submitted = sr.ok ? ((await sr.json())[0] || null) : null;
          if (ir.ok) {
            const key = (v, a) => `${vendorKey(v)}|${amountKey(a)}`;
            const byKey = {};
            for (const i of await ir.json()) byKey[key(i.vendor_name, i.amount)] = i;
            for (const d of documents) {
              const i = byKey[key(d.vendor, d.amount)];
              if (!i) continue;
              d.pm_desk = i.assigned_pm || null;
              d.pm_state = i.review_state;
              /* ⛔ ONE PAYABLE'S DECISION NO LONGER RELEASES ONE ROW. It used to: `pm_awaiting` was
                 per document, so a PM who approved three of five silently handed her three rows
                 while his own board still said the batch was his. The batch is one act now — she
                 gets all of it when he submits, or none of it. */
              d.pm_awaiting = !submitted;
              /* WHAT HE ACTUALLY DECIDED, ON HER ROW. Keith, 2026-08-27: *"she may need to look at
                 his stamp for more detail during reconciliation."* The stamp is burned into the PDF
                 at submit, but making her open a file to read a cost code she is about to file
                 against is the same "go and look it up" the batch board exists to remove. */
              d.pm_coding = {
                job_no: i.job_no || null,
                cost_code: i.cost_code || null,
                mat_or_sub: i.mat_or_sub || null,
                cost_month: i.cost_month || null,
                by: i.reviewed_by || null,
                at: i.reviewed_at || null,
              };
            }
          }
          if (submitted) {
            for (const d of documents) {
              d.submitted_at = submitted.submitted_at;
              d.submitted_by = submitted.submitted_by;
            }
          }
        }
      } catch { /* the batch screen still works without this; it just cannot say whose it is */ }

      /* ===== HAS THIS DOCUMENT ALREADY BEEN FILED, FROM AN EARLIER BATCH? ==================
         Scoped by AMOUNT rather than swept whole: the amounts in this batch are a short numeric
         list, they need no quoting, and it keeps the query proportional to the batch instead of to
         the archive. A null amount cannot be matched on and is left out.

         ⚠ WRAPPED, AND DELIBERATELY SILENT ON FAILURE — but never silently WRONG. If this read
         fails the board renders exactly as it did before, with no duplicate warnings; it must not
         be able to take down the screen she reconciles on. The one thing it must not do is report
         "no duplicates" as though it had looked, so the flag is only ever attached, never cleared. */
      try {
        const amounts = [...new Set(documents
          .map(d => (d.amount === null || d.amount === undefined ? null : Number(d.amount)))
          .filter(a => a !== null && Number.isFinite(a)))];
        if (amounts.length) {
          const pr = await sb('ryc_batch_documents?company_id=eq.ryc&reconciled_at=not.is.null'
            + `&amount=in.(${amounts.join(',')})&batch_id=neq.${id}`
            + '&select=id,batch_id,file_name,vendor,amount,invoice_no,copies,disposition,reconciled_at'
            + '&order=reconciled_at.desc&limit=1000');
          if (pr.ok) {
            const prior = await pr.json();
            /* The batch a prior filing came from is the thing she recognises — "approved 82626GC2",
               the folder she worked that morning. It lives on ryc_batch_jobs, so it is joined on
               here and handed to the pure function rather than looked up inside it. */
            const bids = [...new Set(prior.map(p => p.batch_id).filter(Boolean))];
            if (bids.length) {
              const fr = await sb('ryc_batch_jobs?company_id=eq.ryc&select=id,folder'
                + `&id=in.(${bids.join(',')})&limit=1000`);
              if (fr.ok) {
                const folders = {};
                for (const b of await fr.json()) folders[b.id] = b.folder;
                for (const p of prior) p.batch_folder = folders[p.batch_id] || null;
              }
            }
            const dupes = priorFilings(documents, prior);
            for (const d of documents) if (dupes[d.id]) d.prior_filing = dupes[d.id];
          }
        }
      } catch { /* no warning is a safe outcome; a screen that will not load is not */ }

      return res.status(200).json({ ok: true, documents });
    }

    /* The worker registers what it actually filed. THE JOB IS RESOLVED HERE, not on the VM, because
       the matcher lives here and this module has been bitten three times by expressing one business
       rule in a second place. Idempotent by (batch_id, seq): re-running the worker converges instead
       of duplicating the reconciliation queue. */
    if (action === 'batch_documents_register') {
      const id = String(body.id || '').trim();
      const docs = Array.isArray(body.documents) ? body.documents : [];
      if (!id || !docs.length) return res.status(400).json({ error: 'A batch id and documents are required.' });

      let dir = null;
      try { dir = await jobDirectory(); } catch { /* handled by leaving the job unresolved */ }
      const idx = dir ? __matcher.tokenIndex(dir.jobs) : null;

      /* ⛔ THE HINT STORE WAS WRITE-ONLY FROM THIS SIDE. Teaching it from the batch screen is only
         half the fix — registration has to ASK it, or the front office answers the same three jobs
         every week and watches the tool not learn. This is what makes "Ryan Fire Protection" arrive
         already pointing at "Ryan Fire Prot - Valpo" the second time it is seen.

         A HINT BEATS THE MATCHER, because a hint is a person's confirmed answer and the matcher is
         a resemblance score. That is the same precedence the PM desk already uses. */
      const hints = new Map();
      try {
        /* Normalisation stays in SQL, beside the store - migration 027. Rebuilding those
           two regexes here is exactly how the desk-parity harness once went on asserting a
           rule the product had already reversed. */
        const hr = await sb('rpc/ryc_match_job_hints', {
          method: 'POST',
          body: JSON.stringify({ p_docs: docs.map((d, i) => ({
            seq: parseInt(d.seq, 10) || (i + 1),
            vendor: d.vendor || '', job_text: d.job_text || '' })) }),
        });
        if (hr.ok) for (const h of await hr.json()) hints.set(h.seq, h.job_no);
      } catch { /* fall through to the matcher: an unreadable hint is not a wrong answer */ }

      const rows = docs.map((d, i) => {
        const seq = parseInt(d.seq, 10) || (i + 1);
        let job_no = null, job_name = null, job_source = null;
        if (hints.has(seq)) {
          job_no = hints.get(seq);
          job_name = (dir && dir.names && dir.names[job_no]) || null;
          job_source = 'hint';
        }
        if (!job_no && dir && idx && String(d.job_text || '').trim()) {
          const m = __matcher.matchJob(String(d.job_text), dir.jobs, idx, dir.foundationOnly);
          if (m && m.job) {
            job_no = m.job.no;
            job_name = dir.names[m.job.no] || m.job.name || null;
            job_source = 'matched';
          }
        }
        const name = String(d.name || '').trim();
        return {
          company_id: 'ryc', batch_id: id, seq,
          file_name: name, sp_name: name, sp_url: d.url || null,
          page_from: parseInt(d.page_from, 10) || 0,
          page_to: parseInt(d.page_to, 10) || 0,
          doc_type: d.doc_type || 'unknown',
          vendor: d.vendor || null,
          invoice_no: d.invoice_no || null,
          amount: (d.amount === null || d.amount === undefined || d.amount === '')
            ? null : Number(d.amount),
          /* Pay applications only: what was billed THIS period, before retainage (G703 column E).
             It is NOT the payable — `amount` is — but it is the figure the office actually watches,
             and the reader was already reading it off the continuation sheet and dropping it into
             free text where nothing could use it. See migration 024. */
          work_this_period: (d.work_this_period === null || d.work_this_period === undefined
            || d.work_this_period === '') ? null : Number(d.work_this_period),
          /* G702 line 4 / column G grand total (migration 058). Kept BESIDE the period figure, not
             instead of it: column E is a true zero on an application billing nothing but stored
             materials, and then this is the only figure that describes the document at all. */
          completed_and_stored: (d.completed_and_stored === null || d.completed_and_stored === undefined
            || d.completed_and_stored === '') ? null : Number(d.completed_and_stored),
          /* The G702 to-date ladder — migration 065. The reader has always returned all four and
             nothing kept them, so the office re-derives retainage by hand: 330 per-vendor workbooks
             in SharePoint whose one live column is "what are we holding on this sub, on this job".
             ⛔ ALL FOUR ARE CUMULATIVE, not per-period. `retainage` is TOTAL held to date, so it is
             never summed across a vendor's applications — ryc_retainage_v takes the latest. Only
             `work_this_period` and `amount` describe a single period.
             `less_previous` is the term that makes a catch-up application legible: Legacy Plumbing
             billed 96,105.00 this period and was due 41,790.04, which is not a retainage rate at
             any percentage and reads as a bad number without line 7.
             ⚠ WRITTEN AS FOUR LITERAL KEYS, NOT A LOOP OVER A LIST. The first version of this
             built them with Object.fromEntries over an array of names, which is shorter and is
             exactly the wrong property for the line a gate has to inspect: this whole incident is
             a figure that was read and never landed, and the gate that stops it recurring
             (scripts/verify-ryc-payapp-chain.mjs) works by reading the column names written here.
             A key the gate cannot see is a key that can go missing again. */
          retainage: (d.retainage === null || d.retainage === undefined
            || d.retainage === '') ? null : Number(d.retainage),
          eligible_to_date: (d.eligible_to_date === null || d.eligible_to_date === undefined
            || d.eligible_to_date === '') ? null : Number(d.eligible_to_date),
          less_previous: (d.less_previous === null || d.less_previous === undefined
            || d.less_previous === '') ? null : Number(d.less_previous),
          completed_to_date: (d.completed_to_date === null || d.completed_to_date === undefined
            || d.completed_to_date === '') ? null : Number(d.completed_to_date),
          job_text: d.job_text || null,
          /* The sub lien waiver pages the reconciler kept (migration 071). Only ever an ARRAY or
             null — never `[]` invented here. The worker sends `[]` when it looked and found none,
             and null would mean "this batch predates the capture"; manufacturing one from the other
             at the boundary is how a coverage figure becomes an artefact of the deploy date. */
          sub_waivers: Array.isArray(d.sub_waivers) ? d.sub_waivers : null,
          job_no, job_name, job_source,
        };
      });
      const r = await sb('ryc_batch_documents?on_conflict=batch_id,seq', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
      if (!r.ok) return res.status(502).json({ error: `Could not register documents (${r.status}).` });
      const made = await r.json();
      return res.status(200).json({ ok: true, inserted: made.length, of: rows.length });
    }

    /* ===== WHOSE FOLDER IS THIS, AND DOES HE APPROVE IN THE TOOL OR ON PAPER? ===========
       Keith ruled out asking at upload: *"She doesnt need the optional selector - right now all
       the other PM are manually doing the their approval then erica scan to reconcile."* Which is
       correct — and it turns out the batch can say whose it is without being told, because a
       scanned folder IS one PM's folder and its documents name his jobs.

       ⚠ THE COMMUNITY COUNTS AS A SIGNAL, AND WITHOUT IT THIS WOULD FAIL ON THE BATCH THAT MATTERS
       MOST. `approved 82626GC2` has FIVE documents and not one resolved job — deriving a desk from
       resolved jobs alone would give nothing, and Logan would never see the batch that most needs
       him. Two of those five reach Greencroft South Bend, whose units are all his. So a document
       implies a desk if it resolves to a job OR to a community.

       ⛔ UNANIMOUS OR NOTHING. One dissenting desk and the answer is null, which means paper, which
       means today. A mixed folder is not something to resolve by majority — it is a reason to leave
       a working process alone. */
    async function batchDesk(docs, dir) {
      if (!dir || !dir.jobs.length) return null;
      const byNo = new Map([...dir.jobs, ...(dir.foundationOnly || [])].map(j => [j.no, j]));
      const idx = __matcher.tokenIndex(dir.jobs);
      const desks = new Set();
      let signals = 0;
      for (const d of docs) {
        let pm = null;
        if (d.job_no) { const j = byNo.get(String(d.job_no).trim()); pm = j && j.pm; }
        if (!pm && String(d.job_text || '').trim()) {
          const m = __matcher.matchJob(String(d.job_text), dir.jobs, idx, dir.foundationOnly);
          if (m && m.job) pm = m.job.pm;
          else if (m && m.family) pm = m.family.pm;
        }
        if (pm) { desks.add(pm); signals++; }
      }
      return (desks.size === 1 && signals > 0) ? [...desks][0] : null;
    }

    /* Absence of a row is the default, so the caller cannot forget to check a boolean. */
    async function digitalPms() {
      try {
        const r = await rpc('ryc_digital_approval_pms', {});
        return new Set(r.status === 200 && Array.isArray(r.body) ? r.body : []);
      } catch { return new Set(); }
    }

    /* ===== A SCANNED FOLDER BECOMES PAYABLES ON A PM'S DESK ==============================
       ⛔ THE SCANNED-BATCH PATH HAS NEVER CREATED A PAYABLE. `batch_documents_register` writes
       `ryc_batch_documents` and stops, so nothing that arrives on paper has ever reached a desk —
       measured 2026-08-26: the register held 21 invoices and every one came from the `ap@` mailbox,
       while two Greencroft batches sat holding 10 documents and $26,142.31 that no PM could see.

       This is the missing link, and it is gated on ONE condition: the batch's derived desk belongs
       to a PM who has been explicitly moved onto the digital flow (migration 055, table ships
       EMPTY). For every other PM this returns `skipped` and touches nothing — Erica's scan →
       reconcile → file is byte-identical, which is the constraint Keith set while she is working.

       Idempotent twice over: `open_batch`'s own `source_message_id` guard keyed to the scan, and a
       per-document `request_id` that `ryc_register_invoice` replays on. Running it twice registers
       nothing new — which matters, because the duplicate it would otherwise create is the exact
       failure this whole module was built to catch. */
    if (action === 'batch_to_desk') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'A batch id is required.' });

      const bj = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=*`);
      const batch = bj.ok ? (await bj.json())[0] : null;
      if (!batch) return res.status(404).json({ error: 'No such batch.' });
      /* Somebody has stated this folder was already signed on paper (migration 057). Routing it to
         a desk would ask the PM to approve his own signature a second time. */
      if (batch.pm_approved_at) {
        return res.status(200).json({ ok: true, flow: 'paper', pm: null,
          skipped: `${batch.pm_approved_by || 'someone'} recorded that the PM already approved this `
            + 'folder on paper' });
      }

      const dr = await sb(`ryc_batch_documents?company_id=eq.ryc&batch_id=eq.${id}`
        + '&select=*&order=seq.asc');
      if (!dr.ok) return res.status(502).json({ error: 'Could not read the batch documents.' });
      const docs = await dr.json();
      if (!docs.length) return res.status(200).json({ ok: true, skipped: 'no documents registered yet' });

      let dir = null;
      try { dir = await jobDirectory(); } catch { /* handled below */ }
      const pm = await batchDesk(docs, dir);
      const digital = await digitalPms();

      /* ⛔ A MIXED FOLDER IS NOT A PAPER FOLDER, AND TREATING IT AS ONE PUT $53,163.36 OF LOGAN'S
         WORK ON THE FRONT OFFICE'S SCREEN (found 2026-08-26). Erica scanned his stack into the
         middle of a general batch: 34 documents — 13 Erik Parcell, **12 Logan Moore**, 8 unresolved,
         1 Brad Yoder. `batchDesk()` requires unanimity, correctly refused to name a desk, and the
         whole batch fell to paper — so twelve invoices she must not reconcile were sitting in her
         queue with the reconcile buttons live. Keith: *"apparently erica scanned some of logans
         invoices is way trying to reconcile."*

         THE UNANIMITY RULE WAS RIGHT FOR THE WRONG SCOPE. It exists to answer "whose is a document
         that names nobody" — and for that it must stay strict. But a document carrying its OWN
         resolved job needs no vouching from its neighbours: `2518RO25 Greencroft 2047 WPC` is
         Logan's whatever else is in the folder. So the desk is decided per DOCUMENT:
           · a resolved job → that job's PM, the strongest signal there is;
           · no job at all  → the batch's unanimous desk, if it has one.
         Only documents landing on a DIGITAL PM's desk are registered. The rest of the folder is
         untouched and stays exactly as paper always was — here, Erik's 13 and Brad's 1. */
      const byNo = dir ? new Map([...dir.jobs, ...(dir.foundationOnly || [])].map(j => [j.no, j])) : new Map();
      const deskFor = (d) => {
        if (d.job_no) { const j = byNo.get(String(d.job_no).trim()); return (j && j.pm) || null; }
        return pm;          // no job of its own — fall back to the batch, which may be null
      };
      const mine = docs.filter(d => { const p = deskFor(d); return p && digital.has(p); });
      if (!mine.length) {
        /* The paper flow, which is every PM today. Nothing is created, nothing is changed. */
        return res.status(200).json({ ok: true, flow: 'paper', pm: pm || null,
          skipped: pm ? `${pm} approves on paper` : 'no document in this batch belongs to a digital desk' });
      }
      /* ⚠ ALREADY-RECONCILED DOCUMENTS ARE LEFT ALONE. The front office has finished with those and
         the file has moved; turning one into a payable now would put a decision back in front of a
         PM that the paper process already closed. Only open work is routed. */
      const routable = mine.filter(d => !d.reconciled_at);
      if (!routable.length) {
        return res.status(200).json({ ok: true, flow: 'paper', pm: pm || null,
          skipped: 'every document for a digital desk in this batch is already reconciled' });
      }

      /* Find or create the REGISTER's batch. `ryc_invoices.batch_id` points at
         `ryc_invoice_batches`, a different table from the scanned `ryc_batch_jobs` — so the scan
         gets an invoice batch of its own, keyed to it so a re-run finds the same one. */
      const key = `scan:${id}`;
      let invBatch = null;
      const ex = await sb(`ryc_invoice_batches?company_id=eq.ryc`
        + `&source_message_id=eq.${encodeURIComponent(key)}&select=*`);
      if (ex.ok) invBatch = (await ex.json())[0] || null;
      if (!invBatch) {
        /* Inserted the same way `open_batch` does it — there is no RPC for this — including its
           409 handling. A concurrent run losing the race is the CORRECT outcome: the winner's batch
           is the one everything else keys to, and the loser must find it rather than make a second. */
        const mk = await sb('ryc_invoice_batches', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            received_date: (batch.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
            source: 'scan',
            label: batch.folder || batch.filename || key,
            page_count: batch.page_count || 0,
            /* ⚠ A PM APPROVING MONEY HE CANNOT OPEN IS WORSE THAN THE PAPER HE IS REPLACING.
               These pages are not in `ryc-invoice-scans` — they were split into the batch's own
               SharePoint folder by the worker — so `pages` finds no `storage:` uri and correctly
               reports `stored:false`. It already falls back to whatever link the batch carries, so
               carrying the folder makes View open the folder holding the split documents, each
               named for its vendor and amount. Not per-document, and honest about that. */
            document_uri: batch.folder_url || null,
            source_message_id: key,
          }),
        });
        if (mk.status === 409) {
          const again = await sb(`ryc_invoice_batches?company_id=eq.ryc`
            + `&source_message_id=eq.${encodeURIComponent(key)}&select=*`);
          if (again.ok) invBatch = (await again.json())[0] || null;
        } else if (mk.ok) {
          invBatch = (await mk.json())[0] || null;
        }
        if (!invBatch) {
          return res.status(502).json({ error: `Could not open a register batch (${mk.status}).` });
        }
      }
      const invBatchId = invBatch && invBatch.id;
      if (!invBatchId) return res.status(502).json({ error: 'no register batch id' });

      const preexisting = new Set();
      const r0 = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${invBatchId}&select=id`);
      if (r0.ok) for (const x of await r0.json()) preexisting.add(x.id);

      const results = [];
      for (const d of routable) {
        const out = await rpc('ryc_register_invoice', {
          p_batch_id: invBatchId,
          p_rec: {
            vendor_name: d.vendor || null,
            invoice_no: d.invoice_no || null,
            amount: d.amount,
            doc_type: d.doc_type || 'unknown',
            job_text: d.job_text || null,
            /* The job the batch screen already resolved travels with the document. A machine guess
               is carried as `classifier`, never as a person's answer. */
            job_no: d.job_no || null,
            job_source: d.job_no ? (d.job_source === 'chosen' ? 'manual'
              : d.job_source === 'hint' ? 'hint' : 'classifier') : null,
            page_from: d.page_from, page_to: d.page_to,
            /* The scan date is when the front office received the folder. The RECEIVED stamp is on
               the paper and the reader does not capture it into this table; claiming today's date
               would silently restart every discount and staleness window. */
            received_date: (batch.created_at || '').slice(0, 10) || null,
          },
          p_request_id: `scan:${id}:${d.seq}`, p_actor: actor,
        });
        results.push(out.status === 200 ? { ok: true, seq: d.seq, ...out.body }
          : { ok: false, seq: d.seq, error: out.body && out.body.error });
      }

      /* The package pass and the staging pass are the SAME functions the mailbox path uses. This
         action deliberately re-implements neither — one rule expressed twice is how this module
         has been bitten three separate times. */
      let supporting = null;
      try {
        const rn = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${invBatchId}`
          + '&select=id,version,doc_type,amount,vendor_name,review_state');
        if (rn.ok) {
          const fresh = (await rn.json()).filter(r => !preexisting.has(r.id));
          const marks = supportingDocuments(fresh)
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
          supporting = { marked: done.length, of: fresh.length };
        }
      } catch (e) { supporting = { error: (e && e.message) || 'supporting-document pass failed' }; }

      let placement = null;
      try {
        const p = await stagingPass({ force: false });
        placement = p.error ? { error: p.error }
          : { staged: p.staged, community: p.community || 0, unplaced: p.unplaced };
      } catch (e) { placement = { error: (e && e.message) || 'staging failed' }; }

      /* ⛔ THE DOCUMENTS THAT MOST NEED HIM ARE THE ONES HIS FOLDER CANNOT IDENTIFY, AND THEY WERE
         THE ONES BEING HELD BACK. Measured on the first real run: 7 of 10 released, and the 3 held
         were the Beer & Slabaugh dumpster on Whispering Pines ($670.00), a Leatherman stock buy
         ($980.72) and touch-up paint ($11.97) — which is to say **the only genuinely shared costs
         in the folder**. Everything that DID reach him was a single-unit invoice needing one chip
         tapped. Keith, looking at that desk: *"the main thing we are solving for — seems unsolved —
         he is going to need to assign an invoice to multiple units relative to that units
         respective cost."* He was right, and this is why: a shared cost names no unit and no
         community BY ITS NATURE, so per-document matching must refuse it, and the split editor sat
         on the rows that never needed it.

         THE BATCH IS THE EVIDENCE THE DOCUMENT LACKS. A scanned folder is ONE PM's folder — that is
         the premise `batchDesk()` already derives a desk from, unanimously or not at all. So a
         document in Logan's folder is Logan's, whatever its own text failed to print. It gets his
         DESK and no job, which is exactly the state the community rows already use: the money is on
         the right screen and the allocation is the open question.

         ⚠ IT IS THE DESK ONLY, NEVER A JOB. Inheriting a job from the batch would be the
         confident-wrong-answer this module exists to prevent — a dumpster is not the job the
         invoice above it happened to name. `staged_job_no` stays null, `job_unassigned` stands, and
         he splits it across the units it actually served.

         ⚠ SCOPED TO THIS BATCH'S OWN INVOICES. It can never reach the mailbox queue: the filter is
         `batch_id`, and the 54 unplaced invoices in Inbound have a different batch or none. */
      let inherited = null;
      try {
        /* ⚠ ONLY WHEN THE BATCH ITSELF HAS A UNANIMOUS DIGITAL DESK. In a mixed folder `pm` is null
           by design, and a document that named nobody there genuinely belongs to nobody in
           particular — inheriting a desk from a folder that holds three PMs' work would be the
           confident wrong answer, at the one moment there is no evidence at all. */
        const nr = (pm && digital.has(pm))
          ? await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${invBatchId}`
            + '&released_at=is.null&staged_pm=is.null&select=id,version,vendor_name,amount,job_text')
          : { ok: true, json: async () => [] };
        const orphans = nr.ok ? await nr.json() : [];
        const took = [];
        for (const o of orphans) {
          const note = `From ${batch.folder || 'a scanned folder'} — every other document in it is `
            + `${pm}'s. Nothing on this one named a unit, so it is his to allocate.`;
          const s = await rpc('ryc_stage_invoice', {
            p_id: o.id, p_staged_pm: pm, p_staged_job_no: null,
            p_source: 'job_text', p_confidence: 0.4, p_note: note.slice(0, 300),
            p_expected_version: o.version, p_request_id: `${rid}:inh:${o.id}`, p_actor: actor,
          });
          if (s.status === 200) took.push({ vendor: o.vendor_name, amount: o.amount, job_text: o.job_text });
        }
        inherited = { staged: took.length, of: orphans.length, documents: took };
      } catch (e) { inherited = { error: (e && e.message) || 'batch-desk inheritance failed' }; }

      /* RELEASE IS WHAT PUTS IT ON HIS SCREEN, and it gates on the DESK, not the job — which is the
         whole reason a Greencroft row with an unresolved unit can reach him at all. Anything with
         no desk is held back and reported, exactly as in the mailbox path. */
      let release = null;
      try {
        const rr = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${invBatchId}`
          + '&released_at=is.null&staged_pm=not.is.null&select=id');
        const ids = rr.ok ? (await rr.json()).map(x => x.id) : [];
        if (ids.length) {
          const out = await rpc('ryc_release_invoices', {
            p_ids: ids, p_released_by: 'front office (scan ingest)',
            p_request_id: `${rid}:rel`, p_actor: actor,
          });
          release = out.status === 200 ? out.body : { error: out.body && out.body.error };
        } else release = { released: 0, held: 0, note: 'nothing staged with a desk' };
      } catch (e) { release = { error: (e && e.message) || 'release failed' }; }

      return res.status(200).json({ ok: true, flow: 'digital', pm, inherited,
        /* Say what was taken and what was deliberately left, because "digital" on a mixed folder
           is only true of part of it and a count that hides that is the misleading half. */
        of_documents: docs.length, routed: routable.length,
        left_as_paper: docs.length - routable.length,
        desks: [...new Set(routable.map(d => deskFor(d)))],
        register_batch: invBatchId,
        registered: results.filter(r => r.ok && !r.replayed).length,
        replayed: results.filter(r => r.ok && r.replayed).length,
        failed: results.filter(r => !r.ok).length,
        results, supporting, placement, release });
    }

    /* ===== "THE PM ALREADY SIGNED THIS FOLDER ON PAPER" =================================
       Keith, 2026-08-26: *"logan has already approved those ... in the future he will be approving
       through the PM desk (no need to scan them in) ... Its a function worth build for the
       possibility that logan manually approvoves a batch in the future for some one off reason."*

       ⛔ THE DOCUMENTS CANNOT SETTLE THIS. A folder scanned INSTEAD of being walked over and one
       scanned AFTER it was walked over hold identical paper; only the process differs, so a person
       has to say which it was. Until they do, a digital-flow PM gets everything — the right default
       while paper is still the norm and the pilot is the exception.

       It does two things and refuses to do a third:
         · records the statement, attributed (`pm_approved_by` is NOT NULL by constraint), and
           `batch_to_desk` skips the batch from then on;
         · DELETES the payables the routing created for it — but only those still undecided and
           unfiled. That is the precedent set on 2026-08-13, when the original 17 were removed
           because "that batch was one PM's paper folder, work already done".
         · ⚠ it will not touch anything approved, rejected, marked not-payable or already filed.
           Those are decisions somebody made and facts are not tidied away; they are counted and
           reported back so the caller can see what was left standing. */
    if (action === 'batch_paper_approved') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      const by = String(body.by || '').trim();
      if (!id) return res.status(400).json({ error: 'A batch id is required.' });
      if (!by) {
        return res.status(400).json({
          error: 'Who is stating that the PM already approved this folder? An unattributed answer '
            + 'here is indistinguishable from a routing bug.' });
      }

      const bj = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${id}&select=id,folder,pm_approved_at`);
      const batch = bj.ok ? (await bj.json())[0] : null;
      if (!batch) return res.status(404).json({ error: 'No such batch.' });

      /* The payables this batch's routing created, if any. */
      let removed = 0, kept = [];
      const rb = await sb('ryc_invoice_batches?company_id=eq.ryc&select=id'
        + `&source_message_id=eq.${encodeURIComponent('scan:' + id)}`);
      const regB = rb.ok ? (await rb.json())[0] : null;
      if (regB) {
        const ir = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${regB.id}`
          + '&select=id,vendor_name,amount,review_state,file_state,filed_path&limit=1000');
        if (ir.ok) {
          const rows = await ir.json();
          const UNDECIDED = ['new', 'ready', 'needs_info'];
          const doomed = rows.filter(r => UNDECIDED.includes(r.review_state)
            && !r.filed_path && (r.file_state === 'unfiled' || !r.file_state));
          kept = rows.filter(r => !doomed.includes(r))
            .map(r => ({ vendor: r.vendor_name, amount: r.amount, state: r.review_state }));
          for (const r of doomed) {
            const del = await sb(`ryc_invoices?id=eq.${r.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            if (del.ok) removed++;
          }
        }
      }

      const up = await sb(`ryc_batch_jobs?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          pm_approved_at: new Date().toISOString(),
          pm_approved_by: by,
          pm_approved_note: body.note || null,
        }),
      });
      if (!up.ok) return res.status(502).json({ error: `Could not mark the batch (${up.status}).` });

      return res.status(200).json({ ok: true, batch: batch.folder, by,
        payables_removed: removed, payables_kept: kept.length, kept });
    }

    /* ===== ASK THE MATCHER AGAIN — FOR ROWS IT ANSWERED ITSELF, AND ONLY THOSE ==========
       ⛔ `batch_documents_register` upserts with `resolution=ignore-duplicates`, which is what makes
       a worker re-run converge instead of duplicating the queue — and it also means a document
       registered before a matcher improvement KEEPS THE OLD ANSWER FOREVER. Measured 2026-08-26:
       `approved 82626GC` seq 1, Miller's Building Supply **$5,268.17**, printed "GREEN CROFT GOSHEN
       2048 WHISPERING PINE CT", is stored against **`2502GP12` Goshen WWTP Anaerobic Digester** —
       registered at 07:49 ET, the community rule deployed at 10:20 ET. The fix cannot reach it and
       re-running the worker is a no-op, so it sits there until a person changes it by hand.

       ⚠ A PERSON'S ANSWER IS NEVER OVERWRITTEN. Only `matched` and unresolved rows are re-asked:
       `chosen` is the front office's own decision and `hint` is a PM's confirmed alias, and both
       outrank a resemblance score. Reconciled rows are never touched at all — that document is
       filed, and re-labelling where a filed thing belongs is a correction (`doc_recorrect`), not a
       re-read. Same precedence the inbound queue's "look again" already uses.

       ⚠ IT IS NOT WIRED TO ANY BUTTON ON THE BATCH SCREEN. Erica's process runs every day on that
       screen and this changes nothing she sees; it exists so a stale machine guess can be corrected
       deliberately. */
    if (action === 'batch_rematch') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ error: 'A batch id is required.' });

      const cur = await sb(`ryc_batch_documents?company_id=eq.ryc&batch_id=eq.${id}`
        + '&select=id,seq,vendor,job_text,job_no,job_name,job_source,reconciled_at&order=seq.asc');
      if (!cur.ok) return res.status(502).json({ error: 'Could not read the batch documents.' });
      const docs = await cur.json();

      let dir = null;
      try { dir = await jobDirectory(); } catch { /* handled below */ }
      if (!dir || !dir.jobs.length) {
        return res.status(502).json({ error: 'The job feed could not be read — nothing re-matched rather than guessed.' });
      }
      const idx = __matcher.tokenIndex(dir.jobs);

      /* Eligible = the machine's own answers, on rows nobody has finished. */
      const eligible = docs.filter(d => !d.reconciled_at
        && (d.job_source === null || d.job_source === undefined || d.job_source === 'matched'));

      /* A taught alias still beats the matcher, exactly as at registration. */
      const hints = new Map();
      if (eligible.length) {
        try {
          const hr = await sb('rpc/ryc_match_job_hints', {
            method: 'POST',
            body: JSON.stringify({ p_docs: eligible.map(d => ({
              seq: d.seq, vendor: d.vendor || '', job_text: d.job_text || '' })) }),
          });
          if (hr.ok) for (const h of await hr.json()) hints.set(h.seq, h.job_no);
        } catch { /* an unreadable hint is not a wrong answer */ }
      }

      const changed = [], unchanged = [];
      for (const d of eligible) {
        let job_no = null, job_source = null;
        if (hints.has(d.seq)) { job_no = hints.get(d.seq); job_source = 'hint'; }
        if (!job_no && String(d.job_text || '').trim()) {
          const m = __matcher.matchJob(String(d.job_text), dir.jobs, idx, dir.foundationOnly);
          if (m && m.job) { job_no = m.job.no; job_source = 'matched'; }
        }
        if ((job_no || null) === (d.job_no || null)) { unchanged.push(d.seq); continue; }
        const job_name = job_no ? ((dir.names && dir.names[job_no]) || null) : null;
        const up = await sb(`ryc_batch_documents?id=eq.${d.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ job_no, job_name, job_source, updated_at: new Date().toISOString() }),
        });
        if (!up.ok) { unchanged.push(d.seq); continue; }
        changed.push({ seq: d.seq, vendor: d.vendor, job_text: d.job_text,
          was: d.job_no || null, was_name: d.job_name || null, now: job_no, now_name: job_name });
      }
      return res.status(200).json({ ok: true, documents: docs.length, eligible: eligible.length,
        changed: changed.length, unchanged: unchanged.length, changes: changed });
    }

    /* Assign a document and finish it. `RYC-EXPENSE` is a real answer, not a refusal — an overhead
       cost that belongs to no job — so it completes immediately, because there is nothing to copy.
       A real job leaves `reconciled_at` NULL until the copy actually lands in SharePoint; a
       reconciliation that claimed to be done while the file was still on Vercel's side of the fence
       would be exactly the "green tick over an unknown" this module refuses elsewhere. */
    /* ⛔ ONE RECONCILIATION, EXPRESSED ONCE. Erica's screen submits a whole batch at a time now
       (Keith, 2026-08-27: *"She should be able to reconcile multiple invoice (or the entire batch)
       then click a master submit reconcialtion"*), and the obvious way to build that — a second
       endpoint that loops and does the same writes — is exactly the shape this module has been
       bitten by three times. So the single-document logic below is the only copy of it, and both
       `doc_reconcile` and `docs_reconcile` call it.

       `dir` is passed in so a fifty-document submit reads the job directory ONCE rather than fifty
       times; everything else is per document. Declared as a function statement, so it is hoisted
       above both callers regardless of where they sit in this if-chain. */
    async function reconcileOneDoc(docId, jobNo, opts) {
      opts = opts || {};
      if (!docId) return { status: 400, body: { error: 'A document id is required.' } };

      const cur = await sb(`ryc_batch_documents?company_id=eq.ryc&id=eq.${docId}&select=*`);
      const doc = cur.ok ? (await cur.json())[0] : null;
      if (!doc) return { status: 404, body: { error: 'No such document.' } };
      if (doc.reconciled_at) {
        return { status: 409, body: {
          error: `"${doc.file_name}" was already reconciled on `
            + `${String(doc.reconciled_at).slice(0, 10)} — it cannot be filed twice.` } };
      }

      /* ===== A SPLIT PAGE ARRIVES WITH ITS OWN DESTINATIONS ==========================
         The PM already answered — one job per line, carried onto this row as `split_jobs` at
         submit — so there is nothing for her to pick and `job_no` stays null because no single
         number is true. She may still override by choosing a job, and that wins: an explicit
         choice by the person doing the filing beats a list carried from another screen.

         ⚠ EVERY ENTRY, OR IT IS NOT A SPLIT. A `split_jobs` array with a blank job in it would
         file the page against some of the units that owe for it and quietly drop the others, so a
         malformed list falls through to "a job is required" and she is asked, which is a question
         rather than a wrong answer. */
      const splitAll = Array.isArray(doc.split_jobs) ? doc.split_jobs : null;
      const splitOk = !!(splitAll && splitAll.length
        && splitAll.every(s => s && String(s.job_no || '').trim()));
      const useSplit = !jobNo && splitOk;
      if (!jobNo && !useSplit) {
        return { status: 400, body: { error: 'A document id and a job are required.' } };
      }

      const expense = !useSplit && jobNo.toUpperCase() === RYC_EXPENSE.no;
      let job_name = RYC_EXPENSE.name;
      if (useSplit) {
        job_name = null;
        /* "Resolve without filing" says the job has no folder to copy into. A split says the
           opposite — it names several — so the two cannot both be true of one page, and guessing
           which she meant would either skip a filing she wanted or claim one she did not. */
        if (opts.noFiling === true) {
          return { status: 400, body: {
            error: `"${doc.file_name}" is split across ${splitAll.length} jobs. Resolve without `
              + 'filing applies to one job with no folder — choose a single job first if that is '
              + 'what you meant.' } };
        }
      } else if (!expense) {
        let dir = opts.dir || null;
        if (!dir) { try { dir = await jobDirectory(); } catch { /* reported below */ } }
        if (!dir) return { status: 503, body: { error: 'The job list could not be read just now — try again.' } };
        const j = pickableJobs(dir).find(x => x.no === jobNo);
        if (!j) return { status: 400, body: { error: `${jobNo} is not a job that can be filed to.` } };
        job_name = j.name;
      }

      /* ⛔ A REAL JOB WITH NO SHAREPOINT FOLDER IS A THIRD ENDING, NOT A FAILURE (Keith,
         2026-08-21): *"We dont want a folder for Brad style projects - we just want erica to be
         able to resolve it without moving a file to sharepoint."*

         Measured the same day against the live folder index: of RYC's 53 Procore-active jobs,
         **30 have no job folder at all** — 29 of them Greencroft unit jobs plus St. Joe County
         Garages. Those payables are not overhead, so `ryc_expense` would state something false
         about the money: the cost belongs to that job, it simply has nowhere to be copied. And
         creating folders for one-off residence and unit jobs would litter RYC's job tree with
         directories nobody asked for.

         So the row completes with the job recorded and NOTHING copied. `disposition` says which of
         the three endings it was, because "done" is not one fact here — a reader has to be able to
         tell "the file is in the job folder" from "there is no job folder and we said so on
         purpose". The batch folder keeps the only copy either way, exactly as it does for an
         expense. */
      /* `disposition` stays `ryc_expense` on an expense row even when she reached it through
         "Resolve without filing": RYC Expense is the more specific ending — a cost belonging to no
         job — and `job_unfiled` would assert the opposite, that a job owns it and has no folder. */
      const noFiling = opts.noFiling === true && !expense;
      /* ⛔ THIS USED TO BE A 400, AND IT WAS THE SERVER HALF OF A DEAD END (reversed 2026-09-04).
         It read: *"RYC Expense already means nothing is copied — pick the job it belongs to
         instead."* True about the copy, and impossible on the row that produced it. Erica, on the
         last open row of `approved 9426`: *"This was a duplicate that was flagged but when i tried
         to resolve without filing I received the error message."* Wakarusa Heavy Equipment #2705-1
         was reconciled as RYC Expense on 2026-08-26 — there IS no job it belongs to — while the
         duplicate hold withheld its tick, so the only control left standing was "File it anyway".
         Both endings write the same row; refusing one of them bought nothing and cost the board a
         row nobody could close. The reason is kept either way, which is the half that matters. */
      const done = expense || noFiling;
      const patch = {
        job_no: useSplit ? null : (expense ? RYC_EXPENSE.no : jobNo),
        job_name: useSplit ? null : job_name,
        /* `chosen` means a person picked this job on this screen. On a split she confirmed a list
           the PM made, so the provenance stays his — overwriting it would erase the only record
           that the units were his answer rather than hers. */
        job_source: useSplit ? (doc.job_source || 'pm') : 'chosen',
        disposition: expense ? 'ryc_expense' : (noFiling ? 'job_unfiled' : 'job_folder'),
        /* ⛔ DO NOT BLANK A LEASE THE WORKER IS HOLDING. `copy_error` doubles as the claim lease,
           and since migration 053 a row can be claimed for a RENAME before it has been reconciled
           at all — so this write can now land while a worker is mid-rename. Clearing it there
           would free the row for a second claim and let two workers touch one document. Clearing
           a real error is still right: that is what re-arms a refused row when she settles it. */
        copy_error: doc.copy_error === 'working' ? 'working' : null,
        updated_at: new Date().toISOString(),
      };
      if (done) {
        patch.reconciled_at = new Date().toISOString();
        patch.reconciled_by = who.via === 'admin' ? 'admin' : 'front office';
      }
      /* WHY nothing was copied is written down, on the row, forever. `history` already appends
         rather than overwrites because these records sit behind money moving between job budgets —
         and "this payable was never copied to SharePoint, and here is who decided that and what the
         filer had said" is precisely the kind of question that gets asked months later. */
      /* ⚠ KEYED ON WHAT SHE PRESSED, NOT ON THE DISPOSITION IT PRODUCED. `noFiling` is deliberately
         false for an expense row (see above), so keying the record off it would have dropped the
         reason on exactly the rows that now reach here through that button — the duplicate ones,
         where "why was this never copied" is the whole question a reader will bring. */
      if (opts.noFiling === true) {
        patch.history = [...(Array.isArray(doc.history) ? doc.history : []), {
          at: new Date().toISOString(),
          by: who.via === 'admin' ? 'admin' : 'front office',
          action: 'resolved_without_filing',
          job_no: jobNo,
          job_name,
          filer_said: String(opts.reason || doc.copy_error || '').slice(0, 300) || null,
        }];
      }
      const r = await sb(`ryc_batch_documents?id=eq.${docId}&reconciled_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return { status: 502, body: { error: 'Could not record the reconciliation.' } };
      const rows = await r.json();
      if (!rows.length) return { status: 409, body: { error: 'That document was reconciled a moment ago.' } };
      /* Also taught on completion, because a row whose job the MATCHER got right is never touched
         by `doc_update` — she just clicks Complete. Confirming a correct proposal is a
         confirmation too, and it is what raises `confirmations` on a hint that already exists. */
      /* Nothing is taught from a split: the hint table maps printed text to ONE job, and the whole
         fact about this page is that its text maps to several. Teaching any one of them would make
         the next Beer & Slabaugh dumpster classify itself into a single unit. */
      const learned = (expense || useSplit) ? null : await learnJobHint(rows[0], jobNo);
      return { status: 200, body: { ok: true, document: rows[0], queued: !done, learned } };
    }

    if (action === 'doc_reconcile') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const out = await reconcileOneDoc(
        String(body.doc_id || '').trim(), String(body.job_no || '').trim(),
        { noFiling: body.no_filing === true, reason: body.reason });
      return res.status(out.status).json(out.body);
    }

    /* ===== THE FRONT OFFICE SUBMITS A WHOLE BATCH ===================================
       Keith, 2026-08-27, after watching Erica work: *"It seems that the fact that reconciliation is
       by invoice (in that when she click to copy to folder) it actually does the function instantly
       it can cause a delay. She should be able to reconcile multiple invoice (or the entire batch)
       then click a master submit reconcialtion - and that when the workers fire to save."*

       ⚠ WHAT THIS DOES NOT CHANGE. The copy was ALREADY asynchronous — Vercel does not hold the
       SharePoint credential, so `doc_reconcile` has always queued the work for the VM. Ten invoices
       still take the worker the same total time. What changes is that she is not made to watch each
       one: she settles the whole board, presses once, and the queue drains behind her.

       ⛔ ONE FAILURE MUST NOT DISCARD THE REST. Each document is independent — a job that has gone
       missing from the directory, or a row somebody else finished thirty seconds ago, fails on its
       own and is REPORTED BY NAME. Returning a single error for the batch would make her hunt for
       which of forty rows it was, which is the "the screen is talking about itself" failure the
       refusal messages were rewritten to end. */
    if (action === 'docs_reconcile') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const items = Array.isArray(body.documents) ? body.documents : [];
      if (!items.length) return res.status(400).json({ error: 'Nothing was selected.' });
      if (items.length > 200) {
        return res.status(400).json({ error: 'Too many documents in one submit (200 max).' });
      }
      /* Read ONCE for the whole submit. Forty documents used to mean forty directory fetches. */
      let dir = null;
      try { dir = await jobDirectory(); } catch { /* each row reports it if it needed the list */ }

      const done = [], failed = [];
      for (const it of items) {
        const docId = String((it && it.doc_id) || '').trim();
        const jobNo = String((it && it.job_no) || '').trim();
        const out = await reconcileOneDoc(docId, jobNo, {
          dir, noFiling: it && it.no_filing === true, reason: it && it.reason });
        if (out.status === 200) {
          done.push({ doc_id: docId, queued: !!out.body.queued,
            file_name: out.body.document && out.body.document.file_name });
        } else {
          failed.push({ doc_id: docId, file_name: (it && it.file_name) || null,
            error: (out.body && out.body.error) || `failed (${out.status})` });
        }
      }
      return res.status(200).json({ ok: true,
        submitted: done.length, queued: done.filter(d => d.queued).length,
        failed: failed.length, results: done, errors: failed });
    }

    /* The master edit. Deliberately refused once a document is reconciled: the copy in the job
       folder is filed under the name it had, and silently renaming one half of a pair is worse than
       refusing. Rare-case corrections happen BEFORE filing, which is where the review is anyway. */
    if (action === 'doc_update') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const docId = String(body.doc_id || '').trim();
      if (!docId) return res.status(400).json({ error: 'A document id is required.' });
      const cur = await sb(`ryc_batch_documents?company_id=eq.ryc&id=eq.${docId}&select=*`);
      const doc = cur.ok ? (await cur.json())[0] : null;
      if (!doc) return res.status(404).json({ error: 'No such document.' });
      /* ===== A NAME CAN BE FIXED AFTER FILING. A JOB CANNOT. ==========================
         ⛔ THIS GUARD AND THE RENAME ARM CONTRADICTED EACH OTHER. `doc_update` refused every edit
         on a reconciled row — *"Edit it before filing, not after"* — while migration 053 built a
         rename arm for exactly this and recorded that it is **"DELIBERATELY NOT SCOPED TO
         `reconciled_at is null`"**, because a name fixed after filing still has to reach the
         archive copy and the #AScans mirror. So the mechanism existed and nothing could ever
         trigger it.
         Found 2026-08-26 on two real documents: Midwest Glass PA#2 and PA#3 on Shipshewana were
         filed carrying each other's billed figure. The front office could not correct them in the
         tool — the only route left was renaming in SharePoint by hand, which leaves `file_name` and
         `sp_name` disagreeing forever, the precise drift migration 014 exists to prevent.

         ⚠ THE JOB STAYS LOCKED, AND THAT IS THE WHOLE POINT OF THE ORIGINAL GUARD. Changing where a
         filed document belongs means MOVING it and retiring the old copy — that is `doc_recorrect`,
         which does both and keeps the previous placement in the row's history. Letting `doc_update`
         quietly repoint a filed row would leave the file sitting in the old folder with the record
         claiming the new one. Only the NAME opens up here. */
      if (doc.reconciled_at && body.job_no !== undefined) {
        return res.status(409).json({
          error: `"${doc.file_name}" is already filed to ${doc.job_name || doc.job_no}. `
            + 'Use Change job to move it — that retires the copy in the old folder; '
            + 'editing here would leave the file where it is.' });
      }
      const patch = { updated_at: new Date().toISOString() };
      if (body.file_name !== undefined) {
        const nm = String(body.file_name || '').trim();
        if (!nm) return res.status(400).json({ error: 'A file name cannot be empty.' });
        if (SP_ILLEGAL.test(nm)) {
          return res.status(400).json({ error: 'A file name cannot contain \\ / : * ? " < > | characters.' });
        }
        patch.file_name = /\.pdf$/i.test(nm) ? nm : `${nm}.pdf`;
      }
      if (body.job_no !== undefined) {
        const jobNo = String(body.job_no || '').trim();
        if (jobNo.toUpperCase() === RYC_EXPENSE.no) {
          patch.job_no = RYC_EXPENSE.no; patch.job_name = RYC_EXPENSE.name;
        } else if (jobNo) {
          let dir = null;
          try { dir = await jobDirectory(); } catch { /* reported below */ }
          if (!dir) return res.status(503).json({ error: 'The job list could not be read just now — try again.' });
          const j = pickableJobs(dir).find(x => x.no === jobNo);
          if (!j) return res.status(400).json({ error: `${jobNo} is not a job that can be filed to.` });
          patch.job_no = j.no; patch.job_name = j.name;
        } else {
          patch.job_no = null; patch.job_name = null;
        }
        patch.job_source = 'chosen';
      }
      /* The `reconciled_at is null` filter is a RACE guard, not the policy — it stops a row being
         edited in the instant between the read above and this write. On a row that is ALREADY
         reconciled there is no race to lose, and keeping the filter would refuse the very rename
         this action now exists to allow. */
      /* ⚠ TWO LITERAL CALLS RATHER THAN ONE WITH A COMPUTED URL, DELIBERATELY. The first draft
         built the path into a variable, and `verify-ryc-patch-limit.mjs` — which reads the URL out
         of the call site — silently stopped counting it: 31 mutating calls checked became 30, with
         nothing red. A lint that cannot see a call is indistinguishable from a lint that approves
         it, which is the failure this module has met before. Keep the URL where the tool can read
         it. */
      const opts = { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch) };
      const r = doc.reconciled_at
        ? await sb(`ryc_batch_documents?id=eq.${docId}`, opts)
        : await sb(`ryc_batch_documents?id=eq.${docId}&reconciled_at=is.null`, opts);
      if (!r.ok) return res.status(502).json({ error: 'Could not update the document.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That document was reconciled a moment ago.' });
      /* She picked a job for this printed text — that is the confirmation the hint store is built
         from. Taught here, on the CHOICE, rather than on completion: a document she assigns and
         then resolves without filing has still told us what that text means. */
      let learned = null;
      if (body.job_no !== undefined && patch.job_no) {
        learned = await learnJobHint(rows[0], patch.job_no);
      }
      return res.status(200).json({ ok: true, document: rows[0], learned });
    }

    /* CORRECTING A RECONCILIATION IS NOT REPEATING ONE. Keith, 2026-08-19: *"the user should have
       the ability to edit Job Assignment (in case there is an error)."*

       `doc_reconcile` still refuses a second attempt — that guard exists so a double-click cannot
       put one payable into a job folder twice, and it is untouched. This is the other case, which
       will happen: the wrong job. The live queue already holds one — Kropp Fire Protection
       $30,161.25 resolved to Milford Water Utility because the delivery address reads
       "CHORE TIME 410 N. HIGBEE ST. MILFORD" and "Milford" belongs to exactly one job name.

       ⛔ A CORRECTION IS A MOVE, NEVER A SECOND FILE. The copy already sitting in the wrong job's
       folder is retired first (`retire_path`), and only then is the document re-filed. Leaving both
       would put the mistake and the fix in the archive side by side, reconciling against two job
       budgets — which is worse than the original error and much harder to notice.

       The prior disposition is APPENDED to `history`, never overwritten. These records sit behind
       money moving between job budgets; "it was on the wrong job until someone moved it" is a fact
       the archive has to be able to answer later. */
    if (action === 'doc_recorrect') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const docId = String(body.doc_id || '').trim();
      const jobNo = String(body.job_no || '').trim();
      if (!docId || !jobNo) return res.status(400).json({ error: 'A document id and a job are required.' });

      const cur = await sb(`ryc_batch_documents?company_id=eq.ryc&id=eq.${docId}&select=*`);
      const doc = cur.ok ? (await cur.json())[0] : null;
      if (!doc) return res.status(404).json({ error: 'No such document.' });
      if (!doc.reconciled_at) {
        return res.status(409).json({
          error: `"${doc.file_name}" has not been reconciled yet — use the job list on the row.` });
      }
      if (doc.retire_path) {
        return res.status(409).json({
          error: 'A correction on this document is still being applied — give it a moment.' });
      }

      const expense = jobNo.toUpperCase() === RYC_EXPENSE.no;
      let job_name = RYC_EXPENSE.name;
      if (!expense) {
        let dir = null;
        try { dir = await jobDirectory(); } catch { /* reported below */ }
        if (!dir) return res.status(503).json({ error: 'The job list could not be read just now — try again.' });
        const j = pickableJobs(dir).find(x => x.no === jobNo);
        if (!j) return res.status(400).json({ error: `${jobNo} is not a job that can be filed to.` });
        job_name = j.name;
      }
      /* ⛔ "ALREADY WHERE IT IS FILED" IS FALSE FOR A ROW THAT WAS NEVER FILED (2026-08-26).
         `job_unfiled` is Keith's third ending — the job is recorded and NOTHING is copied, for the
         30 of 53 active jobs that genuinely have no SharePoint folder. It was reachable, and then
         it was a DEAD END: this guard refused a re-file to the same job, so once the front office
         chose it there was no way back, ever. Premium Plant Services $2,934.37 sat resolved against
         26X021 while `2026/ITR - East Point` existed the whole time — and the filer's own refusal
         message had NAMED that folder before offering her the button that means it does not exist.

         Re-filing an unfiled row to its own job is not a repeat. It is the copy that never happened:
         `retire_path` stays null because there is nothing to take back, and the double-click guard
         is untouched because a `job_folder` row still cannot be re-filed to where it already is. */
      const refiling = doc.disposition === 'job_unfiled' && !expense && doc.job_no === jobNo;
      if (!refiling && doc.job_no === (expense ? RYC_EXPENSE.no : jobNo)) {
        return res.status(400).json({ error: `That is already where "${doc.file_name}" is filed.` });
      }

      const past = Array.isArray(doc.history) ? doc.history.slice() : [];
      const evt = {
        at: doc.reconciled_at, by: doc.reconciled_by || null,
        job_no: doc.job_no, job_name: doc.job_name, disposition: doc.disposition,
        copied_path: doc.copied_path, copied_url: doc.copied_url,
      };
      /* A RE-FILE IS NOT A CORRECTION AND MUST NOT BE COUNTED AS ONE. The row's badge counts
         `corrected_at` entries; stamping one here would tell the front office they got the job
         wrong when what actually happened is that the folder was found. Nothing was wrong with the
         job — only with there being nowhere to put the file. */
      if (refiling) {
        evt.action = 'refiled_after_folder_found';
        evt.refiled_at = new Date().toISOString();
      } else {
        evt.corrected_at = new Date().toISOString();
        evt.corrected_to = expense ? RYC_EXPENSE.no : jobNo;
      }
      past.push(evt);

      /* Reopening the row is what puts it back in front of the worker. `retire_path` carries the
         copy that must be deleted; when there is none (it was RYC Expense, so nothing was ever
         copied) and the new answer is RYC Expense too, there is no work to do and it completes
         here. Everything else goes to the VM, because only the VM can touch SharePoint. */
      const retire = doc.disposition === 'job_folder' ? doc.copied_path : null;
      const patch = {
        history: past, retire_path: retire,
        job_no: expense ? RYC_EXPENSE.no : jobNo, job_name, job_source: 'chosen',
        disposition: expense ? 'ryc_expense' : 'job_folder',
        copied_path: null, copied_url: null,
        // Same reason as `doc_reconcile` above: never blank a lease a worker is holding.
        copy_error: doc.copy_error === 'working' ? 'working' : null,
        reconciled_at: null, reconciled_by: null,
        updated_at: new Date().toISOString(),
      };
      if (expense && !retire) {
        patch.reconciled_at = new Date().toISOString();
        patch.reconciled_by = who.via === 'admin' ? 'admin' : 'front office';
      }
      const r = await sb(`ryc_batch_documents?id=eq.${docId}&reconciled_at=not.is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not record the correction.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That document changed a moment ago — reload.' });
      return res.status(200).json({ ok: true, document: rows[0], queued: !(expense && !retire) });
    }

    /* Every job a person may deliberately file an invoice to, plus RYC Expense.
       ⚠ WIDER THAN THE MATCHER'S LIST, ON PURPOSE (Keith, 2026-08-19: *"Yes include all real
       jobs"*). The auto-matcher still excludes warranty work and the two PMs' own residences,
       because an invoice whose job field reads "Brad Yoder" would land on one of them confidently
       and wrongly. A HUMAN choosing one from a dropdown is a different act, and refusing them a
       real destination only moves the misfile somewhere less visible. Only the test jobs stay out
       of both — they are not real work. */
    if (action === 'file_targets') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      let dir = null;
      try { dir = await jobDirectory(); } catch { /* reported below */ }
      if (!dir) return res.status(503).json({ error: 'The job list could not be read just now.' });
      return res.status(200).json({ ok: true, jobs: pickableJobs(dir), as_of: dir.asOf });
    }

    /* ⛔ WHEN THE MATCHER REFUSES, A PERSON HAS TO BE ABLE TO SETTLE IT (Keith, 2026-08-21):
       *"the user should be able to action it."*

       `resolve_job_folder()` has always checked a human-confirmed job -> folder map BEFORE any
       resemblance scoring. It read `job-folder-map.json` on the VM, and measured on 2026-08-21
       THAT FILE HAD NEVER EXISTED — the one override designed to overrule the matcher was
       reachable from no screen. These two actions are its handle.

       The picker offers only folders the VM has actually seen in SharePoint. Letting her type a
       path would let her name one that does not exist, and the failure would arrive later, on the
       copy, looking like a different problem. */
    /* ⛔ THE FRONT OFFICE TAUGHT THIS TOOL FOR FIVE BATCHES AND IT LEARNED NOTHING.
       Erica McIntosh, 2026-08-21: *"NP Tech/ New Paris, Ryan Fire Protection and Coldwater WWTP do
       not show up with the job picked in the drop down. I noticed that the detail for the invoice
       is showing that it is picking up the name in the invoice text."*

       Her second sentence is the whole diagnosis: the job name IS printed on the invoice and IS
       captured into `job_text` — the matcher just cannot turn "Ryan Fire Protection" into a job
       named "Ryan Fire Prot - Valpo", or "NP TECH" into "NPTech Community Fiber".

       `ryc_invoice_job_hints` is the product's own answer to exactly that, and it was wired to the
       PM desk only. Measured the same day: 17 hints, all from 2026-08-11..13; Erica had reconciled
       five batches since, every job chosen by hand, teaching it nothing. Same shape as the
       job-folder override fixed hours earlier — a learning store reachable from one of the two
       surfaces that need it.

       Teaching NEVER blocks the assignment: a hint that fails to save must not stop an invoice
       being filed. It is an optimisation for next time, not part of this decision. */
    async function learnJobHint(doc, jobNo) {
      try {
        if (!doc || !doc.vendor || !doc.job_text || !jobNo) return null;
        const r = await sb('rpc/ryc_learn_job_hint', {
          method: 'POST',
          body: JSON.stringify({ p_vendor: doc.vendor, p_job_text: doc.job_text, p_job_no: jobNo,
            p_actor: who.via === 'admin' ? 'admin' : 'front office' }),
        });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }

    if (action === 'job_folders') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const f = await sb('ryc_job_folders?company_id=eq.ryc&select=folder,seen_at&order=folder.asc&limit=2000');
      if (!f.ok) return res.status(502).json({ error: 'The folder list could not be read.' });
      const folders = await f.json();
      const m = await sb('ryc_job_folder_map?company_id=eq.ryc&select=job_no,folder,set_by,set_at,note&limit=2000');
      return res.status(200).json({
        ok: true,
        folders: folders.map(x => x.folder),
        /* Published, not live. If the index is stale the picker is stale, and a screen that cannot
           say how old its list is will be believed anyway. */
        as_of: folders.length ? folders.map(x => x.seen_at).sort().slice(-1)[0] : null,
        overrides: m.ok ? await m.json() : [],
      });
    }

    /* Pin a job to a folder, permanently, and re-arm the copy that was refused.
       ⚠ THIS OUTRANKS EVERY GUARD BELOW IT — the two-distinctive-words rule, the ambiguity refusal,
       all of it. That is what it is for, and it is why the row records who set it. */
    if (action === 'job_folder_pin') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const jobNo = String(body.job_no || '').trim();
      const folder = String(body.folder || '').trim();
      if (!jobNo || !folder) return res.status(400).json({ error: 'A job and a folder are required.' });
      if (jobNo.toUpperCase() === RYC_EXPENSE.no) {
        return res.status(400).json({ error: 'RYC Expense is not filed to a folder.' });
      }
      /* The folder must be one the VM has seen. A pin to a path that does not exist would look
         settled here and fail on the copy, which is the failure mode this whole action exists to
         end rather than relocate. */
      const chk = await sb(`ryc_job_folders?company_id=eq.ryc&folder=eq.${encodeURIComponent(folder)}&select=folder`);
      const hit = chk.ok ? await chk.json() : [];
      if (!hit.length) {
        return res.status(400).json({
          error: `${folder} is not a SharePoint job folder the system has seen. Pick one from the list.` });
      }
      const row = {
        company_id: 'ryc', job_no: jobNo, folder,
        note: String(body.note || '').slice(0, 300) || null,
        set_by: who.via === 'admin' ? 'admin' : 'front office',
        set_at: new Date().toISOString(),
      };
      const r = await sb('ryc_job_folder_map?on_conflict=company_id,job_no', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([row]),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not save that folder.' });

      /* Re-arm every copy this job had refused. `copy_error` is what keeps a failed row out of
         `doc_copy_claim`, so clearing it IS the retry — the same thing the button does. Scoped to
         this job and to rows that are not finished, so nothing already settled is disturbed. */
      let rearmed = 0;
      const ra = await sb(`ryc_batch_documents?company_id=eq.ryc&job_no=eq.${encodeURIComponent(jobNo)}`
        + '&reconciled_at=is.null&disposition=eq.job_folder&copy_error=not.is.null'
        + '&copy_error=neq.working', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ copy_error: null, updated_at: new Date().toISOString() }),
      });
      if (ra.ok) rearmed = (await ra.json()).length;
      return res.status(200).json({ ok: true, map: (await r.json())[0], rearmed });
    }

    /* ---- the copy worker's actions. Service token only (see SERVICE_ACTIONS). ----
       The copy itself happens on keith-agent-01: SharePoint needs the delegated credential, which
       deliberately does not exist on Vercel. Same split as everything else here — the API owns the
       STATE, the VM owns the WORK. */
    /* WHAT FOLDERS EXIST is a statement about SharePoint, so only the machine holding the
       SharePoint credential may make it (MACHINE_ONLY). Published as a whole set and reconciled
       against what is stored: a folder that has been renamed or removed must LEAVE the picker,
       otherwise she is offered a destination that no longer exists and the pin fails on the copy. */
    if (action === 'job_folders_publish') {
      const list = Array.isArray(body.folders) ? body.folders : null;
      if (!list) return res.status(400).json({ error: 'folders[] is required.' });
      if (!list.length) {
        /* An empty publish would silently empty the picker, and the likeliest cause of one is a
           broken index build rather than an RYC with no job folders. Refuse it. */
        return res.status(400).json({ error: 'Refusing to publish an empty folder list.' });
      }
      const now = new Date().toISOString();
      const rows = list.map(f => ({ company_id: 'ryc', folder: String(f), seen_at: now }));
      const up = await sb('ryc_job_folders?on_conflict=company_id,folder', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows),
      });
      if (!up.ok) return res.status(502).json({ error: 'Could not publish the folder list.' });
      const del = await sb(`ryc_job_folders?company_id=eq.ryc&seen_at=lt.${now}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true, published: rows.length, pruned: del.ok });
    }

    /* The filer's read of the override map. It runs on the VM and already talks to this API, so the
       map lives here rather than in a file on one machine's disk that nothing could write. */
    if (action === 'job_folder_map') {
      const m = await sb('ryc_job_folder_map?company_id=eq.ryc&select=job_no,folder&limit=2000');
      if (!m.ok) return res.status(502).json({ error: 'Could not read the folder map.' });
      const out = {};
      for (const r of await m.json()) out[r.job_no] = r.folder;
      return res.status(200).json({ ok: true, map: out });
    }

    /* ===== THE STAMP QUEUE (migration 060) ==========================================
       Same claim → do → report shape as the copy queue below, and deliberately so: the machine
       holding the SharePoint credential does the work, this endpoint owns the state.

       WHAT IT IS FOR. `do_doc_copy()` stamps the PDF in memory on its way into the JOB folder, so
       the copy in the BATCH folder — the one Erica opens while she reconciles — was never stamped
       at all. Keith, 2026-08-27: *"she may need to look at his stamp for more detail during
       reconciliation."* She cannot read a stamp that will not exist until after she has finished.
       So the PM's submit burns it into the batch-folder copy, and the reconcile copy then carries an
       already-stamped file rather than stamping a second one.

       ⚠ THIS QUEUE IS NEVER A GATE. A batch reaches the front office because it was SUBMITTED. If
       every stamp in a folder fails, she still reconciles and the money still reaches the job
       folder — the failure is reported on the row and the copy path stamps as a fallback. An
       accounts-payable freeze caused by a stamping outage would be far worse than an invoice
       carrying no rubber stamp, which is what every invoice carried before 2026-08-26. */
    if (action === 'doc_stamp_claim') {
      /* PICK, THEN CLAIM — `limit=` does nothing on a PostgREST PATCH, and the copy queue has
         already paid for that lesson once (nine rows leased, one copied, eight stranded). */
      const pick = await sb('ryc_batch_documents?company_id=eq.ryc&stamp_state=eq.pending'
        + '&select=id&order=updated_at.asc&limit=1');
      if (!pick.ok) return res.status(502).json({ error: 'claim failed' });
      const cand = (await pick.json())[0];
      if (!cand) return res.status(200).json({ ok: true, document: null });
      const r = await sb(`ryc_batch_documents?company_id=eq.ryc&id=eq.${cand.id}`
        + '&stamp_state=eq.pending', {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ stamp_state: 'working', updated_at: new Date().toISOString() }),
        });
      if (!r.ok) return res.status(502).json({ error: 'claim failed' });
      // Zero rows = another worker claimed it between the pick and the PATCH. Poll again.
      const doc = (await r.json())[0] || null;
      if (doc) {
        /* The file lives in the batch's own SharePoint folder under `sp_name`. The worker is told
           where, never asked to work it out — resolving a folder from a displayed name is the
           mistake the operating rules already forbid. */
        const b = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${doc.batch_id}`
          + '&select=folder,folder_url,received_date');
        if (b.ok) {
          const batch = (await b.json())[0];
          if (batch) {
            doc.batch_folder = batch.folder;
            doc.batch_folder_url = batch.folder_url;
            /* The stamp prints the RECEIVED date the office actually marked on the paper. Deriving
               it from now() would restart every discount and staleness window on a page that has
               been sitting in a folder for a week. */
            doc.received_date = batch.received_date;
          }
        }
      }
      return res.status(200).json({ ok: true, document: doc });
    }

    /* The worker reports what actually happened to the page. A failure is RECORDED, not retried
       forever: `failed` leaves the queue, stays visible on her row, and the copy path will still
       stamp the job-folder copy as a fallback — so a stamping bug costs the batch-folder stamp and
       nothing else. */
    if (action === 'doc_stamp_done') {
      const docId = String(body.doc_id || '').trim();
      if (!docId) return res.status(400).json({ error: 'A document id is required.' });
      const failed = String(body.error || '').trim();
      const patch = failed
        ? { stamp_state: 'failed', stamp_error: failed.slice(0, 500),
            updated_at: new Date().toISOString() }
        : { stamp_state: 'done', stamped_at: new Date().toISOString(), stamp_error: null,
            updated_at: new Date().toISOString() };
      /* Guarded on the lease this worker holds, so a late report from a dead worker cannot
         overwrite a stamp a live one has since completed. */
      const r = await sb(`ryc_batch_documents?id=eq.${docId}&stamp_state=eq.working`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not record the stamp.' });
      const rows = await r.json();
      if (!rows.length) return res.status(409).json({ error: 'That document is not claimed for stamping.' });
      return res.status(200).json({ ok: true, document: rows[0] });
    }

    if (action === 'doc_copy_claim') {
      /* Claim by PATCHing a row that is still claimable and letting PostgREST report what it
         actually changed, so two workers cannot both win. `copy_error` doubles as the lease: a
         worker that dies leaves a visible "working" a human can see, rather than a row that
         silently re-runs and copies an invoice into a job folder twice. */
      /* THREE kinds of outstanding work, in ONE claim so none of them can starve the others:
           1. a copy to MAKE    — disposition job_folder, not yet reconciled
           2. a copy to RETIRE  — after a correction, including a correction to RYC Expense, where
                                  removing the file is the only work left
           3. a rename to APPLY — `rename_pending`, migration 053

         ⛔ (3) IS DELIBERATELY NOT CONSTRAINED TO `reconciled_at is null`, and that is the whole
         point of it. `ryc_expense` and `job_unfiled` complete INLINE in `doc_reconcile` — there is
         no copy to wait for — so a rename staged just before that click had nowhere to be executed
         and was dropped on the floor: the archive copy kept the old name while the record asserted
         the new one, and the #AScans mirror was never renamed under ANY ending. Claiming a finished
         row for a rename is safe because the rename reports through `doc_rename_done`, which
         cannot set `reconciled_at`. */
      /* ⛔ `limit=1` ON A PATCH DOES NOTHING, AND THIS LEASED THE WHOLE QUEUE EVERY TIME.
         PostgREST applies `limit` to a GET; on an UPDATE it is ignored. So this single statement
         set `copy_error = 'working'` on EVERY claimable row, handed back `rows[0]`, and left the
         others leased to a worker that was never going to touch them — stranded until a person
         cleared them by hand.

         INVISIBLE UNTIL THE QUEUE HELD MORE THAN ONE. With a single document it behaves exactly as
         intended, which is why it survived from the day it was written. Greencroft put NINE
         claimable rows in at once: the worker leased nine, copied one, and went idle with eight
         held. Keith, watching the screen say "copying to SharePoint…" for twelve minutes:
         *"looks like it is still working."* It was not.
         The tell was in the data — all eight carried the SAME `updated_at` to the microsecond,
         because one literal timestamp was written by one UPDATE.

         PICK, THEN CLAIM. The `id=eq.… & copy_error=is.null` PATCH keeps exactly the race-safety
         the original comment describes: two workers racing the same row means the loser's PATCH
         matches nothing and returns zero rows, and it goes back to polling. What it no longer does
         is take out a lease on work it is not doing. */
      const pick = await sb('ryc_batch_documents?company_id=eq.ryc&copy_error=is.null'
        + '&or=(and(reconciled_at.is.null,disposition.eq.job_folder),'
        + 'and(reconciled_at.is.null,retire_path.not.is.null),'
        + 'rename_pending.is.true)'
        + '&select=id&order=updated_at.asc&limit=1');
      if (!pick.ok) return res.status(502).json({ error: 'claim failed' });
      const cand = (await pick.json())[0];
      if (!cand) return res.status(200).json({ ok: true, document: null });
      const r = await sb(`ryc_batch_documents?company_id=eq.ryc&id=eq.${cand.id}&copy_error=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ copy_error: 'working', updated_at: new Date().toISOString() }),
      });
      if (!r.ok) return res.status(502).json({ error: 'claim failed' });
      const rows = await r.json();
      // Zero rows = another worker claimed it between the pick and the PATCH. Poll again.
      const doc = rows[0] || null;
      if (doc) {
        const b = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${doc.batch_id}`
          + '&select=folder,received_date,filed,pm_approved_at');
        if (b.ok) {
          const batch = (await b.json())[0];
          if (batch) {
            doc.batch_folder = batch.folder; doc.received_date = batch.received_date;

            /* ===== THE STAMP GOES ON A DIGITAL APPROVAL AND NOTHING ELSE ===================
               Keith, 2026-08-26: *"Let's implement item 8 for those invoices approved by logan.
               The batch approval process where erica uploads the already approved invoices do not
               need the stamp."* Right, and the reason is that the paper already carries it — those
               folders were signed before they were scanned, so stamping them would print a second,
               weaker claim on top of a real signature.

               THE DECISION IS MADE HERE, NOT IN THE WORKER. The worker stamps if and only if it is
               handed an `approval`, so "should this be stamped" has exactly one expression. Two
               conditions, and both are necessary:
                 · the batch is NOT marked `pm_approved_at` — nobody has said it came in signed;
                 · a payable for this document exists and is `approved` — a PM actually pressed it.
               A paper batch fails the first. A digital batch whose PM has not answered yet fails
               the second, and the copy cannot happen before he answers anyway.

               ⚠ IT CARRIES `identity_verified` THROUGH UNCHANGED. Until per-user sign-in that is
               false for everyone, and the stamp says so rather than implying a verified signature —
               a rubber stamp asserting more than the record holds is worse than no stamp. */
            /* ⛔ AND NOT IF THE PAGE ALREADY CARRIES ONE (migration 060). Since the PM's submit
               burns the stamp into the batch-folder copy, the file this worker is about to copy is
               already stamped — stamping it again would print a second, overlapping mark on the same
               page. `done` is the only state that proves it: `failed` deliberately falls THROUGH to
               here, so a batch-folder stamp that could not be written still reaches the job folder
               stamped by the old path. A stamp must never cost a filing, and it must never cost a
               stamp either where there is a second chance to apply one. */
            let approval = null;
            if (!batch.pm_approved_at && doc.stamp_state !== 'done') {
              try {
                const rb = await sb('ryc_invoice_batches?company_id=eq.ryc&select=id'
                  + `&source_message_id=eq.${encodeURIComponent('scan:' + doc.batch_id)}`);
                const regB = rb.ok ? (await rb.json())[0] : null;
                if (regB) {
                  /* Matched on (vendor, amount) — the pair `ryc_register_invoice` already dedupes
                     on. There is no foreign key from a batch document to its payable and inventing
                     one would be a migration for a lookup that has a natural key. */
                  const ir = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${regB.id}`
                    + '&review_state=eq.approved'
                    + '&select=vendor_name,amount,cost_month,cost_code,mat_or_sub,reviewed_by,'
                    + 'reviewed_at,identity_verified&limit=500');
                  if (ir.ok) {
                    const want = `${vendorKey(doc.vendor)}|${amountKey(doc.amount)}`;
                    const hit = (await ir.json())
                      .find(i => `${vendorKey(i.vendor_name)}|${amountKey(i.amount)}` === want);
                    if (hit) {
                      approval = {
                        month: hit.cost_month || null,
                        cost_code: hit.cost_code || null,
                        mat_or_sub: hit.mat_or_sub || null,
                        pm: hit.reviewed_by || null,
                        approved_at: hit.reviewed_at || null,
                        identity_verified: !!hit.identity_verified,
                      };
                    }
                  }
                }
              } catch { /* no stamp is a safe outcome; a wrong stamp is not */ }
            }
            doc.approval = approval;
            /* WHERE THE #AScans MIRROR WENT — read off the batch's own verification record, never
               recomputed from today's date. The daily folder is named for the day the scan was
               PROCESSED, and a rename can land days later, so deriving it from now() would point
               the worker at the wrong day's folder or at one that does not exist. Null is a
               legitimate answer (a batch filed before the mirror existed, or one whose folder
               could not be made): then there is nothing to rename, which is not a failure. */
            doc.daily_folder = (batch.filed && batch.filed.daily_folder) || null;
          }
        }
      }
      return res.status(200).json({ ok: true, document: doc });
    }

    /* The worker reports what actually happened. A SUCCESS here is the only thing that sets
       `reconciled_at`, and it is set from evidence — the copy landed at this path, at this URL. */
    if (action === 'doc_copy_done') {
      const docId = String(body.doc_id || '').trim();
      if (!docId) return res.status(400).json({ error: 'A document id is required.' });
      const failed = String(body.error || '').trim();

      /* ===== A SPLIT PAGE HAS SEVERAL DESTINATIONS AND IS FINISHED ONLY WHEN ALL OF THEM LAND ===
         The worker reports one entry per destination. Four of five is NOT a reconciliation: a
         reconciled row is refused all further physical work by design, so completing a partial
         copy would strand the missing folders permanently and report success while doing it.
         So `copies` is recorded either way — that is what makes a retry safe, because the worker
         skips a destination already recorded as landed and `upload()` uses conflictBehavior=fail —
         and `reconciled_at` is set only when nothing is outstanding.

         ⚠ `copied_path` / `copied_url` KEEP THEIR OLD MEANING: one copy, the first that landed.
         Erica's screen links to them, and a link that silently changed shape would break the one
         control she uses to check a filing. `copies` says where else it went. */
      const copies = Array.isArray(body.copies) ? body.copies.filter(Boolean) : null;
      const landed = copies ? copies.filter(c => !c.error) : null;
      const missed = copies ? copies.filter(c => c.error) : null;
      const complete = !failed && (!copies || missed.length === 0);
      const stamp = new Date().toISOString();

      /* WHAT HAPPENED TO THE SUB LIEN WAIVERS (migration 071). Recorded on BOTH endings — a waiver
         that could not be split is a fact whether or not the invoice itself landed, and losing it
         on the failure branch would mean the only record of a missing waiver disappears exactly
         when someone is looking at the row.
         ⛔ IT NEVER AFFECTS `complete`. The payable reaching its job folder is what reconciles a
         document; a second artefact from the same page must not be able to hold a filing open, or
         a missing Pay Apps folder would strand real money on the board. */
      const waiverCopies = Array.isArray(body.waiver_copies)
        ? body.waiver_copies.filter(Boolean) : null;

      const patch = complete
        ? {
            copy_error: null,
            copied_path: (landed && landed.length ? landed[0].path : body.path) || null,
            copied_url: (landed && landed.length ? landed[0].url : body.url) || null,
            ...(copies ? { copies } : {}),
            ...(waiverCopies ? { waiver_copies: waiverCopies } : {}),
            sp_name: body.sp_name || undefined,
            // The retirement is only finished once the worker says so; clearing it here is what
            // takes a corrected document back out of the work queue.
            retire_path: null,
            reconciled_at: stamp, reconciled_by: 'front office',
            updated_at: stamp,
          }
        : {
            /* NAME WHAT IS MISSING, NOT JUST THAT SOMETHING IS. The retry clears `copy_error`, so
               this sentence is the whole of what a person has to work from. */
            copy_error: (failed || `filed to ${landed.length} of ${copies.length} job folder(s) — `
              + `still owed: ${missed.map(c => `${c.job_no || '?'} (${c.error})`).join('; ')}`
            ).slice(0, 500),
            ...(copies ? { copies } : {}),
            ...(waiverCopies ? { waiver_copies: waiverCopies } : {}),
            ...(landed && landed.length
              ? { copied_path: landed[0].path || null, copied_url: landed[0].url || null }
              : {}),
            updated_at: stamp,
          };
      const r = await sb(`ryc_batch_documents?id=eq.${docId}&reconciled_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not record the copy.' });
      return res.status(200).json({ ok: true, document: (await r.json())[0] || null });
    }

    /* THE RENAME IS WORK IN ITS OWN RIGHT, AND IT DOES NOT FINISH A DOCUMENT.

       ⛔ IT MUST NOT REPORT THROUGH `doc_copy_done`. That action sets `reconciled_at` from
       evidence — a copy landed at this path, at this URL. A rename is evidence of nothing of the
       kind: the row it is applied to may not even have a job yet, because she is free to fix a
       name before deciding anything. Routing a rename through there would complete a
       reconciliation nobody made, which is the worst single thing this table can be made to say.
       So this is a second, narrower report: it writes what the file is NOW CALLED, releases the
       lease, and touches nothing else. */
    if (action === 'doc_rename_done') {
      const docId = String(body.doc_id || '').trim();
      if (!docId) return res.status(400).json({ error: 'A document id is required.' });
      const failed = String(body.error || '').trim();
      const nowName = String(body.sp_name || '').trim();
      if (!failed && !nowName) {
        return res.status(400).json({ error: 'A successful rename must say what the file is now called.' });
      }
      const patch = failed
        ? { copy_error: failed.slice(0, 500), updated_at: new Date().toISOString() }
        : { copy_error: null, sp_name: nowName, updated_at: new Date().toISOString() };

      /* WHAT THE #AScans MIRROR DID IS RECORDED, AND ONLY WHEN IT WAS NOT A CLEAN SUCCESS.
         A clean one needs no record — `sp_name` proves it, and appending on every rename would
         bury the corrections this column exists to keep. The cases worth keeping forever are the
         ones where the office's daily-scan copy did NOT follow the name, because a mirror that
         quietly stops tracking is exactly how "we put them in #AScans too" stops being true
         without anybody noticing. Same reasoning as `daily_failed` on the batch itself. */
      if (!failed && body.daily_note) {
        const cur = await sb(`ryc_batch_documents?company_id=eq.ryc&id=eq.${docId}&select=history`);
        const row = cur.ok ? (await cur.json())[0] : null;
        patch.history = [...(Array.isArray(row && row.history) ? row.history : []), {
          at: new Date().toISOString(), action: 'daily_scan_rename',
          from: String(body.was || '').slice(0, 200) || null,
          to: nowName || null,
          result: String(body.daily_note).slice(0, 300),
        }];
      }
      const r = await sb(`ryc_batch_documents?id=eq.${docId}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not record the rename.' });
      return res.status(200).json({ ok: true, document: (await r.json())[0] || null });
    }
    /* ---- the worker's two actions. Service token only (see SERVICE_ACTIONS). ---- */
    if (action === 'batch_claim') {
      /* Claim by PATCHing a row that is still in a claimable state, and let PostgREST return
         what it actually changed. Two workers racing therefore cannot both win: the second one
         matches zero rows. A stale lease is visible in `claimed_at` rather than invented here —
         a worker that dies leaves a row a human can see, not one that silently re-runs. */
      const want = String(body.state || '') === 'confirmed' ? 'confirmed' : 'uploaded';
      const next = want === 'confirmed' ? 'filing' : 'rendering';
      /* ⛔ SAME DEFECT AS `doc_copy_claim`, FOUND IN THE SAME SWEEP (2026-08-26): `limit=1` on a
         PATCH is ignored by PostgREST, so this moved EVERY batch in `uploaded` to `rendering` (or
         every `confirmed` to `filing`), returned one, and left the rest sitting in a working state
         no worker was working. Worse here than on a document, because the batch's STATUS is what
         the board reads — a stranded batch reports "rendering pages" indefinitely.
         Latent while the front office scanned one folder at a time; today there were several.
         Pick, then claim conditionally: the loser of a race matches zero rows and polls again. */
      const pick = await sb(`ryc_batch_jobs?company_id=eq.ryc&status=eq.${want}`
        + '&select=id&order=created_at.asc&limit=1');
      if (!pick.ok) return res.status(502).json({ error: 'claim failed' });
      const cand = (await pick.json())[0];
      if (!cand) return res.status(200).json({ ok: true, job: null });
      const r = await sb(`ryc_batch_jobs?company_id=eq.ryc&id=eq.${cand.id}&status=eq.${want}`, {
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
      if (!rows.length) return { staged: 0, unplaced: 0, community: 0, note: 'nothing waiting to be staged' };

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
        return { staged: 0, unplaced: rows.length, community: 0,
          note: 'the Procore job feed could not be read — nothing staged rather than guessed' };
      }
      const idx = tokenIndex(jobs);
      const byNo = new Map(jobs.map(j => [j.no, j]));

      const staged = [], unplaced = [], community = [];
      for (const r of rows) {
        /* A job resolved at REGISTER time — from ryc_invoice_job_hints, the alias a PM taught
           once — is already a human's answer. Re-deriving it from the printed text would be
           strictly worse than using it. */
        const known = r.job_no ? byNo.get(String(r.job_no).trim()) : null;
        const m = known
          ? { job: known, conf: 1.0, why: `job ${known.no} was already resolved on this invoice`, source: 'hint' }
          : { ...matchJob(r.job_text, jobs, idx, foundationOnly), source: 'job_text' };

        /* ⛔ A DESK WITHOUT A JOB IS A REAL ANSWER, AND IT NEEDED NO SCHEMA (2026-08-26).
           Greencroft invoices routinely name the community and not the unit — a dumpster on
           Whispering Pines, a flooring invoice whose Project field the vendor truncated at
           "Southfield Village - ". Five of the ten pages in Logan's real weekly batch, and the
           front office had already written "Which units?" on a teal sticky on every one of them.
           Treating that as "unplaced" is wrong in the way that matters: the desk, the customer and
           a candidate list of 4 to 21 are all known, so the only open question is one a PM answers
           in a tap — and it is HIS question, not the front office's (Keith, 2026-08-26).

           `ryc_stage_invoice` already accepts a PM with a null job, and `ryc_release_invoices`
           gates on `staged_pm` alone, so this releases to Logan's desk carrying the
           `job_unassigned` flag it should carry. Nothing was added to the schema; the state was
           expressible all along and nothing produced it. `staged_source` stays `job_text` — the
           desk WAS derived from the printed text — and with no job number, release leaves
           `job_source` untouched, so no vocabulary is being smuggled across that boundary. */
        if (!m.job && m.family && m.family.pm) {
          const note = `${m.family.label} — the unit is not printed. Pick one of `
            + `${m.family.candidates.length}.`;
          if (r.staged_pm !== m.family.pm || r.staged_job_no || r.staged_note !== note) {
            const s = await rpc('ryc_stage_invoice', {
              p_id: r.id, p_staged_pm: m.family.pm, p_staged_job_no: null,
              p_source: 'job_text', p_confidence: 0.5, p_note: note,
              p_expected_version: r.version, p_request_id: `${rid}:fam:${r.id}`, p_actor: actor,
            });
            if (s.status !== 200) {
              unplaced.push({ id: r.id, vendor: r.vendor_name, why: (s.body && s.body.error) || 'stage failed' });
              continue;
            }
          }
          community.push({ id: r.id, vendor: r.vendor_name, job_text: r.job_text,
            family: m.family.key, label: m.family.label, pm: m.family.pm,
            candidates: m.family.candidates, why: m.why });
          continue;
        }

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
      /* `community` is reported as its own number rather than folded into either of the others.
         Counting it as staged would tell the front office an invoice is fully placed when its job
         is still open; counting it as unplaced would put work back on their screen that is
         deliberately on the PM's. It is a third outcome and it reads as one. */
      return { staged: staged.length, unplaced: unplaced.length, community: community.length,
        staged_rows: staged, unplaced_rows: unplaced, community_rows: community };
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

    /* ===== WHICH UNIT — THE QUESTION THE FRONT OFFICE WRITES ON A STICKY NOTE ==========
       ⛔ A PM DESK ROW WITH NO JOB RENDERS A FREE-TEXT "Job no" BOX, and for Greencroft that is
       the wrong affordance by a distance. Logan Moore's desk IS Greencroft — all 28 of his active
       jobs are duplex units — so "which job" means "which of 21 houses on Whispering Pine Ct",
       and the box asks him to recall that `2518RO20` is 6516 Chestnut. Nobody does that; they go
       back to the paper, which is precisely what this module exists to replace.

       The candidates are computed HERE, by the same `familyMatch` the stager uses, rather than
       re-derived in the browser. This module has been bitten three separate times by one rule
       written twice — the desk rule the harness re-implemented, the coverage rule, the
       `rename_pending` flag — and a second copy of the community rule living in `invoices.js`
       would drift the first time an alias is added on one side only.

       Keyed by the printed text rather than by row id: two flooring invoices in one batch both
       read "Southfield Village - " and deserve one answer and one round trip. The browser already
       holds `job_text` (it is the tooltip on that very box) and already holds the job list, so
       nothing is exposed here that the desk could not already see. */
    if (action === 'job_candidates') {
      /* `items` carries the desk alongside the printed text; `texts` is the original shape and
         still works. The desk matters because of the case below. */
      const items = Array.isArray(body.items) ? body.items.slice(0, 200)
        : (Array.isArray(body.texts) ? body.texts : []).slice(0, 200).map(t => ({ text: t, pm: null }));
      const texts = items.map(i => (i && i.text !== undefined ? i.text : i));
      if (!texts.length) return res.status(200).json({ ok: true, families: {} });
      let dir = null;
      try { dir = await jobDirectory(); } catch { /* handled below */ }
      if (!dir || !dir.jobs.length) {
        // No feed is an honest empty answer: the desk keeps the text box it has today.
        return res.status(200).json({ ok: true, families: {}, note: 'the job feed could not be read' });
      }
      const byNo = new Map([...dir.jobs, ...(dir.foundationOnly || [])].map(j => [j.no, j]));
      const families = {};
      for (const it of items) {
        const t = (it && it.text !== undefined) ? it.text : it;
        const deskPm = (it && it.pm) ? String(it.pm).trim() : null;
        const key = String(t == null ? '' : t);
        if (Object.prototype.hasOwnProperty.call(families, key)) continue;
        const m = familyMatch(key, dir.jobs);

        /* ⛔ A SHARED COST NAMES NO COMMUNITY BY ITS NATURE, AND THAT IS THE ONE THE SPLIT IS FOR.
           A 30-yard container standing on Whispering Pines serves a street, so the ticket says
           "Waste Containers 2026" and nothing else; a stock buy of door hardware says "Rodeliser
           Stock". Both refuse, correctly — and until now that meant they fell back to a bare "Job
           no" text box with no way to split at all. **Every row that DID get the split editor was a
           single-unit invoice that never needed it**, which is exactly what Keith saw on the desk.

           So when the document says nothing but the DESK is known, the candidates are that PM's own
           jobs. That is a weaker claim than a community and it is labelled as one — it does not
           assert which units, it offers the ones he could possibly mean. For Logan Moore every
           active job is a Greencroft unit, so this is the street; for a PM with a mixed portfolio it
           is his job list, which is still the right set and still requires him to choose.

           ⚠ Only when there is more than one candidate. A PM with a single job needs no picker, and
           offering one would turn an unambiguous row into a question. */
        if (!m || !m.family) {
          if (!deskPm) continue;
          const mine = dir.jobs.filter(j => j.pm === deskPm);
          if (mine.length < 2) continue;
          const allGreencroft = mine.every(j => jobTokens(j.name).has('greencroft'));
          const misc = allGreencroft ? byNo.get('2105CO09') : null;
          families[key] = {
            key: 'desk', label: `Nothing named a community — ${deskPm}'s jobs`, pm: deskPm,
            candidates: mine.map(j => ({ no: j.no, name: j.name, pm: j.pm || null })),
            misc: misc ? { no: misc.no, name: misc.name } : null,
          };
          continue;
        }
        const def = FAMILIES.find(f => f.key === m.family.key);
        const misc = def && byNo.get(def.misc);
        families[key] = {
          key: m.family.key, label: m.family.label, pm: m.family.pm,
          candidates: m.family.candidates,
          /* Read back off the feed, never asserted from the table above. */
          misc: misc ? { no: misc.no, name: misc.name } : null,
        };
      }
      return res.status(200).json({ ok: true, families, as_of: dir.asOf || null });
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
    /* ===== THE PM HANDS THE BATCH OVER =============================================
       Keith, 2026-08-27: *"when all invoices have been approved logan should need to press a master
       submit button for the batch he is on - at which point the stamp is added and his edits are
       committed - which erica recives the batch for reconcilation it includes logans edits and
       stamps."*

       This REPLACES `close_batch` on the screen. That action only ever built a summary and told the
       PM it was *"the summary the front office receives"* — which nobody received, because it sent
       nothing anywhere. The summary itself was worth keeping, so it comes back as this action's
       return value: pressing Submit shows him exactly what he just handed over.

       It does four things, in an order chosen so a failure leaves a state a person can read:
         1. refuses if anything on his desk in this batch is still undecided — the master button is
            not a way to skip work, and the count says how much is left;
         2. records the submission, attributed (`submitted_by` is NOT NULL by constraint). This is
            the row `awaiting_pm` reads, and it is what moves the batch to the front office;
         3. carries HIS answers onto the scan documents — the job he settled, and the coding frozen
            as `stamp_approval`;
         4. queues the stamp.

       ⚠ 2 IS THE HANDOFF AND 3–4 ARE CONSEQUENCES. The submission is written FIRST and never rolled
       back by a later failure: if the stamp queue cannot be written, Erica has still been handed a
       batch a PM genuinely submitted, and an unstamped document is a visible, retryable defect. The
       reverse order would let a stamping outage silently keep a finished batch on his desk.

       ⚠ HIS JOB ANSWER OVERWRITES THE MATCHER'S, AND THAT IS THE POINT. Until now the desk's job
       assignment never reached the front office at all — `batch_documents` read `job_no` off the
       payable and threw it away — so Logan answered "which Greencroft unit" and Erica was then asked
       the same question from scratch, with his answer one table away. Doing it HERE rather than in a
       background join is what makes it honest: it happens at a moment he chose, it is recorded in
       `history` with what it replaced, and `job_source` becomes `pm`, which `batch_rematch` already
       refuses to overwrite. */
    if (action === 'submit_batch') {
      if (!pm) return res.status(400).json({ error: 'A PM is required to submit a batch.' });
      const batchId = String(body.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'A batch id is required.' });

      /* ⚠ `job_name` IS NOT A COLUMN ON THIS TABLE — it lives on `ryc_batch_documents`. Selecting it
         here made PostgREST reject the request and this endpoint answered a flat 502 "Could not read
         the batch", which is true and tells nobody anything. The name is resolved from the job
         directory below, which is where every other caller gets it. */
      const ir = await sb(`ryc_invoices?company_id=eq.ryc&batch_id=eq.${batchId}`
        + `&assigned_pm=eq.${encodeURIComponent(pm)}`
        + '&select=id,vendor_name,amount,review_state,job_no,cost_code,mat_or_sub,'
        + 'cost_month,reviewed_by,reviewed_at,identity_verified&limit=1000');
      if (!ir.ok) {
        /* SAY WHAT POSTGREST SAID. A bare 502 on a read that cannot fail for an ordinary reason is
           how the missing column above survived a deploy and four green gates. */
        const detail = await ir.text().catch(() => '');
        return res.status(502).json({
          error: `Could not read the batch (${ir.status}).`,
          detail: detail.slice(0, 300) || null });
      }
      const mine = await ir.json();
      if (!mine.length) {
        return res.status(404).json({ error: 'Nothing in that batch is on your desk.' });
      }

      const DECIDED = ['approved', 'rejected', 'not_ap', 'duplicate'];
      const open = mine.filter(i => !DECIDED.includes(i.review_state));
      if (open.length) {
        /* NAME WHAT IS LEFT. "3 still need a decision" sends him hunting; the vendors are what he
           recognises on his own screen. */
        return res.status(409).json({
          error: `${open.length} of ${mine.length} still need a decision before this batch can be `
            + `submitted: ${open.slice(0, 6).map(i => i.vendor_name || 'unnamed').join(', ')}`
            + `${open.length > 6 ? '…' : ''}`,
          outstanding: open.length, of: mine.length });
      }

      const approved = mine.filter(i => i.review_state === 'approved');
      const by = who.scope === 'pm' ? pm : `front office on behalf of ${pm}`;
      const ins = await sb('ryc_invoice_batch_submissions', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          batch_id: batchId, pm, submitted_by: by,
          invoice_count: mine.length, approved_count: approved.length,
          note: body.note ? String(body.note).slice(0, 500) : null,
        }),
      });
      /* Already submitted. A second press is not an error — it is a person checking, and the honest
         answer is "you already did this, here is when". */
      if (ins.status === 409) {
        const ex = await sb('ryc_invoice_batch_submissions?company_id=eq.ryc'
          + `&batch_id=eq.${batchId}&pm=eq.${encodeURIComponent(pm)}&select=*`);
        const had = ex.ok ? (await ex.json())[0] : null;
        return res.status(200).json({ ok: true, already: true, submission: had,
          summary: { documents: mine.length, approved: approved.length,
            held: mine.length - approved.length } });
      }
      if (!ins.ok) return res.status(502).json({ error: `Could not record the submission (${ins.status}).` });
      const submission = (await ins.json())[0] || null;

      /* ---- 3 + 4: his answers travel, and the stamp is queued ---- */
      let carried = { documents: 0, jobs_set: 0, stamps_queued: 0, unmatched: [] };
      try {
        const bb = await sb(`ryc_invoice_batches?company_id=eq.ryc&id=eq.${batchId}`
          + '&select=source_message_id');
        const src = bb.ok ? ((await bb.json())[0] || {}).source_message_id : null;
        const scanId = src && String(src).startsWith('scan:') ? String(src).slice(5) : null;
        if (scanId) {
          /* The job NAME comes from the directory, the same place `batch_rematch` gets it. Read once
             for the whole submit. A null name is survivable — the number is what files the document
             — so a directory outage must not stop the handoff. */
          let jdir = null;
          try { jdir = await jobDirectory(); } catch { /* name stays null */ }
          const nameFor = (no) => (jdir && jdir.names && jdir.names[no]) || null;
          const dr = await sb(`ryc_batch_documents?company_id=eq.ryc&batch_id=eq.${scanId}`
            + '&select=*&order=seq.asc');
          const docs = dr.ok ? await dr.json() : [];
          carried.documents = docs.length;
          const key = (v, a) => `${vendorKey(v)}|${amountKey(a)}`;
          const byKey = {};
          for (const i of mine) byKey[key(i.vendor_name, i.amount)] = i;
          const now = new Date().toISOString();

          /* ===== THE SPLIT TRAVELS TOO ==============================================
             Keith, 2026-08-31: *"The split invoice needs to be copied to all of the jobs
             folders."* A split page's answer is not on the payable — `job_no` is null on it by
             design — it is one row per unit in `ryc_invoice_lines`. So the carry below, which
             reads `i.job_no`, moved nothing for exactly the documents that were hardest to place,
             and Erica received a $670 page with an empty job cell after Logan had already
             attributed every dollar of it.

             ⚠ EVERY LINE, OR NOTHING. Migration 062 will not approve a split whose lines do not
             all name a job, so an approved split is already whole — and this re-checks it anyway
             rather than trusting that, because carrying a partial split would file a page against
             some of the jobs that owe for it and silently drop the rest. A page that cannot be
             carried keeps its empty job cell, which is a question on her screen; a page filed to
             three of five folders is a wrong answer nobody is asked to look at. */
          const splitByInv = new Map();
          const needLines = mine.filter(i => i.review_state === 'approved' && !i.job_no).map(i => i.id);
          if (needLines.length) {
            const lr = await sb(`ryc_invoice_lines?invoice_id=in.(${needLines.join(',')})`
              + '&select=invoice_id,seq,job_no,amount&order=seq.asc');
            if (lr.ok) {
              const all = new Map();
              for (const l of await lr.json()) {
                const a = all.get(l.invoice_id) || [];
                a.push(l);
                all.set(l.invoice_id, a);
              }
              for (const [invId, lines] of all) {
                if (!lines.length) continue;
                if (lines.some(l => !String(l.job_no || '').trim())) {
                  carried.partial_splits = (carried.partial_splits || 0) + 1;
                  continue;                     // not whole — leave the question on her screen
                }
                splitByInv.set(invId, lines.map(l => ({
                  job_no: String(l.job_no).trim(),
                  amount: l.amount,
                })));
              }
            } else {
              carried.split_read_error = `could not read the coded lines (${lr.status})`;
            }
          }
          for (const d of docs) {
            const i = byKey[key(d.vendor, d.amount)];
            if (!i) { carried.unmatched.push({ seq: d.seq, vendor: d.vendor, amount: d.amount }); continue; }
            /* ⚠ ONLY AN APPROVED PAYABLE IS STAMPED. A rejected invoice or a supporting document
               marked `not_ap` is a decision, not an approval, and stamping one would print a claim
               nobody made. Its row still tells her what he decided — `pm_state` carries that. */
            if (i.review_state !== 'approved') continue;
            /* ⛔ A DOCUMENT SHE HAS ALREADY FINISHED IS NEVER TOUCHED. Re-stamping or re-jobbing a
               reconciled row would rewrite a file that has already been copied into a job folder. */
            if (d.reconciled_at) continue;

            const patch = {
              stamp_state: 'pending',
              stamp_approval: {
                pm: i.reviewed_by || pm,
                month: i.cost_month || null,
                cost_code: i.cost_code || null,
                mat_or_sub: i.mat_or_sub || null,
                approved_at: i.reviewed_at || null,
                /* Carried through unchanged. Until per-user sign-in this is false for everyone and
                   the stamp says so rather than implying a verified signature. */
                identity_verified: !!i.identity_verified,
              },
              stamp_error: null,
              updated_at: now,
            };
            if (i.job_no && i.job_no !== d.job_no) {
              const jn = nameFor(i.job_no) || d.job_name || null;
              patch.job_no = i.job_no;
              patch.job_name = jn;
              patch.job_source = 'pm';
              patch.history = [...(Array.isArray(d.history) ? d.history : []), {
                at: now, by, action: 'pm_assigned_job',
                job_no: i.job_no, job_name: jn,
                was: d.job_no || null, was_name: d.job_name || null,
                was_source: d.job_source || null,
              }];
              carried.jobs_set++;
            } else if (!i.job_no && splitByInv.has(i.id)) {
              /* ⚠ `job_no` STAYS NULL ON A SPLIT, DELIBERATELY. There is no single job, and
                 inventing one — the largest line, the first line, the community bucket — would put
                 a number on the record that no person chose and that the money contradicts.
                 `split_jobs` is the answer, and it is the filing destination list. */
              const sp = splitByInv.get(i.id).map(s => ({
                job_no: s.job_no, job_name: nameFor(s.job_no) || null, amount: s.amount,
              }));
              patch.split_jobs = sp;
              patch.job_source = 'pm';
              patch.history = [...(Array.isArray(d.history) ? d.history : []), {
                at: now, by, action: 'pm_split_job',
                jobs: sp.map(s => s.job_no),
                was: d.job_no || null, was_name: d.job_name || null,
                was_source: d.job_source || null,
              }];
              carried.splits_set = (carried.splits_set || 0) + 1;
            }
            const up = await sb(`ryc_batch_documents?id=eq.${d.id}&reconciled_at=is.null`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
            });
            if (up.ok) carried.stamps_queued++;
          }
        } else {
          carried.note = 'This batch has no scanned folder — nothing to stamp.';
        }
      } catch (e) {
        /* The handoff already happened and must not be undone by this. Say what did not travel. */
        carried.error = (e && e.message) || 'carrying the coding to the documents failed';
      }

      return res.status(200).json({ ok: true, submission, carried,
        summary: { documents: mine.length, approved: approved.length,
          held: mine.length - approved.length } });
    }

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

    /* THE BOUNDARY AUDIT. Same gate as `adjudicate` — it reads pages and returns an opinion; it
       writes nothing, files nothing and cannot create a payable. Whether a page actually MOVES is
       decided on the VM, where the answer is corroborated against the printed vendor before
       anything is applied. A model saying "next" is not on its own permission to re-cut a
       document. */
    if (action === 'boundary') {
      if (!canRead) return res.status(403).json({ error: 'Front office only.' });
      if (!READ_ENABLED) {
        return res.status(503).json({ error: 'The document reader is switched off on this deployment.' });
      }
      const imgs = Array.isArray(body.images) ? body.images : [];
      if (!imgs.length || !body.current || !body.next) {
        return res.status(400).json({ error: 'Pages and both neighbouring documents are required.' });
      }
      if (imgs.length > MAX_IMAGES) {
        return res.status(413).json({ error: `${imgs.length} pages sent; this endpoint reads up to ${MAX_IMAGES} at a time.` });
      }
      const bbytes = imgs.reduce((n, im) => n + String(im.data || '').length, 0);
      if (bbytes > MAX_IMAGE_BYTES) {
        return res.status(413).json({ error: `Pages total ${Math.round(bbytes / 1024)}KB, over the ${MAX_IMAGE_BYTES / 1024}KB limit.` });
      }
      const out = await auditBoundary(imgs, body.current, body.next);
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

    /* ===== RETAINAGE HELD, PER VENDOR PER JOB ==========================================
       The screen that replaces 330 per-vendor workbooks in SharePoint under
       Company Share/Accounting Office/Annette's Files/Vendors — one .xlsx per subcontractor, a
       worksheet tab per job, whose entire live column is "how much are we holding on this sub".

       FRONT OFFICE ONLY, deliberately. This is accounting's whole-portfolio question, and a PM
       scope would either show one desk's slice — which is not the question anyone asks here — or
       leak every vendor's position to a link-holder. A PM gets a clear refusal rather than a
       partial view that reads like the whole one.

       The view does the judging (migrations 066/067); this action does NOT re-derive any of it.
       It sums only `retainage_stated`, which is G702 line 5 taken from each vendor+job's LATEST
       application — a to-date figure, so the portfolio total is a sum ACROSS vendor+job pairs and
       never a sum across a vendor's own applications. */
    if (action === 'retainage') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const cols = 'company_id,vendor,job_no,job_name,apps,apps_with_stated_retainage,'
        + 'first_app_at,last_app_at,period_billed_total,paid_total,retainage_stated,'
        + 'retainage_implied,retainage_implied_apps,retainage_delta,completed_to_date_stated,'
        + 'eligible_to_date_stated,less_previous_stated,retainage_rate_stated,face_sheet_residual,'
        + 'apps_excluded_unsound,implied_status,stated_status,retainage_peak,paper_released,'
        + 'releases_count,released_total,released_after_last_app,last_release_on,'
        + 'retainage_outstanding,release_status';
      const r = await sb(`ryc_retainage_v?select=${cols}&order=retainage_stated.desc.nullslast`);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the retainage view.' });
      const rows = await r.json();
      const n = (x) => (x === null || x === undefined ? 0 : Number(x));
      const summary = {
        rows: rows.length,
        vendors: new Set(rows.map((x) => x.vendor)).size,
        jobs: new Set(rows.map((x) => x.job_no)).size,
        apps: rows.reduce((a, x) => a + n(x.apps), 0),
        /* COVERAGE IS PUBLISHED, NOT ASSUMED. A row whose applications carried no legible line 5
           has retainage_stated null, and null is NOT zero: reporting it as zero would say RYC holds
           nothing on a subcontractor it may be holding plenty on. The screen shows every count. */
        stated_rows: rows.filter((x) => x.stated_status === 'ok').length,
        /* ⛔ THE TOTAL SUMS ONLY FIGURES WHOSE OWN PAGE FOOTS (migration 068, stated_status).
           A contradicted figure is neither added nor dropped: it is counted and subtotalled
           separately so the front office can see there is a document to go and look at.
           OscarWLarson on INDOT Roselawn reads line 5 as 0.00 while line 4 minus line 6 on the same
           sheet is 1,708.80 — adding that zero would quietly understate the portfolio, and hiding
           the row would quietly lose the question. */
        held: Math.round(rows.filter((x) => x.stated_status === 'ok')
          .reduce((a, x) => a + n(x.retainage_stated), 0) * 100) / 100,
        contradicted_rows: rows.filter((x) => x.stated_status === 'contradicted').length,
        contradicted_held: Math.round(rows.filter((x) => x.stated_status === 'contradicted')
          .reduce((a, x) => a + n(x.retainage_stated), 0) * 100) / 100,
        unstated_rows: rows.filter((x) => x.stated_status === 'unstated').length,
        /* Rows carrying a pay application the register cannot treat as sound — today that is a
           negative payable, which is a misread face sheet. Surfaced, never filtered away. */
        excluded_rows: rows.filter((x) => n(x.apps_excluded_unsound) > 0).length,
        /* The page's own arithmetic disagreeing with itself: line 4 - line 5 - line 6 should be 0. */
        residual_rows: rows.filter((x) => x.face_sheet_residual !== null
          && Math.abs(Number(x.face_sheet_residual)) > 1).length,
        /* ⛔ OUTSTANDING IS THE ANSWER TO "WHAT DO WE STILL HOLD"; `held` answers "what did the
           paper last say". They differ once retainage starts coming back, and the screen leads with
           outstanding. Both sum only rows whose stated figure is usable (stated_status 'ok'). */
        outstanding: Math.round(rows.filter((x) => x.stated_status === 'ok')
          .reduce((a, x) => a + n(x.retainage_outstanding), 0) * 100) / 100,
        released_total: Math.round(rows.reduce((a, x) => a + n(x.released_total), 0) * 100) / 100,
        released_rows: rows.filter((x) => n(x.releases_count) > 0).length,
        /* The filed applications show line 5 coming DOWN and nothing records why. Derived evidence
           only — a person records the release; the register never invents a payment. */
        paper_unrecorded_rows: rows.filter((x) => x.release_status === 'paper_unrecorded').length,
        over_released_rows: rows.filter((x) => x.release_status === 'over_released').length,
      };
      return res.status(200).json({ ok: true, rows, summary });
    }

    /* ===== RECORD THAT RETAINAGE WENT BACK ============================================
       Annette keeps this in band — a pay-app row whose date cell reads `pd retainage`, or one
       labelled `Final Retention`. Here it is a durable fact with a date, because the date is what
       decides whether the filed paper already reflects it (migration 069/070).

       ⛔ THE PAIR MUST ALREADY EXIST. A release is recorded against a vendor+job the register has
       pay applications for; anything else is a typo or a job the register has never seen, and an
       orphan release would be invisible in `ryc_retainage_v` (which is built from applications) —
       money recorded as returned that no screen can ever show. Refuse it at the door rather than
       write a row nothing reads. */
    if (action === 'retainage_release') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const vendor = String(body.vendor || '').trim();
      const jobNo = String(body.job_no || '').trim();
      const amount = Number(body.amount);
      const releasedOn = String(body.released_on || '').trim();
      const method = String(body.method || 'check').trim();

      if (!vendor || !jobNo) return res.status(400).json({ error: 'Vendor and job are required.' });
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Amount must be a positive number.' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(releasedOn)) {
        return res.status(400).json({ error: 'A release needs the date the money moved (YYYY-MM-DD).' });
      }
      if (!['final_application', 'check', 'credit', 'other'].includes(method)) {
        return res.status(400).json({ error: 'Unknown method.' });
      }

      const pr = await sb(`ryc_retainage_v?vendor=eq.${encodeURIComponent(vendor)}`
        + `&job_no=eq.${encodeURIComponent(jobNo)}`
        + '&select=vendor,job_no,job_name,retainage_stated,retainage_outstanding,stated_status,'
        + 'released_after_last_app,last_app_at');
      if (!pr.ok) return res.status(502).json({ error: 'Could not check the vendor and job.' });
      const pair = (await pr.json())[0];
      if (!pair) {
        return res.status(409).json({
          error: `The register holds no pay applications for ${vendor} on ${jobNo}, so a release `
            + 'recorded against it would never appear anywhere. Check the vendor and job.' });
      }

      /* A screen that refuses must offer the control that satisfies it. Over-releasing is a real
         possibility — the stated figure can be stale — so it is not forbidden, it is CONFIRMED.
         The refusal names the numbers and the flag that lifts it. */
      const stated = pair.retainage_stated === null ? null : Number(pair.retainage_stated);
      const already = Number(pair.released_after_last_app || 0);
      if (!body.confirm_over && pair.stated_status === 'ok' && stated !== null
          && already + amount > stated + 0.005) {
        return res.status(409).json({
          error: `That is more than the paper says is held. Line 5 on the last application `
            + `(${pair.last_app_at}) is ${stated.toFixed(2)}`
            + (already ? `, of which ${already.toFixed(2)} is already recorded as released` : '')
            + `, and this would take the total to ${(already + amount).toFixed(2)}. `
            + 'Record it anyway with confirm_over if the paper is out of date.',
          needs_confirm: true, stated, already, would_be: already + amount });
      }

      const ins = await sb('ryc_retainage_releases', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          company_id: 'ryc', vendor, job_no: jobNo, amount, released_on: releasedOn, method,
          source: 'person',
          note: (body.note ? String(body.note).slice(0, 500) : null),
          evidence: body.evidence || null,
          recorded_by: 'front office',
        }]),
      });
      if (!ins.ok) return res.status(502).json({ error: 'Could not record the release.' });
      return res.status(200).json({ ok: true, release: (await ins.json())[0] });
    }

    /* Voided, never deleted — the original assertion and its correction both stay readable.
       A void with no reason removes money from every total and leaves nobody able to say what
       happened, which is why the table refuses one. */
    if (action === 'retainage_release_void') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const id = String(body.id || '').trim();
      const reason = String(body.reason || '').trim();
      if (!id) return res.status(400).json({ error: 'Which release?' });
      if (!reason) return res.status(400).json({ error: 'A void has to say why.' });
      /* Conditional on it not already being void: `limit=` does nothing on a PostgREST PATCH, so
         the state condition IS the narrowing, and a second click cannot rewrite the first void's
         reason. */
      const r = await sb(`ryc_retainage_releases?id=eq.${encodeURIComponent(id)}&voided_at=is.null`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          voided_at: new Date().toISOString(), voided_by: 'front office',
          void_reason: reason.slice(0, 500),
        }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Could not void the release.' });
      const rows2 = await r.json();
      if (!rows2.length) return res.status(409).json({ error: 'That release is already voided.' });
      return res.status(200).json({ ok: true, release: rows2[0] });
    }

    /* Every release on one vendor+job, voided ones included — the record is the point. */
    /* ===== THE THING ANNETTE'S WORKBOOK IS ACTUALLY FOR ==================================
       Keith, 2026-09-02, looking at the first version: *"where does she see history, it seems the
       payapp to payapp from week to week is the important insight her spreadsheet offers."*

       Correct, and the first version threw it away. Her tabs are a ROW PER PAY APPLICATION —
       `Date | This Period | X% Ret | Current Due` — and the running story down that column is the
       point; the total at the bottom is a by-product. A screen that shows only the latest aggregate
       replaces the by-product and loses the thing she keeps the file for.

       ⛔ RELEASES ARE INTERLEAVED INTO THE SAME TIMELINE, because that is how she records them: a
       row in the same table whose date cell reads `pd retainage` or `Final Retention`. Keeping them
       in a separate list would make this screen's shape differ from the one the office already
       reads, for no reason.

       `retainage_this_period` IS HER `X% Ret` COLUMN, AND IT IS DERIVED THE OTHER WAY ROUND.
       She computes it forward: this period times the rate. The register reads G702 line 5, which is
       retainage held TO DATE, so the per-period figure is the DIFFERENCE between one application's
       line 5 and the previous one's. Two independent routes to the same number — hers from the rate,
       this one from the paper — which is why they are worth having side by side. Null when either
       application did not print a legible line 5: unknown, never zero. */
    if (action === 'retainage_detail') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const vendor = String(body.vendor || '').trim();
      const jobNo = String(body.job_no || '').trim();
      if (!vendor || !jobNo) return res.status(400).json({ error: 'Vendor and job are required.' });

      const dr = await sb('ryc_batch_documents?select=id,batch_id,seq,file_name,invoice_no,amount,'
        + 'work_this_period,completed_and_stored,completed_to_date,retainage,eligible_to_date,'
        + 'less_previous,page_from,page_to,sp_url,copied_url,disposition,created_at,'
        + 'ryc_batch_jobs(received_date)'
        + `&company_id=eq.ryc&doc_type=eq.pay_application&vendor=eq.${encodeURIComponent(vendor)}`
        + `&job_no=eq.${encodeURIComponent(jobNo)}`);
      if (!dr.ok) return res.status(502).json({ error: 'Could not read the pay applications.' });
      const docs = await dr.json();

      const apps = docs.map((d) => ({
        id: d.id,
        at: (d.ryc_batch_jobs && d.ryc_batch_jobs.received_date) || String(d.created_at).slice(0, 10),
        invoice_no: d.invoice_no,
        pages: (d.page_to && d.page_from) ? `${d.page_from}-${d.page_to}` : null,
        work_this_period: d.work_this_period,
        amount: d.amount,
        retainage: d.retainage,
        eligible_to_date: d.eligible_to_date,
        less_previous: d.less_previous,
        completed_to_date: (d.completed_and_stored === null || d.completed_and_stored === undefined)
          ? d.completed_to_date : d.completed_and_stored,
        url: d.copied_url || d.sp_url,
        disposition: d.disposition,
      }));

      /* ⛔ DATE DOES NOT ORDER PAY APPLICATIONS, AND ORDERING IS THE WHOLE PREMISE OF THE DELTA.
         Midwest Glass on Shipshewana filed applications #2 and #3 in ONE scanned batch, so both
         carry the same received date. Sorted by date alone they came back #3 then #2, and
         "retainage this period" read -$1,232.50 at -102.71% — valid arithmetic on a wrong premise,
         the same shape as the Niblock defect.

         THE FORM ORDERS ITSELF. G702 line 7 (LESS PREVIOUS CERTIFICATES) on one application is
         line 6 (TOTAL EARNED LESS RETAINAGE) on the one before it. Measured on that very pair:
         #2's line 6 is 10,584.90 and #3's line 7 is 10,584.90, to the cent. Both are cumulative and
         only increase, so ordering by line 6 puts them in the sequence the subcontractor filed them
         in — no application number required, which matters because the reader discards it.

         AND THE SAME IDENTITY FINDS A MISSING ONE. If application n's line 7 does not equal
         application n-1's line 6, an application between them is not in the register. That is the
         "a missing application in a sequence cannot be detected" limitation, retired — by the paper
         rather than by a field nobody captures. */
      const pos = (a) => {
        const v = [a.eligible_to_date, a.completed_to_date, a.less_previous]
          .find((n) => n !== null && n !== undefined);
        return v === undefined ? null : Number(v);
      };
      apps.sort((p, q) => {
        const pp = pos(p), qq = pos(q);
        if (pp !== null && qq !== null && pp !== qq) return pp - qq;
        if (p.at !== q.at) return p.at < q.at ? -1 : 1;
        return 0;
      });

      let prevA = null;   // the previous application, whole — deltas are between two documents
      for (const a of apps) {
        const num = (x) => (x === null || x === undefined ? null : Number(x));
        const pElig = prevA ? num(prevA.eligible_to_date) : null;
        const pRet = prevA ? num(prevA.retainage) : null;

        /* Consecutive when this application line 7 is the previous one line 6. Null — not false —
           when either figure is missing: "we cannot tell" is a different answer from "there is a
           gap", and printing the second for the first sends somebody hunting for a document that
           does not exist. */
        a.follows_previous = (pElig === null || num(a.less_previous) === null)
          ? null : Math.abs(num(a.less_previous) - pElig) <= 0.01;

        /* The delta only means something between two applications that BOTH printed line 5.
           Treating a missing one as zero would invent a period with no retainage withheld. */
        a.retainage_this_period = (num(a.retainage) === null || pRet === null)
          ? null : Math.round((num(a.retainage) - pRet) * 100) / 100;

        /* ⛔ THE DENOMINATOR IS THE INCREASE IN LINE 4, NOT G703 COLUMN E.
           Column E is work completed this period and EXCLUDES stored materials. Midwest Glass on
           Shipshewana billed 7,650.00 of column E while retainage rose 1,232.50 — that reads as a
           16.11% rate, and the office would know at a glance it is wrong. The form settles it:
           line 4 = line 5 + line 6, so the true amount earned this period is the increase in
           (line 6 + line 5) = 24,650.00, and 1,232.50 of that is exactly 5.00%. That is the rate on
           the contract and the one Annette carries in her own column heading. */
        const completedNow = (num(a.eligible_to_date) === null || num(a.retainage) === null)
          ? null : num(a.eligible_to_date) + num(a.retainage);
        const completedPrev = (pElig === null || pRet === null) ? null : pElig + pRet;
        a.completed_this_period = (completedNow === null || completedPrev === null)
          ? null : Math.round((completedNow - completedPrev) * 100) / 100;

        /* ⚠ Suppressed across a break in the chain: the difference then spans an application the
           register does not hold, so it is a rate for a period the numerator does not describe. */
        a.rate_this_period = (a.retainage_this_period === null
          || a.completed_this_period === null
          || a.completed_this_period === 0
          || a.follows_previous === false)
          ? null
          : Math.round((a.retainage_this_period / a.completed_this_period) * 10000) / 10000;

        prevA = a;
      }

      const rr = await sb('ryc_retainage_releases?select=id,amount,released_on,method,source,note,'
        + 'recorded_by,created_at,voided_at,voided_by,void_reason'
        + `&company_id=eq.ryc&vendor=eq.${encodeURIComponent(vendor)}`
        + `&job_no=eq.${encodeURIComponent(jobNo)}&order=released_on.asc`);
      if (!rr.ok) return res.status(502).json({ error: 'Could not read the releases.' });

      return res.status(200).json({ ok: true, vendor, job_no: jobNo,
        applications: apps, releases: await rr.json() });
    }

    if (action === 'retainage_releases') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const vendor = String(body.vendor || '').trim();
      const jobNo = String(body.job_no || '').trim();
      if (!vendor || !jobNo) return res.status(400).json({ error: 'Vendor and job are required.' });
      const r = await sb('ryc_retainage_releases?select=id,vendor,job_no,amount,released_on,method,'
        + 'source,note,recorded_by,created_at,voided_at,voided_by,void_reason'
        + `&company_id=eq.ryc&vendor=eq.${encodeURIComponent(vendor)}`
        + `&job_no=eq.${encodeURIComponent(jobNo)}&order=released_on.desc`);
      if (!r.ok) return res.status(502).json({ error: 'Could not read the releases.' });
      return res.status(200).json({ ok: true, rows: await r.json() });
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
