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
    h(2, 'Delvist shipped til prod — 4 af 7 tabs ekstraheret + verificeret'),
    h(3, 'Leveret'),
    ul(
      li(p(code('tabs/EjendomSkatTab.tsx'),txt(' (387l) — commit '),code('0d799ee'))),
      li(p(code('tabs/EjendomDokumenterTab.tsx'),txt(' (936l) — commit '),code('a669c9c'))),
      li(p(code('tabs/EjendomEjerforholdTab.tsx'),txt(' (196l) — commit '),code('eb0348e'))),
      li(p(code('tabs/EjendomOekonomiTab.tsx'),txt(' (612l) — commit '),code('ad2d3e6'))),
    ),
    p(strong('Master-fil: '),code('EjendomDetaljeClient.tsx'),txt(' 7845 → 6146 linjer (−1699, 22% reduktion).')),
    h(3, 'Pattern'),
    p(txt('Præsentations-komponenter der tager data + callbacks som props; parent beholder state + fetch-orchestration. Hver tab definerer sit eget lokale '),code('t'),txt('-oversættelses-objekt fra '),code('lang'),txt('-prop. Tinglysning var allerede ekstraheret som selvstændig fil før denne ticket.')),
    h(3, 'Live-verifikation på bizzassist.dk'),
    ul(
      li(p(code('/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465'),txt(' (Kaffevej 31 1.tv) → H1 korrekt, alle 4 ekstraherede tabs renderer korrekt, 0 page errors'))),
      li(p(txt('Verificeret sektioner: Ejendomsvurdering + Salgshistorik (Økonomi), Ejendomsskatter + Skattehistorik (Skat), BBR-meddelelse + Jordforurening + Matrikelkort + Download-knap (Dokumenter), Administrator-kort + Ejerskab-diagram (Ejerforhold)'))),
    ),
    h(3, 'Gates (per commit)'),
    ul(
      li(p(code('tsc --noEmit'),txt(' grøn'))),
      li(p(code('npm test'),txt(' — 1534/1534 grøn'))),
      li(p(code('npm run build'),txt(' grøn'))),
    ),
    h(3, 'Tilbage — parkeret som follow-up'),
    ul(
      li(p(strong('BBR-tab'),txt(' (~883l) — store BBR-bygning/enhed/anlæg-dependencies'))),
      li(p(strong('Overblik-tab'),txt(' (~670l) — cross-tab hovedsammenfatning'))),
    ),
    p(txt('Begge fortjener frisk session hvor agent har fuld context til at identificere state-dependencies omhyggeligt. Pattern er veletableret fra de 4 shippede extractions så overdragelse er ligetil.')),
    h(3, 'Non-obvious fund (saved i memory)'),
    p(code('EjendomDetaljeClient.tsx'),txt(' har TO render-grene: DAWA-path (det faktiske branch) og en mock-fallback-path (legacy dead code). Ekstraktionerne har kun targetet DAWA-pathen. Mock-fallback branchen har duplikate inline-blokke for alle 7 tabs men bruger '),code('ejendom'),txt(' mock-objekt fra '),code('app/lib/mock/ejendomme.ts'),txt(' — lad den være; den kan slettes separat.')),
    p(strong('Klar til verifier-browser-test af shippet delmængde.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-657/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status}) ${c.body.slice(0,200)}`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-657/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-657 → In Review':`⚠️ (${tr.status}) ${tr.body.slice(0,200)}`);
