const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const tickets = [
  {
    key: 'BIZZ-611',
    text: "Kode-side er fuldt færdig — resterende er rene admin/ops-opgaver:\n\nKode på plads:\n✅ Cron /api/cron/ingest-ejf-bulk wired op (vercel.json har '0 4 * * *').\n✅ withCronMonitor wrapper (Sentry cron-monitor + heartbeat-persistence).\n✅ Migration 046_ejf_ejerskab_bulk.sql ligger klar i supabase/migrations/.\n✅ BIZZ-623 auto-detect: cron_heartbeats-fejl udløser nu automatisk en service_manager_scans-row (commit fc0343b) så admin bliver notificeret hvis ingest fejler eller udebliver.\n✅ Sentry cron-monitor alerter via withCronMonitor hvis check-in mangler (schedule: '0 4 * * *', maxRuntime: 10 min).\n\nAdmin-/ops-opgaver tilbage (kræver login):\n1. Merge develop → main\n2. Verificér cron-job vises i Vercel UI → Settings → Cron Jobs\n3. Kør migration 046 mod prod-Supabase (via Supabase Studio eller CLI)\n4. Sæt env vars i Vercel production: DATAFORDELER_OAUTH_CLIENT_ID/_SECRET + CRON_SECRET + SUPABASE_SERVICE_ROLE_KEY\n5. Manuel første-trigger: curl -H 'Authorization: Bearer \\$CRON_SECRET' -H 'x-vercel-cron: 1' https://bizzassist.dk/api/cron/ingest-ejf-bulk\n6. Observer første row i public.ejf_ingest_runs\n\nDokumentér ressource-forbrug + runtime efter første uge. Hvis Mode B (GraphQL pagination) tager for lang tid, se BIZZ-612 for Mode A (Filudtræk).",
  },
  {
    key: 'BIZZ-612',
    text: "Kode-side understøtter allerede Mode A — resterende er 100% ops/procurement:\n\nKode på plads:\n✅ app/api/cron/ingest-ejf-bulk/route.ts har ingestFromBulkFile() der streamer fra EJF_BULK_DUMP_URL hvis env var er sat (Mode A). Uden env var falder den tilbage til Mode B (GraphQL pagination).\n✅ NDJSON-parser implementeret med line-by-line streaming (undgår OOM på 2–4 GB gzip).\n✅ RawEjfNode-interfacet matcher Datafordeler's flade JSON-format (ejendePersonBegraenset + ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref.CVRNummer).\n\nAdmin-/ops-opgaver tilbage (kræver selvbetjening.datafordeler.dk-login):\n1. Log ind på selvbetjening.datafordeler.dk med vores Datafordeler-bruger\n2. Find URL til 'EJF Totaludtræk Flad Prædefineret JSON' i katalog\n3. Whitelist domains på Hetzner-proxy: dataudtraek.datafordeler.dk + selvbetjening.datafordeler.dk (pt. kun services. + graphql. er åbnet)\n4. Sæt EJF_BULK_DUMP_URL i Vercel production env\n5. Manuel trigger: observer at rows_processed > 1 M efter én kørsel uden cursor-resume\n\nHvis JSON-filformatet afviger fra det nuværende GraphQL-shape, tilpas mapNodeToRow() i route.ts — men RawEjfNode-interfacet er designet til at matche Datafordeler's officielle flade JSON per dokumentation.\n\nKan ikke løses fra udvikler-side alene. Ticket bør køre videre med admin tildelt.",
  },
];

for (const t of tickets) {
  const comment = {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t.text }] }],
    },
  };
  const r1 = await fetch('https://' + host + '/rest/api/3/issue/' + t.key + '/comment', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(comment),
  });
  console.log(t.key, 'comment:', r1.status);
}
