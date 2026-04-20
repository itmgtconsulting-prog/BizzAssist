const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Implementeret i 52e42a5 — ny /dashboard/admin/ops landing-side med 4 tiles (Infrastructure, Cron-jobs, Service Manager, Security). Hver tile linker til eksisterende dedikeret sub-dashboard. Cron-tile aggregerer live fra /api/admin/cron-status (14 jobs) og viser OK/issues-badge. Auto-refresh hver 60s. Mobile-responsive. De 3 øvrige tiles viser "Se status"-prompt indtil deres respective APIs eksponerer count-summary (BIZZ-622/623 fortsætter dette arbejde). Klar til verifikation.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-625/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-625/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-625 comment:', r1.status, 'transition:', r2.status);
