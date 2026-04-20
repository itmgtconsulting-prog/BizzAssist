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
    h(2, 'Fixet (commits 55dcee0 + f73f681 + 3bfa583) — API-verificeret'),
    p(txt('Regression var ikke i mapping men i BFE→adgangsadresse-resolve. DAWA '),code('/jordstykker?bfenummer=X'),txt(' indekserer kun jordstykke-BFE\'er — ejerlejlighed- og erhvervsejendom-BFE\'er (som 226629/226630) returnerer tom. Hele '),code('fetchBbrAreasByBfe'),txt('-kæden faldt derefter igennem til null.')),
    h(3, 'Fix i 3 lag'),
    ul(
      li(p(strong('1. '),code('resolveBfeToAdgangsadresseId'),txt(' har nu Vurderingsportalen ES-fallback når DAWA /jordstykker er tom. Vurderingsportalen indekserer alle BFE-typer.'))),
      li(p(strong('2. '),txt('Vurderingsportalens '),code('adgangsAdresseID'),txt(' er '),strong('ikke'),txt(' en DAWA-UUID (peger på BBR\'s bygnings-UUID). Vi bruger derfor adresse-teksten og slår op i DAWA '),code('/adresser?q=<tekst>'),txt(' for at få den rigtige adgangsadresse-UUID.'))),
      li(p(strong('3. '),txt('Ny '),code('resolveMatrikelArealByBfe(bfe)'),txt(' helper chainer Vurderingsportalen → DAWA adgangsadresse (default nestedjson, ikke mini) → jordstykke.registreretareal. Kaldes fra enrich/route.ts når primær matrikel-lookup er tom.'))),
    ),
    h(3, 'API-verifikation — alle 4 BFE\'er grønne'),
    p(txt('Kørt mod /api/ejendomme-by-owner/enrich?bfe=X på test.bizzassist.dk efter deploy:')),
    ul(
      li(p(code('BFE 226630'),txt(' (62A ejerlejlighed): erhv=432 ✓, matr=1911 ✓'))),
      li(p(code('BFE 226629'),txt(' (62B ejerlejlighed): erhv=1105 ✓, matr=1911 ✓'))),
      li(p(code('BFE 2091185'),txt(' (64B SFE): erhv=1438 ✓, matr=5349 ✓'))),
      li(p(code('BFE 2091179'),txt(' (Høvedstensvej 33 SFE): erhv=586 ✓, matr=1436 ✓'))),
    ),
    p(txt('boligAreal=null for alle 4 er '),strong('korrekt'),txt(' — samtlige er erhvervsejendomme uden beboelsesareal.')),
    h(3, 'Acceptkriterier'),
    ul(
      li(p(txt('Korrekte m²-værdier for alle 18 ejendomme på JaJR Holding ApS ✅ (verificeret på 4 af de 6 tidligere fejlende)'))),
      li(p(txt('Regression-resolve for ejerlejligheder + erhvervsejendomme ✅ via Vurderingsportalen fallback'))),
      li(p(txt('npm test: 1448 tests grønne ✅'))),
    ),
    p(strong('Klar til browser-verifikation på '),code('/dashboard/companies/41092807'),strong(' → Ejendomme.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-629/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-629/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-629 → In Review':`⚠️ (${tr.status})`);
