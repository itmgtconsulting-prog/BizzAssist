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

const bodies = {
  'BIZZ-625': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Nyt route + client leveret:')),
      ul(
        li(p(code('app/dashboard/admin/ops/page.tsx'), txt(' — "BIZZ-625: Unified Operations Dashboard — /dashboard/admin/ops"'))),
        li(p(code('app/dashboard/admin/ops/OpsDashboardClient.tsx'), txt(' — client component der konsoliderer Service Management + Service Manager + Cron Status med eksplicit BIZZ-625 accept-criteria-reference'))),
      ),
      h(3, 'Caveat'),
      p(txt('Underliggende '), code('/api/admin/cron-status'), txt(' returnerer pt. HTTP 500 (BIZZ-621 sendt tilbage til To Do). Dashboard-siden eksisterer og konsoliderer UI-delene, men cron-sektionen vil vise fejl indtil BIZZ-621 er fikset. Acceptance for '), code('BIZZ-625'), txt(' er dog "konsolidér i én admin-side" — det er på plads.')),
    ],
  },
  'BIZZ-607': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Begge dele af fixet implementeret:')),
      ul(
        li(p(strong('Fra ejerlejligheds-side → hovedejendom: '), code('EjendomDetaljeClient.tsx:2188-2193'), txt(' har knap "Gå til hovedejendom" / "Go to main property" der viser BFE'))),
        li(p(strong('Fra diagram/ejendomstab → ejerlejlighedens BFE: '), code('EjendomDetaljeClient.tsx:1208-1215'), txt(' + 3971 + 6928 — bruger '), code('bbrData.ejerlejlighedBfe ?? ejendomsrelationer[0].bfeNummer'), txt(' som primær BFE-identifier i stedet for hovedejendommens BFE'))),
        li(p(code('app/api/ejendomme-by-owner/enrich/route.ts:173'), txt(' — "intra-koncern-overdragelser og nye ejerlejlighed-BFE\'er"'))),
      ),
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
