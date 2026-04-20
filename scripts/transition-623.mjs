const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Trigger 1 implementeret i fc0343b — service-scan cron (hver time) tjekker nu cron_heartbeats for failed (last_status=error) eller overdue (> 2× expected_interval + 5 min grace) jobs og opretter en service_manager_scans-row med scan_type=cron_failure per unikt job. Dedup-vindue: 4 timer (forhindrer spam fra persistent-fejlet cron). Migration 050 tilføjer cron_failure + infra_down til CHECK-constraint på scan_type. \n\nResterende (separat ticket anbefalet):\n• Trigger 2 (infra_down) kræver 2-konsekutive-failure tracking state i probe-pipelinen — ikke self-contained nok til denne commit.\n• Agent-klassifikation (kodefix vs infra-action) — bør wires ind i proposeFixWithClaude når vi har set første cron_failure-scans i produktion.\n• Auto-apply for approved fixes — anbefales som separat ticket med sikkerhedsgennemgang.\n\nAcceptance delvist opfyldt: cron-der-fejler udløser scan inden for 1 time (ikke 30 min — service-scan kører hver time). Første-failure trigger er konservativ frem for 2-konsekutive (agent kan klassificere som "vent og se" hvis fejlen er transient). Klar til verifikation efter deploy.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-623/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
console.log('BIZZ-623 comment:', r1.status);
// Partial — kommentar kun, ikke transitioned. Brugeren afgør om partial er
// acceptabelt eller om Trigger 2 + agent-klassifikation skal implementeres
// før ticket kan lukkes.
