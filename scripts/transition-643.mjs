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
    h(2, 'Code-level verifikation — DELVIST, sender til To Do'),
    h(3, 'Implementeret ✅'),
    ul(
      li(p(code('allocateTokensBySource()'), txt(' ('), code('chat/route.ts:1225-1290'), txt(') — BIZZ-643 helper med prioritets-dekrement plan → bonus → topUp.'))),
      li(p(txt('Per-kilde tracking: '), code('planTokensUsed'), txt(' / '), code('bonusTokensUsed'), txt(' / '), code('topUpTokensUsed'), txt(' i '), code('app_metadata.subscription'), txt('.'))),
      li(p(txt('Backwards-compat: '), code('planTokensUsed?: number'), txt(' med default 0 for gamle subscriptions.'))),
      li(p(code('__tests__/unit/allocateTokensBySource.test.ts'), txt(' — unit-tests for hver dekrement-sti.'))),
      li(p(txt('Brugt i både normal-afslutning (linje 1670-1675) og abort-scenarier (linje 1757-1761).'))),
    ),
    h(3, 'Mangler ❌'),
    ul(
      li(p(strong('API-response indeholder ikke per-kilde-balance. '), code('planRemaining'), txt(' / '), code('bonusRemaining'), txt(' / '), code('topUpRemaining'), txt(' er kun lokale variabler i allocateTokensBySource — bliver ikke returneret i AI-chat-response. Acceptance: "API-response: Inkluder { planRemaining, bonusRemaining, topUpRemaining }".'))),
      li(p(strong('UI viser ikke balance pr. kilde. '), code('AIChatPanel.tsx'), txt(' har 0 references til '), code('planRemaining/bonusRemaining/topUpRemaining'), txt('. Acceptance: "UI viser balance pr. kilde (Plan: X, Bonus: Y, Købt: Z)".'))),
      li(p(strong('Månedsskift-reset er uklart. '), txt('Stripe webhook '), code('checkout.session.completed'), txt(' (linje 277) sætter '), code('tokensUsedThisMonth: 0'), txt(' ved NY subscription, men '), code('planTokensUsed'), txt(' nulstilles ikke eksplicit ved billing-period-skift ('), code('invoice.payment_succeeded'), txt('). Acceptance: "Månedsskift nulstiller kun plan-quota, bevarer bonus + topUp".'))),
    ),
    p(strong('Sender til To Do. '), txt('De 3 manglende dele:')),
    ul(
      li(p(txt('1. Returnér '), code('{ planRemaining, bonusRemaining, topUpRemaining }'), txt(' i AI-chat SSE-stream (evt. som første event eller i '), code('[DONE]'), txt('-block).'))),
      li(p(txt('2. Vis balance-per-source i '), code('AIChatPanel.tsx'), txt(' header eller footer ("Plan: 1.2k · Bonus: 500 · Købt: 2k").'))),
      li(p(txt('3. Implementér '), code('planTokensUsed = 0'), txt('-reset i '), code('invoice.payment_succeeded'), txt('-handler når ny billing-periode starter (check '), code('current_period_start'), txt(' ændring).'))),
    ),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-643/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-643/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-643/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-643 → To Do':`⚠️ (${r.status})`);
