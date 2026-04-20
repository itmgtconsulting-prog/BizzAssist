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
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});

const body = {
  type:'doc', version:1, content:[
    h(2, 'API-level re-verifikation 2026-04-20 — FEJLET ANDEN GANG'),
    p(txt('Re-testet '), code('/api/ejendomme-by-owner/enrich?bfe=X'), txt(' efter at ticket blev sendt til In Review igen. Bug er '), strong('ikke'), txt(' fixet — enrich-endpointet returnerer stadig null for '), code('boligAreal'), txt(' og '), code('erhvervsAreal'), txt(' på samtlige testede BFE\'er:')),
    codeBlock(
`GET /api/ejendomme-by-owner/enrich?bfe=226630 (62A):
  boligAreal=null  erhvervsAreal=null  matrikelAreal=null

GET /api/ejendomme-by-owner/enrich?bfe=226629 (62B):
  boligAreal=null  erhvervsAreal=null  matrikelAreal=null

GET /api/ejendomme-by-owner/enrich?bfe=2091185 (64B):
  boligAreal=null  erhvervsAreal=null  matrikelAreal=5349  ← matr OK, bolig/erhv fejl

GET /api/ejendomme-by-owner/enrich?bfe=2091179 (Høvedstensvej 33):
  boligAreal=null  erhvervsAreal=null  matrikelAreal=1436  ← matr OK, bolig/erhv fejl`, 'text'),
    p(txt('Mønsteret matcher original-ticketens observation præcist: alle '), code('boligAreal'), txt(' + '), code('erhvervsAreal'), txt(' er null. '), code('matrikelAreal'), txt(' virker for nogle ejendomme men ikke alle.')),
    h(3, 'Hvor fixet må være i enrich-pipelinen'),
    p(txt('Enrich-endpointet '), code('app/api/ejendomme-by-owner/enrich/route.ts'), txt(' må slå op mod BBR og mappe felter forkert. Verificér:')),
    p(txt('• Returnerer '), code('BBR_BygningPunkt'), txt(' eller '), code('BBR_Ejendomsrelation'), txt(' de forventede felter for disse specifikke BFE\'er? Prøv manuelt via GraphQL explorer.')),
    p(txt('• Mangler et samlet-areal-mapping-led efter BIZZ-534 bulk-refactoren?')),
    p(txt('• Sammenlign med ejendoms-detaljesiden ('), code('/dashboard/ejendomme/[id]'), txt(') — dér vises m² korrekt, så data findes. Spor hvor felterne tabes mellem detaljeside-path og liste-path.')),
    p(strong('Sender tilbage til To Do igen. '), txt('Næste fix-forsøg skal teste mod API direkte: '), code('curl /api/ejendomme-by-owner/enrich?bfe=226630'), txt(' skal returnere non-null bolig+erhv før ticket er Done.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-629/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-629/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-629/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-629 → To Do (anden gang)':`⚠️ (${r.status})`);
