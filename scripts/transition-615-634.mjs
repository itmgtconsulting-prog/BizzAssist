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
  'BIZZ-615': {
    type:'doc', version:1, content: [
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('ADR-dokument leveret: '), code('docs/adr/0004-tinglysning-event-feed-evaluation.md'), txt(' (BIZZ-615 refereret i header).')),
      h(3, 'Konklusion fra ADR'),
      ul(
        li(p(strong('Status: '), code('Accepted (investigation complete — implementation deferred)'))),
        li(p(txt('e-TL '), strong('tilbyder'), txt(' et event-feed — "Valgfrit abonnement" — men '), strong('ikke'), txt(' et globalt ændringsstream / delta-udtræk.'))),
        li(p(txt('Abonnement er pr. objekt (BFE/CVR/CPR/andelsbolig). Gratis. Brugbar til watch-list-feature for fulgte ejendomme.'))),
        li(p(txt('Ikke brugbar til bulk-sync af alle danske ejendomme — kan ikke abonnere på millioner af BFE\'er.'))),
        li(p(txt('Bulk incremental sync forbliver afhængig af Datafordeler EJF/BBR Hændelsesbesked (BIZZ-534/612) + nattlig polling af '), code('/ejdsummarisk'), txt(' for kendte BFE\'er.'))),
      ),
      p(txt('Acceptance opfyldt: ADR skrevet + committet, beslutning dokumenteret som "implementér som follow-up når watch-list-feature udvikles".')),
    ],
  },
  'BIZZ-634': {
    type:'doc', version:1, content: [
      h(2, 'Code-level verifikation — PASSED'),
      p(txt('Fix implementeret i '), code('app/components/ejendomme/PropertyOwnerCard.tsx'), txt(':')),
      ul(
        li(p(code('linje 98-100'), txt(': eksplicit BIZZ-634 kommentar på '), code('salgspris'), txt(' + '), code('salgsdato'), txt(' props ("Ejer-specifik salgspris/salgsdato for solgte ejendomme")'))),
        li(p(code('linje 328'), txt(': rendering af "salgspris — samt beregnet gevinst/tab i %" på solgte ejendomskort'))),
      ),
      p(txt('Dækker acceptance om at vise '), strong('både købspris og salgspris'), txt(' for den pågældende ejer (ikke seneste ejer) samt gevinst/tab-beregning.')),
      p(strong('Caveat: '), txt('Browser-verifikation ikke gennemført pga. skeleton-blokerende issues på Jakobs persontab (samme som BIZZ-619). Code-evidens er dog entydig. Manuel browser-QA kan verificere format "Købt: X → Solgt: Y" på fx Greve Alle 70 eller Mejsevænget 17 under Jakobs historiske ejendomme.')),
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
