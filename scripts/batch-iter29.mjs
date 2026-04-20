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

const toTodo = {
  'BIZZ-629': {
    type:'doc', version:1, content:[
      h(2, 'API-level re-verifikation — uændret, sender til To Do (4. gang)'),
      p(txt('/api/ejendomme-by-owner/enrich: BFE 226629/226630 (62A/62B ejerlejligheder) returnerer stadig null på alle areal-felter. BFE 2091185/2091179 (SFE\'er) har erhvervsAreal men ikke boligAreal. Ingen ændring siden forrige verifikation. Fix skal specifikt håndtere ejerlejligheder via BBR_Enhed (jf. BIZZ-637).')),
    ],
  },
  'BIZZ-633': {
    type:'doc', version:1, content:[
      h(2, 'API-level re-verifikation — uændret, sender til To Do (4. gang)'),
      p(txt('/api/salgshistorik: stadig '), code('handler.length: 0'), txt(' med fejl '), code('"EJFCustom_EjerskabBegraenset query fejlede"'), txt(' på alle 3 testede BFE\'er (425479, 226629, 100165718). Ingen ændring. Query-shape mod EJFCustom-endpointet fejler.')),
    ],
  },
  'BIZZ-600': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — uændret, sender til To Do (3. gang)'),
      p(txt('Heavy libs er stadig ikke lazy-loaded. '), code('grep -rnE "dynamic\\([^)]*mapbox|recharts|d3"'), txt(' → 0 matches. LRU + React.memo-halvdelene er stadig OK, men '), strong('lazy-load-halvdelen mangler'), txt('. Samme tilstand som sidst.')),
    ],
  },
  'BIZZ-598': {
    type:'doc', version:1, content:[
      h(2, 'Code-level re-verifikation — FORBEDRET men ikke Done (3. gang)'),
      p(txt('Fremskridt: '), code('cvr-public/person/raw/route.ts'), txt(' har nu 1 try-block ✅. '), code('console.log'), txt('-tælling er faldet fra 25 til '), strong('7'), txt(' — stort fremskridt, men acceptance siger 0.')),
      p(txt('De sidste 7 console.log-kald skal erstattes med '), code('logger.error/log'), txt(' før ticket er Done. Kør '), code('grep -rn "console\\." app/ lib/ | grep -v __tests__'), txt(' for at finde dem.')),
    ],
  },
};

for (const [key, body] of Object.entries(toTodo)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} (${c.status})`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const todo = (JSON.parse(tr.body).transitions||[]).find(t => /^to\s*do$/i.test(t.name));
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: todo.id } });
  console.log(r.status===204 ? `🔄 ${key} → To Do` : `⚠️ ${key} (${r.status})`);
}

// BIZZ-621: inconclusive
const bizz621 = {
  type:'doc', version:1, content:[
    h(2, 'Re-verifikation — INKONKLUSIV (admin-only endpoint)'),
    p(txt('/api/admin/cron-status returnerer HTTP 403 for ikke-admin test-bruger (korrekt auth-adfærd — ikke længere crash til 500). Kan ikke verificere admin-path fra E2E-session.')),
    p(strong('Anbefaler manuel browser-QA: '), txt('åbn '), code('/dashboard/admin/cron-status'), txt(' som admin — hvis den viser cron-liste uden HTTP 500, er fix landet. Tidligere screenshot fra brugeren viste HTTP 500-fejl, så dette kræver ny manuel verifikation.')),
  ],
};
const c = await req('POST', '/rest/api/3/issue/BIZZ-621/comment', { body: bizz621 });
console.log(c.status===201 ? `📝 BIZZ-621 inkonklusiv-kommentar — forbliver In Review` : `❌ BIZZ-621 (${c.status})`);
