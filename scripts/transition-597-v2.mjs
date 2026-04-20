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
    h(2, 'Paraply-refactor leveret via delte primitives'),
    p(txt('Alle sub-tickets er enten Done eller afleveret til In Review:')),
    ul(
      li(p(code('BIZZ-594'),txt(' — '),strong('Done'),txt(' (person-diagram ejendomme + korrekt ejerandel)'))),
      li(p(code('BIZZ-595'),txt(' — '),strong('Done'),txt(' (personligt ejede ejendomme på person-tab)'))),
      li(p(code('BIZZ-596'),txt(' — '),strong('In Review'),txt(' (datafelt-paritet + performance — blocker BIZZ-629 nu Done)'))),
    ),
    h(3, 'Delte primitives (realiseret arkitektur)'),
    ul(
      li(p(code('PropertyOwnerCard.tsx'),txt(' — samme kort bruges begge steder'))),
      li(p(code('DiagramForce.tsx'),txt(' — samme engine + auto-expand for top-owners'))),
      li(p(code('/api/ejendomme-by-owner + /enrich-batch'),txt(' — shared listing + enrichment'))),
      li(p(code('fetchSalgshistorikMedFallback.ts'),txt(' — shared EJFCustom + TL merge'))),
    ),
    p(txt('Person-specifik parallel pipeline ligger '),strong('oven i'),txt(' de delte primitives: '),code('/api/ejerskab/person-bridge'),txt(' + '),code('person-properties'),txt(' (BIZZ-534), '),code('buildPersonDiagramGraph'),txt(' (person-centreret view).')),
    h(3, 'Oprindeligt foreslået monolitisk EjendommeTabs.tsx er ikke oprettet'),
    p(txt('Alignment er i stedet realiseret via delte primitiver — hver side komponerer sin tab-struktur med fælles byggeklodser. Dette følger Next.js/React-mønstret og giver større fleksibilitet end en stor wrapper-komponent. Ingen drift-risiko så længe '),code('PropertyOwnerCard'),txt(' + enrich-endpoint er den delte sandhedskilde.')),
    p(strong('Anbefaling: '),txt('Luk BIZZ-597 som Done når BIZZ-596 er verificeret på test.bizzassist.dk (side-by-side sammenligning /dashboard/owners/4000115446 vs /dashboard/companies/<cvr>).')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-597/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-597/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-597 → In Review':`⚠️ (${tr.status})`);
