#!/usr/bin/env node
/**
 * Iteration 17: process 5 tickets in In Review.
 * - BIZZ-629, BIZZ-633: still broken → To Do
 * - BIZZ-595, BIZZ-596, BIZZ-619: inconclusive via Playwright, ask user
 */
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
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});

// ── To Do: BIZZ-629 + BIZZ-633 ─────────────────────────────────────────────

const toTodo = {
  'BIZZ-629': {
    type:'doc', version:1, content:[
      h(2, 'API-level re-verifikation — DELVIST FIXED, sender til To Do'),
      p(txt('Re-testet '), code('/api/ejendomme-by-owner/enrich?bfe=X'), txt(' — '), strong('partial fix bekræftet'), txt(':')),
      codeBlock(
`BFE 2091185 (64B):     erhvervsAreal=1438 ✓  matrikelAreal=5349 ✓  boligAreal=null ✗
BFE 2091179 (Høved. 33): erhvervsAreal=586  ✓  matrikelAreal=1436 ✓  boligAreal=null ✗
BFE 226630  (62A):      erhvervsAreal=null ✗  matrikelAreal=null ✗  boligAreal=null ✗
BFE 226629  (62B):      erhvervsAreal=null ✗  matrikelAreal=null ✗  boligAreal=null ✗`, 'text'),
      p(txt('Nogle BFE\'er har fået '), code('erhvervsAreal'), txt(' tilbage (64B, Høvedstensvej 33), men 62A og 62B returnerer stadig '), code('null'), txt(' på alle 3 areal-felter. Ejendomme-kortene for 62A/62B viser stadig 0 m².')),
      h(3, 'Hypotese — ejerlejlighed vs. SFE'),
      p(txt('64B og Høvedstensvej 33 er '), strong('samlede faste ejendomme (SFE)'), txt('. 62A og 62B er '), strong('ejerlejligheder'), txt('. Mønsteret matcher BIZZ-637 (ejerlejligheder bruger BBR_Enhed, ikke BBR_Bygning). Fixet til enrich-endpointet må også håndtere ejerlejlighed-typen separat.')),
      p(strong('Sender tilbage til To Do.'), txt(' Næste fix-verifikation: '), code('curl /api/ejendomme-by-owner/enrich?bfe=226630'), txt(' skal returnere non-null bolig/erhv før ticket er Done.')),
    ],
  },
  'BIZZ-633': {
    type:'doc', version:1, content:[
      h(2, 'API-level re-verifikation — NY FEJL, sender til To Do igen'),
      p(txt('Re-testet '), code('/api/salgshistorik?bfeNummer=X'), txt(' — fejlen er '), strong('ikke længere'), txt(' '), code('"EJF_Ejerskifte query fejlede"'), txt(' (forrige run). Fix-forsøget skiftede til den korrekte service '), code('EJFCustom_EjerskabBegraenset'), txt(' per anbefalingen — men querien mod den nye service fejler også:')),
      codeBlock(
`GET /api/salgshistorik?bfeNummer=425479 (Kaffevej 31):
  handler.length: 0, fejl: "EJFCustom_EjerskabBegraenset query fejlede"

GET /api/salgshistorik?bfeNummer=226629 (Arnold Nielsens Blvd 62B):
  handler.length: 0, fejl: "EJFCustom_EjerskabBegraenset query fejlede"

GET /api/salgshistorik?bfeNummer=100165718 (Thorvald Bindesbølls 18):
  handler.length: 0, fejl: "EJFCustom_EjerskabBegraenset query fejlede"`, 'text'),
      h(3, 'Mulige årsager'),
      ul(
        li(p(txt('Forkert query-shape mod '), code('EJFCustom_EjerskabBegraenset'), txt(' — queriens felter matcher ikke schemaet'))),
        li(p(txt('Manglende '), code('virkningstid:'), txt(' argument — per BIZZ-584 er dette påkrævet på alle Custom-queries'))),
        li(p(txt('OAuth-token fejler — test med samme credentials som '), code('/api/ejerskab'), txt('-endpointet (der virker)'))),
      ),
      p(strong('Næste skridt: '), txt('Kig i server-logs ved API-kald for at se den rå GraphQL-fejl. Bogstaveligt talt test via '), code('fetch('), txt(' mod '), code('https://graphql.datafordeler.dk/flexibleCurrent/v1/'), txt(' med den faktiske query før nyt fix-forsøg.')),
    ],
  },
};

for (const [key, body] of Object.entries(toTodo)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} comment (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const todo = (JSON.parse(tr.body).transitions||[]).find(t => /^to\s*do$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: todo.id } });
  console.log(r.status===204 ? `🔄 ${key} → To Do` : `⚠️ ${key} (${r.status})`);
}

// ── Inconclusive: BIZZ-595, 596, 619 ────────────────────────────────────────

const inconclusive = {
  'BIZZ-595': 'Person→Ejendomme-tab (personligt ejede ejendomme)',
  'BIZZ-596': 'Person→Ejendomme alignment med virksomhedsfane',
  'BIZZ-619': 'Persondiagram: Jakobs personligt ejede ejendomme + IT Management consulting',
};

for (const [key, topic] of Object.entries(inconclusive)) {
  const body = {
    type:'doc', version:1, content:[
      h(2, 'Re-verifikation — INKONKLUSIV (Playwright tab-klik upålideligt)'),
      p(txt('Siden mit forrige check (hvor '), code(key), txt(' blev sendt til To Do) er ticket igen i In Review. Mit Playwright-forsøg på at klikke tab på Jakobs persondetailside lander konsistent på sidebar-Ejendomme i stedet for tab — tab-selektoren virker ikke pålideligt.')),
      p(txt('Kode-level check viser '), strong('nye'), txt(' fix-markører for '), code(key), txt(':')),
      ul(
        li(p(code('PersonDetailPageClient.tsx:2015'), txt(' "BIZZ-595/596: Erstat \'Kommer snart\'"'))),
        li(p(code('PersonDetailPageClient.tsx:2362'), txt(' "BIZZ-619: Revideret — ejendomme skal vises fra start"'))),
        li(p(code('PersonDetailPageClient.tsx:2515'), txt(' "BIZZ-595: Personligt ejede ejendomme (fra ejf_ejerskab)"'))),
      ),
      p(strong('Kan ikke automatisk verificere '), txt(topic), txt('. Anbefaler manuel browser-QA:')),
      ul(
        li(p(txt('1) Åbn '), code('test.bizzassist.dk/dashboard/owners/4000115446'))),
        li(p(txt('2) Klik Ejendomme-tab (eller Diagram-tab for BIZZ-619)'))),
        li(p(txt('3) Bekræft at Jakobs personligt ejede ejendomme (Søbyvej 11, Vigerslevvej 146, Hovager 8, Thorvald Bindesbølls Plads 18, etc.) nu vises'))),
      ),
      p(txt('Siger du PASSED manuelt → jeg transitionerer til Done. Siger du FAILED → jeg transitionerer til To Do.')),
    ],
  };
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(c.status===201 ? `📝 ${key} inkonklusiv-kommentar — forbliver In Review` : `❌ ${key} (${c.status})`);
}
