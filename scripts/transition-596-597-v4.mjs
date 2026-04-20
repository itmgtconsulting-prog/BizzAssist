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

const body596 = {
  type:'doc', version:1, content:[
    h(2, 'Ejerlejlighed-boligAreal fixet (commit 7734719) — API-verificeret'),
    p(strong('Root cause: '),txt('når klienten ikke sendte '),code('dawaId'),txt(' returnerede resolve-helperen en '),code('adgangsadresseid'),txt(' (bygningsniveau), men '),code('BBR_Enhed.adresseIdentificerer'),txt(' kræver den fulde lejligheds-adresse-UUID (med etage/dør). Resultat: boligAreal=null for ejerlejligheder.')),
    h(3, 'Fix'),
    ul(
      li(p(code('lookupAdgangsadresseByBfeViaVurderingsportalen'),txt(' returnerer nu DAWA '),code('adresse-UUID (id)'),txt(' — ikke '),code('adgangsadresseid'),txt('. Den UUID fungerer som '),code('adresseIdentificerer'),txt(' i BBR_Enhed (matcher lejligheden direkte).'))),
      li(p(code('BBR_Bygning'),txt('-fallbacken probe\'r automatisk adresse → adgangsadresse via DAWA, så SFE\'er og kommercielle ejendomme stadig fungerer.'))),
      li(p(code('resolveMatrikelArealByBfe'),txt(' prøver '),code('/adgangsadresser/{id}'),txt('; ved 404 falder tilbage til '),code('/adresser/{id}'),txt(' → jordstykke-chain.'))),
    ),
    h(3, 'API-verifikation'),
    p(code('BFE 425479 (Kaffevej 31 1.tv, ejerlejlighed):')),
    ul(
      li(p(txt('før fix: '),code('boligAreal=null, erhvervsAreal=null, matrikelAreal=2314'))),
      li(p(txt('efter fix: '),code('boligAreal=97, erhvervsAreal=null, matrikelAreal=2314'),txt(' ✅'))),
    ),
    p(strong('Regression-test: '),txt('samtlige BIZZ-629 BFE\'er stadig grønne (62A=432, 62B=1105, 64B=1438, Høvedstensvej 33=586 på erhverv).')),
    p(strong('Klar til re-verifikation: '),code('curl /api/ejendomme-by-owner/enrich?bfe=425479'),txt(' returnerer nu '),code('boligAreal=97'),txt(' — brugerens oprindelige klage "596 på ejendomstab viser lejligheder ikke korrekt antal bolig m2" er løst.')),
  ],
};

const body597 = {
  type:'doc', version:1, content:[
    h(2, 'BIZZ-596 blocker løst (commit 7734719)'),
    p(txt('Ejerlejlighed-boligAreal regression i /api/ejendomme-by-owner/enrich er nu fixet via resolve-kædens retur af fuld adresse-UUID (i stedet for adgangsadresseid). Se BIZZ-596 for API-verifikation.')),
    h(3, 'Paraply-status'),
    ul(
      li(p(code('BIZZ-594'),txt(' — '),strong('Done'))),
      li(p(code('BIZZ-595'),txt(' — '),strong('Done'))),
      li(p(code('BIZZ-596'),txt(' — '),strong('API-verificeret (commit 7734719)'),txt(' — klar til browser-verifier'))),
    ),
    p(strong('Ready for umbrella-close. '),txt('Fase 1 (backend-symmetri) + Fase 2 (batch-enrichment) + Fase 3 (memoized diagram) alle bekræftet af verifier tidligere. Sidste blocker (ejerlejlighed-boligAreal) løst.')),
  ],
};

const c1 = await req('POST','/rest/api/3/issue/BIZZ-596/comment',{body:body596});
console.log(c1.status===201?'✅ 596 comment':`❌ 596 (${c1.status})`);
const t1 = await req('POST','/rest/api/3/issue/BIZZ-596/transitions',{transition:{id:'31'}});
console.log(t1.status===204?'✅ BIZZ-596 → In Review':`⚠️ 596 (${t1.status})`);

const c2 = await req('POST','/rest/api/3/issue/BIZZ-597/comment',{body:body597});
console.log(c2.status===201?'✅ 597 comment':`❌ 597 (${c2.status})`);
const t2 = await req('POST','/rest/api/3/issue/BIZZ-597/transitions',{transition:{id:'31'}});
console.log(t2.status===204?'✅ BIZZ-597 → In Review':`⚠️ 597 (${t2.status})`);
