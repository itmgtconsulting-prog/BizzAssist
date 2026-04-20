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
    h(2, 'Code-level re-verifikation — DELVIST, sender til To Do'),
    p(txt('Paraply-refactor er '), strong('delvist'), txt(' implementeret via 3 faser med eksplicit BIZZ-597-kommentarer i koden:')),
    ul(
      li(p(strong('✅ Fase 1 (Backend-symmetri): '), code('api/ejendomme-by-owner/route.ts:295, 346, 970'), txt(' — person-query returnerer nu ejerandel-brøk symmetrisk med CVR-pathen.'))),
      li(p(strong('✅ Fase 2 (Batch-enrichment): '), code('PersonDetailPageClient.tsx:799, 1511'), txt(' — pre-enriched data per BFE fra batch-endpoint.'))),
      li(p(strong('✅ Fase 3 (Memoized diagram + auto-expand): '), code('DiagramForce.tsx:1589, 1599'), txt(' + '), code('PersonDetailPageClient.tsx:1251, 2354'), txt(' — memoized person-diagram-graf + auto-expand af root person-node.'))),
    ),
    p(strong('❌ Blocker: BIZZ-596 ikke fixet'), txt(' — ejerlejligheders boligareal returnerer stadig '), code('null'), txt(' fra '), code('/api/ejendomme-by-owner/enrich'), txt('. Paraply-ticketen siger explicit "dækker den samlede refactor der løser BIZZ-594, BIZZ-595 og BIZZ-596 på én gang".')),
    p(strong('Sender til To Do. '), txt('Kan transition til Done når BIZZ-596 er løst (ejerlejlighed BBR_Enhed-lookup i enrich-route).')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-597/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-597/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-597/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-597 → To Do':`⚠️ (${r.status})`);
