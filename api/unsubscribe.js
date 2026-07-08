// api/unsubscribe.js — CivicScope email opt-out (one-click, scanner-safe).
//
//   GET  /unsubscribe?c={contact_id}  -> branded confirmation page with a button.
//   POST /unsubscribe?c={contact_id}  -> records the opt-out and shows confirmation.
//
// Two-step on purpose: .gov email security gateways (Proofpoint/Mimecast/Barracuda)
// auto-issue GETs against every link in a message — the same scanners that hammer
// /try. A GET here only renders a page (no side effect), so a scanner can't
// unsubscribe a real recipient; only a human clicking the button fires the POST.
//
// The actual suppression lives in the CRM (single source of truth = contacts.tags
// 'do-not-email'). We call it server-side so the recipient never sees a non-CivicScope
// domain. Auth via shared CS_UNSUB_SECRET.

const CRM_UNSUB_URL = 'https://crm.jbkdevelopment.com/api/cs-unsubscribe';

function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — CivicScope</title>
<style>
:root{--ink:#1a2433;--cream:#faf7f2;--orange:#e8703a;--rule:#e3dccf;--muted:#6b7280}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--cream);color:var(--ink);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border:1px solid var(--rule);border-radius:14px;max-width:480px;width:100%;padding:36px 32px;box-shadow:0 6px 30px rgba(26,36,51,.06)}
.brand{font-weight:700;letter-spacing:.5px;font-size:14px;margin-bottom:18px}
.brand span{color:var(--orange)}
h1{font-size:20px;margin:0 0 10px}
p{color:var(--muted);line-height:1.55;font-size:15px;margin:0 0 18px}
button{background:var(--orange);color:#fff;border:0;border-radius:9px;padding:12px 22px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(.95)}
a{color:var(--orange)}
.small{font-size:13px;color:var(--muted);margin-top:18px}
.addr{font-size:11px;color:#b9b2a6;margin-top:22px;padding-top:14px;border-top:1px solid var(--rule)}
</style></head><body><div class="card"><div class="brand">Civic<span>SCOPE</span></div>${bodyHtml}<div class="addr">CivicScope · PO Box 69, Nappanee, IN 46550</div></div></body></html>`;
}

export default async function handler(req, res) {
  const c = (req.query.c || '').toString().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (!c) {
    return res.status(400).send(page('Unsubscribe',
      `<h1>Link incomplete</h1><p>This unsubscribe link is missing its reference. To stop receiving CivicScope emails, reply <strong>STOP</strong> to any message and we'll take care of it.</p>`));
  }

  if (req.method === 'POST') {
    let ok = false, already = false;
    try {
      const secret = (process.env.CS_UNSUB_SECRET || '').trim();
      const r = await fetch(`${CRM_UNSUB_URL}?key=${encodeURIComponent(secret)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: c }),
      });
      const j = await r.json().catch(() => ({}));
      ok = r.ok && j.ok === true;
      already = j.already === true;
    } catch (e) { ok = false; }

    if (ok) {
      return res.status(200).send(page('Unsubscribed',
        `<h1>You're unsubscribed</h1><p>You won't receive any further CivicScope emails.${already ? ' (You were already opted out.)' : ''}</p><p class="small">Changed your mind? Email <a href="mailto:keith@civicscope.io">keith@civicscope.io</a>.</p>`));
    }
    return res.status(200).send(page('Unsubscribe',
      `<h1>Something went wrong</h1><p>We couldn't process that automatically. Please reply <strong>STOP</strong> to any CivicScope email, or email <a href="mailto:keith@civicscope.io">keith@civicscope.io</a> and we'll remove you right away.</p>`));
  }

  // GET — confirm button only (no side effects; safe for link scanners).
  return res.status(200).send(page('Unsubscribe', `
    <h1>Unsubscribe from CivicScope</h1>
    <p>Click below to stop receiving CivicScope emails. You won't be contacted again.</p>
    <form method="POST" action="/unsubscribe?c=${encodeURIComponent(c)}">
      <button type="submit">Unsubscribe me</button>
    </form>
    <p class="small">Prefer email? Reply <strong>STOP</strong> to any message.</p>`));
}
