// api/ryc-foundation-query.js — Vercel proxy for the RYC Foundation reporting tool.
//
// Auth gate + forwarder ONLY. All sensitive logic (NL->SQL, PII guard, ODBC execution,
// audit) lives on the VM at /api/foundation-query. This proxy:
//   1. verifies the dedicated tool password SERVER-SIDE (never trust the client),
//   2. forwards the question to the VM with the X-API-Key (kept server-side),
//   3. relays the VM's JSON result.
//
// Env (already present in this CivicScope project from api/ryc-active.js):
//   M365_VM_URL, M365_VM_API_KEY
// New env to set: FOUNDATION_TOOL_PASSWORD (Tristan's login).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const { password, question, verify } = body;

  const expected = process.env.FOUNDATION_TOOL_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'Tool password not configured' });
  if (!password || password !== expected) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // Login check: password-only ping, no query.
  if (verify) return res.status(200).json({ ok: true });

  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: 'Ask a question.' });
  }

  const VM_URL = process.env.M365_VM_URL || 'http://20.230.82.67:8080';
  const VM_KEY = process.env.M365_VM_API_KEY || '';
  try {
    const r = await fetch(`${VM_URL}/api/foundation-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': VM_KEY },
      body: JSON.stringify({ question: String(question).trim(), user: 'tristan' }),
    });
    const text = await r.text();
    const data = safeParse(text) ?? { status: 'error', error: text?.slice(0, 300) || 'VM error' };
    return res.status(r.ok ? 200 : 502).json(data);
  } catch (e) {
    return res.status(502).json({ status: 'error', error: `Could not reach the reporting backend: ${e.message}` });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
