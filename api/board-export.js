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

export const VER = '1.1.0-boardexport';

const BUCKET = 'board-exports';
// The browser uploads manifest.json after every meeting; comparing the one it replaces with the
// one arriving is how a run's START (or resume) and FINISH are noticed. Keith is told by email —
// never the district contact, whose address this system deliberately does not hold.
const NOTIFY_TO = process.env.BOARD_EXPORT_NOTIFY || 'keith@jbkdevelopment.com';
const NOTIFY_FROM = 'CivicScope Notices <notices@civicscope.io>';
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

// What changed between the manifest being replaced and the one arriving. `started` fires on every
// click (a resume is a click too — that is the "she started" signal); `finished` once, when the
// browser stamps `finished` on a manifest that did not carry it.
function manifestEvent(oldM, newM) {
  if (!newM || typeof newM !== 'object') return null;
  const meetings = Object.values(newM.meetings || {});
  const done = meetings.filter(m => m && m.done).length;
  const total = newM.meetingCount || meetings.length || 0;
  const withErr = meetings.filter(m => m && m.error).length;
  const minutes = meetings.reduce((a, m) => { const k = (m && m.minutes) || 'none'; a[k] = (a[k] || 0) + 1; return a; }, {});
  const files = meetings.reduce((a, m) => a + ((m && m.files) || 0), 0);
  const stats = { done, total, withErr, minutes, files, signedIn: !!newM.signedIn, ver: newM.ver || '' };
  if (newM.finished && !(oldM && oldM.finished)) return { kind: 'finished', stats };
  const oldStart = (oldM && oldM.lastStarted) || '';
  if (newM.lastStarted && newM.lastStarted > oldStart) return { kind: done > 0 || (oldM && oldM.meetings && Object.keys(oldM.meetings).length) ? 'resumed' : 'started', stats };
  return null;
}

async function notify(org, ev) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, why: 'RESEND_API_KEY missing' };
  const s = ev.stats;
  const subj = ev.kind === 'finished'
    ? `Board export FINISHED — ${org}: ${s.done}/${s.total} meetings, ${s.files} attachments`
    : `Board export ${ev.kind.toUpperCase()} — ${org} (${s.done}/${s.total} done so far)`;
  const lines = [
    `District: ${org}`,
    `Event: ${ev.kind} at ${new Date().toISOString()}`,
    `Signed-in session: ${s.signedIn ? 'yes' : 'NO — anonymous run, minutes and attachments will be missing'}`,
    `Meetings done: ${s.done} of ${s.total}${s.withErr ? ` (${s.withErr} with errors)` : ''}`,
    `Attachments listed: ${s.files}`,
    `Minutes by outcome: ${JSON.stringify(s.minutes)}`,
    `Script version: ${s.ver}`,
    '',
    ev.kind === 'finished'
      ? 'Pull it down: node Civicscope/scripts/pull-board-export.mjs --org ' + org
      : 'Progress: node Civicscope/scripts/pull-board-export.mjs --org ' + org + ' --status',
  ];
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], subject: subj, text: lines.join('\n') }),
    });
    if (!r.ok) return { sent: false, why: `resend ${r.status}` };
    return { sent: true };
  } catch (e) { return { sent: false, why: String(e && e.message || e).slice(0, 120) }; }
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

  // For the manifest, read what is being replaced BEFORE the upsert, so the event is a real diff.
  let oldManifest = null, newManifest = null;
  if (rel === 'manifest.json') {
    try { newManifest = JSON.parse(body.toString('utf8')); } catch { newManifest = null; }
    const g = await fetch(objectUrl(`${org}/manifest.json`), { headers: store.headers });
    if (g.ok) { try { oldManifest = await g.json(); } catch { oldManifest = null; } }
  }

  const r = await fetch(objectUrl(`${org}/${rel}`), {
    method: 'POST',
    headers: { ...store.headers, 'Content-Type': type, 'x-upsert': 'true' },
    body,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return res.status(502).json({ error: `storage ${r.status}`, detail: t.slice(0, 200) });
  }
  const out = { ok: true, path: `${org}/${rel}`, bytes: body.length };
  if (newManifest) {
    const ev = manifestEvent(oldManifest, newManifest);
    if (ev) { out.event = ev.kind; out.notified = await notify(org, ev); }
  }
  return res.status(200).json(out);
}
