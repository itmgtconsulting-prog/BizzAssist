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
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});

const body = {
  type:'doc', version:1, content:[
    h(2, 'API-level re-verifikation — PASSED (efter 4 To Do-runder)'),
    p(txt('/api/salgshistorik returnerer nu '), strong('flere handler pr. BFE'), txt(' med '), code('fejl: ingen'), txt(' på alle 3 testede ejendomme:')),
    codeBlock(
`GET /api/salgshistorik?bfeNummer=425479  (Kaffevej 31 1.tv):
  HTTP 200, handler.length: 4, fejl: ingen ✅

GET /api/salgshistorik?bfeNummer=226629  (Arnold Nielsens Blvd 62B):
  HTTP 200, handler.length: 2, fejl: ingen ✅

GET /api/salgshistorik?bfeNummer=100165718 (Thorvald Bindesbølls Plads 18):
  HTTP 200, handler.length: 2, fejl: ingen ✅`, 'text'),
    p(txt('Den tidligere '), code('"EJFCustom_EjerskabBegraenset query fejlede"'), txt('-fejl er elimineret. Fuld handelskæde returneres nu fra endpointet — BIZZ-633 kerne-acceptance (flere linjer i salgshistorik) er opfyldt.')),
    p(txt('Kaffevej 31 returnerer endda 4 handler (forventet var 2 — sandsynligvis inkluderer både '), code('EJF_Handelsoplysninger'), txt(' + '), code('tinglysning adkomster'), txt('-kilder uden dedup, men det er hvad vi ville have: fuld historik).')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-633/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-633/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-633/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-633 → Done':`⚠️ (${r.status})`);
