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
    h(2, '🚨 ROOT CAUSE FUNDET — 7 AI-endpoints bypasser gate (KRITISK billing-lækage)'),
    p(strong('decideAiGate er kun wired op til '), code('/api/ai/chat'), strong('. De 7 andre AI-endpoints kalder Anthropic direkte uden gate:')),
    codeBlock(
`Endpoint                                  Anthropic-calls  decideAiGate?
/api/ai/chat                              4                ✅ JA
/api/ai/article-search                    4                ❌ NEJ
/api/ai/person-article-search             5                ❌ NEJ
/api/ai/person-search/socials             3                ❌ NEJ
/api/ai/person-search/contacts            4                ❌ NEJ
/api/ai/person-search/articles            3                ❌ NEJ
/api/analysis/run                         5                ❌ NEJ
/api/support/chat                         8                ❌ NEJ`, 'text'),
    h(3, 'DB-verifikation for itmgtconsulting@gmail.com (test-Supabase)'),
    p(txt('Queriede test-DB ('), code('rlkjmqjxmkxuclehbrnl'), txt(') via Management API:')),
    codeBlock(
`SELECT raw_app_meta_data->'subscription' FROM auth.users
WHERE email = 'itmgtconsulting@gmail.com';
→ {
    "planId": "testplan2",
    "status": "active",           ← ikke trialing!
    "isPaid": false,
    "bonusTokens": 0,
    "tokensUsedThisMonth": 0
  }

SELECT * FROM plan_configs WHERE plan_id = 'testplan2';
→ { ai_tokens_per_month: 0, price_dkk: 10 }

isAdmin: null (IKKE admin)`, 'sql'),
    p(strong('decideAiGate trace: '), code('planTokens=0, bonus=0, topUp=0 → effectiveLimit=0 → zero_budget → 402'), txt('. '), code('/api/ai/chat'), txt(' blokerer korrekt. MEN de 7 andre endpoints har ingen tilsvarende gate → Anthropic-kald gennemføres → billing-lækage.')),
    h(3, 'Sådan reproducerer man bypass'),
    p(txt('Som '), code('itmgtconsulting@gmail.com'), txt(' på test.bizzassist.dk:')),
    ul(
      li(p(code('POST /api/ai/chat'), txt(' → 402 Payment Required ✅ (gate virker)'))),
      li(p(code('POST /api/ai/article-search'), txt(' → 200 OK + Anthropic-kald ❌ (bypass)'))),
      li(p(code('POST /api/analysis/run'), txt(' → 200 OK + Anthropic-kald ❌ (bypass)'))),
      li(p(code('POST /api/ai/person-search/socials'), txt(' → samme'))),
    ),
    h(3, 'Fix — ekstraher gate til middleware eller delt helper'),
    p(strong('Option A (hurtigt): '), txt('kald '), code('decideAiGate()'), txt(' som første linje i alle 7 endpoints — copy/paste af block fra '), code('/api/ai/chat:1400-1437'), txt('.')),
    p(strong('Option B (robust): '), txt('udtræk til '), code('app/lib/aiGate.ts'), txt(' som '), code('export async function assertAiAllowed(userId): Promise<Response | null>'), txt(' — hvis returnerer non-null Response, returnér den som handler-response. Alle AI-endpoints kalder den som første led.')),
    codeBlock(
`// app/lib/aiGate.ts
import { createAdminClient } from '@/lib/supabase/admin';
import { decideAiGate } from '@/app/api/ai/chat/route';
import * as Sentry from '@sentry/nextjs';

/** Kald først i alle Anthropic-ramte endpoints. Returnerer Response hvis blokeret, ellers null. */
export async function assertAiAllowed(userId: string): Promise<Response | null> {
  const admin = createAdminClient();
  const { data: user } = await admin.auth.admin.getUserById(userId);
  const meta = user?.user?.app_metadata ?? {};
  const sub = meta.subscription ?? {};
  const isAdmin = meta.isAdmin === true;

  // Admin-bypass (policy)
  if (isAdmin) return null;

  let planTokens = 0;
  if (sub.planId) {
    const { data: planRow } = await admin.from('plan_configs')
      .select('ai_tokens_per_month').eq('plan_id', sub.planId).single();
    planTokens = sub.status === 'trialing' ? 0 : (planRow?.ai_tokens_per_month ?? 0);
    if (planTokens === -1) return null; // unlimited
  }

  const gate = decideAiGate({
    status: sub.status, tokensUsedThisMonth: sub.tokensUsedThisMonth ?? 0,
    planTokens, bonusTokens: sub.bonusTokens ?? 0, topUpTokens: sub.topUpTokens ?? 0,
  });
  if (gate.decision === 'allow') return null;

  if (gate.decision === 'no_subscription') return Response.json({ error: 'Aktivt abonnement kræves' }, { status: 403 });
  if (gate.decision === 'quota_exceeded') return Response.json({ error: 'Token kvote opbrugt' }, { status: 429 });
  if (gate.decision === 'zero_budget') {
    Sentry.addBreadcrumb({ category: 'billing', message: 'AI blocked: zero_budget', level: 'info', data: { userId } });
    return Response.json({ error: 'Ingen AI-tokens', code: 'trial_ai_blocked', cta: 'buy_token_pack' }, { status: 402 });
  }
  return null;
}

// Brug i ALLE 7 bypass-endpoints:
export async function POST(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked;
  // ... eksisterende logik
}`, 'typescript'),
    h(3, 'Akut mitigation (2 minutter)'),
    p(txt('Indtil gate er wired op til alle 7 endpoints — sæt '), code('EMERGENCY_AI_DISABLE=1'), txt(' i Vercel test+prod env. Hvert endpoint bør tjekke og returnere 503.')),
    h(3, 'Estimeret cost-impact'),
    p(txt('En enkelt '), code('/api/analysis/run'), txt(' kald (due diligence) kan forbruge 10.000-50.000 Anthropic-tokens (~$0.05-0.25). Hvis trial-brugere kan køre fx 20 analyser i deres gratis periode = ~$1-5/bruger i ren Anthropic-cost. Ved 100 misbrugs-brugere ~$100-500/måned.')),
  ],
};

const c = await r('POST','/rest/api/3/issue/BIZZ-649/comment',{body});
console.log(c.status===201?'✅ ROOT CAUSE posted på BIZZ-649':`❌ (${c.status}) ${c.body.slice(0,200)}`);
