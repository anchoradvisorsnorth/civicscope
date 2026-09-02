/* /api/ryc-desk-upload — file a hand-dropped plan set into a SharePoint job folder and take it off.
 *
 *   POST { pw, stage: 'begin'|'chunk'|'finish'|'status', ... }
 *
 * Thin gated proxy to the VM service (desk-upload.js), which holds the SharePoint token and the
 * disk. Nothing about either reaches the browser — same shape as /api/ryc-desk-intake, which is
 * the Dodge half of the same job.
 *
 * WHY THIS EXISTS. Until 2026-09-02 the Desk's drop zone rendered every page to a lossy JPEG, sent
 * those to the model from the tab, and threw the ORIGINAL files away — so a priced estimate had no
 * retrievable source, and a 290-page set meant 30 sequential model calls pinned to one browser tab
 * for half an hour, where any single failure lost all of it (it did, at 16:17Z that day). Keith:
 * the upload is how this tool will actually be used, so it gets the same server treatment the
 * Dodge route already had.
 *
 * CHUNKS TRAVEL AS BASE64 IN JSON, deliberately. A serverless request body caps at 4.5MB while a
 * real plan set is 20-80MB, so the browser slices it. Base64 costs 33% over raw octet-stream, and
 * buys certainty: the runtime's body handling for binary content types is not something to
 * discover in production against a plan set, and a corrupted PDF that opens fine for six sheets is
 * the worst outcome this path has. Byte-exactness is asserted end to end by readback in test.
 */
export const config = { maxDuration: 300 };

const GATE = process.env.RYC_ESTIMATE_PASSWORD || 'ryc2026';
const STAGES = ['begin', 'chunk', 'finish', 'status'];

// 2.5MB raw -> ~3.4MB base64, under the 4.5MB body ceiling with room for the JSON envelope.
const MAX_CHUNK_RAW = 3 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  if (body.pw !== GATE) return res.status(401).json({ error: 'unauthorized' });

  const stage = String(body.stage || '');
  if (!STAGES.includes(stage)) {
    return res.status(400).json({ ok: false, error: 'stage must be begin, chunk, finish or status' });
  }

  const base = process.env.RYC_DODGE_API_URL, key = process.env.RYC_DODGE_API_KEY;
  if (!base || !key) {
    return res.status(503).json({ ok: false, kind: 'not_configured',
      error: 'Document intake is not configured on this deployment.' });
  }
  const root = base.replace(/\/$/, '');

  try {
    const qs = new URLSearchParams();
    let init = { method: 'POST', headers: { 'x-api-key': key } };
    let budget = 30000;

    if (stage === 'begin') {
      if (!String(body.name || '').trim()) return res.status(400).json({ ok: false, error: 'a project name is required' });
      if (body.pursuit_id) qs.set('pursuit_id', String(body.pursuit_id));
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ name: String(body.name).trim(), project: body.project || null });
      // Copying RYC's folder template is a Graph copy polled to completion — slower than it looks.
      budget = 120000;

    } else if (stage === 'chunk') {
      const raw = Buffer.from(String(body.data || ''), 'base64');
      if (!raw.length) return res.status(400).json({ ok: false, error: 'empty chunk' });
      if (raw.length > MAX_CHUNK_RAW) {
        return res.status(413).json({ ok: false, error: `chunk too large (${raw.length} > ${MAX_CHUNK_RAW})` });
      }
      qs.set('uploadId', String(body.uploadId || ''));
      qs.set('file', String(body.file || ''));
      qs.set('seq', String(body.seq));
      init.headers['Content-Type'] = 'application/octet-stream';
      init.body = raw;
      budget = 60000;

    } else if (stage === 'finish') {
      qs.set('uploadId', String(body.uploadId || ''));
      if (body.pursuit_id) qs.set('pursuit_id', String(body.pursuit_id));
      if (body.takeoff === false) qs.set('takeoff', '0');
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify({ project: body.project || null });
      // Uploads every staged file into SharePoint before it answers; a full set is minutes.
      budget = 290000;

    } else {
      qs.set('uploadId', String(body.uploadId || ''));
      init = { headers: { 'x-api-key': key } };
      budget = 20000;
    }

    const r = await fetch(`${root}/deskupload/${stage}?${qs}`,
      Object.assign({ signal: AbortSignal.timeout(budget) }, init));
    const text = await r.text();
    let out = null; try { out = JSON.parse(text); } catch {}
    if (!out) {
      return res.status(502).json({ ok: false, kind: 'upstream_failed',
        error: `intake ${stage} returned no JSON (HTTP ${r.status})` });
    }
    /* Relay the upstream STATUS, not a flattened 200. A replayed slice (409, carrying the slice it
       actually wants) and an unknown session (404) are both recoverable by the client — but only
       if it can tell them apart. */
    return res.status(r.status).json(out);
  } catch (e) {
    const aborted = /timeout|abort/i.test(e.name || e.message || '');
    return res.status(aborted ? 504 : 502).json({ ok: false, kind: aborted ? 'timeout' : 'unreachable',
      error: aborted
        ? `The ${stage} step is still running on the server — reopen this pursuit shortly to see it finish.`
        : 'Could not reach the document intake service.' });
  }
}
