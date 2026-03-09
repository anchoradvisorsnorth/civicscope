export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action } = req.body;

    if (action === 'log_run') {
      const { data } = req.body;
      const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/qa_runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(data)
      });
      const result = await r.json();
      return res.status(r.ok ? 200 : 400).json(result);
    }

    if (action === 'get_history') {
      const limit = req.body.limit || 50;
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/qa_runs?order=created_at.desc&limit=${limit}`,
        {
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
          }
        }
      );
      const result = await r.json();
      return res.status(r.ok ? 200 : 400).json(result);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: 'QA log request failed' });
  }
}
