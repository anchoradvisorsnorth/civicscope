// Groundwork — read API for newsletter editions.
//   GET /api/groundwork-editions                  → list editions (defaults to sent only, limit 20)
//   GET /api/groundwork-editions?number=N         → single edition by issue_number
//   GET /api/groundwork-editions?status=draft     → filter by status
//   GET /api/groundwork-editions?id=UUID          → single edition by id

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars missing' });
  }

  async function sb(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'User-Agent': 'curl/8.0',
      },
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    return r.json();
  }

  try {
    const { number, id, status, limit = '20' } = req.query;

    // Single edition by issue_number — full payload (body_html included)
    if (number) {
      const rows = await sb(
        `civic_issues?issue_number=eq.${encodeURIComponent(number)}&select=id,issue_number,issue_date,subject,preview_text,body_html,body_text,status,send_completed_at`
      );
      if (!rows || rows.length === 0) return res.status(404).json({ error: 'Edition not found' });
      return res.json(rows[0]);
    }

    // Single edition by uuid
    if (id) {
      const rows = await sb(
        `civic_issues?id=eq.${encodeURIComponent(id)}&select=id,issue_number,issue_date,subject,preview_text,body_html,body_text,status,send_completed_at`
      );
      if (!rows || rows.length === 0) return res.status(404).json({ error: 'Edition not found' });
      return res.json(rows[0]);
    }

    // List — metadata only, no body html
    const statusFilter = status ? `&status=eq.${encodeURIComponent(status)}` : '&status=eq.sent';
    const safeLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const rows = await sb(
      `civic_issues?select=id,issue_number,issue_date,subject,preview_text,status,send_completed_at${statusFilter}&order=issue_number.desc&limit=${safeLimit}`
    );
    return res.json(rows || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
