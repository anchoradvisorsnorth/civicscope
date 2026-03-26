// api/ryc-schedule-tasks.js — Fetch Procore schedule tasks for a single project
// Called lazily by the dashboard after main cards render
// Returns summary: { tasksTotal, tasksComplete, overdueCount, criticalCount, dataAvailable }

async function procoreFetch(url, headers, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r;
    if (attempt < retries && (r.status === 429 || r.status >= 500)) {
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 2000));
      continue;
    }
    return r; // return last failed response
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const projectId = req.query.projectId;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  const COMPANY_ID = '598134325557276';

  try {
    // Authenticate — DMSA client_credentials (same creds as procore-refresh.js)
    const authRes = await fetch('https://login.procore.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'h2Y7VbL-GUQy420YOg5-ViKfgzjdq4zLVj_r14jeXhg',
        client_secret: 'Uyr1en0O6by9bmawO47JQ4qeBrlLyi3GogwD9furmJI',
      }),
    });
    if (!authRes.ok) return res.status(502).json({ error: 'Procore auth failed' });
    const { access_token } = await authRes.json();

    // Fetch schedule tasks (v1.1 — v1.0 returns 404) with retry for 429
    const taskRes = await procoreFetch(
      `https://api.procore.com/rest/v1.1/projects/${projectId}/schedule/tasks?per_page=250`,
      { 'Authorization': `Bearer ${access_token}`, 'Procore-Company-Id': COMPANY_ID }
    );

    if (!taskRes.ok) {
      return res.status(200).json({ dataAvailable: false, rateLimited: taskRes.status === 429 });
    }

    const tasks = await taskRes.json();
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(200).json({ dataAvailable: false });
    }

    const today = new Date().toISOString().slice(0, 10);
    const leafTasks = tasks.filter(t => !t.has_children);
    const tasksComplete = leafTasks.filter(t => t.percentage === 100).length;
    const overdueCount = leafTasks.filter(t => {
      const fd = (t.finish || '').slice(0, 10);
      return fd && fd < today && t.percentage < 100;
    }).length;
    const criticalCount = leafTasks.filter(t => t.critical_path === true && t.percentage < 100).length;

    return res.status(200).json({
      dataAvailable: true,
      tasksTotal: leafTasks.length,
      tasksComplete,
      overdueCount,
      criticalCount,
    });
  } catch (e) {
    return res.status(200).json({ dataAvailable: false, error: e.message });
  }
}
