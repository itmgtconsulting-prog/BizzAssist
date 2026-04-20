const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Status 2026-04-20 — kode komplet, venter pa produktions-rollout:\n\nKode-leverancer (alle landet):\n- Migration 046_ejf_ejerskab_bulk.sql (skema med composite primary key + lookup-indekser)\n- Migration 047_ejf_ejerskab_id_text.sql (id-type TEXT fix)\n- Migration 048_ejf_ejerskab_navn_exact_idx.sql (exact-match indeks for hurtigere person-lookup)\n- /api/ejerskab/person-bridge (enhedsNummer -> navn + fodselsdato via hjemadresse)\n- /api/ejerskab/person-properties (navn + fodselsdato -> BFE-liste fra ejf_ejerskab)\n- /api/cron/ingest-ejf-bulk (dagligt 04:00 UTC; Mode A Filudtraek via EJF_BULK_DUMP_URL + Mode B GraphQL pagination fallback)\n- withCronMonitor wrapper (Sentry cron-monitor + heartbeat-persistence)\n- UI wired up i persondiagram + person-Ejendomme-tab til at vise personligt ejede ejendomme\n\nBlokeret af admin/ops:\n- BIZZ-611: Aktiver cron i production + forste backfill-kørsel\n- BIZZ-612: Konfigurer EJF_BULK_DUMP_URL (kraever Datafordeler-login + Hetzner-whitelist)\n\nAnbefaler: Luk BIZZ-534 som Done når BIZZ-611 + BIZZ-612 er verificeret i prod (forste backfill komplet + minst 1 BFE per person i Danmark). Kode-arkitekturen er i ordet klar og deployet til develop.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-534/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
console.log('BIZZ-534 comment:', r.status);
