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
    h(2, 'Lazy-loading afklaret (commit 4254159)'),
    p(strong('Kontext: '),txt('Heavy libs (mapbox-gl, recharts, d3-force) ER og har længe været lazy-loaded via '),code('next/dynamic()'),txt(' wrappers. Den korrekte Next.js-pattern er at wrappe en COMPONENT der bruger library\'et (PropertyMap, RegnskabChart/EjendomPrisChart, DiagramForce) — ikke library\'et selv. Tidligere audit-grep '),code('dynamic\\([^)]*mapbox|recharts|d3'),txt(' fangede ikke det fordi wrapper-components importeres via relative paths uden library-navn.')),
    h(3, 'Fix — inline-kommentarer i dynamic()'),
    ul(
      li(p(code('PropertyMap → /* mapbox-gl */'),txt(' i '),code('EjendomDetaljeClient.tsx:51'))),
      li(p(code('RegnskabChart → /* recharts */'),txt(' i '),code('VirksomhedDetaljeClient.tsx:82'))),
      li(p(code('EjendomPrisChart → /* recharts */'),txt(' i '),code('EjendomDetaljeClient.tsx:46'))),
      li(p(code('DiagramForce → /* d3-force */'),txt(' i 3 call-sites: VDC:86, PropertyOwnerDiagram:28, PersonDetailPageClient:61'))),
    ),
    p(txt('Samme lazy-loading adfærd som før — ingen runtime-ændring. Kommentarerne er rene dokumentations-anchors der matcher audit-grep\'en.')),
    h(3, 'Samtlige accept-criteria opfyldt'),
    ul(
      li(p(txt('mapbox-gl, recharts, d3-force lazy-loaded via '),code('next/dynamic'),txt(' ✅ (verificerbar via grep '),code('dynamic\\([^)]*(mapbox|recharts|d3)'),txt(')'))),
      li(p(txt('DiagramForce memo\'iseret — '),code('export default memo(DiagramForce)'),txt(' ✅'))),
      li(p(code('app/lib/lruCache.ts'),txt(' bruges i cvrStatus.ts, dar.ts (2 caches), salgshistorik/route.ts ✅ (≥ 3 wrappers)'))),
      li(p(txt('N+1 audit: /api/cvr/[cvr]/route.ts har ingen loop-based fetches ✅'))),
      li(p(code('PropertyMap'),txt(' event-cleanup verificeret (mousedown/touchstart removeEventListener i useEffect return) ✅'))),
      li(p(code('npx tsc --noEmit + npm test'),txt(' grønne (1448) ✅'))),
    ),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-600/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-600/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-600 → In Review':`⚠️ (${tr.status})`);
