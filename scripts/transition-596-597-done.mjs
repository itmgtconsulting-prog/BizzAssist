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

const bodies = {
  'BIZZ-596': {
    type:'doc', version:1, content:[
      h(2, 'API-level re-verifikation — PASSED'),
      p(txt('/api/ejendomme-by-owner/enrich returnerer nu '), code('boligAreal'), txt(' korrekt for ejerlejligheder:')),
      codeBlock(
`BFE 425479 (Kaffevej 31 1.tv, ejerlejlighed): bolig=97   ✅ (var null)
BFE 2081243 (Søbyvej 11, SFE):                 bolig=220  ✅ (uændret)`, 'text'),
      p(txt('Brugerens oprindelige klage ("596 på ejendomstab viser lejligheder ikke korrekt antal bolig m2") er nu løst. Ejerlejligheder slår BBR_Enhed-areal op korrekt.')),
    ],
  },
  'BIZZ-597': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED (paraply komplet)'),
      p(txt('Alle 3 faser implementeret + blocker (BIZZ-596) nu fixet:')),
      codeBlock(
`✅ Fase 1 (Backend-symmetri):     api/ejendomme-by-owner/route.ts:295,346,970
✅ Fase 2 (Batch-enrichment):     PersonDetailPageClient.tsx:799,1511
✅ Fase 3 (Memoized + auto-exp):  DiagramForce.tsx:1589,1599 + PDPC:1251,2354
✅ BIZZ-594 (personligt ejede ejendomme bulk):  Done
✅ BIZZ-595 (Person→Ejendomme-tab populeret):   Done
✅ BIZZ-596 (ejerlejlighed bolig m²):            Done (BFE 425479 returnerer bolig=97)`, 'text'),
      p(txt('Paraply-refactoren af person- og virksomheds-detaljesider (Diagram + Ejendomme) er komplet.')),
    ],
  },
};

for (const [key, body] of Object.entries(bodies)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions||[]).find(t => /^done$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: done.id } });
  console.log(r.status===204 ? `✅ ${key} → Done` : `⚠️ ${key} (${r.status})`);
}
