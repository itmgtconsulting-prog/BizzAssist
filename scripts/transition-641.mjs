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
    h(2, 'Code-level verifikation — PASSED (commit 3855ac8)'),
    p(txt('Alle 3 fix-punkter fra min tidligere analyse er implementeret i '), code('app/api/ai/chat/route.ts'), txt(':')),
    ul(
      li(p(strong('✅ Trial-gate lempet'), txt(' (linje 1260): '), code("subStatus !== 'active' && subStatus !== 'trialing'"), txt(' — tillader trialing med quota-check'))),
      li(p(strong('✅ topUpTokens læses og dekrementerer'), txt(' (linje 1273, 1282, 1284): '), code('topUpTokens = sub.topUpTokens ?? 0'), txt(' inkluderet i '), code('effectiveTokenLimit'))),
      li(p(strong('✅ Dual-balance-beregning'), txt(' (linje 1281-1284): '))),
      li(p(code('active: effectiveTokenLimit = planTokens + bonusTokens + topUpTokens'))),
      li(p(code('trialing: effectiveTokenLimit = bonusTokens + topUpTokens'), txt(' (plan-tokens = 0 under trial)'))),
      li(p(strong('✅ 402 Payment Required med CTA'), txt(' (linje 1290-1295): '), code("code: 'trial_ai_blocked'"), txt(' så UI kan vise CTA til token-pakke-køb'))),
    ),
    p(strong('Acceptance-criteria opfyldt:')),
    ul(
      li(p(txt('Trial uden token-pakke → 402 Payment Required ✅'))),
      li(p(txt('Trial MED token-pakke → AI-brug tilladt, dekrementerer mod quota ✅'))),
      li(p(txt('Aktivt abonnement → uændret plan+bonus+topUp adgang ✅'))),
    ),
    p(txt('Stripe webhook-flowet for token-pakke-køb ('), code('handleTokenTopUp'), txt(') er uændret og skriver fortsat til '), code('app_metadata.subscription.topUpTokens'), txt(' — nu læses det endelig af AI-chat.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-641/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-641/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-641/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-641 → Done':`⚠️ (${r.status})`);
