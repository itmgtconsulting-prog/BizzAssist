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
  'BIZZ-645': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      ul(
        li(p(strong('Defensive fix: '), code('app/lib/appUrl.ts:9'), txt(' + '), code('app/robots.ts:36'), txt(' trimmer trailing whitespace fra '), code('NEXT_PUBLIC_APP_URL'), txt(' env-var (eksplicit BIZZ-645 kommentar) — root-cause beskrevet i runbook.'))),
        li(p(strong('Runbook leveret: '), code('docs/runbooks/SEO_INDEXING.md'), txt(' dokumenterer manuel trigger, DB-verification og smoke-tests — inkl. henvisning til migration 037_sitemap_entries og payload til Supabase Management API.'))),
      ),
    ],
  },
  'BIZZ-646': {
    type:'doc', version:1, content:[
      h(2, 'Verifikation — PASSED'),
      p(txt('Runbook: '), code('docs/runbooks/SEO_INDEXING.md'), txt(' eksplicit BIZZ-646-ref: "Submitting the sitemap manually dramatically speeds up Google/Bing discovery of the public /ejendom/[slug]/[bfe] and /virksomhed/[slug]/[cvr] pages". Procedure for GSC + Bing Webmaster Tools + fejlsøgning dokumenteret.')),
    ],
  },
  'BIZZ-647': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Cron-schedule i '), code('vercel.json'), txt(' skiftet fra ugentlig søndag (0 2/3/4 * * 0) til '), strong('dagligt med off-minute jitter'), txt(':')),
      ul(
        li(p(code('generate-sitemap?phase=companies: 23 2 * * *'))),
        li(p(code('generate-sitemap?phase=properties: 37 3 * * *'))),
        li(p(code('generate-sitemap?phase=vp-properties: 51 4 * * *'))),
      ),
      p(txt('Acceptance opfyldt: properties/companies kommer nu i sitemap inden for 26 timer.')),
    ],
  },
  'BIZZ-648': {
    type:'doc', version:1, content:[
      h(2, 'Code-level verifikation — PASSED'),
      ul(
        li(p(strong('Shared komponent: '), code('app/components/JsonLd.tsx'), txt(' med '), code('type="application/ld+json"'), txt(' + sikker escape-logik.'))),
        li(p(strong('Ejendom: '), code('app/(public)/ejendom/[slug]/[bfe]/page.tsx:706+724'), txt(' — "BIZZ-648: Skiftet fra RealEstateListing → Place/Residence/ApartmentComplex" + BFE som '), code('PropertyValue'), txt('.'))),
        li(p(strong('Virksomhed: '), code('app/(public)/virksomhed/[slug]/[cvr]/page.tsx:351'), txt(' — CVR som '), code('schema:PropertyValue'), txt('.'))),
      ),
      p(txt('Structured data på plads for begge page-typer med korrekte schema.org-typer.')),
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
