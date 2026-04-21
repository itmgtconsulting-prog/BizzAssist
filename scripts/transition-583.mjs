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
    h(2, 'Shipped til prod + verificeret (commit c1181a8)'),
    h(3, 'Leveret'),
    ul(
      li(p(code('/api/ejendomsadmin?bfeNummer=X'),txt(' — OAuth bearer auth, 24t cache, EJF Custom GraphQL-query'))),
      li(p(code('EjendomAdministratorCard.tsx'),txt(' — UI-komponent med CVR→navn lookup, skjules ved 0 aktive admins'))),
      li(p(txt('Wired ind på Ejerforhold-tab for primær BFE'))),
    ),
    h(3, 'Query pattern (per BIZZ-584-afklaring)'),
    p(code('EJFCustom_EjendomsadministratorBegraenset { personBegraenset { id, navn, foedselsdato } }'),txt(' — traversal via '),code('personBegraenset'),txt(' giver os navn + fødselsdato selvom direkte fields ikke er eksponeret.')),
    h(3, 'Live-verifikation på bizzassist.dk'),
    ul(
      li(p(code('BFE 100165718'),txt(' (Thorvald Bindesbølls Plads) → person-admin: Jakob Juul Rasmussen, 1972-07-11, status=historisk ✅'))),
      li(p(code('BFE 425479'),txt(' (Kaffevej 31 1.tv) → 0 administratorer → sektion skjules ✅'))),
      li(p(code('BFE 226629'),txt(' (Arnold Nielsens Blvd 62B) → 0 admins → skjult ✅'))),
    ),
    h(3, 'Acceptance'),
    ul(
      li(p(txt('Ejendom med admin viser sektion ✅'))),
      li(p(txt('Ejendom uden admin skjuler sektion (ikke "Ukendt") ✅'))),
      li(p(txt('Klik på virksomhedsadmin → /dashboard/companies/[cvr] ✅ (verified in code + Link-komponent)'))),
      li(p(txt('Person-admin vises uden link (persondata-begræsning) ✅'))),
      li(p(txt('24t cache på endpoint ✅ (s-maxage=86400)'))),
    ),
    h(3, 'Scope-note'),
    p(txt('Bonus "Administrerede ejendomme"-fane på virksomhedssiden (reverse lookup — find alle BFE\'er hvor CVR optræder som admin) er '),strong('ikke'),txt(' inkluderet. Kan følge op som separat ticket når feature er adopted og vi ser hvilke virksomheder der er administratorer (typisk ejendomsadministrations-selskaber).')),
    p(strong('Klar til verifier-browser-test på '),code('/dashboard/ejendomme/<dawa-id>'),strong(' → Ejerskab-fanen.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-583/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-583/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-583 → In Review':`⚠️ (${tr.status})`);
