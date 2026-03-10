// api/schedule-notify.js — RYC Weekly Schedule email notifications via Resend
// Pattern: raw fetch (no SDK), matches existing api/email.js approach

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { type, weekLabel, weekParam, recipients, changes, schedule, employees } = req.body;

  if (!recipients || recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients' });
  }

  const readOnlyUrl = `https://app.civicscope.io/ryc/schedule?view=readonly&week=${weekParam}`;
  const results = [];

  try {
    if (type === 'weekly') {
      // Weekly publish: send full schedule to everyone
      const html = buildWeeklyEmail(weekLabel, schedule, employees, readOnlyUrl);
      for (const email of recipients) {
        const r = await sendEmail(email, `RYC Field Schedule: ${weekLabel}`, html);
        results.push({ email, ok: r.ok });
      }
    } else if (type === 'change') {
      // Mid-week change: send personalized change notice to affected employees
      const grouped = {};
      (changes || []).forEach(c => {
        if (!grouped[c.email]) grouped[c.email] = { employee: c.employee, changes: [] };
        grouped[c.email].changes.push(c);
      });

      for (const [email, data] of Object.entries(grouped)) {
        const html = buildChangeEmail(weekLabel, data.employee, data.changes, readOnlyUrl);
        const r = await sendEmail(email, `Schedule Change: ${weekLabel}`, html);
        results.push({ email, ok: r.ok });
      }
    }

    const sent = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    return res.status(200).json({ sent, failed, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function sendEmail(to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'R. Yoder Construction <info@civicscope.io>',
      to,
      subject,
      html,
      reply_to: 'keith@anchoradvisorsnorth.com',
    }),
  });
  return { ok: resp.ok, status: resp.status };
}

// ── Email Templates ──

function buildWeeklyEmail(weekLabel, schedule, employees, readOnlyUrl) {
  const roleOrder = ['SR SS', 'SS', 'SSIT', 'FC', 'FM'];
  const sorted = [...employees].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));

  // Get weekday dates from schedule keys
  const dates = Object.keys(schedule).sort();
  const dayHeaders = dates.map(d => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  });

  let tableRows = '';
  sorted.forEach(emp => {
    const assignments = dates.map(d => schedule[d]?.[emp.name] || '—');
    const allSame = assignments.every(a => a === assignments[0]);

    tableRows += `<tr>
      <td style="padding:8px 10px;font-weight:600;border:1px solid #e5e5e5;white-space:nowrap;font-size:13px;">${emp.name}<br><span style="font-size:11px;color:#888;font-weight:400;">${emp.role}</span></td>`;

    if (allSame && assignments[0] !== '—') {
      // Same assignment all week — show merged cell
      tableRows += `<td colspan="${dates.length}" style="padding:8px 10px;text-align:center;border:1px solid #e5e5e5;font-size:13px;background:#eff6ff;color:#1e40af;">${assignments[0]}</td>`;
    } else {
      assignments.forEach(a => {
        let style = 'padding:6px 8px;text-align:center;border:1px solid #e5e5e5;font-size:12px;';
        if (a === 'VAC') style += 'background:#fffbeb;color:#d97706;';
        else if (a === 'Training') style += 'background:#f3e8ff;color:#7c3aed;';
        else if (a === 'Shop') style += 'background:#f0fdf4;color:#15803d;';
        else if (a === '—') style += 'color:#ccc;';
        else style += 'background:#eff6ff;color:#1e40af;';
        tableRows += `<td style="${style}">${a}</td>`;
      });
    }
    tableRows += '</tr>';
  });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f4;margin:0;padding:0;">
<div style="max-width:800px;margin:0 auto;padding:20px;">
  <div style="background:#1c1917;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:18px;font-weight:600;">R. Yoder Construction</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#a8a29e;">Weekly Field Schedule</p>
  </div>
  <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;">
    <h2 style="margin:0 0 16px;font-size:16px;color:#1c1917;">${weekLabel}</h2>
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f5f5f4;">
            <th style="padding:8px 10px;text-align:left;border:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;color:#78716c;">Employee</th>
            ${dayHeaders.map(d => `<th style="padding:8px 10px;text-align:center;border:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;color:#78716c;">${d}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div style="margin-top:20px;text-align:center;">
      <a href="${readOnlyUrl}" style="display:inline-block;background:#2563eb;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">View Full Schedule</a>
    </div>
  </div>
  <div style="padding:16px 24px;text-align:center;font-size:11px;color:#a8a29e;">
    R. Yoder Construction &bull; Schedule published ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
  </div>
</div>
</body></html>`;
}

function buildChangeEmail(weekLabel, employeeName, changes, readOnlyUrl) {
  let changeRows = changes.map(c => `
    <tr>
      <td style="padding:8px 10px;border:1px solid #e5e5e5;font-size:13px;">${c.date}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5;font-size:13px;color:#dc2626;text-decoration:line-through;">${c.from || '(none)'}</td>
      <td style="padding:8px 10px;border:1px solid #e5e5e5;font-size:13px;color:#059669;font-weight:500;">${c.to || '(none)'}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f4;margin:0;padding:0;">
<div style="max-width:600px;margin:0 auto;padding:20px;">
  <div style="background:#1c1917;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:18px;font-weight:600;">R. Yoder Construction</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#a8a29e;">Schedule Update</p>
  </div>
  <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;">
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;margin-bottom:16px;">
      <p style="margin:0;font-size:14px;color:#dc2626;font-weight:500;">Your schedule for ${weekLabel} has been updated.</p>
    </div>
    <p style="font-size:14px;color:#44403c;margin:0 0 16px;">${employeeName}, the following changes were made:</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="background:#f5f5f4;">
          <th style="padding:8px 10px;text-align:left;border:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;color:#78716c;">Day</th>
          <th style="padding:8px 10px;text-align:left;border:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;color:#78716c;">Was</th>
          <th style="padding:8px 10px;text-align:left;border:1px solid #e5e5e5;font-size:11px;text-transform:uppercase;color:#78716c;">Now</th>
        </tr>
      </thead>
      <tbody>${changeRows}</tbody>
    </table>
    <div style="margin-top:20px;text-align:center;">
      <a href="${readOnlyUrl}" style="display:inline-block;background:#2563eb;color:white;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500;">View Full Schedule</a>
    </div>
  </div>
  <div style="padding:16px 24px;text-align:center;font-size:11px;color:#a8a29e;">
    R. Yoder Construction &bull; Updated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
  </div>
</div>
</body></html>`;
}
