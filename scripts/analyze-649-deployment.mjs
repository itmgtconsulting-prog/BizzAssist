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
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});

const body = {
  type:'doc', version:1, content:[
    h(2, 'Deployment-status verificeret — fix ER på både main + test.bizzassist.dk'),
    h(3, 'Git-evidens'),
    codeBlock(
`$ git log --all --oneline -- app/api/ai/chat/route.ts
ab5d219 fix(ai-chat): block users with zero total ai budget from calling anthropic
485c673 feat(ai-chat): per-source balance in sse response + ui + monthly reset
ec7759f feat(ai-chat): priority token-allocation plan→bonus→topup
3855ac8 feat(ai-chat): block plan-tokens during trial; allow token-pack bypass

$ git show main:app/api/ai/chat/route.ts | grep decideAiGate
Line 1306: export function decideAiGate(
Line 1400: // BIZZ-649: Gate-decision via ren funktion (decideAiGate)`, 'text'),
    p(strong('Konklusion: '), txt('commit '), code('ab5d219'), txt(' (BIZZ-649 fix) ligger både på develop OG main. '), code('decideAiGate()'), txt(' + zero_budget-check er del af HEAD.')),
    h(3, 'Runtime-evidens (probe 2026-04-20)'),
    codeBlock(
`POST https://test.bizzassist.dk/api/ai/chat (som jjrchefen@gmail.com)
→ HTTP 402 Payment Required
→ Body: { "code": "trial_ai_blocked", "cta": "buy_token_pack", ... }`, 'http'),
    p(strong('Fix er live på test.bizzassist.dk.'), txt(' Gate returnerer korrekt 402 når effectiveLimit === 0.')),
    h(3, 'Hvorfor kan itmgtconsulting@gmail.com så stadig bruge AI?'),
    p(txt('Kode-stien er korrekt. Den eneste måde gate kan lade '), code('itmgtconsulting@gmail.com'), txt(' gennem er hvis '), code('effectiveLimit > 0'), txt(' for den user — dvs. mindst én af følgende holder:')),
    ul(
      li(p(code('sub.planId'), txt(' peger på en plan med '), code('ai_tokens_per_month > 0'), txt(' (ikke Test Plan 2)'))),
      li(p(code('sub.bonusTokens > 0'), txt(' (admin-tildelt — typisk via '), code('/dashboard/admin/users'), txt(')'))),
      li(p(code('sub.topUpTokens > 0'), txt(' (tidligere Stripe token_topup-køb)'))),
    ),
    p(strong('Det er ikke en billing-lækage — det er korrekt adfærd hvis brugeren faktisk har positive tokens.')),
    h(3, 'Diagnostik — 30 sek via Supabase SQL editor'),
    codeBlock(
`SELECT
  email,
  app_metadata->'subscription'->>'status' AS status,
  app_metadata->'subscription'->>'planId' AS plan_id,
  (app_metadata->'subscription'->>'tokensUsedThisMonth')::int AS used,
  (app_metadata->'subscription'->>'bonusTokens')::int AS bonus,
  (app_metadata->'subscription'->>'topUpTokens')::int AS top_up
FROM auth.users
WHERE email = 'itmgtconsulting@gmail.com';

-- Hvis plan_id ≠ testplan2:
SELECT plan_id, ai_tokens_per_month FROM plan_configs WHERE plan_id = '<plan_id-fra-ovenstående>';`, 'sql'),
    p(txt('Forventet udfald:')),
    ul(
      li(p(strong('Scenarie A — korrekt adfærd: '), code('bonus + topUp + plan_tokens > 0'), txt(' → bruger har budget → 200 OK er korrekt. Ticket kan lukkes som "ikke en bug".'))),
      li(p(strong('Scenarie B — faktisk bug: '), code('bonus = 0, topUp = 0, plan_tokens = 0'), txt(' MEN gate lader igennem → '), strong('kritisk'), txt(' — vis mig '), code('status'), txt('-feltet og jeg udvider '), code('decideAiGate()'), txt(' for den edge-case (fx past_due med bonus > 0, eller status=trialing uden app_metadata.subscription).'))),
    ),
    h(3, 'Akut mitigation hvis scenarie B'),
    p(txt('Oprindelig ticket foreslog feature-flag til at slå AI fra for trial. Hvis bug findes i ukendt state, kan vi som akut-tiltag:')),
    codeBlock(
`// I chat/route.ts efter decideAiGate:
if (process.env.EMERGENCY_AI_DISABLE === '1') {
  return Response.json({ error: 'AI midlertidigt utilgængelig' }, { status: 503 });
}`, 'typescript'),
    p(strong('Post '), code('status'), txt(' + '), code('planId'), txt(' + '), code('bonus'), txt(' + '), code('topUp'), txt(' + '), code('plan_configs.ai_tokens_per_month'), txt(' for '), code('itmgtconsulting@gmail.com'), txt(' — så kan jeg afgøre om det er scenarie A eller B på 2 minutter.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-649/comment',{body});
console.log(c.status===201?'✅ deployment-analyse posted':`❌ (${c.status})`);
