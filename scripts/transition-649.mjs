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
    h(2, 'Code-level verifikation — PASSED (P0 billing-gate implementeret)'),
    ul(
      li(p(strong('Pure gate-funktion: '), code('decideAiGate()'), txt(' i '), code('chat/route.ts:1306'), txt(' med eksplicit BIZZ-649-kommentar. Returnerer 1 af 4 decisions: '), code('allow'), txt(' / '), code('no_subscription'), txt(' / '), code('quota_exceeded'), txt(' / '), code('zero_budget'), txt('.'))),
      li(p(strong('Zero-budget detection: '), code('if (effectiveLimit === 0)'), txt(' (linje 1332) — når '), code('planTokens + bonusTokens + topUpTokens === 0'), txt(' returneres '), code('zero_budget'), txt(' uden Anthropic-kald.'))),
      li(p(strong('POST-handler bruger gate FØR Anthropic: '), code('chat/route.ts:1400-1437'), txt(' — '), code('zero_budget'), txt(' → 402 Payment Required med '), code("code: 'trial_ai_blocked'"), txt(' + Sentry-breadcrumb for audit.'))),
      li(p(strong('Unit-tests: '), code('__tests__/unit/decideAiGate.test.ts'), txt(' — eksplicit "BIZZ-649 P0 billing gate"-describe. Dækker '), code('null/undefined'), txt(', ikke-aktive statuses, alle gate-permutationer.'))),
    ),
    p(strong('Billing-lækage lukket: '), txt('bruger med plan_tokens=0 + bonus=0 + topUp=0 rammer nu '), code('zero_budget'), txt(' og får 402 '), strong('før'), txt(' Anthropic-kaldet. Test Plan 2-scenariet (1 dag trial, 0 tokens/md) er dækket.')),
    p(strong('Produktions-launch kan frigives når denne er deployet.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-649/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-649/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-649/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-649 → Done':`⚠️ (${r.status})`);
