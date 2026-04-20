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
  'BIZZ-636': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Ny migration leveret: '), code('supabase/migrations/049_plan_configs_admin_write_rls.sql'), txt(' — opretter policy '), code('plan_configs_admin_write'), txt(' der tilføjer INSERT/UPDATE/DELETE for service_role + authenticated super-admin.')),
      p(txt('Root cause fra original-ticketen (RLS aktiv men kun SELECT-policy) er adresseret direkte. '), code('/api/admin/plans'), txt(' POST skulle nu kunne oprette plans uden "Internal server error".')),
    ],
  },
  'BIZZ-635': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Duplikerede spinners fjernet i '), code('VirksomhedDetaljeClient.tsx'), txt(':')),
      ul(
        li(p(code('linje 2440'), txt(': "BIZZ-617 + BIZZ-635: ÉN tab-level loading spinner"'))),
        li(p(code('linje 2451'), txt(': "BIZZ-635: Fjernet intern \'Indledende spinner\' — den ydre dækker"'))),
      ),
      p(txt('Kun én '), code('TabLoadingSpinner'), txt(' med '), code('loadingEjendomsportefoelje'), txt(' vises nu på tab-niveau i stedet for 3 stablet oven på hinanden.')),
    ],
  },
  'BIZZ-637': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Fix implementeret i '), code('app/lib/fetchBbrData.ts'), txt(':')),
      ul(
        li(p(code('linje 697'), txt(': "BIZZ-637: For ejerlejligheder er dawaId et adresse-UUID (med etage/dør)" — dedikeret ejerlejlighed-handling.'))),
        li(p(code('linje 743'), txt(': "bygnings-areal-tal. Regression ift. BIZZ-637" — separerer BBR Enhed-areal fra BBR Bygning-areal for ejerlejligheder.'))),
      ),
      p(txt('Ejerlejligheder slår nu korrekt op via BBR_Enhed (specifik lejlighed) i stedet for BBR Bygning (hele hovedejendommen).')),
    ],
  },
  'BIZZ-638': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Fix implementeret i '), code('PersonDetailPageClient.tsx:1520'), txt(': "BIZZ-638: Enrich BÅDE virksomhedsejede (ejendommeData) OG personligt [ejede]".')),
      p(txt('Progressive enrich-flowet dækker nu begge data-kilder: BFE\'er fra CVR-opslag + BFE\'er fra bulk-seedet '), code('ejf_ejerskab'), txt('. Personligt ejede ejendoms-kort skulle nu loade Bolig/Erhv/Matr/Grundv/Købt-felter i samme tempo som virksomhedsejede.')),
    ],
  },
  'BIZZ-639': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Fix implementeret i '), code('VirksomhedDetaljeClient.tsx:2487'), txt(' med eksplicit BIZZ-639 kommentar: "Overskriften skal vise både aktive og historiske". Aktiv-tallet + historisk-tallet rendres nu i tab-overskriften.')),
    ],
  },
};

for (const [key, body] of Object.entries(bodies)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} comment (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions||[]).find(t => /^done$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: done.id } });
  console.log(r.status===204 ? `✅ ${key} → Done` : `⚠️ ${key} (${r.status})`);
}
