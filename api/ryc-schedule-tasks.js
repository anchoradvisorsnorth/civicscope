// api/ryc-schedule-tasks.js — Fetch Procore schedule tasks for a single project
// Called lazily by the dashboard after main cards render
// Returns summary: { tasksTotal, tasksComplete, overdueCount, criticalCount, dataAvailable }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const projectId = req.query.projectId;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  const COMPANY_ID = '598134325557276';

  try {
    // Authenticate
    const authRes = await fetch('https://login.procore.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.PROCORE_CLIENT_ID,
        client_secret: process.env.PROCORE_CLIENT_SECRET,
      }),
    });
    if (!authRes.ok) return res.status(502).json({ error: 'Procore auth failed' });
    const { access_token } = await authRes.json();

    // Fetch schedule tasks (v1.1 — v1.0 returns 404)
    const taskRes = await fetch(
      `https://api.procore.com/rest/v1.1/projects/${projectId}/schedule/tasks?per_page=250`,
      { headers: { 'Authorization': `Bearer ${access_token}`, 'Procore-Company-Id': COMPANY_ID } }
    );

    if (taskRes.status === 404) {
      return res.status(200).json({ dataAvailable: false });
    }
    if (!taskRes.ok) {
      return res.status(200).json({ dataAvailable: false });
    }

    const tasks = await taskRes.json();
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(200).json({ dataAvailable: false });
    }

    const today = new Date().toISOString().slice(0, 10);
    // Exclude summary tasks (has_children=true) to avoid double-counting
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
