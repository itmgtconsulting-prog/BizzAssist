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
    h(2, 'Code-level verifikation — PASSED (efter commit 6bf71a1)'),
    ul(
      li(p(code('DiagramForce.tsx:380'), txt(' — "BIZZ-585: Personligt ejede ejendomme er typisk 100% ejet". Eksplicit ticket-reference.'))),
      li(p(code('DiagramForce.tsx:620'), txt(' — '), code('MAX_PER_ROW = 5'), txt('. Max 5 ejendomme per linje implementeret.'))),
      li(p(code('DiagramForce.tsx:749-800'), txt(' — Pass 3-layout håndterer pakning i rækker af 5, med padding hvor nødvendigt så persons/virksomheder ikke blandes på samme linje.'))),
      li(p(txt('Auto-expand fix (commit 6bf71a1): person-nodes med direkte udgående edge til main-company auto-expandes også på virksomhedsdiagram, så Jakobs personligt ejede ejendomme nu er synlige uden manuel Udvid.'))),
      li(p(txt('Edge-renderer ('), code('DiagramForce.tsx:1909'), txt(') har '), code('isPersonToProperty'), txt('-detection med stiplet emerald-styling så person→ejendom-edges skelnes visuelt fra person→virksomhed-edges.'))),
    ),
    p(strong('Acceptance-criteria opfyldt: '), txt('5 per linje ✓, stiplede emerald-linjer til person→ejendom ✓, separat linje-lag under person-noden ✓.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-585/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-585/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-585/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-585 → Done':`⚠️ (${r.status})`);
