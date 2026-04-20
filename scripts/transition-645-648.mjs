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

const b647 = {
  type:'doc', version:1, content:[
    h(2, 'Implementeret (commit fb56560)'),
    p(code('vercel.json'),txt(' + '),code('generate-sitemap/route.ts'),txt(' + '),code('admin/cron-status/route.ts'),txt(' — alle opdateret. intervalMinutes 10080 → 1440.')),
    p(txt('Crons kører nu:')),
    ul(
      li(p(code('23 2 * * *'),txt(' — companies'))),
      li(p(code('37 3 * * *'),txt(' — properties'))),
      li(p(code('51 4 * * *'),txt(' — vp-properties'))),
    ),
    p(strong('Effekt'),txt(' efter deploy til prod: nye ejendomme/virksomheder indekseres inden for 24t i stedet for op til 7 dage.')),
  ],
};

const b648 = {
  type:'doc', version:1, content:[
    h(2, 'Implementeret (commit fb56560)'),
    p(strong('Ejendom: '),code('RealEstateListing'),txt(' → '),code('Place/Residence/ApartmentComplex'),txt(' baseret på BBR anvendelseskode (120/130 → Residence, 140 → ApartmentComplex, øvrige → Place). RealEstateListing impliserer "til-salg" som er misvisende.')),
    p(strong('Virksomhed: '),code('identifier'),txt(' upgraded fra tekst-string til struktureret '),code('PropertyValue'),txt(' med propertyID=CVR + value. Samme pattern for BFE på ejendom.')),
    ul(
      li(p(code('app/(public)/ejendom/[slug]/[bfe]/page.tsx'),txt(' — Place-schema'))),
      li(p(code('app/(public)/virksomhed/[slug]/[cvr]/page.tsx'),txt(' — Organization/LocalBusiness med PropertyValue CVR'))),
    ),
    p(strong('Verifier-steps: '),txt('åbn en /ejendom/ og /virksomhed/ side efter prod-deploy + tjek JSON-LD via '),code('view-source:'),txt(' eller https://validator.schema.org + https://search.google.com/test/rich-results.')),
  ],
};

const b645 = {
  type:'doc', version:1, content:[
    h(2, 'Fixet i 2 lag (commit fb56560)'),
    p(txt('Baseline-scan 2026-04-20 fandt 3 problemer som alle nu er løst:')),
    h(3, '1. sitemap_entries-tabel manglede på test + prod ✅'),
    p(txt('Migration 037_sitemap_entries.sql var aldrig applied på test/prod (kun dev). Applied via Management API til begge miljøer.')),
    h(3, '2. robots.txt Sitemap-header brokket over 2 linjer ✅'),
    p(code('NEXT_PUBLIC_APP_URL'),txt(' på Vercel prod indeholdt trailing newline. Det fik '),code('robots.ts'),txt(' til at render:')),
    p(code("Sitemap: https://bizzassist.dk\\n/sitemap/0.xml")),
    p(txt('Fix: '),code('getAppUrl()'),txt(' og '),code('robots.ts'),txt(' '),code('.trim()'),txt(' env-var før '),code("/\\/$/"),txt('-strip. 3 nye unit-tests dækker edge cases (trailing newline, CR+LF, whitespace).')),
    h(3, '3. Cron-verifikation på test ✅'),
    p(txt('Manuel '),code('curl -H "Authorization: Bearer $CRON_SECRET" ...'),txt(' mod test.bizzassist.dk/api/cron/generate-sitemap?phase=properties → 591 ejendom-rækker inserted i test-Supabase. Cron-pipelinen er verificeret funktionel.')),
    h(3, 'Resterende brugeraktioner til prod'),
    ul(
      li(p(txt('Merge develop → main så '),code('trim()'),txt('-fixet kommer i prod'))),
      li(p(txt('Efter deploy: curl '),code('/api/cron/generate-sitemap?phase=properties'),txt(' med prod-CRON_SECRET for at starte backfill (ellers venter vi til 37:03 UTC næste døgn)'))),
      li(p(txt('Sæt CVR_ES_USER/CVR_ES_PASS i Vercel prod (pending approval) — uden dem er '),code('phase=companies'),txt(' en no-op'))),
    ),
    p(strong('Acceptance-status:'),txt(' sitemap_entries-struktur eksisterer ✅, robots.txt fix klar til deploy ✅, cron-pipeline valideret ✅. Antallet > 1 M på prod afhænger af første fulde backfill efter deploy (dagligt cron + CVR-creds).')),
  ],
};

const b646 = {
  type:'doc', version:1, content:[
    h(2, 'Runbook landet (commit fb56560)'),
    p(code('docs/runbooks/SEO_INDEXING.md'),txt(' dækker hele flowet:')),
    ul(
      li(p(strong('Google Search Console: '),txt('property-setup, DNS TXT-verifikation, sitemap-submission, email-alerts'))),
      li(p(strong('Bing Webmaster Tools: '),txt('import fra GSC eller manuel setup'))),
      li(p(strong('Troubleshooting: '),txt('3 kategorier med curl-kommandoer — robots.txt blokerer, sitemap tom, individual pages 404'))),
      li(p(strong('Monitoring: '),txt('cron-status dashboard, Sentry check-ins, GSC Coverage-tab'))),
      li(p(strong('Credentials + access: '),txt('hvem har adgang, hvor findes CRON_SECRET, rotations-procedure'))),
      li(p(strong('Change log: '),txt('BIZZ-645/646/647/648 tracket med dato'))),
    ),
    p(strong('Acceptance — manuel ops-del:'),txt(' GSC property-creation + DNS TXT + sitemap-submission kræver DNS-adgang og kan ikke automatiseres fra kode. Runbook\'en giver nu step-by-step for at udføre det. 2-ugers follow-up forbliver bruger-trigger.')),
  ],
};

async function go(key, body){
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(c.status===201?`✅ ${key} comment`:`❌ ${key} (${c.status})`);
  const t = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: '31' } });
  console.log(t.status===204?`✅ ${key} → In Review`:`⚠️ ${key} (${t.status})`);
}
await go('BIZZ-647', b647);
await go('BIZZ-648', b648);
await go('BIZZ-645', b645);
await go('BIZZ-646', b646);
