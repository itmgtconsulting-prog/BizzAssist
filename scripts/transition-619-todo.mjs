#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});r.on('error',rej);if(d)r.write(d);r.end()});}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t,m) => m?{type:'text',text:t,marks:m}:{type:'text',text:t};
const strong = (s) => txt(s,[{type:'strong'}]);
const code = (s) => txt(s,[{type:'code'}]);
const h = (l,t) => ({type:'heading',attrs:{level:l},content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});

const body = {
  type:'doc', version:1, content:[
    h(2, 'Manuel browser-verifikation 2026-04-20 — FAILED'),
    p(txt('Bruger bekræftede manuelt at følgende '), strong('personligt ejede ejendomme mangler'), txt(' på Jakob Juul Rasmussens persondiagram ('), code('/dashboard/owners/4000115446'), txt(' → Diagram):')),
    ul(
      li(p(txt('❌ Søbyvej 11, 2650 Hvidovre'))),
      li(p(txt('❌ Vigerslevvej 146'))),
      li(p(txt('❌ Hovager 8'))),
    ),
    p(strong('Derudover mangler også en personligt ejet virksomhed:')),
    ul(
      li(p(txt('❌ '), code('IT Management consulting'), txt(' (enkeltmandsvirksomhed — Jakob er eneejer via sit enhedsNummer)'))),
    ),
    p(txt('Bugget er bredere end kun ejendomme — persondiagrammet henter hverken personligt ejede ejendomme ('), code('ejf_ejerskab'), txt('-bulk) eller personligt ejede enkeltmandsvirksomheder (ENK/I/S/K/S/P/S via '), code('erEjerVedForm()'), txt(') analogt til virksomhedsdiagrammet.')),
    p(strong('Sender til To Do. '), txt('Fix-hypotese: '), code('buildPersonDiagramGraph()'), txt(' mangler 2 datalag:')),
    ul(
      li(p(txt('1) Personligt ejede ejendomme via '), code('/api/ejerskab/person-properties?enhedsNummer=…'), txt(' (bulk-data fra BIZZ-534)'))),
      li(p(txt('2) Personligt ejede virksomheder via '), code('erEjerVedForm()'), txt('-helper fra '), code('PersonDetailPageClient.tsx:134'), txt(' (samme som BIZZ-620 på Virksomheder-tab)'))),
    ),
    p(txt('Relaterer: '), strong('BIZZ-620'), txt(' (samme ENK-logik — allerede Done på Virksomheder-tabben, men ikke wired op til diagrammet)'), txt(' og '), strong('BIZZ-597'), txt(' (paraply-alignment).')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-619/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-619/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-619/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-619 → To Do':`⚠️ (${r.status})`);
