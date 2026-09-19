// api/board-export.js — receiver for the in-browser board-records export (2026-09-18).
//
// WHAT THIS IS
// A school district's BoardDocs site publishes agenda OUTLINES anonymously and keeps minutes,
// packets and attachments behind the district's own login. Loogootee (lcsc) is the first case.
// Rather than hold a credential for someone else's system, a district employee who already has a
// login clicks a bookmarklet (board-export/export.js) while signed in. That script runs INSIDE
// her BoardDocs tab, reads every meeting with her own session, and POSTs each document here.
// Her password never leaves her browser; this endpoint never sees BoardDocs at all — it only
// ever sees uploads from her browser. BoardDocs, in turn, only ever sees her normal session.
//
// WHAT IT DOES
//   GET  ?ver=1                          — the live build's VER. Ungated. The deploy contract.
//   GET  ?org=<slug>&action=manifest     — the export's progress file, so a re-click resumes.
//   POST ?org=<slug>&path=<relative>     — body = the bytes of one document; stored at
//                                           <org>/<path> in the PRIVATE bucket `board-exports`.
// Every gated call carries the district's export token in `X-Export-Token`. Tokens live in the
// Vercel env var BOARD_EXPORT_TOKENS as {"<org>":"<token>"} — one per district, minted by
// scripts/setup-board-export.mjs, never written into this public repo.
//
// WHY A PER-DISTRICT TOKEN AND NOT A LOGIN
// The uploader is a browser on a domain we do not control, so there is no session to check.
// The token is the whole gate: it is unguessable, it is bound to one org prefix, and the worst a
// leaked token allows is writing files under that one prefix — nothing here reads them back
// except the manifest, and nothing is ever published. Rotate by re-running the setup script.
//
// LIMITS
// Vercel's request body cap is 4.5 MB, so the browser splits anything larger into .partNNN
// objects plus a .parts.json; scripts/pull-board-export.mjs reassembles them locally.

export const VER = '1.0.0-boardexport';

const BUCKET = 'board-exports';
const ALLOWED_ORIGIN = 'https://go.boarddocs.com';
const MAX_PATH = 400;

function tokens() {
  try { return JSON.parse(process.env.BOARD_EXPORT_TOKENS || '{}'); } catch { return {}; }
}

// Constant-time-ish compare so a token cannot be walked character by character.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A stored path is <org>/<relative>. The relative part is what the browser chose from a file
// name on BoardDocs, so it is untrusted: no traversal, no leading slash, a bounded charset.
function cleanPath(p) {
  if (typeof p !== 'string' || !p.length || p.length > MAX_PATH) return null;
  const parts = p.split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const s of parts) {
    if (s === '.' || s === '..') return null;
    if (!/^[A-Za-z0-9 _.,()&+\-\[\]%'@=#!~]+$/.test(s)) return null;
  }
  return parts.join('/');
}

function sb() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  if (!url || !key) return null;
  return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

async function readRawBody(req) {
  // Vercel's Node runtime pre-parses by content type: JSON -> object, text/* -> string,
  // anything else -> Buffer. The browser sends application/octet-stream for everything, but
  // accept the other shapes so a curl test with text/html also lands as bytes.
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  if (b && typeof b === 'object') return Buffer.from(JSON.stringify(b), 'utf8');
  // Body not pre-parsed (e.g. no content-type): drain the stream.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Export-Token');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET' && req.query.ver) return res.status(200).json({ ver: VER });

  const org = String(req.query.org || '').toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(org)) return res.status(400).json({ error: 'org required' });

  const expected = tokens()[org];
  const supplied = req.headers['x-export-token'];
  if (!expected) return res.status(404).json({ error: 'no export configured for this org' });
  if (!sameToken(supplied, expected)) return res.status(401).json({ error: 'bad token' });

  const store = sb();
  if (!store) return res.status(500).json({ error: 'storage not configured' });
  const objectUrl = (p) => `${store.url}/storage/v1/object/${BUCKET}/${p.split('/').map(encodeURIComponent).join('/')}`;

  if (req.method === 'GET') {
    if (req.query.action !== 'manifest') return res.status(400).json({ error: 'unknown action' });
    const r = await fetch(objectUrl(`${org}/manifest.json`), { headers: store.headers });
    if (r.status === 404 || r.status === 400) return res.status(200).json({ org, meetings: {}, library: {}, fresh: true });
    if (!r.ok) return res.status(502).json({ error: `storage ${r.status}` });
    let m; try { m = await r.json(); } catch { m = { org, meetings: {}, library: {} }; }
    return res.status(200).json(m);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const rel = cleanPath(req.query.path);
  if (!rel) return res.status(400).json({ error: 'bad path' });
  const body = await readRawBody(req);
  if (!body.length) return res.status(400).json({ error: 'empty body' });
  const type = String(req.query.type || '').slice(0, 120) || 'application/octet-stream';
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+\-]+$/i.test(type)) return res.status(400).json({ error: 'bad type' });

  const r = await fetch(objectUrl(`${org}/${rel}`), {
    method: 'POST',
    headers: { ...store.headers, 'Content-Type': type, 'x-upsert': 'true' },
    body,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return res.status(502).json({ error: `storage ${r.status}`, detail: t.slice(0, 200) });
  }
  return res.status(200).json({ ok: true, path: `${org}/${rel}`, bytes: body.length });
}
