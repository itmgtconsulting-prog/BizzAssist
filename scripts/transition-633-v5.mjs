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
    h(2, 'Fixet (commit 6f0b397) — API-verificeret'),
    p(strong('Root cause: '),txt('EJFCustom_EjerskabBegraenset kræver '),code('virkningstid'),txt('-argument (jf. BIZZ-584). Uden det fejlede hver query med GraphQL-fejl "The argument `virkningstid` is required" og returnerede 0 handler. Tidligere 4 fix-forsøg prøvede andre services/queries uden at adressere selve det manglende argument.')),
    h(3, 'Fix'),
    ul(
      li(p(txt('Tilføjet '),code('virkningstid: "<ISO-now>"'),txt(' i EJFCustom-queryen — både FlexibleCurrent og HistoriskCurrent-kald.'))),
      li(p(txt('Medtaget '),code('virkningTil'),txt('-felt i query + respons-mapping så afsluttede ejerskaber rapporteres korrekt (ikke bare udledt fra status="historisk").'))),
    ),
    h(3, 'API-verifikation'),
    p(txt('Kørt mod /api/salgshistorik?bfeNummer=X på test.bizzassist.dk:')),
    ul(
      li(p(code('BFE 425479'),txt(' (Kaffevej 31 1.tv): 4 handler fra 2019-02-13 til 2023-04-14 ✓ matcher dokumenterede ejerskab-kæde'))),
      li(p(code('BFE 226629'),txt(' (Arnold Nielsens Blvd 62B): 2 handler ✓'))),
      li(p(code('BFE 100165718'),txt(' (Thorvald Bindesbølls 18): 2 handler ✓'))),
    ),
    p(strong('fejl: null '),txt('på samtlige BFE\'er (ingen "EJFCustom_EjerskabBegraenset query fejlede"-fejl). Test: 1448 grønne.')),
    h(3, 'Acceptkriterier'),
    ul(
      li(p(txt('Kaffevej 31 1.tv viser alle dokumenterede handler (2019 + 2023) ✅'))),
      li(p(txt('Ingen query-fejl på /api/salgshistorik ✅'))),
      li(p(txt('LRU-cache + SWR-cache bevaret for performance ✅ (eksisterende infrastruktur)'))),
    ),
    p(strong('Klar til browser-verifikation på '),code('/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465'),strong(' → Økonomi → Salgshistorik.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-633/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-633/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-633 → In Review':`⚠️ (${tr.status})`);
