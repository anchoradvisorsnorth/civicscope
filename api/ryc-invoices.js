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

/* ===================== handler ===================================================== */
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
    'invoice-filer': new Set(['filing_queue', 'mark_filed']),
    'invoice-ingest': new Set(['open_batch', 'read', 'register']),
  };
  const FILING_ACTIONS = SERVICE_ACTIONS['invoice-filer'];
  if (who.scope === 'service') {
    const allowed = SERVICE_ACTIONS[who.service] || new Set();
    if (!allowed.has(action)) {
      return res.status(403).json({ error: `The ${who.service} service may not call this action.` });
    }
  }
  if (FILING_ACTIONS.has(action) && who.scope !== 'service') {
    return res.status(403).json({ error: 'Filing actions require the filing service token.' });
  }
  // The intake pipeline is front office OR the ingest service — nothing else.
  const canIntake = who.scope === 'all'
    || (who.scope === 'service' && who.service === 'invoice-ingest');

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

    /* Job number -> the PM who owns it, straight off the Procore feed (51 of 53 jobs carry one,
       and the names match the desks exactly: Troy Jennings, Logan Moore, Erik Parcell). This is
       what makes routing automatic without a classifier: the invoice's job is already resolved at
       REGISTER time by ryc_invoice_job_hints — (vendor, printed job text) -> job number, learned
       only from a PM's own correction — so the remaining step is a lookup, not a guess.
       Returns an empty map on any failure: no suggestion is a fine outcome, a wrong one is not. */
    async function jobPmMap() {
      const origin = process.env.RYC_DATA_ORIGIN || 'https://app.civicscope.io';
      try {
        const r = await fetch(`${origin}/ryc-data/procore-cache.json`, {
          headers: { 'User-Agent': 'ryc-invoices/1.0' }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return {};
        const cache = await r.json();
        const map = {};
        for (const j of (cache.jobs || [])) {
          const no = String(j.projectNumber || '').trim();
          const pm = j.pm && j.pm.name ? String(j.pm.name).trim() : '';
          if (no && pm) map[no] = pm;
        }
        return map;
      } catch { return {}; }
    }

    /* ===================== STAGING: READ THE JOB OFF THE INVOICE =======================
       Keith, 2026-08-13: "the way the system will know is reading the invoice and looking for the
       job name" — and "job name tells you who the PM is".

       So the primary signal is `job_text`: what the VENDOR PRINTED. Measured on the first real
       mailbox pull, 9 of 13 invoices carry one. Vendor billing history is a fallback, not the
       method — a vendor who has always billed one job can bill a new one tomorrow, and treating
       history as truth would confidently misfile exactly the invoices nobody re-checks.

       ⛔ IT REFUSES RATHER THAN GUESSES. "WAKARUSA" overlaps ONE distinctive word with
       "Wakarusa WTP" — and also with Wakarusa Pickleball Courts and Wakarusa Water Treatment
       Plant. That is the shape that once matched two different South Bend jobs to Monreaux. A
       match needs 2+ distinctive words and a clear winner; anything less is left for a human,
       which is the entire point of the front office's screen. */
    const JOB_FILLER = new Set(['the','of','and','a','an','at','in','on','for','llc','inc','co',
      'corp','project','projects','phase','rebid','bid','new','addition','renovation','reno',
      'improvements','improvement','building','bldg','construction','center','centre','north',
      'south','east','west','no','site','work','works','replacement','upgrade','upgrades',
      'remodel','expansion','town','city','county','school','corporation','unit']);
    const jobTokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(w => w.length > 2 && !JOB_FILLER.has(w) && !/^\d+$/.test(w)));

    /* job_text -> a job number, or null with a reason. Never a guess. */
    function matchJob(jobText, jobs) {
      const want = jobTokens(jobText);
      if (!want.size) return { job: null, why: 'nothing distinctive printed' };
      const scored = [];
      for (const j of jobs) {
        const have = jobTokens(j.name);
        let overlap = 0;
        for (const w of want) if (have.has(w)) overlap++;
        if (overlap) scored.push({ overlap, job: j });
      }
      if (!scored.length) return { job: null, why: 'no job resembles what the invoice printed' };
      scored.sort((a, b) => b.overlap - a.overlap);
      const best = scored[0];
      if (best.overlap < 2) {
        return { job: null, why: `only 1 distinctive word matched "${best.job.name}" — too weak` };
      }
      if (scored.filter(s => s.overlap === best.overlap).length > 1) {
        return { job: null, why: `${scored.filter(s => s.overlap === best.overlap).length} jobs match equally` };
      }
      return { job: best.job, overlap: best.overlap };
    }

    /* ---------- job names ---------------------------------------------------------------
       "2510GP04" is not what anyone calls that job. Command resolves names from its Procore
       feed, but the tool deliberately does not load that whole feed just to decorate a header
       — so the server hands back the one thing it needs: a number → name map. Small payload,
       one call, and it degrades to bare numbers rather than failing. */
    if (action === 'jobs') {
      const origin = process.env.RYC_DATA_ORIGIN || 'https://app.civicscope.io';
      try {
        const r = await fetch(`${origin}/ryc-data/procore-cache.json`, {
          headers: { 'User-Agent': 'ryc-invoices/1.0' }, signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return res.status(200).json({ ok: true, names: {}, jobs: [] });
        const cache = await r.json();
        const names = {};
        /* The picklist the front office chooses from, and the PM each job implies. ACTIVE only —
           an inbound invoice for a closed job is an exception a human should look at, not an
           option to pick by accident from a list of hundreds. */
        const jobs = [];
        for (const j of (cache.jobs || [])) {
          const n = String(j.projectNumber || '').trim();
          if (!n || !j.name) continue;
          names[n] = j.name;
          if (j.active !== false) {
            jobs.push({ no: n, name: j.name, pm: (j.pm && j.pm.name) ? String(j.pm.name).trim() : null });
          }
        }
        jobs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return res.status(200).json({ ok: true, names, jobs, asOf: cache.refreshed || null });
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
          unplaced: rows.filter(r => !r.staged_pm).length,
          flagged: rows.filter(r => Number(r.open_high) > 0).length,
          value: rows.reduce((a, r) => a + (Number(r.amount) || 0), 0),
        },
      });
    }

    /* Resolve what can be resolved, and say plainly what could not. Runs on demand (and after an
       ingest) so the front office opens a screen that is already mostly answered. */
    if (action === 'stage_inbound') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
      const q = await rpc('ryc_inbound_queue', { p_days: 90 });
      if (q.status !== 200) return res.status(q.status).json(q.body);
      const rows = (Array.isArray(q.body) ? q.body : []).filter(r => !r.staged_pm);
      if (!rows.length) return res.status(200).json({ ok: true, staged: 0, unplaced: 0, note: 'nothing waiting to be staged' });

      // The job list and each job's PM come from the same Procore feed Command reads.
      const origin = process.env.RYC_DATA_ORIGIN || 'https://app.civicscope.io';
      let jobs = [];
      try {
        const r = await fetch(`${origin}/ryc-data/procore-cache.json`, {
          headers: { 'User-Agent': 'ryc-invoices/1.0' }, signal: AbortSignal.timeout(15000),
        });
        if (r.ok) {
          const cache = await r.json();
          jobs = (cache.jobs || []).map(j => ({
            no: String(j.projectNumber || '').trim(),
            name: String(j.name || ''),
            pm: j.pm && j.pm.name ? String(j.pm.name).trim() : null,
          })).filter(j => j.no && j.name);
        }
      } catch { /* no feed -> nothing is staged, which is honest */ }
      if (!jobs.length) return res.status(200).json({ ok: true, staged: 0, unplaced: rows.length,
        note: 'the Procore job feed could not be read — nothing staged rather than guessed' });

      const staged = [], unplaced = [];
      for (const r of rows) {
        const m = matchJob(r.job_text, jobs);
        if (!m.job) { unplaced.push({ id: r.id, vendor: r.vendor_name, job_text: r.job_text, why: m.why }); continue; }
        if (!m.job.pm) { unplaced.push({ id: r.id, vendor: r.vendor_name, job_text: r.job_text,
          why: `matched ${m.job.no} but that job has no PM in Procore` }); continue; }
        const s = await rpc('ryc_stage_invoice', {
          p_id: r.id, p_staged_pm: m.job.pm, p_staged_job_no: m.job.no,
          p_source: 'job_text', p_confidence: Math.min(0.5 + 0.15 * m.overlap, 0.95),
          p_note: `matched "${r.job_text}" to ${m.job.name}`,
          p_expected_version: r.version, p_request_id: `${rid}:${r.id}`, p_actor: actor,
        });
        if (s.status === 200) staged.push({ id: r.id, vendor: r.vendor_name, job: m.job.no, pm: m.job.pm });
        else unplaced.push({ id: r.id, vendor: r.vendor_name, why: (s.body && s.body.error) || 'stage failed' });
      }
      return res.status(200).json({ ok: true, staged: staged.length, unplaced: unplaced.length,
        staged_rows: staged, unplaced_rows: unplaced });
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
            error: `Job ${jobNo} has no PM in the Procore feed, so there is no desk to send it to. `
              + 'Pick another job, or set the PM in Procore first.',
          });
        }
        note = note || `desk follows job ${jobNo}`;
      }
      if (!jobNo && !pm) {
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

    if (action === 'read') {
      if (!canIntake) return res.status(403).json({ error: 'Front office only.' });
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
      return res.status(200).json({
        ok: true, registered: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length, flagged, results,
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
