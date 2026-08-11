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
const actorFor = (who) => ({
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
  const pm = who.scope === 'pm' ? who.pm : (body.pm ? String(body.pm).slice(0, 120) : null);

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

    /* ---------- the queue: "my batch for the day" ---------- */
    if (action === 'queue') {
      const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 365);
      const out = await rpc('ryc_invoice_queue', { p_pm: pm, p_days: days });
      if (out.status !== 200) return res.status(out.status).json(out.body);
      const rows = Array.isArray(out.body) ? out.body : [];
      // Summary computed here rather than in the view, so the count a PM sees and the count the
      // front office sees come from one place.
      const openHigh = rows.filter(r => Number(r.open_high) > 0).length;
      const outstanding = rows.filter(r => r.review_state === 'new' || r.review_state === 'ready').length;
      return res.status(200).json({
        ok: true, scope: who.scope, pm, rows,
        summary: { documents: rows.length, outstanding, flagged: openHigh },
      });
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
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
      const r = await sb('ryc_invoice_batches', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          received_date: body.received_date || new Date().toISOString().slice(0, 10),
          source: body.source || 'manual', label: body.label || null,
          page_count: body.page_count || 0, document_uri: body.document_uri || null,
        }),
      });
      if (!r.ok) return res.status(502).json({ error: `Could not open batch (${r.status}).` });
      const rows = await r.json();
      return res.status(200).json({ ok: true, batch: rows[0] });
    }

    if (action === 'read') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
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
      const out = await readPages(images);
      return res.status(out.status).json(out.body);
    }

    if (action === 'register') {
      if (who.scope !== 'all') return res.status(403).json({ error: 'Front office only.' });
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
