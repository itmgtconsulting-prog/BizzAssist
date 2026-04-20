const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Implementeret i f9b3481 — Del A (withCronMonitor-wrapper på alle 12 cron-routes) var færdig fra tidligere session. Denne commit afslutter Del B: Nyt /dashboard/admin/cron-status-dashboard der viser live status for 14 cron-jobs (inkl. purge-old-data + ai-feedback-triage). API /api/admin/cron-status læser public.cron_heartbeats, beregner status (ok/error/overdue/missing) baseret på forventet interval, og returnerer summary + liste. UI-tabellen viser job-name + beskrivelse + schedule + seneste run-tid + duration + status-badge med fejlmeddelelse. Auto-refresher hver 30. sek. Ny Cron-status-tab tilføjet til admin-navigation. Klar til verifikation.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-621/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-621/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-621 comment:', r1.status, 'transition:', r2.status);
