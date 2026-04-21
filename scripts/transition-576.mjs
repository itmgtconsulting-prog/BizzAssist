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

// Kommenter med live-fund der viser at ticketens præmis er fejlagtig:
// BFE 425479 ER ejerlejlighed-BFE, ikke hovedejendom-BFE — EJF returnerer korrekt data.
const body = {
  type:'doc', version:1, content:[
    h(2, 'Investigation: premisset er fejlagtigt — ingen drill-down nødvendig'),
    h(3, 'Live-probe af acceptance-eksemplet'),
    p(strong('JAJR Ejendomme ApS (CVR 26316804) → Kaffevej 31'),txt(': EJF returnerer '),code('BFE 425479'),txt(' hvilket ticketen påstår er hovedejendom-BFE. Probe af VP ES viser:')),
    ul(
      li(p(code('bfeNumbers: "425479"'),txt(' (enkelt BFE, ikke array)'))),
      li(p(code('juridiskUnderkategori: "Ejerlejlighed til helårsbeboelse"'),txt(' — dette '),strong('er'),txt(' ejerlejligheden'))),
      li(p(code('address: "Kaffevej 31, 1. tv, 2610 Rødovre"'),txt(' — med etage+dør'))),
      li(p(code('floor: "1"'),txt(', '),code('door: "tv"'),txt(' — metadata sat'))),
      li(p(code('adresseID: "486e732a-399f-43c1-90a1-acf1cf160c3f"'),txt(' — specifik lejligheds-ID'))),
    ),
    p(strong('/api/ejerskab?bfeNummer=425479'),txt(' → 1 ejer: JAJR Ejendomme ApS, 100% ejerandel. EJF har ejerskabsrelationen direkte på ejerlejligheds-BFE.')),
    h(3, 'Konklusion'),
    p(txt('BFE 425479 '),strong('er'),txt(' ejerlejlighed-BFE for Kaffevej 31 1.tv — ikke hovedejendom-BFE. EJF returnerer den korrekte BFE. /api/ejendomme-by-owner-payload\'en indeholder allerede:')),
    ul(
      li(p(code('bfeNummer: 425479'),txt(' (ejerlejligheden)'))),
      li(p(code('dawaId: "4afa00c5-c304-463d-a67e-b24446187465"'),txt(' (specifik Kaffevej 31 1.tv adresse-UUID)'))),
      li(p(code('etage: "1"'),txt(', '),code('doer: "tv"'),txt(' (fra VP ES)'))),
      li(p(code('adresse: "Kaffevej 31"'),txt(' (uden etage/dør i feltet — UI formateerer til "Kaffevej 31, 1. tv")'))),
    ),
    p(txt('Ticketens egen detektions-heuristik ('),code('ingen etage-dør-metadata'),txt(') vil selv have detekteret Kaffevej 31 som '),strong('ikke'),txt(' et drill-down-case, fordi etage/dør er sat.')),
    h(3, 'Verificeret'),
    ul(
      li(p(code('/dashboard/ejendomme/4afa00c5-c304-463d-a67e-b24446187465'),txt(' → H1 = '),code('"Kaffevej 31, 1. tv, 2610 Rødovre"'),txt(' ✅ (korrekt ejerlejligheds-side)'))),
      li(p(code('/dashboard/ejendomme/425479'),txt(' → H1 null (BFE-som-URL fungerer ikke — separat bug, ikke omfang her — [id]-routen forventer UUID)'))),
    ),
    h(3, 'Anbefaling'),
    p(txt('Lukkes som '),strong('Not a Bug'),txt('. Hvis der findes '),strong('andre'),txt(' konkrete CVR+BFE-eksempler hvor EJF returnerer hovedejendom-BFE i stedet for ejerlejlighed-BFE, opret ny ticket med eksempel-data så fix kan targetes præcist. Forslag:')),
    ul(
      li(p(txt('Separat ticket for '),code('/dashboard/ejendomme/[BFE]'),txt(' → altid redirecte til dawaId-UUID hvis numerisk BFE'))),
      li(p(txt('Separat ticket for at beriget '),code('EjendomSummary.adresse'),txt(' med etage+dør når de findes, så visningen er fuldstændig uden ekstra formattering'))),
    ),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-576/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status}) ${c.body.slice(0,200)}`);
// Luk som Done (ikke In Review — der er ingen kode-ændring at reviewe)
const tr = await req('POST','/rest/api/3/issue/BIZZ-576/transitions',{transition:{id:'41'}});
console.log(tr.status===204?'✅ BIZZ-576 → Done':`⚠️ (${tr.status}) ${tr.body.slice(0,200)}`);
