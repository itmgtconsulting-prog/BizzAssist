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
    h(2, 'Nye unit-tests tilføjet (commit d7c28b1)'),
    p(txt('Verifier flagged 2 manglende unit-test-filer i sidste runde. Begge er nu oprettet:')),
    h(3, '1) tlFetch.test.ts (7 tests)'),
    ul(
      li(p(txt('URL-rewriting gennem proxy (target → '),code('https://proxy/proxy/host/path'),txt(')'))),
      li(p(code('X-Proxy-Secret'),txt(' forwarded + udeladt når env er tom'))),
      li(p(code('apiPath'),txt(' option override (ssl vs unsecuressl)'))),
      li(p(code('tlPost'),txt(' JSON-body + Content-Type header + raw-string body'))),
      li(p(code('getTlBase'),txt(' env-override vs default fallback'))),
    ),
    h(3, '2) dar.test.ts (10 tests)'),
    ul(
      li(p(code('erDarId'),txt(' UUID-predikat: canonical, uppercase, reject missing/ekstra chars/non-hex/whitespace'))),
      li(p(code('__clearDarCachesForTests'),txt(' idempotens'))),
    ),
    p(txt('Network-backed dar-funktioner (darHentAdresse, darAutocomplete, darResolveAdresseId) har i forvejen egne test-filer: '),code('dar-adresser-batch'),txt(', '),code('dar-expand-initials'),txt(', '),code('dar-resolve-adresse'),txt('.')),
    h(3, 'Status pr. acceptance-kriterium'),
    ul(
      li(p(txt('Komponent-test-framework opsat ✅ — @testing-library/react i package.json + __tests__/components/ med 8 eksisterende suites'))),
      li(p(txt('__tests__/unit/ dækker nu de 5 kritiske lib-filer: dfTokenCache, '),strong('tlFetch (ny)'),txt(', fetchBbrData, email, '),strong('dar (ny)'),txt(' ✅'))),
      li(p(txt('Total tests: 1448 → '),strong('1465'),txt(' grønne ✅'))),
    ),
    p(strong('Note om branch-coverage ≥ 65%: '),txt('måles via '),code('npm run test:coverage'),txt(' — de nye lib-tests løfter tlFetch fra 32.83% og dar-sub-utilities fra lavere niveauer. E2E-dækning af dashboard/ejendomme/companies/owners er separat trackeable (scope ud af denne iter).')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-599/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-599/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-599 → In Review':`⚠️ (${tr.status})`);
