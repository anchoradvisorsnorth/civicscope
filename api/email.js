// api/email.js — CivicScope transactional email
// Handles Free/Pro (CS-branded) and GC White Label (GC-branded) emails
// Uses Resend — CS reports send from info@civicscope.io, GC reports send from info@civicscope.io but brand as GC

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

    // ── Send report to user ──────────────────────────────────────────────────
    if (action === 'send_report') {
      const {
        recipientEmail, recipientName, municipality, projectType,
        costLow, costHigh, costMidpoint, confidence, narrative, assumptions,
        briefingHtml, whyGC, processSteps, product, gcName, gcSlug
      } = data;

      const isGC = product && product.startsWith('gc-');

      const reportHtml = isGC
        ? buildGCReportEmail({ recipientName, municipality, projectType, costLow, costHigh, costMidpoint, confidence, narrative, assumptions, whyGC, processSteps, gcName })
        : buildReportEmail({ recipientName, municipality, projectType, costLow, costHigh, costMidpoint, confidence, narrative, assumptions, briefingHtml, product });

      const subject = isGC
        ? `Your Project Cost Summary — ${projectType}${municipality ? ' in ' + municipality : ''}`
        : `Your CivicScope Feasibility Report — ${projectType} in ${municipality}`;

      const emailPayload = {
        from: FROM_EMAIL,
        to: [recipientEmail],
        bcc: [KEITH_EMAIL],
        subject,
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

    // ── Lead notification ────────────────────────────────────────────────────
    if (action === 'notify_lead') {
      const {
        firstName, lastName, email, role, municipality, projectType,
        costLow, costHigh, confidence, product, sessionId, runId,
        gcName, gcNotifyEmail
      } = data;

      const isGC = product && product.startsWith('gc-');

      // GC leads go to GC's notify_email (+ BCC Keith); CS leads go to Keith
      const toAddress = isGC && gcNotifyEmail ? gcNotifyEmail : KEITH_EMAIL;
      const bccAddress = isGC && gcNotifyEmail ? KEITH_EMAIL : null;

      const notifyHtml = isGC
        ? buildGCLeadNotificationEmail({ firstName, lastName, email, municipality, projectType, costLow, costHigh, confidence, gcName, sessionId })
        : buildLeadNotificationEmail({ firstName, lastName, email, role, municipality, projectType, costLow, costHigh, confidence, product, sessionId, runId });

      const subject = isGC
        ? `New Lead from Your Project Estimator — ${firstName} ${lastName} | ${municipality || projectType}`
        : `New CivicScope Lead — ${firstName} ${lastName} | ${municipality}`;

      const emailPayload = {
        from: FROM_EMAIL,
        to: [toAddress],
        ...(bccAddress ? { bcc: [bccAddress] } : {}),
        subject,
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

// ── Resend API call ──────────────────────────────────────────────────────────
async function sendEmail(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  if (!r.ok) { const err = await r.text(); throw new Error(`Resend error: ${err}`); }
  return r.json();
}

// ── GC Report Email (GC-branded) ─────────────────────────────────────────────
function buildGCReportEmail({ recipientName, municipality, projectType, costLow, costHigh, costMidpoint, confidence, narrative, assumptions, whyGC, processSteps, gcName }) {
  const confidenceColor = confidence === 'High' ? '#15803d' : confidence === 'Medium' ? '#92400e' : '#b91c1c';
  const confidenceBg    = confidence === 'High' ? '#dcfce7'  : confidence === 'Medium' ? '#fef3c7'  : '#fee2e2';

  const assumptionsHtml = assumptions && assumptions.length ? `
    <div style="margin-bottom:32px;">
      <div style="font-size:10px;letter-spacing:2px;color:#9ca3af;text-transform:uppercase;margin-bottom:12px;font-family:monospace;">Key Assumptions</div>
      <ul style="margin:0;padding-left:18px;color:#4b5563;font-size:14px;line-height:1.85;">
        ${assumptions.map(a => `<li style="margin-bottom:4px;">${a}</li>`).join('')}
      </ul>
    </div>` : '';

  const whyGCHtml = whyGC ? `
    <div style="background:#f0f4ff;border-left:3px solid #1e3a5f;border-radius:0 8px 8px 0;padding:24px 28px;margin-bottom:32px;">
      <div style="font-size:10px;letter-spacing:2px;color:#4b6cb7;text-transform:uppercase;margin-bottom:14px;font-family:monospace;">Why ${gcName}</div>
      ${whyGC.statement ? `<p style="color:#1e3a5f;font-size:15px;line-height:1.7;margin:0 0 16px;font-weight:500;">${whyGC.statement}</p>` : ''}
      ${whyGC.values && whyGC.values.length ? `
        <ul style="margin:0;padding:0;list-style:none;">
          ${whyGC.values.map(v => `<li style="font-size:13px;color:#374151;padding:5px 0 5px 16px;position:relative;border-bottom:1px solid #dbeafe;line-height:1.5;">
            <span style="position:absolute;left:0;color:#4b6cb7;">›</span>${v}
          </li>`).join('')}
        </ul>` : ''}
    </div>` : '';

  const processHtml = processSteps && processSteps.length ? `
    <div style="margin-bottom:32px;">
      <div style="font-size:10px;letter-spacing:2px;color:#9ca3af;text-transform:uppercase;margin-bottom:16px;font-family:monospace;">What Happens Next</div>
      ${processSteps.map((step, i) => `
        <div style="display:flex;gap:16px;margin-bottom:14px;align-items:flex-start;">
          <div style="width:24px;height:24px;background:#1e3a5f;border-radius:50%;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:sans-serif;">${i+1}</div>
          <div>
            <div style="font-size:13px;font-weight:600;color:#1e3a5f;margin-bottom:2px;font-family:sans-serif;">${step.title}</div>
            <div style="font-size:13px;color:#6b7280;line-height:1.55;font-family:sans-serif;">${step.description}${step.timeline ? ` <span style="color:#9ca3af;">· ${step.timeline}</span>` : ''}</div>
          </div>
        </div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f6f3;font-family:'Georgia',serif;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;">

  <!-- GC Header -->
  <div style="background:#1e3a5f;padding:28px 40px;border-bottom:3px solid #c8102e;">
    <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">${gcName}</div>
    <div style="color:rgba(255,255,255,0.45);font-size:10px;letter-spacing:2px;margin-top:4px;text-transform:uppercase;font-family:monospace;">Project Cost Summary</div>
  </div>

  <!-- Body -->
  <div style="padding:40px;">
    <p style="color:#374151;font-size:15px;margin:0 0 8px;font-family:sans-serif;">Hi ${recipientName || 'there'},</p>
    <p style="color:#6b7280;font-size:14px;line-height:1.7;margin:0 0 32px;font-family:sans-serif;">
      Here's your cost summary for the <strong style="color:#1e3a5f;">${projectType}</strong>${municipality ? ` project in <strong style="color:#1e3a5f;">${municipality}</strong>` : ''}.
      This gives you a realistic picture of what a project like this typically runs — so you can move forward with confidence.
    </p>

    <!-- Cost Range -->
    <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2d5a9e 100%);border-radius:10px;padding:28px;margin-bottom:32px;text-align:center;">
      <div style="font-size:10px;letter-spacing:2px;color:rgba(255,255,255,0.5);text-transform:uppercase;margin-bottom:8px;font-family:monospace;">Estimated Construction Cost</div>
      <div style="font-size:34px;font-weight:700;color:#ffffff;letter-spacing:-1px;">${costLow} – ${costHigh}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:6px;font-family:sans-serif;">Midpoint: ${costMidpoint}</div>
      <div style="display:inline-block;margin-top:12px;padding:4px 14px;border-radius:20px;background:${confidenceBg};color:${confidenceColor};font-size:11px;font-weight:600;font-family:sans-serif;">${confidence} Confidence</div>
    </div>

    <!-- Narrative -->
    <div style="margin-bottom:28px;">
      <div style="font-size:10px;letter-spacing:2px;color:#9ca3af;text-transform:uppercase;margin-bottom:10px;font-family:monospace;">What This Range Reflects</div>
      <p style="color:#374151;font-size:15px;line-height:1.75;margin:0;font-family:sans-serif;">${narrative}</p>
    </div>

    ${assumptionsHtml}
    ${whyGCHtml}
    ${processHtml}

    <!-- Next step CTA -->
    <div style="border-top:1px solid #e8e4df;padding-top:28px;text-align:center;">
      <p style="color:#6b7280;font-size:14px;line-height:1.7;margin:0 0 18px;font-family:sans-serif;">
        Questions about this estimate or ready to talk next steps?
      </p>
      <a href="mailto:${gcName}" style="display:inline-block;background:#c8102e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;font-family:sans-serif;">Get in Touch with ${gcName}</a>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f7f6f3;padding:18px 40px;border-top:1px solid #e8e4df;">
    <p style="color:#9ca3af;font-size:11px;margin:0;font-family:sans-serif;">
      This estimate is for preliminary planning purposes only and does not constitute a bid or proposal.
    </p>
    <p style="color:#d1cdc7;font-size:10px;margin:6px 0 0;font-family:monospace;">
      Delivered by ${gcName} · Powered by <a href="https://civicscope.io" style="color:#d1cdc7;">CivicScope</a>
    </p>
  </div>

</div>
</body>
</html>`;
}

// ── GC Lead Notification Email ────────────────────────────────────────────────
function buildGCLeadNotificationEmail({ firstName, lastName, email, municipality, projectType, costLow, costHigh, confidence, gcName, sessionId }) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis', dateStyle: 'medium', timeStyle: 'short' });
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f6f3;font-family:sans-serif;">
<div style="max-width:540px;margin:0 auto;background:#fff;">
  <div style="background:#1e3a5f;padding:22px 32px;border-bottom:3px solid #c8102e;">
    <div style="color:#fff;font-size:16px;font-weight:700;">New Lead — ${gcName} Estimator</div>
    <div style="color:rgba(255,255,255,0.45);font-size:10px;letter-spacing:2px;margin-top:4px;font-family:monospace;">${ts}</div>
  </div>
  <div style="padding:32px;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:9px 0;color:#9ca3af;width:130px;">Name</td><td style="padding:9px 0;color:#111;font-weight:600;">${firstName} ${lastName}</td></tr>
      <tr style="background:#fafaf9;"><td style="padding:9px 6px;color:#9ca3af;">Email</td><td style="padding:9px 6px;"><a href="mailto:${email}" style="color:#1e3a5f;font-weight:500;">${email}</a></td></tr>
      <tr><td style="padding:9px 0;color:#9ca3af;">Organization</td><td style="padding:9px 0;color:#374151;">${municipality || '—'}</td></tr>
      <tr style="background:#fafaf9;"><td style="padding:9px 6px;color:#9ca3af;">Project Type</td><td style="padding:9px 6px;color:#374151;">${projectType}</td></tr>
      <tr><td style="padding:9px 0;color:#9ca3af;">Cost Range</td><td style="padding:9px 0;color:#374151;font-weight:500;">${costLow} – ${costHigh} <span style="color:#9ca3af;font-weight:400;">(${confidence})</span></td></tr>
    </table>
    <div style="margin-top:24px;padding-top:22px;border-top:1px solid #e8e4df;">
      <a href="mailto:${email}?subject=Re: Your ${projectType} project${municipality ? ' in ' + municipality : ''}" style="display:inline-block;background:#1e3a5f;color:#fff;padding:10px 22px;border-radius:5px;text-decoration:none;font-size:13px;font-weight:600;">Reply to ${firstName} →</a>
    </div>
    ${sessionId ? `<p style="color:#d1cdc7;font-size:10px;margin:16px 0 0;font-family:monospace;">Session: ${sessionId}</p>` : ''}
  </div>
</div>
</body>
</html>`;
}

// ── CS Report Email (original — Free / Pro) ───────────────────────────────────
function buildReportEmail({ recipientName, municipality, projectType, costLow, costHigh, costMidpoint, confidence, narrative, assumptions, briefingHtml, product }) {
  const tier = product === 'pro' ? 'CivicScope Pro' : 'CivicScope';
  const confidenceColor = confidence === 'High' ? '#2d6a4f' : confidence === 'Medium' ? '#b5860d' : '#c0392b';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:Georgia,serif;">
<div style="max-width:600px;margin:0 auto;background:#fff;">
  <div style="background:#1a2744;padding:32px 40px;">
    <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">CivicScope</div>
    <div style="color:#9aa5c4;font-size:11px;letter-spacing:2px;margin-top:4px;text-transform:uppercase;">Municipal Project Feasibility</div>
  </div>
  <div style="padding:40px;">
    <p style="color:#555;font-size:15px;margin:0 0 24px;">Hi ${recipientName || 'there'},</p>
    <p style="color:#555;font-size:15px;margin:0 0 32px;">Here is your feasibility report for the <strong>${projectType}</strong> project in <strong>${municipality}</strong>.</p>
    <div style="background:#f5f0eb;border-radius:8px;padding:28px;margin-bottom:32px;text-align:center;">
      <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:8px;">Estimated Project Cost</div>
      <div style="font-size:36px;font-weight:700;color:#1a2744;">${costLow} – ${costHigh}</div>
      <div style="font-size:14px;color:#888;margin-top:4px;">Midpoint: ${costMidpoint}</div>
      <div style="display:inline-block;margin-top:12px;padding:4px 12px;border-radius:20px;background:${confidenceColor};color:#fff;font-size:11px;letter-spacing:1px;text-transform:uppercase;">${confidence} Confidence</div>
    </div>
    <div style="margin-bottom:28px;">
      <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:12px;">Assessment</div>
      <p style="color:#333;font-size:15px;line-height:1.7;margin:0;">${narrative}</p>
    </div>
    ${assumptions && assumptions.length ? `
    <div style="margin-bottom:28px;">
      <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:12px;">Key Assumptions</div>
      <ul style="margin:0;padding-left:20px;color:#555;font-size:14px;line-height:1.8;">
        ${assumptions.map(a => `<li>${a}</li>`).join('')}
      </ul>
    </div>` : ''}
    ${briefingHtml ? `
    <div style="margin-bottom:28px;border-top:1px solid #eee;padding-top:28px;">
      <div style="font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:16px;">Council Briefing Guide</div>
      <div style="font-size:14px;color:#333;line-height:1.7;">${briefingHtml}</div>
    </div>` : ''}
    <div style="border-top:1px solid #eee;padding-top:28px;margin-top:28px;">
      <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 16px;">Ready to explore how to deliver this project? JBK Development helps Indiana and Michigan municipalities evaluate feasibility and structure projects from concept through construction.</p>
      <a href="mailto:keith@jbkdevelopment.com" style="display:inline-block;background:#1a2744;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;font-size:14px;">Contact JBK Development</a>
    </div>
  </div>
  <div style="background:#f5f0eb;padding:20px 40px;border-top:1px solid #e8e0d5;">
    <p style="color:#999;font-size:11px;margin:0;">Generated by ${tier} · <a href="https://civicscope.io" style="color:#999;">civicscope.io</a></p>
    <p style="color:#bbb;font-size:10px;margin:4px 0 0;">This estimate is for preliminary planning purposes only and should not be used as a final budget figure.</p>
  </div>
</div>
</body>
</html>`;
}

// ── CS Lead Notification Email (original) ────────────────────────────────────
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
