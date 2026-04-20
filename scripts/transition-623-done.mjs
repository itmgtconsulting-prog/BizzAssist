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
    h(2, 'Code-level re-verifikation — PASSED (begge triggers implementeret)'),
    ul(
      li(p(strong('✅ Trigger 1: Cron-heartbeat-fejl: '), code('service-scan/route.ts:912+949+957'), txt(' — '), code("scan_type='cron_failure'"), txt('-rows oprettes når cron fejler, dedup 4 timer.'))),
      li(p(strong('✅ Trigger 2: Infra_down: '), code('service-scan/route.ts:936+940+945+1254+1257+1266'), txt(' — explicit "BIZZ-623 Trigger 2: infra_down detection". Prober '), code('/api/admin/service-status'), txt(' og opretter '), code("scan_type='infra_down'"), txt('-scan ved 2 konsekutive down-states.'))),
      li(p(strong('✅ Cron-bypass for probe: '), code('service-status/route.ts:181'), txt(' — "BIZZ-623: Cron-bypass for infra_down probe-flowet" så service-scan kan probe services uden admin-auth-loop.'))),
    ),
    p(txt('Begge acceptance-criteria opfyldt: cron-fejl og infra-down events udløser automatisk '), code('service_manager_scans'), txt('-rows som Service Manager-agenten kan klassificere og handle på.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-623/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-623/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-623/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-623 → Done':`⚠️ (${r.status})`);
