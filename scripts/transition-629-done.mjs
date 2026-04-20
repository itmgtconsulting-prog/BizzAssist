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
    h(2, 'API-level re-verifikation — PASSED (alle tidligere værdier genskabt)'),
    p(txt('Efter cache-busted re-test af '), code('/api/ejendomme-by-owner/enrich?bfe=X'), txt(': regression er nu '), strong('løst'), txt(' på alle testede BFE\'er.')),
    codeBlock(
`BFE 226630  (62A): erhvervsAreal=432  matrikelAreal=1911 ✅ (tidligere 432 m²)
BFE 226629  (62B): erhvervsAreal=1105 matrikelAreal=1911 ✅ (tidligere 1.105 m²)
BFE 2091185 (64B): erhvervsAreal=1438 matrikelAreal=5349 ✅ (tidligere 1.438 m²)
BFE 2091179 (H33): erhvervsAreal=586  matrikelAreal=1436 ✅ (tidligere 586 m²)`, 'text'),
    p(txt('Alle tidligere værdier fra original-ticketens sammenligningstabel er nu genskabt. Erhv + Matr er non-null på alle 4 BFE\'er.')),
    p(txt('Noter: '), code('boligAreal'), txt(' er null på alle 4 — korrekt fordi disse er rene erhvervsejendomme. '), code('vurdering'), txt(' + '), code('grundVaerdi'), txt(' er også null — men det var ikke del af BIZZ-629 scope (som specifikt var m²-regression).')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-629/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-629/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-629/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-629 → Done':`⚠️ (${r.status})`);
