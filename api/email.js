// api/email.js — CivicScope transactional email
// Sends feasibility report to user, lead notification to Keith
// Uses Resend — sends from info@civicscope.io

const SANDBOX_MODE = process.env.SANDBOX_MODE || 'send'; // 'log' or 'send'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const KEITH_EMAIL = 'keith@jbkdevelopment.com';
  const FROM_EMAIL = 'CivicScope <info@civicscope.io>';

  try {
    const { action, data } = req.body;

    // ── Send report to user ───────────────────────────────────────
    if (action === 'send_report') {
      const {
        recipientEmail,
        recipientName,
        municipality,
        projectType,
        costLow,
        costHigh,
        costMidpoint,
        confidence,
        narrative,
        assumptions,
        briefingHtml,
        product
      } = data;

      const reportHtml = buildReportEmail({
        recipientName,
        municipality,
        projectType,
        costLow,
        costHigh,
        costMidpoint,
        confidence,
        narrative,
        assumptions,
        briefingHtml,
        product
      });

      const emailPayload = {
        from: FROM_EMAIL,
        to: [recipientEmail],
        bcc: [KEITH_EMAIL],
        subject: `Your CivicScope Feasibility Report — ${projectType} in ${municipality}`,
        html: reportHtml
      };

      if (SANDBOX_MODE === 'log') {
        console.log('=== SANDBOX EMAIL (report) ===');
        console.log(JSON.stringify(emailPayload, null, 2));
        return res.status(200).json({ sent: false, sandbox: true, payload: emailPayload });
      }

      const result = await sendEmail(RESEND_API_KEY, emailPayload);
      return res.status(200).json({ sent: true, id: result.id });
    }

    // ── Lead notification to Keith ────────────────────────────────
    if (action === 'notify_lead') {
      const {
        firstName,
        lastName,
        email,
        role,
        municipality,
        projectType,
        costLow,
        costHigh,
        confidence,
        product,
        sessionId,
        runId
      } = data;

      const notifyHtml = buildLeadNotificationEmail({
        firstName,
        lastName,
        email,
        role,
        municipality,
        projectType,
        costLow,
        costHigh,
        confidence,
        product,
        sessionId,
        runId
      });

      const emailPayload = {
        from: FROM_EMAIL,
        to: [KEITH_EMAIL],
        subject: `New CivicScope Lead — ${firstName} ${lastName} | ${municipality}`,
        html: notifyHtml
      };

      if (SANDBOX_MODE === 'log') {
        console.log('=== SANDBOX EMAIL (lead notification) ===');
        console.log(JSON.stringify(emailPayload, null, 2));
        return res.status(200).json({ sent: false, sandbox: true, payload: emailPayload });
      }

      const result = await sendEmail(RESEND_API_KEY, emailPayload);
      return res.status(200).json({ sent: true, id: result.id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Email error:', err);
    return res.status(200).json({ error: err.message, sent: false });
  }
}

// ── Resend API call ───────────────────────────────────────────────
async function sendEmail(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Resend error: ${err}`);
  }
  return r.json();
}

// ── Report email HTML ─────────────────────────────────────────────
function buildReportEmail({ recipientName, municipality, projectType, costLow, costHigh, costMidpoint, confidence, narrative, assumptions, briefingHtml, product }) {
  const tier = product === 'pro' ? 'CivicScope Pro' : 'CivicScope';
  const confidenceColor = confidence === 'High' ? '#2d6a4f' : confidence === 'Medium' ? '#b5860d' : '#c0392b';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:Georgia,serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;">

    <!-- Header -->
    <div style="background:#1a2744;padding:32px 40px;">
      <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">CivicScope</div>
      <div style="color:#9aa5c4;font-size:11px;letter-spacing:2px;margin-top:4px;text-transform:uppercase;">Municipal Project Feasibility</div>
    </div>

    <!-- Body -->
    <div style="padding:40px;">
      <p style="color:#555;font-size:15px;margin:0 0 24px;">Hi ${recipientName || 'there'},</p>
      <p style="color:#555;font-size:15px;margin:0 0 32px;">Here is your feasibility report for the <strong>${projectType}</strong> project in <strong>${municipality}</strong>.</p>

      <!-- Cost Range -->
      <div style="background:#f5f0eb;border-radius:8px;padding:28px;margin-bottom:32px;text-align:center;">
        <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:8px;">Estimated Project Cost</div>
        <div style="font-size:36px;font-weight:700;color:#1a2744;">${costLow} – ${costHigh}</div>
        <div style="font-size:14px;color:#888;margin-top:4px;">Midpoint: ${costMidpoint}</div>
        <div style="display:inline-block;margin-top:12px;padding:4px 12px;border-radius:20px;background:${confidenceColor};color:#fff;font-size:11px;letter-spacing:1px;text-transform:uppercase;">${confidence} Confidence</div>
      </div>

      <!-- Narrative -->
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:12px;">Assessment</div>
        <p style="color:#333;font-size:15px;line-height:1.7;margin:0;">${narrative}</p>
      </div>

      <!-- Assumptions -->
      ${assumptions && assumptions.length ? `
      <div style="margin-bottom:28px;">
        <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:12px;">Key Assumptions</div>
        <ul style="margin:0;padding-left:20px;color:#555;font-size:14px;line-height:1.8;">
          ${assumptions.map(a => `<li>${a}</li>`).join('')}
        </ul>
      </div>` : ''}

      <!-- Council Briefing -->
      ${briefingHtml ? `
      <div style="margin-bottom:28px;border-top:1px solid #eee;padding-top:28px;">
        <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:16px;">Council Briefing Guide</div>
        <div style="font-size:14px;color:#333;line-height:1.7;">${briefingHtml}</div>
      </div>` : ''}

      <!-- CTA -->
      <div style="border-top:1px solid #eee;padding-top:28px;margin-top:28px;">
        <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 16px;">Ready to explore how to deliver this project? JBK Development helps Indiana and Michigan municipalities evaluate feasibility and structure projects from concept through construction.</p>
        <a href="mailto:keith@jbkdevelopment.com" style="display:inline-block;background:#1a2744;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:14px;">Contact JBK Development</a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#f5f0eb;padding:20px 40px;border-top:1px solid #e8e0d5;">
      <p style="color:#999;font-size:11px;margin:0;">Generated by ${tier} · <a href="https://civicscope.io" style="color:#999;">civicscope.io</a></p>
      <p style="color:#bbb;font-size:10px;margin:4px 0 0;">This estimate is for preliminary planning purposes only and should not be used as a final budget figure.</p>
    </div>

  </div>
</body>
</html>`;
}

// ── Lead notification email HTML ──────────────────────────────────
function buildLeadNotificationEmail({ firstName, lastName, email, role, municipality, projectType, costLow, costHigh, confidence, product, sessionId, runId }) {
  const tier = product === 'pro' ? 'Pro' : 'Free';
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis' });

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:Georgia,serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;">

    <div style="background:#1a2744;padding:24px 32px;">
      <div style="color:#fff;font-size:18px;font-weight:700;">New CivicScope Lead</div>
      <div style="color:#9aa5c4;font-size:11px;letter-spacing:2px;margin-top:4px;text-transform:uppercase;">${tier} · ${ts}</div>
    </div>

    <div style="padding:32px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;color:#888;width:140px;">Name</td><td style="padding:8px 0;color:#222;font-weight:600;">${firstName} ${lastName}</td></tr>
        <tr style="background:#f9f6f3;"><td style="padding:8px 6px;color:#888;">Email</td><td style="padding:8px 6px;"><a href="mailto:${email}" style="color:#1a2744;">${email}</a></td></tr>
        <tr><td style="padding:8px 0;color:#888;">Role</td><td style="padding:8px 0;color:#222;">${role || '—'}</td></tr>
        <tr style="background:#f9f6f3;"><td style="padding:8px 6px;color:#888;">Municipality</td><td style="padding:8px 6px;color:#222;">${municipality}</td></tr>
        <tr><td style="padding:8px 0;color:#888;">Project</td><td style="padding:8px 0;color:#222;">${projectType}</td></tr>
        <tr style="background:#f9f6f3;"><td style="padding:8px 6px;color:#888;">Cost Range</td><td style="padding:8px 6px;color:#222;">${costLow} – ${costHigh} (${confidence})</td></tr>
        <tr><td style="padding:8px 0;color:#888;">Product</td><td style="padding:8px 0;color:#222;">${tier}</td></tr>
      </table>

      <div style="margin-top:24px;padding-top:24px;border-top:1px solid #eee;">
        <a href="mailto:${email}?subject=Re: Your ${projectType} project in ${municipality}" style="display:inline-block;background:#1a2744;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:13px;">Reply to ${firstName}</a>
      </div>

      ${sessionId ? `<p style="color:#ccc;font-size:10px;margin:16px 0 0;">Session: ${sessionId} · Run: ${runId || '—'}</p>` : ''}
    </div>

  </div>
</body>
</html>`;
}
