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
    h(2, 'Manuel browser-verifikation — FAILED'),
    p(txt('Bruger bekræftede manuelt: på Person→Ejendomme-tab viser '), strong('ejerlejligheder ikke korrekt antal bolig-m²'), txt('. Data-felt-alignment med virksomhedsfanen er derfor ikke komplet.')),
    h(3, 'Root cause (samme som BIZZ-629 + BIZZ-637)'),
    p(txt('API-level verifikation via '), code('/api/ejendomme-by-owner/enrich?bfe=X'), txt(' viste at '), code('boligAreal=null'), txt(' returneres for ejerlejligheder (fx BFE 226629/226630 Arnold Nielsens Boulevard 62A/62B). Frontend-fallback '), code('(boligAreal ?? 0)'), txt(' → UI viser 0 m².')),
    h(3, 'Fix-retning'),
    p(txt('Samme fix som BIZZ-637: enrich-endpointet skal slå ejerlejligheder op via '), code('BBR_Enhed'), txt(' (specifik lejlighed) i stedet for '), code('BBR_Bygning'), txt(' (hele hovedejendommen). Fix skal også dække '), code('erhvervsAreal'), txt(' for blandet-anvendelse-ejerlejligheder.')),
    h(3, 'Relaterer'),
    ul(
      li(p(strong('BIZZ-629'), txt(' (3x To Do) — samme m²-regression på virksomhedsfanen. Begge løses når enrich-endpointet fixes for ejerlejligheder.'))),
      li(p(strong('BIZZ-637'), txt(' (Done) — indførte BBR_Enhed lookup logik, men enrich-endpointet ser ud til ikke at bruge det.'))),
    ),
    p(strong('Sender til To Do. '), txt('Layout-polish fra tidligere feedback ("9 ejendomme på egne linjer, ikke sammen med selskaber") kan addresseres som del af samme fix eller separat.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-596/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-596/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-596/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-596 → To Do':`⚠️ (${r.status})`);
