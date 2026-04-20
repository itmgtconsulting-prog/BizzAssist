#!/usr/bin/env node
/**
 * Post reproduction-analyse til BIZZ-649 baseret på E2E-test mod test.bizzassist.dk.
 */
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
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});

const body = {
  type:'doc', version:1, content:[
    h(2, 'API-level reproduktion 2026-04-20 — gate VIRKER for test-bruger, men muligvis IKKE for itmgtconsulting@gmail.com'),
    p(strong('Vigtig observation: '), txt('jeg kan IKKE reproducere bugget som '), code('jjrchefen@gmail.com'), txt(' på test.bizzassist.dk. Gate returnerer korrekt 402 med '), code("code: 'trial_ai_blocked'"), txt('.')),
    h(3, 'Probe-resultat'),
    codeBlock(
`POST https://test.bizzassist.dk/api/ai/chat
  credentials: include
  body: { messages: [{ role: 'user', content: 'test' }] }

Response: HTTP 402 Payment Required
Body: {
  "error": "Dit abonnement har ingen AI-tokens. Køb en token-pakke eller opgrader plan for at bruge AI.",
  "code": "trial_ai_blocked",
  "cta": "buy_token_pack"
}`, 'http'),
    h(3, 'Konklusion'),
    p(strong('Fix ER deployet og virker for mindst én bruger-type.'), txt(' Hvis '), code('itmgtconsulting@gmail.com'), txt(' stadig kan bruge AI, handler det IKKE om gate-koden — handler om at netop den brugers subscription-state afviger fra '), code('plan_tokens=0 + bonus=0 + topUp=0'), txt('-scenariet.')),
    h(3, 'Mulige edge-cases der kan forklare bypass'),
    ul(
      li(p(strong('1. Plan-ID peger på anden plan: '), code('planId != testplan2'), txt(' → plan_configs.ai_tokens_per_month > 0'))),
      li(p(strong('2. Admin har tildelt '), code('bonusTokens'), txt(': '), txt('nonzero bonus → effectiveLimit > 0 → gate = '), code('allow'), txt('.'))),
      li(p(strong('3. Top-up-tokens købt: '), txt('én tidligere Stripe token_topup-transaction har populeret '), code('topUpTokens > 0'), txt('.'))),
      li(p(strong('4. Status er aktivt betalt: '), code('sub.status === \'active\''), txt(' (ikke trialing) MED plan der har tokens > 0 → korrekt adfærd, ikke bug.'))),
      li(p(strong('5. Stale session cache: '), txt('browser har cached session.app_metadata.subscription fra før plan-skift. Force-logout + re-login afslører.'))),
    ),
    h(3, 'Anbefalet diagnostik-script'),
    codeBlock(
`-- Kør i prod-Supabase SQL editor mod auth.users:
SELECT
  email,
  app_metadata->'subscription'->>'status' AS status,
  app_metadata->'subscription'->>'planId' AS plan_id,
  app_metadata->'subscription'->>'tokensUsedThisMonth' AS used,
  app_metadata->'subscription'->>'bonusTokens' AS bonus,
  app_metadata->'subscription'->>'topUpTokens' AS top_up
FROM auth.users
WHERE email = 'itmgtconsulting@gmail.com';

-- Derefter plan_configs:
SELECT plan_id, ai_tokens_per_month FROM plan_configs WHERE plan_id = '<result-fra-ovenstående>';`, 'sql'),
    h(3, 'Forventet: begge dele sammenregnet = 0'),
    p(txt('Hvis '), code('plan_configs.ai_tokens_per_month + bonus + topUp > 0'), txt(', er det '), strong('ikke'), txt(' et bug — det er korrekt billing-adfærd for bruger med positive tokens. Bekræft at rapporteren testede med præcis '), code('plan_tokens=0 + bonus=0 + topUp=0'), txt('.')),
    p(strong('Næste skridt: '), txt('kør SQL ovenfor for at afklare om det er (a) edge-case subscription-state eller (b) faktisk bypass. Hvis (a): luk som duplikat / not-a-bug. Hvis (b): reopen og send mig konkret subscription-state så jeg kan opdatere '), code('decideAiGate()'), txt(' gate-logikken.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-649/comment',{body});
console.log(c.status===201?'✅ analyse posted på BIZZ-649':`❌ (${c.status})`);
