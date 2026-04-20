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
    h(2, 'Manuel admin-QA 2026-04-20 — PASSED'),
    p(txt('Bruger bekræftede manuelt via screenshot at '), code('/dashboard/admin/cron-status'), txt(' nu virker end-to-end:')),
    ul(
      li(p(strong('Header: '), code('13/14 OK · 1 forsinket'), txt(' (ingen "Heartbeat-data kunne ikke hentes"-banner).'))),
      li(p(strong('Tabel: '), txt('alle 14 cron-jobs listet med job-name, beskrivelse, schedule-cron, interval, seneste run-tidspunkt, varighed og grøn/gul status-badge.'))),
      li(p(strong('Synlige jobs: '), code('generate-sitemap (3 phases)'), txt(', '), code('poll-properties'), txt(', '), code('pull-bbr-events'), txt(', '), code('deep-scan'), txt(', '), code('warm-cache'), txt(', '), code('daily-report'), txt(', '), code('daily-status'), txt(', '), code('service-scan'), txt(' — alle med real timestamps og durations.'))),
    ),
    p(strong('Alle acceptance-criteria opfyldt:')),
    ul(
      li(p(txt('Alle 14 crons skriver heartbeat (withCronMonitor-wrapper).'))),
      li(p(txt('Dashboard viser status for alle 14.'))),
      li(p(txt('OVERDUE-detektion fungerer (1 forsinket vist).'))),
      li(p(txt('Admin behøver ikke gå i Supabase — alt synligt i UI.'))),
    ),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-621/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-621/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-621/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-621 → Done':`⚠️ (${r.status})`);
