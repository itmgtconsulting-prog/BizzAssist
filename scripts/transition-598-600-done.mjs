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
      h(2, 'Code-level re-verifikation — PASSED (alle 3 heavy libs lazy-loaded)'),
      ul(
        li(p(strong('✅ Mapbox: '), code('app/dashboard/kort/KortDynamicLoader.tsx:14'), txt(' — "Lazy-loaded to keep mapbox-gl out of the server bundle". Bruger '), code('nextDynamic(() => import(\'./KortPageClient\'), { ssr: false })'), txt('.'))),
        li(p(strong('✅ Recharts: '), code('VirksomhedDetaljeClient.tsx:82'), txt(' RegnskabChart + '), code('EjendomDetaljeClient.tsx:46'), txt(' EjendomPrisChart dynamic-imports med '), code('/* recharts */'), txt(' annotation.'))),
        li(p(strong('✅ D3-force: '), txt('DiagramForce dynamic-importet 3 steder — '), code('VirksomhedDetaljeClient.tsx:86'), txt(', '), code('PropertyOwnerDiagram.tsx:29'), txt(', '), code('PersonDetailPageClient.tsx:62'), txt(' — alle med '), code('/* d3-force */'), txt(' annotation og '), code('ssr: false'), txt('.'))),
        li(p(strong('✅ LRU cache: '), code('app/lib/lruCache.ts'), txt(' brugt i '), code('cvrStatus'), txt(', '), code('dar'), txt(', '), code('salgshistorik'), txt(' + egen impl i '), code('PropertyMap.tsx'), txt('.'))),
        li(p(strong('✅ React.memo: '), code('DiagramForce.tsx:2629'), txt(' '), code('export default memo(DiagramForce)'), txt('.'))),
      ),
      p(txt('Alle 5 acceptance-punkter opfyldt. Bundle-optimering landet.')),
    ],
  },
  'BIZZ-598': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — PASSED'),
      ul(
        li(p(strong('✅ Try/catch: '), code('cvr-public/person/raw/route.ts'), txt(' har nu 1 try-block (var 0). Alle 8 produktions-ruter er dækket.'))),
        li(p(strong('✅ Console.log: '), code('grep -rnE "\\bconsole\\.(log|error|warn|info|debug)" app/ lib/ | grep -v __tests__'), txt(' → '), strong('0 matches'), txt('. Acceptance om 0 console-kald uden for tests er opfyldt.'))),
      ),
      p(txt('Mine tidligere tællinger (25 → 7 → 5) var falske positiver — grep matchede '), code('console.'), txt(' som prefix også i doc-kommentarer og URL-strings ('), code('console.upstash.com'), txt(', '), code('console.anthropic.com'), txt(' m.fl.). Strikt grep efter '), code('console.log/error/warn/info/debug'), txt(' returnerer 0.')),
    ],
  },
};

for (const [key, body] of Object.entries(bodies)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions||[]).find(t => /^done$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: done.id } });
  console.log(r.status===204 ? `✅ ${key} → Done` : `⚠️ ${key} (${r.status})`);
}
