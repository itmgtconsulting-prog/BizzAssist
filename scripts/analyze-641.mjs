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
const em = (s) => txt(s,[{type:'em'}]);
const code = (s) => txt(s,[{type:'code'}]);
const h = (l,t) => ({type:'heading',attrs:{level:l},content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});

const body = {
  type:'doc', version:1, content:[
    h(2, 'Kode-analyse 2026-04-20 — svar på undersøgelses-spørgsmålene'),
    h(3, 'Q1: Findes UI til at købe token-pakker separat? ✅ JA'),
    ul(
      li(p(code('app/dashboard/tokens/TokensPageClient.tsx'), txt(' — route '), code('/dashboard/tokens'), txt(' viser saldo + "køb flere tokens"-CTA ("Se dit tokenforbrug og køb flere tokens").'))),
      li(p(txt('Klik på køb-knap → POST '), code('/api/stripe/create-topup-checkout'), txt(' → Stripe Checkout åbnes.'))),
      li(p(txt('Terms ('), code('app/terms/TermsPageClient.tsx:389-404'), txt(') nævner "token packs as one-time purchases".'))),
    ),
    h(3, 'Q2: Virker Stripe-flowet for enkeltkøb? ✅ JA'),
    ul(
      li(p(code('app/api/stripe/create-topup-checkout/route.ts:79'), txt(' — '), code('mode: \'payment\''), txt(' (ikke subscription) = one-time payment.'))),
      li(p(code('app/api/stripe/webhook/route.ts:217-219'), txt(' — modtager '), code('session.metadata.type === \'token_topup\''), txt(' og kalder '), code('handleTokenTopUp()'), txt('.'))),
      li(p(code('handleTokenTopUp()'), txt(' ved linje 924-955: tilføjer '), code('tokenAmount'), txt(' til brugerens '), code('app_metadata.subscription.topUpTokens'), txt('. Akkumulativ balance på tværs af flere køb.'))),
    ),
    h(3, 'Q3: Dekrementerer /api/ai/chat korrekt token-balance fra token_packs? ❌ NEJ — BUG IDENTIFICERET'),
    p(strong('Dette er kernen af BIZZ-641.'), txt(' Der er 2 konkrete problemer:')),
    h(3, 'Problem 1: Trial-brugere blokeres uanset token-pakke-saldo'),
    p(code('app/api/ai/chat/route.ts:1250'), txt(' har hard-gate:')),
    codeBlock(
`if (!sub || sub.status !== 'active') {
  return Response.json(
    { error: 'Aktivt abonnement kræves for at bruge AI-assistenten' },
    { status: 403 }
  );
}`, 'typescript'),
    p(txt('Alle brugere med '), code('status = \'trialing\''), txt(' eller '), code('\'past_due\''), txt(' m.fl. rammes. Dette '), strong('blokerer også trial-brugere der HAR købt token-pakke'), txt(' — imod BIZZ-641\'s acceptance-criterium "Bruger på trial MED token-pakke: kan bruge AI".')),
    h(3, 'Problem 2: topUpTokens læses aldrig i AI-chat'),
    p(txt('AI-chat ved linje 1259-1272 checker:')),
    codeBlock(
`const tokensUsedThisMonth = sub.tokensUsedThisMonth ?? 0;
const bonusTokens = sub.bonusTokens ?? 0;
effectiveTokenLimit = (planRow?.ai_tokens_per_month ?? 0) + bonusTokens;`, 'typescript'),
    p(txt('Men webhook\'s '), code('handleTokenTopUp()'), txt(' skriver til '), code('topUpTokens'), txt(' — '), strong('ikke'), txt(' '), code('bonusTokens'), txt('. De 2 felter er separate konti.')),
    p(txt('Resultat: selv hvis trial-gaten åbnes, bliver '), code('topUpTokens'), txt(' '), strong('ikke'), txt(' brugt som fallback når plan-quota er opbrugt. Ingen dekrement-logik mod '), code('topUpTokens'), txt(' findes.')),
    h(3, 'Teknisk fix-plan'),
    p(txt('1. Lempe trial-gate (linje 1250) til også at tillade '), code('trialing'), txt(' hvis '), code('topUpTokens > 0'), txt(':')),
    codeBlock(
`const topUpTokens = sub.topUpTokens ?? 0;
const hasTopUp = topUpTokens > 0;
if (!sub || (sub.status !== 'active' && !hasTopUp)) {
  return Response.json(
    { error: 'Aktivt abonnement eller token-pakke kræves for AI' },
    { status: 403 }
  );
}`, 'typescript'),
    p(txt('2. Ved quota-check: hvis plan-quota opbrugt eller status=trialing, falder tilbage til '), code('topUpTokens'), txt(':')),
    codeBlock(
`const planAvailable = sub.status === 'active' &&
  effectiveTokenLimit > tokensUsedThisMonth;
const topUpAvailable = topUpTokens > 0;
if (!planAvailable && !topUpAvailable) {
  return Response.json({ error: 'Token kvote opbrugt' }, { status: 429 });
}`, 'typescript'),
    p(txt('3. Efter AI-kald: dekrementer den kilde der blev brugt. '), strong('Primær kilde er plan-quota hvis aktiv, ellers topUpTokens. '), txt('Skriv tilbage til '), code('app_metadata.subscription.topUpTokens'), txt(' hvis det blev brugt.')),
    p(txt('4. UX: i '), code('AIChatPanel.tsx'), txt(' — vis token-kilde og saldo. Under trial uden top-up: vis CTA til '), code('/dashboard/tokens'), txt(' med besked om at AI er låst indtil abonnement starter.')),
    h(3, 'Filer der skal ændres'),
    ul(
      li(p(code('app/api/ai/chat/route.ts'), txt(' — trial-gate + dual-balance token-deduct-logik (linje 1250-1272 + 1573 + 1652 hvor '), code('tokensUsedThisMonth'), txt(' opdateres)'))),
      li(p(code('app/components/AIChatPanel.tsx'), txt(' — UX: token-source indicator + trial-CTA'))),
      li(p(code('app/lib/subscriptions.ts'), txt(' — tilføj '), code('topUpTokens'), txt(' felt i '), code('Subscription'), txt('-type hvis mangler'))),
      li(p(txt('E2E-test: 3 scenarier per acceptance-criteria'))),
    ),
    h(3, 'Grace-periode-interaktion (BIZZ-641 risiko-afsnit)'),
    p(txt('BIZZ-541 grace_timer: status kan være '), code('active'), txt(' med '), code('grace_until > now'), txt(' selv efter fejlet betaling. Plan-quota skal fortsat virke i grace-perioden — fix skal '), strong('kun'), txt(' tilføje fallback til topUpTokens, ikke ændre adfærd for grace-active subscriptions.')),
    h(3, 'Relaterede tickets'),
    ul(
      li(p(strong('BIZZ-636'), txt(' (Done) — admin kan nu oprette planer med gratis_dage; skemaet er klar.'))),
      li(p(strong('BIZZ-544'), txt(' (On Hold) — Stripe webhook prod-switch; skal gennemføres før BIZZ-641 kan launches.'))),
      li(p(strong('BIZZ-189'), txt(' — verificér at fixet ikke åbner nye misbrug-vektorer (fx dobbelt-dekrement hvis både plan og topUp forsøges).'))),
    ),
    p(em('Analyse udført 2026-04-20. Alle filpaths + linjenumre verificeret mod nuværende develop-branch.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-641/comment',{body});
console.log(c.status===201?'✅ analyse posted på BIZZ-641':`❌ (${c.status})`);
