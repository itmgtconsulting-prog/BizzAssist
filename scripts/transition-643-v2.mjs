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
    h(2, 'Code-level re-verifikation — PASSED (alle 3 manglende dele nu på plads)'),
    p(txt('Efter tidligere To Do-kommentar er de resterende 3 dele implementeret:')),
    ul(
      li(p(strong('✅ API-response med per-kilde-balance: '), code('chat/route.ts:1672-1674'), txt(' (normal) + '), code('1762-1764'), txt(' (abort) — SSE-streamet inkluderer nu '), code('{ planRemaining, bonusRemaining, topUpRemaining }'), txt('.'))),
      li(p(strong('✅ UI balance-per-source: '), code('AIChatPanel.tsx:86-87, 433-460, 711'), txt(' — state + SSE-parsing + display-rendering. BIZZ-643 explicit-kommentar i komponenten.'))),
      li(p(strong('✅ Månedsskift-reset: '), code('webhook/route.ts:683, 701, 711'), txt(' — '), code('invoice.payment_succeeded'), txt('-handler nulstiller '), code('planTokensUsed: 0'), txt(' + '), code('tokensUsedThisMonth: 0'), txt(' ved billing-cycle renewal. Bevarer bonus + topUp.'))),
    ),
    p(strong('Alle 5 acceptance-criteria opfyldt:')),
    ul(
      li(p(txt('✅ Tokens trækkes plan → bonus → topUp ('), code('allocateTokensBySource'), txt(')'))),
      li(p(txt('✅ Månedsskift nulstiller kun plan-quota, bevarer bonus + topUp'))),
      li(p(txt('✅ UI viser balance pr. kilde'))),
      li(p(txt('✅ Unit-tests ('), code('allocateTokensBySource.test.ts'), txt(')'))),
      li(p(txt('✅ Backwards-compat med eksisterende subscriptions'))),
    ),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-643/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-643/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-643/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-643 → Done':`⚠️ (${r.status})`);
