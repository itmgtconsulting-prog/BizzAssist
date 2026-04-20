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
    h(2, 'Code-level verifikation — PASSED'),
    ul(
      li(p(strong('✅ Cron aktiveret i prod: '), code('vercel.json'), txt(' — '), code('"path": "/api/cron/ingest-ejf-bulk", "schedule": "0 4 * * *"'), txt(' (dagligt kl. 04:00 UTC).'))),
      li(p(strong('✅ Monitorering implementeret: '), code('service-scan/route.ts:1106-1219'), txt(' — '), code('checkEjfIngestHealthAndCreateScans()'), txt(' med eksplicit BIZZ-611-reference.'))),
      li(p(strong('Health-checks:'))),
      li(p(txt('• Stuck run: '), code('finished_at=NULL && started_at > 24t'), txt(' → opretter '), code('cron_failure'), txt('-scan.'))),
      li(p(txt('• Suspicious low volume: '), code('finished_at != NULL && rows_processed < 100'), txt(' → opretter '), code('cron_failure'), txt('-scan.'))),
      li(p(strong('✅ Integration med Service Manager: '), txt('Scans oprettes med '), code("scan_type='cron_failure'"), txt(' (BIZZ-623) så agenten kan klassificere + foreslå fix.'))),
      li(p(strong('Commit-historie: '), code('4bb30eb feat(service-scan): detect stuck or low-volume ejf bulk-ingest runs'), txt('.'))),
    ),
    p(txt('Acceptance: aktivér i produktion ✅, tilføj monitorering ✅. Første backfill-verifikation skal ses i produktionens '), code('ejf_ingest_runs'), txt(' efter første cron-kørsel.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-611/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-611/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-611/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-611 → Done':`⚠️ (${r.status})`);
