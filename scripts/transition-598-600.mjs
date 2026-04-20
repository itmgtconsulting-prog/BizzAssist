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

const bodies = {
  'BIZZ-600': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — DELVIST, sender til To Do'),
      ul(
        li(p(strong('✅ LRU cache'), txt(': '), code('app/lib/lruCache.ts'), txt(' bruges i 3 libs ('), code('cvrStatus'), txt(', '), code('dar'), txt(', '), code('salgshistorik'), txt('). PropertyMap har også egen LRUCache(150).'))),
        li(p(strong('✅ React.memo'), txt(': '), code('DiagramForce.tsx:2629'), txt(' — '), code('export default memo(DiagramForce)'))),
        li(p(strong('❌ Lazy-load'), txt(': Grep efter '), code('dynamic(...mapbox|recharts|d3)'), txt(' → '), strong('0 matches'), txt('. Heavy libs er stadig ikke wrappet i '), code('next/dynamic({ ssr: false })'), txt('. Bundle-besparelsen (100KB+) er ikke opnået.'))),
      ),
      p(strong('Sender til To Do. '), txt('Verifikation for Done: '), code('grep -rnE "dynamic\\(...mapbox|recharts|d3" app/'), txt(' skal have matches, og '), code('npm run build'), txt(' skal vise reduceret first-load JS.')),
    ],
  },
  'BIZZ-598': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — DELVIST, sender til To Do'),
      ul(
        li(p(strong('✅ Try/catch'), txt(': 7 af 8 routes har try-blocks nu. '), code('app/api/cvr-public/person/raw/route.ts'), txt(' mangler stadig '), strong('0 try-blocks'), txt('.'))),
        li(p(strong('❌ console.log'), txt(': '), strong('25 forekomster'), txt(' af '), code('console.log/error/warn'), txt(' i '), code('app/'), txt(' og '), code('lib/'), txt(' (uden for __tests__) — acceptance siger 0.'))),
      ),
      p(strong('Sender til To Do. '), txt('Verifikation for Done:')),
      ul(
        li(p(code('grep -c "try {" app/api/cvr-public/person/raw/route.ts'), txt(' ≥ 1'))),
        li(p(code('grep -r "console\\." app/ lib/ | grep -v __tests__ | wc -l'), txt(' = 0'))),
      ),
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
