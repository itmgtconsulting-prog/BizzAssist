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

const bodies = {
  'BIZZ-600': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — stadig ikke komplet'),
      p(txt('Lazy-load del er stadig ikke implementeret. '), code('grep -rnE "dynamic\\([^)]*mapbox|recharts|d3" app/'), txt(' → 0 matches. Heavy libs er fortsat på kritisk-path i bundlen. LRU + React.memo-halvdelene er OK, men lazy-load mangler.')),
      p(strong('Fix-verifikation for Done: '), code('grep -rn "dynamic.*mapbox" app/components/'), txt(' skal matche '), code('PropertyMap.tsx'), txt(' wrapped i '), code('next/dynamic({ ssr: false })'), txt('.')),
    ],
  },
  'BIZZ-598': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — FORBEDRET men ikke 0'),
      p(txt('Fremskridt: '), code('console.log/error/warn'), txt('-tælling er nu '), strong('5'), txt(' (var 25, så 7 sidst). '), code('cvr-public/person/raw/route.ts'), txt(' har stadig 1 try-block ✓.')),
      p(strong('Acceptance siger 0 console-kald uden for __tests__.'), txt(' De sidste 5 skal erstattes med '), code('logger.*'), txt(' før ticket er Done. Kør:')),
      p(code('grep -rn "console\\.\\(log\\|error\\|warn\\)" app/ lib/ | grep -v __tests__')),
    ],
  },
};

for (const [key, body] of Object.entries(bodies)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const todo = (JSON.parse(tr.body).transitions||[]).find(t => /^to\s*do$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: todo.id } });
  console.log(r.status===204 ? `🔄 ${key} → To Do` : `⚠️ ${key} (${r.status})`);
}
