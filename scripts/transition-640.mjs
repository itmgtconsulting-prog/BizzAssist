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
    h(2, 'Code-level verifikation — PASSED'),
    p(txt('Fix implementeret i '), code('PersonDetailPageClient.tsx:2455-2479'), txt(' med eksplicit "BIZZ-639 + BIZZ-640"-kommentar. Tælle-logikken dedupper BFE\'er via Map på tværs af '), code('ejendommeData'), txt(' (virksomhedsejede) + '), code('personalBfes'), txt(' (personligt ejede), så Jakobs 12 + 9 = 21 aktive + 6 historiske.')),
    p(txt('Konsistent også på header-badge (linje 2031-2036) hvor '), code('totalAktive = aktive + privat'), txt(' giver samme sum.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-640/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-640/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-640/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-640 → Done':`⚠️ (${r.status})`);
