#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});r.on('error',rej);if(d)r.write(d);r.end()});}

const p = (...c) => ({ type:'paragraph', content:c });
const txt = (t,m) => m?{type:'text',text:t,marks:m}:{type:'text',text:t};
const strong = (s) => txt(s,[{type:'strong'}]);
const code = (s) => txt(s,[{type:'code'}]);
const h = (l,t) => ({type:'heading',attrs:{level:l},content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});
const cb = (s, lang='sql') => ({type:'codeBlock',attrs:{language:lang},content:[{type:'text',text:s}]});

const description = {
  type:'doc', version:1, content:[
    h(2, 'Baggrund'),
    p(txt('Initial backfill af '),code('public.ejf_ejerskab'),txt(' er komplet på prod 2026-04-20 (7.6M rows, 2.57M unique BFE, 3.64M unique ejere — via engangs test→prod copy). Snapshot dækker data per 2026-04-19. For at holde prod frisk med nye ejerskifter mangler vi en '),strong('daglig incremental delta-sync cron'),txt('.')),
    p(strong('Arkitektur-beslutning: '),txt('Tinglysning '),code('/tinglysningsobjekter/aendringer'),txt('-endpoint er valgt som delta-kilde fremfor Datafordeler Hændelsesbesked (BIZZ-613 parkeret pga. ekstra abonnement + duplikater). ADR 0004 dokumenterer e-TL event-feed evaluering.')),
    h(2, 'Design'),
    p(strong('Rullende 5-dages vindue dagligt. '),txt('Hver cron-run henter aendringer fra (now - 5 dage) til now. Hvis cron fejler 1-4 dage i træk, fanger næste successfulde run op automatisk uden manuel intervention. Overlap giver idempotent upsert — composite PK '),code('(bfe_nummer, ejer_ejf_id, virkning_fra)'),txt(' sikrer ingen duplikater.')),
    cb(`[Dagligt cron — fx 03:15 UTC]
  ↓
1. Beregn fraDate = now - 5 days, tilDate = now
2. POST /tinglysning/ssl/tinglysningsobjekter/aendringer
   { bog: 'EJENDOM', datoFra: <fraDate>, datoTil: <tilDate>, fraSide: 1 }
3. Hent liste af AendretTinglysningsobjekt[] — paginér via fraSide++
4. For hver unique BFE:
     → Kald EJFCustom_EjerskabBegraenset(bestemtFastEjendomBFENr: BFE)
     → Map nodes → ejf_ejerskab rows
     → Upsert batch (ON CONFLICT DO UPDATE)
5. Log til ejf_ingest_runs med sync_type='tl_delta'
6. Gem last_run_at til tinglysning_aendring_cursor (til monitorering)`, 'text'),
    p(strong('Volumen-estimat: '),txt('Tinglysning viste ~100 BFE-ændringer/døgn i probe. 5-dages vindue = ~500 unique BFE per run. 500 × ~300ms GraphQL-call = ~2.5 min. Vercel '),code('maxDuration = 300'),txt(' giver os god margin. Ved mere trafik kan vi gå til 3-dages vindue.')),
    h(2, 'Leverancer'),
    ul(
      li(p(strong('Migration: '),code('053_tinglysning_aendring_cursor.sql'),txt(' — singleton-tabel med last_run_at, last_from_date, last_to_date, rows_processed, error. Mønster kopieret fra '),code('bbr_event_cursor'),txt('.'))),
      li(p(strong('Helper-lib: '),code('app/lib/ejfIngest.ts'),txt(' — factor '),code('fetchEjerskabForBFE(bfe)'),txt(' + '),code('upsertEjfRows(rows)'),txt(' ud fra eksisterende '),code('ingest-ejf-bulk'),txt(' så begge crons deler upsert-logic (composite PK, type-mapping).'))),
      li(p(strong('Cron-route: '),code('app/api/cron/pull-tinglysning-aendringer/route.ts'),txt(' — wrappet i '),code('withCronMonitor'),txt(' (heartbeat + Sentry checkin). Bruger '),code('tlPost'),txt(' til aendringer-endpoint + '),code('fetchEjerskabForBFE'),txt(' til EJF-opslag per BFE.'))),
      li(p(strong('vercel.json: '),txt('cron-entry '),code('{ "path": "/api/cron/pull-tinglysning-aendringer", "schedule": "15 3 * * *" }'),txt(' — dagligt 03:15 UTC, før andre daglige jobs.'))),
      li(p(strong('cron-status dashboard: '),txt('ny entry i '),code('CRONS[]'),txt('-listen så watchdog detekterer overdue.'))),
      li(p(strong('Unit-tests: '),txt('mock Tinglysning + EJFCustom responses. Verify 5-day window beregning, BFE dedup, idempotent upsert, error-paths.'))),
      li(p(strong('Monitoring (add-on til service-scan): '),txt('alert hvis '),code('tinglysning_aendring_cursor.last_run_at'),txt(' er > 24t gammel — samme pattern som '),code('checkEjfIngestHealthAndCreateScans'),txt('.'))),
    ),
    h(2, 'Acceptance criteria'),
    ul(
      li(p(code('/api/cron/pull-tinglysning-aendringer'),txt(' kan trigges manuelt med CRON_SECRET og returnerer '),code('{ ok: true, bfesProcessed: <n>, rowsUpserted: <n> }'))),
      li(p(code('ejf_ejerskab.max(sidst_opdateret)'),txt(' på prod er < 48t gammel efter 1-2 cron-kørsler'))),
      li(p(txt('Cron-failure i 1-4 dage → næste run fanger automatisk op (5-day overlap)'))),
      li(p(txt('Ingen nye duplikater i '),code('ejf_ejerskab'),txt(' efter 10+ cron-kørsler (composite PK respekteres)'))),
      li(p(txt('Cron-status-dashboard viser '),code('pull-tinglysning-aendringer'),txt(' som "ok" med forventet interval 24t'))),
      li(p(txt('Unit-tests grønne (minimum 5 tests dækkende window-beregning, dedup, upsert, error, cursor-update)'))),
    ),
    h(2, 'Risici + afbødning'),
    ul(
      li(p(strong('Tinglysning API-timeouts: '),txt('Hetzner proxy er etableret + tlPost har eksisterende timeout-handling. Worst-case: partial upsert, næste dag fanger op.'))),
      li(p(strong('EJFCustom rate-limits: '),txt('500 calls per run i ~2.5 min = 3.3/s. Vel inden for Datafordeler\'s limits (var før hit 10/s ved bulk-ingest).'))),
      li(p(strong('Nye BFE\'er uden initial backfill: '),txt('ikke problem — upsert inserter nye rækker hvis '),code('bfe_nummer'),txt(' ikke eksisterer.'))),
      li(p(strong('Window for kort: '),txt('Hvis cron fejler > 5 dage, mister vi data. Mitigeret af: (a) Sentry cron-monitor alert, (b) service-scan checker cursor-age > 24t, (c) manuel kørsel kan altid bruge custom interval via query-param.'))),
    ),
    h(2, 'Relaterede tickets'),
    ul(
      li(p(code('BIZZ-534'),txt(' — P1 story for EJF bulk-ingestion (initial backfill nu komplet på prod via test→prod copy)'))),
      li(p(code('BIZZ-524'),txt(' — '),code('/api/tinglysning/aendringer'),txt(' on-demand endpoint (Done, genbruges)'))),
      li(p(code('BIZZ-613'),txt(' — Datafordeler Hændelsesbesked delta (Done/parked, denne ticket er erstatningen)'))),
      li(p(code('BIZZ-615'),txt(' — e-TL event-feed evaluation (Done, ADR 0004 underbygger design)'))),
      li(p(code('BIZZ-612'),txt(' — Mode A Filudtræk (kan nedprioriteres — delta-sync dækker ~99% af ejerskifter; Filudtræk kun nødvendig som ugentlig reconciliation)'))),
    ),
  ],
};

const issue = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: 'BIZZ' },
    summary: 'Tinglysning delta-sync cron — dagligt 5-day rolling window på aendringer-endpoint',
    description,
    issuetype: { name: 'Task' },
    priority: { name: 'High' },
    labels: ['ejf', 'tinglysning', 'cron', 'delta-sync', 'backend'],
  },
});
const parsed = JSON.parse(issue.body);
if (issue.status === 201) {
  console.log(`✅ Created ${parsed.key}`);
  console.log(`   https://${process.env.JIRA_HOST}/browse/${parsed.key}`);
} else {
  console.log(`❌ (${issue.status})`, parsed);
}
