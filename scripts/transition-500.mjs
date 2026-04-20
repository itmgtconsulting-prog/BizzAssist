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
      li(p(code('app/api/matrikel/historik/route.ts'), txt(' — ny endpoint med eksplicit BIZZ-500 reference. Bitemporale queries mod MAT/v1 med '), code('virkningstid'), txt('-parametre. Returnerer '), code('MatrikelHistorikResponse'), txt(' med tidslinje-events.'))),
      li(p(code('EjendomDetaljeClient.tsx:3811 + 6693'), txt(' — collapsible "Matrikel-historik"-tidslinje på desktop + mobil.'))),
      li(p(txt('State '), code('matrikelHistorik'), txt(' (linje 953) — "BIZZ-500: Matrikel-historik (udstykninger, sammenlægninger, arealændringer)".'))),
    ),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-500/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-500/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-500/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-500 → Done':`⚠️ (${r.status})`);
