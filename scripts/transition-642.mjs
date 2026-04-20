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
      li(p(code('AIChatPanel.tsx:366-369'), txt(' — 402-handler: '), code("if (res.status === 402 && err.code === 'trial_ai_blocked')"), txt(' sætter dedikeret trial-gate state.'))),
      li(p(code('AIChatPanel.tsx:632-633'), txt(' — dedikeret banner rendering: "402 trial_ai_blocked. Dedikeret CTA lader brugeren købe en [token-pakke]".'))),
      li(p(code('AIChatPanel.tsx:669'), txt(' — top-up-balance display når bruger har købt token-pakke.'))),
      li(p(code('app/lib/translations.ts:271 (DA)'), txt(' + '), code(':869 (EN)'), txt(' — bilingual trial-gate strings.'))),
    ),
    p(txt('Acceptance-criteria opfyldt: 402 trial_ai_blocked viser dedikeret banner med CTA i stedet for generic error-toast, bilingual, top-up-balance synlig.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-642/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-642/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-642/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-642 → Done':`⚠️ (${r.status})`);
