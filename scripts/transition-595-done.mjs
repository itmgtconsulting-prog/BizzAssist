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
    h(2, 'Manuel browser-verifikation — PASSED'),
    p(txt('Bruger bekræftede manuelt: "595 er fin" — Jakobs 9 personligt ejede ejendomme '), strong('er nu synlige'), txt(' på Person→Ejendomme-tab ('), code('/dashboard/owners/4000115446'), txt(').')),
    p(txt('Follow-up polish (separat): bruger vil gerne have de 9 ejendomme på egne linjer så de ikke ligger sammen med selskaber. Det hører til BIZZ-596 (alignment med virksomhedsfane) eller en ny layout-polish-ticket — ikke denne ticket, som er Done.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-595/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-595/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-595/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-595 → Done':`⚠️ (${r.status})`);
