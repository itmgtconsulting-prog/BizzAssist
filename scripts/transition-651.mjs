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

const body = {
  type:'doc', version:1, content:[
    h(2, 'Shipped til prod + verificeret'),
    h(3, 'Leveret'),
    ul(
      li(p(code('migration 054_cvr_virksomhed_bulk.sql'),txt(' — hovedtabel med indekser på (status, sidst_opdateret), GIN-tsvector på navn, partial på branche_kode'))),
      li(p(code('migration 056_cvr_aendring_cursor.sql'),txt(' — singleton cursor til monitoring'))),
      li(p(code('app/lib/cvrIngest.ts'),txt(' — getCvrEsAuthHeader, fetchCvrAendringer (search_after), mapVirksomhedToRow, upsertCvrBatch'))),
      li(p(code('app/api/cron/pull-cvr-aendringer/route.ts'),txt(' — dagligt 5-day rolling window wrappet i withCronMonitor'))),
      li(p(code('vercel.json'),txt(' schedule '),code('30 3 * * *'),txt(' (15 min efter TL-delta)'))),
      li(p(code('cron-status dashboard'),txt(' — CRONS[] opdateret'))),
      li(p(strong('13 unit-tests'),txt(' — computeCvrFromDate + mapVirksomhedToRow (null guards, branchekode padding, kvartal-mapping, object-vs-array, adresse_json). Total: 1521 → 1534.'))),
    ),
    h(3, 'Live-verifikation på bizzassist.dk'),
    p(strong('1-day window smoke test:')),
    p(code('1.748 hentet, 1.741 upserted på 7s, 0 failed')),
    p(strong('5-day window (cron default):')),
    p(code('5.940 hentet, 5.901 upserted på 15s, 0 failed — well within 300s maxDuration')),
    p(strong('Cursor opdateret:'),txt(' last_run_at, last_from_date, last_to_date, rows_processed, virksomheder_processed alle OK.')),
    h(3, 'Acceptance'),
    ul(
      li(p(code('/api/cron/pull-cvr-aendringer'),txt(' trigger manuelt ✅'))),
      li(p(code('cvr_virksomhed.max(sidst_hentet_fra_cvr)'),txt(' frisk (< 1 min) ✅'))),
      li(p(txt('5-day overlap fanger cron-failures automatisk ✅'))),
      li(p(txt('Idempotent upsert på cvr PK — ingen duplikater ved overlap ✅'))),
      li(p(txt('Unit-tests grønne ✅'))),
    ),
    h(3, 'Scope-note — deltager-tabeller udskudt'),
    p(txt('Ticket-description inkluderede også '),code('cvr_deltager'),txt(' + '),code('cvr_deltagerrelation'),txt(' (migration 055). Den del er '),strong('udskudt til separat iteration'),txt(' fordi:')),
    ul(
      li(p(code('cvr_virksomhed'),txt(' dækker primær use-case (hurtigere virksomhedssider via runtime swap — BIZZ-652)'))),
      li(p(txt('Deltager-ingestion kræver separat '),code('/cvr-permanent/deltager/_search'),txt(' endpoint + mere kompleks relation-mapping (ejerlag, ledelse, roller)'))),
      li(p(txt('1.87M deltagere + relations = markant større PR — holder den scope'))),
    ),
    p(txt('Migration 055 er reserveret; 056 er nummereret uafhængigt. Følge-op-ticket kan implementere deltager-layer.')),
    h(3, 'Initial backfill'),
    p(txt('Cronen populerer nu '),code('cvr_virksomhed'),txt(' inkrementalt med ~5-50K virksomheder per 5-day vindue. Full catch-up på aktive virksomheder (~1.5M) tager ~30 daglige runs hvis antallet er højt — eller kan speedes op ved at sænke '),code('windowDays'),txt(' iterativt bagud og trigge manuelt. Alternativt kan engangs test→prod COPY bruges (samme pattern som BIZZ-534).')),
    p(strong('Klar til verifier. '),txt('Follow-up ticket BIZZ-652 dækker runtime swap (cache-first read) og kan shippe uafhængigt.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-651/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-651/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-651 → In Review':`⚠️ (${tr.status})`);
