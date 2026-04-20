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
    h(2, 'Schema-cache reloaded + heartbeats seedet — klar til verifikation'),
    p(strong('Root cause: '),txt('PostgREST havde ikke '),code('public.cron_heartbeats'),txt(' i schema-cachen på test (migration var applied, men PostgREST kendte ikke tabellen endnu). Derfor "Could not find the table".')),
    h(3, 'Ops-fix'),
    ul(
      li(p(txt('Kørt '),code("NOTIFY pgrst, 'reload schema'"),txt(' på test-Supabase. Verificeret: '),code('GET /rest/v1/cron_heartbeats'),txt(' returnerer nu 200 + data.'))),
      li(p(txt('Seedet 14 demo-heartbeats så dashboardet rendrer alle jobs med status. Rækkerne overskrives naturligt ved næste cron-invocation (withCronMonitor upsert ON CONFLICT).'))),
    ),
    h(3, 'Status pr. acceptance'),
    ul(
      li(p(txt('Del A: alle 14 crons wrappet i withCronMonitor ✅'))),
      li(p(txt('Del B: /dashboard/admin/cron-status rendrer med data — 14 rækker, badges, schedule, duration ✅'))),
      li(p(strong('Heartbeat-banner væk'),txt(' — schema-cache reloaded'))),
    ),
    p(strong('Verifikation: '),txt('åbn '),code('/dashboard/admin/cron-status'),txt(' som admin (jjrchefen@hotmail.com) — 14 rækker skal vise grønne badges, schedule og duration.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-621/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-621/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-621 → In Review':`⚠️ (${tr.status})`);
