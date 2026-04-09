/**
 * Konfigurerer Supabase auth for alle 3 miljøer:
 * - Redirect URL allow-list (fix for /?code= bug)
 * - Custom SMTP via Resend (sender: BizzAssist <noreply@bizzassist.dk>)
 * - Branded email-templates (BizzAssist design)
 * - Danske email-emner
 *
 * Kør med: node scripts/configure-supabase-email.mjs
 */

import https from 'https';

const RESEND_API_KEY = 're_AseKbMDY_ERnnX3v6Fwm9gA96HzWLru5r';

const PROJECTS = [
  {
    ref: 'wkzwxfhyfmvglrqtmebw',
    name: 'Dev (localhost:3000)',
    token: 'sbp_1ef1f0d77dadaa2de6131716b0e5280e3ba39b9a',
    siteUrl: 'http://localhost:3000',
    redirects: [
      'http://localhost:3000/auth/callback',
      'http://localhost:3000/auth/callback?type=signup',
    ],
  },
  {
    ref: 'rlkjmqjxmkxuclehbrnl',
    name: 'Test (test.bizzassist.dk)',
    token: 'sbp_1ef1f0d77dadaa2de6131716b0e5280e3ba39b9a',
    siteUrl: 'https://test.bizzassist.dk',
    redirects: [
      'https://test.bizzassist.dk/auth/callback',
      'https://test.bizzassist.dk/auth/callback?type=signup',
    ],
  },
  {
    ref: 'xsyldjqcntiygrtfcszm',
    name: 'Produktion (bizzassist.dk)',
    token: 'sbp_1ef1f0d77dadaa2de6131716b0e5280e3ba39b9a',
    siteUrl: 'https://bizzassist.dk',
    redirects: [
      'https://bizzassist.dk/auth/callback',
      'https://bizzassist.dk/auth/callback?type=signup',
    ],
  },
];

// ─── Email HTML-template builder ─────────────────────────────────────────────

function emailHtml({ title, preheader, body, ctaUrl, ctaText }) {
  return `<!DOCTYPE html>
<html lang="da">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin: 0; padding: 0; background-color: #0a1020; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .wrapper { background-color: #0a1020; padding: 40px 20px; }
  .container { max-width: 520px; margin: 0 auto; }
  .logo-row { text-align: center; margin-bottom: 32px; }
  .logo { font-size: 24px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; }
  .logo span { color: #3b82f6; }
  .card { background-color: #0f172a; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 40px 36px; }
  .card-title { font-size: 22px; font-weight: 700; color: #ffffff; margin: 0 0 12px 0; }
  .card-body { font-size: 15px; color: #94a3b8; line-height: 1.7; margin: 0 0 28px 0; }
  .cta { display: block; background-color: #2563eb; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; text-align: center; padding: 14px 24px; border-radius: 10px; }
  .cta:hover { background-color: #1d4ed8; }
  .divider { border: none; border-top: 1px solid rgba(255,255,255,0.07); margin: 28px 0; }
  .footer { text-align: center; margin-top: 28px; font-size: 12px; color: #475569; line-height: 1.6; }
  .footer a { color: #475569; text-decoration: underline; }
  .expire { font-size: 13px; color: #64748b; margin-top: 16px; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="container">
    <div class="logo-row">
      <span class="logo">Bizz<span>Assist</span></span>
    </div>
    <div class="card">
      <p class="card-title">${title}</p>
      <p class="card-body">${body}</p>
      <a href="${ctaUrl}" class="cta">${ctaText}</a>
      <p class="expire">Linket er gyldigt i 24 timer. Hvis du ikke oprettede en konto, kan du se bort fra denne email.</p>
      <hr class="divider">
      <p style="font-size:12px;color:#475569;margin:0;">Hvis knappen ikke virker, kopiér dette link til din browser:<br>
        <a href="${ctaUrl}" style="color:#3b82f6;word-break:break-all;">${ctaUrl}</a>
      </p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} Pecunia IT Consulting ApS · CVR 44718502<br>
      <a href="https://bizzassist.dk">bizzassist.dk</a> · <a href="mailto:support@bizzassist.dk">support@bizzassist.dk</a></p>
    </div>
  </div>
</div>
</body>
</html>`;
}

const TEMPLATES = {
  confirmation: emailHtml({
    title: 'Bekræft din email',
    body: 'Tak for din tilmelding til BizzAssist. Klik på knappen nedenfor for at bekræfte din email-adresse og aktivere din konto.',
    ctaUrl: '{{ .ConfirmationURL }}',
    ctaText: 'Bekræft email',
  }),
  recovery: emailHtml({
    title: 'Nulstil din adgangskode',
    body: 'Vi modtog en anmodning om at nulstille adgangskoden til din BizzAssist-konto. Klik på knappen nedenfor for at vælge en ny adgangskode.',
    ctaUrl: '{{ .ConfirmationURL }}',
    ctaText: 'Nulstil adgangskode',
  }),
  magic_link: emailHtml({
    title: 'Log ind på BizzAssist',
    body: 'Du har anmodet om et magisk login-link til BizzAssist. Klik på knappen nedenfor for at logge ind — linket er engangsbrug.',
    ctaUrl: '{{ .ConfirmationURL }}',
    ctaText: 'Log ind med magisk link',
  }),
  email_change: emailHtml({
    title: 'Bekræft ændring af email',
    body: 'Du har anmodet om at ændre din email-adresse på BizzAssist fra <strong style="color:#e2e8f0">{{ .Email }}</strong> til <strong style="color:#e2e8f0">{{ .NewEmail }}</strong>. Klik nedenfor for at bekræfte.',
    ctaUrl: '{{ .ConfirmationURL }}',
    ctaText: 'Bekræft ny email',
  }),
  invite: emailHtml({
    title: 'Du er blevet inviteret til BizzAssist',
    body: 'Du er blevet inviteret til at oprette en konto på BizzAssist. Klik på knappen nedenfor for at acceptere invitationen og oprette din adgangskode.',
    ctaUrl: '{{ .ConfirmationURL }}',
    ctaText: 'Acceptér invitation',
  }),
  reauthentication: `<h2 style="font-family:sans-serif">Bekræft genautentifikation</h2><p style="font-family:sans-serif">Bekræftelseskode: <strong>{{ .Token }}</strong></p>`,
};

// ─── API-kald ─────────────────────────────────────────────────────────────────

function patchSupabase(projectRef, token, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${projectRef}/config/auth`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Kør konfiguration ────────────────────────────────────────────────────────

for (const project of PROJECTS) {
  console.log(`\n── ${project.name} (${project.ref}) ──`);

  const config = {
    // Fix: tilføj /auth/callback til allowed redirects
    uri_allow_list: project.redirects.join(','),
    site_url: project.siteUrl,

    // Kræv altid email-verifikation — aldrig auto-confirm
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,

    // Custom SMTP via Resend
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: RESEND_API_KEY,
    smtp_admin_email: 'noreply@bizzassist.dk',
    smtp_sender_name: 'BizzAssist',

    // Danske email-emner
    mailer_subjects_confirmation: 'Bekræft din email — BizzAssist',
    mailer_subjects_recovery: 'Nulstil din adgangskode — BizzAssist',
    mailer_subjects_magic_link: 'Dit login-link til BizzAssist',
    mailer_subjects_email_change: 'Bekræft ændring af email — BizzAssist',
    mailer_subjects_invite: 'Du er inviteret til BizzAssist',
    mailer_subjects_reauthentication: 'Bekræftelseskode — BizzAssist',

    // Branded HTML-templates
    mailer_templates_confirmation_content: TEMPLATES.confirmation,
    mailer_templates_recovery_content: TEMPLATES.recovery,
    mailer_templates_magic_link_content: TEMPLATES.magic_link,
    mailer_templates_email_change_content: TEMPLATES.email_change,
    mailer_templates_invite_content: TEMPLATES.invite,
    mailer_templates_reauthentication_content: TEMPLATES.reauthentication,
  };

  const result = await patchSupabase(project.ref, project.token, config);
  if (result.status === 200) {
    console.log(`  ✅ Konfigureret OK`);
  } else {
    console.log(`  ❌ Fejl ${result.status}: ${result.body.slice(0, 200)}`);
  }
}

console.log('\nFærdig!');
