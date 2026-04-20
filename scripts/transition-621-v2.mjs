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

const body = {
  type:'doc', version:1, content:[
    h(2, 'Manuel browser-verifikation — FAILED'),
    p(txt('Bruger bekræftede manuelt at '), code('/dashboard/admin/cron-status'), txt(' renderer tab-shell korrekt, men dataen loader ikke — siden viser '), strong('"HTTP 500"'), txt('-fejl i stedet for cron-listen.')),
    p(txt('Sandsynlig root cause: API-endpointet '), code('/api/admin/cron-status'), txt(' kaster en uhåndteret fejl ved forespørgsel mod '), code('public.cron_heartbeats'), txt('. Tjek server-logs for stack-trace.')),
    h(3, 'Fix-hypoteser'),
    p(txt('• Manglende columns i '), code('cron_heartbeats'), txt(' (fx '), code('expected_interval_minutes'), txt(') efter migration')),
    p(txt('• Forkert Supabase RLS-policy — endpoint kører som admin-user uden service_role-bypass')),
    p(txt('• TypeScript-cast-fejl ved status-beregning (parsing af '), code('last_event_at'), txt(' duration-intervals)')),
    p(strong('Sender til To Do. '), txt('Fix-verifikation: '), code('curl /api/admin/cron-status'), txt(' skal returnere 200 med JSON-liste af 14 cron-jobs før ticket er Done.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-621/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-621/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-621/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-621 → To Do':`⚠️ (${r.status})`);
