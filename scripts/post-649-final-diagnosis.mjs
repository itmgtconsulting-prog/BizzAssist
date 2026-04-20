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
    h(2, 'Samlet diagnose efter user-feedback — 2 bugs identificeret'),
    p(strong('Baggrund: '), code('itmgtconsulting@gmail.com'), txt(' er admin-bruger OG skal kunne bypass gate. Mine credentials peger på dev/test Supabase ('), code('wkzwxfhyfmvglrqtmebw'), txt(') som kun har 3 brugere — prod Supabase er separat og kræver andre credentials.')),
    h(3, '🐛 Bug 1: Ingen eksplicit admin-bypass i decideAiGate'),
    p(txt('Grep efter '), code('isAdmin'), txt(' / '), code('admin.*bypass'), txt(' i '), code('chat/route.ts'), txt(' → '), strong('0 matches'), txt('. Gate bruger kun '), code('sub.status + planTokens + bonus + topUp'), txt(' — admin-flag fra '), code('app_metadata.isAdmin'), txt(' ignoreres.')),
    p(strong('Hvis policy er "admin bypasser altid": '), txt('tilføj eksplicit early-return i gate:')),
    codeBlock(
`export function decideAiGate(state, opts?: { isAdmin?: boolean }) {
  // BIZZ-649: Admin-brugere bypasser gate — internt team skal kunne bruge AI
  // til test/support uden plan-config.
  if (opts?.isAdmin) {
    return { decision: 'allow', isTrial: false, effectiveLimit: -1, reason: 'admin_bypass' };
  }
  // … eksisterende logik …
}

// Caller i POST-handler (efter linje 1387):
const isAdmin = (existingMeta as any)?.isAdmin === true;
const gate = decideAiGate({ ... }, { isAdmin });`, 'typescript'),
    h(3, '🐛 Bug 2: "-1 = unlimited"-konvention håndteres IKKE i gate'),
    p(txt('Dokumenteret konvention ('), code('subscriptions.ts:55'), txt(' + '), code('AIChatPanel.tsx:319'), txt('): '), code('ai_tokens_per_month === -1'), txt(' betyder unlimited. Men '), code('decideAiGate()'), txt(' behandler -1 som normalt tal → '), code('effectiveLimit = -1'), txt(' → '), code('tokensUsedThisMonth >= -1'), txt(' er true → returnerer '), code('quota_exceeded'), txt(' (429).')),
    p(strong('Effekt: '), txt('enterprise-plan med '), code('-1'), txt(' er pt. '), strong('wrongly blocked'), txt(' for aktive brugere. Ikke en billing-lækage (fail-closed), men funktionsfejl for enterprise-kunder.')),
    p(strong('Fix: '), txt('special-case -1 i gate:')),
    codeBlock(
`const planTokens = state.planTokens ?? 0;
const bonusTokens = state.bonusTokens ?? 0;
const topUpTokens = state.topUpTokens ?? 0;

// BIZZ-649: -1 = unlimited (dokumenteret konvention)
if (planTokens === -1 || bonusTokens === -1 || topUpTokens === -1) {
  return { decision: 'allow', isTrial: subStatus === 'trialing', effectiveLimit: -1 };
}

const effectiveLimit = planTokens + bonusTokens + topUpTokens;
if (effectiveLimit <= 0) {  // fra === 0 til <= 0 for at fange negative edge-cases
  return { decision: 'zero_budget', ... };
}`, 'typescript'),
    h(3, 'Anbefalet handlings-rækkefølge'),
    ul(
      li(p(txt('1. Tilføj '), code('isAdmin'), txt('-parameter til '), code('decideAiGate()'), txt(' med early-return — løser itmgtconsulting-case direkte.'))),
      li(p(txt('2. Special-case '), code('-1'), txt(' som unlimited — fixer enterprise-kunder.'))),
      li(p(txt('3. Skift '), code('effectiveLimit === 0'), txt(' til '), code('effectiveLimit <= 0'), txt(' — fanger negative edge-cases fra data-fejl.'))),
      li(p(txt('4. Opdatér '), code('decideAiGate.test.ts'), txt(' med 3 nye test-cases: admin-bypass, unlimited-plan, negative edge-case.'))),
    ),
    h(3, 'Hvis du vil have mig til at undersøge videre i prod-DB'),
    p(txt('Send '), code('SUPABASE_URL'), txt(' + '), code('SUPABASE_SERVICE_ROLE_KEY'), txt(' for prod-miljøet, eller kør denne SQL og paste output:')),
    codeBlock(
`SELECT email, app_metadata->'subscription', app_metadata->>'isAdmin'
FROM auth.users WHERE email = 'itmgtconsulting@gmail.com';`, 'sql'),
  ],
};

const c = await r('POST','/rest/api/3/issue/BIZZ-649/comment',{body});
console.log(c.status===201?'✅ samlet diagnose posted':`❌ (${c.status})`);
