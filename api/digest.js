// api/digest.js — CivicScope Daily Digest
// Queries last 24h of tool_runs + leads, sends summary email to Keith
// Triggered by Vercel cron daily at 7am ET (see vercel.json)
// Can also be triggered manually: POST /api/digest with Authorization header

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>
  // Manual trigger: same header
  const authHeader = req.headers['authorization'];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (authHeader !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const KEITH_EMAIL = 'info@civicscope.io';

  try {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const dateLabel = now.toLocaleDateString('en-US', {
      timeZone: 'America/Indiana/Indianapolis',
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    // ── Fetch tool runs from last 24h ────────────────────────────────
    const runsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tool_runs?created_at=gte.${since}&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    if (!runsRes.ok) throw new Error(`Supabase tool_runs error: ${await runsRes.text()}`);
    const runs = await runsRes.json();

    // ── Fetch leads from last 24h ────────────────────────────────────
    const leadsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?created_at=gte.${since}&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );
    if (!leadsRes.ok) throw new Error(`Supabase leads error: ${await leadsRes.text()}`);
    const leads = await leadsRes.json();

    // ── Skip email if nothing happened ───────────────────────────────
    if (runs.length === 0 && leads.length === 0) {
      return res.status(200).json({ sent: false, reason: 'No activity in last 24h' });
    }

    // ── Segment runs ─────────────────────────────────────────────────
    const campaignRuns = runs.filter(r => r.ref);
    const organicRuns = runs.filter(r => !r.ref);

    // Campaign ref breakdown
    const refCounts = {};
    campaignRuns.forEach(r => {
      refCounts[r.ref] = (refCounts[r.ref] || 0) + 1;
    });

    // Product breakdown
    const productCounts = {};
    runs.forEach(r => {
      const p = r.product || 'free';
      productCounts[p] = (productCounts[p] || 0) + 1;
    });

    // ── Build email HTML ─────────────────────────────────────────────
    const html = buildDigestEmail({
      dateLabel,
      runs,
      leads,
      campaignRuns,
      organicRuns,
      refCounts,
      productCounts
    });

    // ── Send via Resend ──────────────────────────────────────────────
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'CivicScope <info@civicscope.io>',
        to: [KEITH_EMAIL],
        subject: `CivicScope Daily — ${runs.length} run${runs.length !== 1 ? 's' : ''}, ${leads.length} lead${leads.length !== 1 ? 's' : ''} (${now.toLocaleDateString('en-US', { timeZone: 'America/Indiana/Indianapolis', month: 'short', day: 'numeric' })})`,
        html
      })
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      throw new Error(`Resend error: ${err}`);
    }

    const result = await emailRes.json();
    return res.status(200).json({ sent: true, id: result.id, runs: runs.length, leads: leads.length });

  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Email Template ──────────────────────────────────────────────────────────
function buildDigestEmail({ dateLabel, runs, leads, campaignRuns, organicRuns, refCounts, productCounts }) {
  const fmt = (n) => typeof n === 'number' ? '$' + n.toLocaleString('en-US') : n;
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Indiana/Indianapolis',
    hour: 'numeric', minute: '2-digit'
  });

  // ── Summary stats row ──
  const statsHtml = `
    <div style="display:flex;gap:0;">
      ${statCard('Total Runs', runs.length, '#1a2744')}
      ${statCard('Leads', leads.length, '#c2410c')}
      ${statCard('Campaign', campaignRuns.length, '#15803d')}
      ${statCard('Organic', organicRuns.length, '#78716c')}
    </div>`;

  // ── Campaign tracking ──
  let campaignHtml = '';
  if (Object.keys(refCounts).length > 0) {
    const rows = Object.entries(refCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ref, count]) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e7e2d8;font-size:13px;color:#1a2744;font-weight:600;">${ref}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e7e2d8;font-size:13px;color:#44403c;text-align:right;">${count} run${count !== 1 ? 's' : ''}</td>
        </tr>`)
      .join('');
    campaignHtml = `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">Campaign Tracking (by ref)</div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
          ${rows}
        </table>
      </div>`;
  }

  // ── Individual runs table ──
  const runRows = runs.map(r => `
    <tr style="border-bottom:1px solid #e7e2d8;">
      <td style="padding:10px 12px;font-size:12px;color:#78716c;white-space:nowrap;vertical-align:top;">${time(r.created_at)}</td>
      <td style="padding:10px 12px;vertical-align:top;">
        <div style="font-size:13px;font-weight:600;color:#1a2744;">${r.project_type || '—'}</div>
        <div style="font-size:12px;color:#44403c;margin-top:2px;">${r.municipality || ''}${r.state ? ', ' + r.state : ''}${r.zip ? ' ' + r.zip : ''}</div>
        ${r.scope_description ? `<div style="font-size:12px;color:#78716c;margin-top:4px;line-height:1.4;font-style:italic;">"${truncate(r.scope_description, 120)}"</div>` : ''}
      </td>
      <td style="padding:10px 12px;text-align:right;vertical-align:top;white-space:nowrap;">
        <div style="font-size:13px;font-weight:600;color:#1a2744;">${fmt(r.cost_low)} – ${fmt(r.cost_high)}</div>
        <div style="font-size:11px;color:${r.confidence === 'High' ? '#15803d' : r.confidence === 'Medium' ? '#92400e' : '#c2410c'};margin-top:2px;">${r.confidence || '—'}</div>
      </td>
      <td style="padding:10px 12px;text-align:center;vertical-align:top;">
        ${r.ref ? `<span style="display:inline-block;padding:2px 8px;background:#dcfce7;color:#15803d;font-size:10px;font-weight:600;border-radius:10px;letter-spacing:0.5px;">${r.ref}</span>` : `<span style="color:#a8a29e;font-size:11px;">organic</span>`}
      </td>
    </tr>`).join('');

  const runsTableHtml = runs.length > 0 ? `
    <div style="margin-bottom:28px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">All Runs (${runs.length})</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
        <tr style="background:#f5f0eb;">
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Time</th>
          <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Project</th>
          <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Cost Range</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Source</th>
        </tr>
        ${runRows}
      </table>
    </div>` : '';

  // ── Leads table ──
  let leadsHtml = '';
  if (leads.length > 0) {
    const leadRows = leads.map(l => `
      <tr style="border-bottom:1px solid #e7e2d8;">
        <td style="padding:10px 12px;font-size:12px;color:#78716c;white-space:nowrap;">${time(l.created_at)}</td>
        <td style="padding:10px 12px;">
          <div style="font-size:13px;font-weight:600;color:#1a2744;">${l.first_name} ${l.last_name}</div>
          <div style="font-size:12px;color:#44403c;margin-top:2px;"><a href="mailto:${l.email}" style="color:#c2410c;text-decoration:none;">${l.email}</a></div>
        </td>
        <td style="padding:10px 12px;font-size:12px;color:#44403c;">${l.role || '—'}</td>
        <td style="padding:10px 12px;font-size:12px;color:#44403c;">${l.municipality || '—'}</td>
      </tr>`).join('');

    leadsHtml = `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#78716c;margin-bottom:12px;">New Leads (${leads.length})</div>
        <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e7e2d8;">
          <tr style="background:#f5f0eb;">
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Time</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Contact</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Role</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;">Municipality</th>
          </tr>
          ${leadRows}
        </table>
      </div>`;
  }

  // ── Product breakdown ──
  const productRows = Object.entries(productCounts)
    .map(([p, c]) => `<span style="display:inline-block;margin-right:12px;font-size:12px;color:#44403c;"><strong>${p}</strong>: ${c}</span>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:-apple-system,Segoe UI,sans-serif;">
<div style="max-width:680px;margin:0 auto;background:#fff;">
  <div style="background:#1a2744;padding:28px 36px;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">CivicScope Daily Digest</div>
    <div style="color:#9aa5c4;font-size:12px;margin-top:4px;">${dateLabel}</div>
  </div>
  <div style="padding:32px 36px;">
    ${statsHtml}
    <div style="margin:20px 0 28px;padding:0;">${productRows}</div>
    ${campaignHtml}
    ${leadsHtml}
    ${runsTableHtml}
    <div style="border-top:1px solid #e7e2d8;padding-top:20px;margin-top:8px;">
      <p style="font-size:12px;color:#a8a29e;margin:0;">This digest covers the last 24 hours. Campaign runs are attributed via <code style="background:#f5f0eb;padding:1px 4px;border-radius:3px;">?ref=</code> parameter.</p>
    </div>
  </div>
  <div style="background:#f5f0eb;padding:16px 36px;border-top:1px solid #e7e2d8;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">CivicScope Daily Digest · <a href="https://civicscope.io" style="color:#a8a29e;">civicscope.io</a></p>
  </div>
</div>
</body>
</html>`;
}

function statCard(label, value, color) {
  return `
    <div style="flex:1;padding:16px;text-align:center;border:1px solid #e7e2d8;margin-right:-1px;">
      <div style="font-size:28px;font-weight:700;color:${color};">${value}</div>
      <div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#78716c;margin-top:4px;">${label}</div>
    </div>`;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '…' : str;
}
