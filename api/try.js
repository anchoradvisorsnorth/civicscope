// api/try.js — clean campaign link: /try/{slug} → /civicscope?ref={slug}
//
// Why this exists: campaign emails used to link directly to
// app.civicscope.io/civicscope?ref=slug. Government email security gateways
// (Proofpoint / Mimecast / Barracuda) flag and rewrite query-string URLs, which
// (a) hurts deliverability and (b) strips the ?ref=, destroying click attribution.
// A clean path like /try/wabash-county passes the gateways untouched; we then set
// the ref ourselves on a same-origin server redirect that the gateway never sees.
//
// Also logs the click to cs_clicks (CivicScope Supabase) so we can measure the
// click stage of the funnel. Click logging is best-effort and never blocks the
// redirect. NOTE: gateway link-scanners can hit this endpoint too, so treat raw
// click counts as directional — the high-confidence signal is a tool_run with the
// same ref (see CRM api/cs-data.js ref_activity).

export default async function handler(req, res) {
  const slug = (req.query.slug || '').toString().trim();
  // Sanitize: ref slugs are lowercase kebab/underscore tokens. Strip anything else.
  const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);

  if (safe) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (SUPABASE_URL && SUPABASE_KEY) {
      // Await before redirecting — serverless functions can freeze after the
      // response is sent, which would drop an in-flight insert.
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/cs_clicks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            ref_slug: safe,
            user_agent: (req.headers['user-agent'] || '').toString().slice(0, 400),
            referer: (req.headers['referer'] || req.headers['referrer'] || '').toString().slice(0, 400),
            ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || null,
          }),
        });
      } catch (err) {
        console.error('try.js click log failed:', err.message);
      }
    }
  }

  const dest = safe ? `/civicscope?ref=${encodeURIComponent(safe)}` : '/civicscope';
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.statusCode = 302;
  res.setHeader('Location', dest);
  res.end();
}
