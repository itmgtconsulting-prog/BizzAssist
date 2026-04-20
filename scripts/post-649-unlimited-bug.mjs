import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);if(d)q.write(d);q.end()});}

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
    h(2, 'DB-audit + kritisk fund: -1 = "unlimited"-konvention er IKKE håndteret i decideAiGate'),
    h(3, 'DB-state (auth.users i tilgængelig Supabase)'),
    p(txt('Min '), code('.env.local'), txt(' peger på local/dev Supabase — '), code('itmgtconsulting@gmail.com'), txt(' findes '), strong('ikke'), txt(' der. Kun 3 brugere: '), code('jjrchefen@gmail.com'), txt(' (admin, ingen sub), '), code('rls-test-tenant-b'), txt(' (ingen sub), '), code('jjrchefen@hotmail.com'), txt(' (active, planId=enterprise, usedThisMonth=846.377, bonus=0, topUp=0, admin).')),
    p(txt('Prod/test-DB kræver separate credentials — men jeg fandt noget VIGTIGT i '), code('plan_configs'), txt(':')),
    codeBlock(
`plan_id       ai_tokens_per_month  is_active
demo          10000                true
basis         0                    true
professionel  50000                true
enterprise    -1                   true   ← "-1" = unlimited`, 'text'),
    h(3, 'Kritisk: "-1" = unlimited-konvention'),
    p(txt('Kode-konvention er eksplicit dokumenteret i 3 filer:')),
    ul(
      li(p(code('app/lib/subscriptions.ts:55'), txt(': '), code('/** Monthly AI token limit (0 = no AI, -1 = unlimited) */'))),
      li(p(code('app/lib/subscriptions.ts:379'), txt(': '), code('@returns Total available tokens (-1 = unlimited)'))),
      li(p(code('app/components/AIChatPanel.tsx:111+319'), txt(': '), code('// -1 means unlimited tokens'), txt(' + '), code('// Block if token limit exceeded (skip check if unlimited: -1)'))),
    ),
    p(strong('Men decideAiGate() håndterer IKKE -1: '), code('chat/route.ts:1327-1337'), txt(':')),
    codeBlock(
`const planTokens = state.planTokens ?? 0;
const effectiveLimit = planTokens + bonusTokens + topUpTokens;
if (effectiveLimit === 0) return { decision: 'zero_budget' };
if (tokensUsedThisMonth >= effectiveLimit) return { decision: 'quota_exceeded' };
return { decision: 'allow' };`, 'typescript'),
    h(3, 'Konsekvens pr. scenarie'),
    ul(
      li(p(strong('Enterprise-bruger (-1 unlimited): '), code('effectiveLimit = -1 + 0 + 0 = -1'), txt('. '), code('-1 !== 0'), txt(' → '), code('zero_budget'), txt(' skipper. '), code('846377 >= -1'), txt(' → '), code('quota_exceeded'), txt(' (429). '), strong('Wrongly blocked!'), txt(' Admin-brugere med enterprise-plan kan ikke bruge AI.'))),
      li(p(strong('basis-bruger (0 no AI): '), code('effectiveLimit = 0 + 0 + 0 = 0'), txt(' → '), code('zero_budget'), txt(' (402). Korrekt.'))),
      li(p(strong('Hvis itmgtconsulting er på (ukendt) testplan2 med '), code('ai_tokens_per_month < 0'), txt(' (fx '), code('-5'), txt(' ved data-indtastningsfejl): '), code('effectiveLimit = -5'), txt('. '), code('0 >= -5'), txt(' → '), code('quota_exceeded'), txt(' (429). Blokker men ikke via zero_budget.'))),
      li(p(strong('Hvis plan har positive tokens OG negative bonus: '), code('effectiveLimit = 1000 + (-5) + 0 = 995'), txt(' → normal quota-check.'))),
    ),
    h(3, 'Fix — håndter -1 eksplicit i decideAiGate'),
    codeBlock(
`export function decideAiGate(state) {
  const subStatus = state?.status ?? '';
  if (!state || (subStatus !== 'active' && subStatus !== 'trialing')) {
    return { decision: 'no_subscription', isTrial: false, effectiveLimit: 0 };
  }
  const planTokens = state.planTokens ?? 0;
  const bonusTokens = state.bonusTokens ?? 0;
  const topUpTokens = state.topUpTokens ?? 0;

  // BIZZ-649 edge-case: -1 = unlimited (dokumenteret konvention)
  if (planTokens === -1 || bonusTokens === -1 || topUpTokens === -1) {
    return { decision: 'allow', isTrial: subStatus === 'trialing', effectiveLimit: -1 };
  }

  const effectiveLimit = planTokens + bonusTokens + topUpTokens;
  if (effectiveLimit <= 0) {
    return { decision: 'zero_budget', isTrial: subStatus === 'trialing', effectiveLimit };
  }
  if ((state.tokensUsedThisMonth ?? 0) >= effectiveLimit) {
    return { decision: 'quota_exceeded', isTrial: subStatus === 'trialing', effectiveLimit };
  }
  return { decision: 'allow', isTrial: subStatus === 'trialing', effectiveLimit };
}`, 'typescript'),
    h(3, 'Bemærk: '), p(txt(' '), code('effectiveLimit <= 0'), txt(' (ikke '), code('=== 0'), txt(') — dækker både 0-plans OG negative edge-cases som '), code('-5'), txt(' fra data-fejl.')),
    h(3, 'Er itmgtconsulting-bypass faktisk unlimited?'),
    p(txt('Hvis '), code('itmgtconsulting@gmail.com'), txt(' er på en plan med '), code('ai_tokens_per_month === -1'), txt(' → '), strong('ja, unlimited bypasser nuværende kode via quota_exceeded-check'), txt(' (vent — nej, -1 blokeres FORKERT som '), code('quota_exceeded'), txt('). Så det er ikke det.')),
    p(strong('Mere sandsynligt: '), txt('itmgtconsulting har '), code('sub.bonusTokens > 0'), txt(' tildelt af admin. Nødvendig diagnose i prod/test-DB:')),
    codeBlock(
`SELECT email, app_metadata->'subscription'
FROM auth.users WHERE email = 'itmgtconsulting@gmail.com';`, 'sql'),
    p(strong('Giv mig et screenshot eller kopi af denne SQL-output, så kan jeg pege præcist på edge-case i decideAiGate der skal opdateres.')),
  ],
};

const c = await r('POST','/rest/api/3/issue/BIZZ-649/comment',{body});
console.log(c.status===201?'✅ DB-audit + -1 bug posted':`❌ (${c.status})`);
