// Give the proxy headroom: a single Sonnet estimate (esp. Schools/Infra
// renovation scenarios) can generate ~1,300 output tokens / ~20s. Without an
// explicit cap the function rides the Vercel plan default and a long run can
// 504 into the generic "something went wrong" error. 60s = Hobby max.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    console.error('API proxy error:', err.message || err);
    return res.status(500).json({ error: { message: `API request failed: ${err.message || 'unknown'}` } });
  }
}
