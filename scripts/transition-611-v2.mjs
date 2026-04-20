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
    h(2, 'Monitorering-delen shippet (commit 4bb30eb)'),
    p(txt('Acceptance-item "Sentry cron-monitor + alert hvis ejf_ingest_runs.finished_at IS NULL efter 24t eller rows_processed < 100" er nu implementeret.')),
    h(3, 'Delivered'),
    ul(
      li(p(strong('Sentry cron-monitor: '),txt('allerede på plads via '),code('withCronMonitor()'),txt(' wrapper (BIZZ-624 + BIZZ-621) — auto check-in hver kørsel + alert ved missed/failed.'))),
      li(p(strong('Alerting via service-scan: '),txt('den hourly '),code('service-scan'),txt('-cron tjekker nu '),code('public.ejf_ingest_runs'),txt(' og opretter '),code('service_manager_scans'),txt(' med '),code('scan_type=cron_failure'),txt(' hvis:'))),
      li(p(code('stuck'),txt(': seneste række har '),code('finished_at IS NULL'),txt(' og er > 24t gammel'))),
      li(p(code('low_volume'),txt(': seneste successful run processede < 100 rækker (forventet millioner)'))),
      li(p(strong('Dedup: '),txt('4-timers vindue per reason-type forhindrer spam ved persistent fejl'))),
      li(p(strong('Unit-tests: '),txt('8 tests dækker detection-logikken inkl. edge cases (stuck+low kombineret, null rows_processed, errored runs)'))),
    ),
    h(3, 'Remaining — kræver brugerindgriben'),
    ul(
      li(p(txt('Merge develop → main (prod-deploy)'))),
      li(p(txt('Sæt '),code('EJF_BULK_DUMP_URL'),txt(' i Vercel prod env (hentes fra selvbetjening.datafordeler.dk — se BIZZ-612)'))),
      li(p(txt('Whitelist '),code('dataudtraek.datafordeler.dk'),txt(' i bizzassist proxy (ops-opgave)'))),
      li(p(txt('Manuel trigger første backfill-run via '),code('curl -H "Authorization: Bearer $CRON_SECRET" https://bizzassist.dk/api/cron/ingest-ejf-bulk'))),
    ),
    p(strong('Verifier: '),txt('monitoring-kode-delen er klar — de tre ops-skridt er brugeraktioner og kan ikke automatiseres. Anbefales at lukke denne ticket som In Progress (monitoring done) + oprette separat ops-ticket for prod-activation.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-611/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-611/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-611 → In Review':`⚠️ (${tr.status})`);
