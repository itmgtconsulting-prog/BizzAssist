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
    h(2, 'API-level re-verifikation 2026-04-20 — FEJLET ANDEN GANG'),
    p(txt('Re-testet '), code('/api/salgshistorik?bfeNummer=X'), txt(' efter fix-forsøg. Bug er '), strong('ikke'), txt(' fixet — endpointet returnerer stadig 0 handler med fejl '), code('"EJF_Ejerskifte query fejlede"'), txt(' på alle 3 testede BFE\'er:')),
    codeBlock(
`GET /api/salgshistorik?bfeNummer=425479 (Kaffevej 31 1.tv):
  handler.length: 0, fejl: "EJF_Ejerskifte query fejlede"

GET /api/salgshistorik?bfeNummer=226629 (Arnold Nielsens Blvd 62B):
  handler.length: 0, fejl: "EJF_Ejerskifte query fejlede"

GET /api/salgshistorik?bfeNummer=100165718 (Thorvald Bindesbølls Plads 18):
  handler.length: 0, fejl: "EJF_Ejerskifte query fejlede"`, 'text'),
    h(3, 'Root cause står uændret'),
    p(txt('Per '), strong('BIZZ-584'), txt(' har vi ikke adgang til '), code('EJF_Ejerskifte'), txt(' direkte — kun '), code('EJFCustom_EjerskabBegraenset'), txt(' via flexibleCurrent. Fixet skal skifte primær-kilden til '), code('EJFCustom_EjerskabBegraenset'), txt(' (eller tinglysning-adkomster) — ikke fortsætte med at kalde den utilgængelige '), code('EJF_Ejerskifte'), txt('.')),
    p(strong('Sender tilbage til To Do igen. '), txt('Næste fix-forsøg: verificér via '), code('curl /api/salgshistorik?bfeNummer=425479'), txt(' — skal returnere minst 2 handler (ingen '), code('EJF_Ejerskifte'), txt('-fejl) før ticket er Done.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-633/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-633/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-633/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-633 → To Do (anden gang)':`⚠️ (${r.status})`);
