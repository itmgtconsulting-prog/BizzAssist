#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...b) => ({ type: 'doc', version: 1, content: b });

async function postAndTransition(key, body, target) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => new RegExp(`^${target}$`, 'i').test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → ${target}` : `  ⚠️ ${r.status}`);
  }
}

// BIZZ-732 → PASS → Done
await postAndTransition('BIZZ-732', doc(
  h(2, 'Playwright-verifikation — PASS'),
  p(strong('Test: '), txt('naviger til '), code('/dashboard/companies/41092907'), txt(' (JaJR Holding), observér API-kald over 8s uden at klikke nogen tab.')),
  cb(
`Prefetch-timing (målt fra mount-til-request):
  /api/cvr-public/related   @ +2738ms  ✅
  /api/salgshistorik/cvr    @ +2745ms  ✅
  /api/ejendomme-by-owner   @ +3300-3800ms  ✅ (pr. CVR datterselskab)

Tab stadig på default Oversigt (ingen klik-simulering),
så fetches fyrede RENT fra mount-useEffect — ikke aktivTab-gate.`,
    'text'
  ),
  p(txt('Delay på ~2.7s matcher '), code('requestIdleCallback'), txt('-hint + LCP-window. Jakobs egne målinger (3380ms) er inden for samme range.')),
  p(strong('Commit: '), code('d4788c9'), txt('. '), strong('→ Done.'))
), 'Done');

// BIZZ-724 → PARTIAL → To Do
await postAndTransition('BIZZ-724', doc(
  h(2, 'Verifikation — PARTIAL (2 af 4 enheder berigt)'),
  p(strong('Jakob\'s egen verifikation '), txt('viser at kun 62B-enheder har gennemført enrichment. 62A-enheder mangler areal + BFE fordi de ikke er indekseret i BBR_Enhed via '), code('adresseIdentificerer'), txt(' = adgangsadresse-UUID. Vurderingsportalen-lookup returnerede heller ikke match.')),
  h(3, 'Status pr. enhed'),
  cb(
`62B, st.  areal=200 m²   ✅ (BBR_Enhed match)
62B, 1.   areal=42 m²    ✅ (BBR_Enhed match)
62A, st.  areal=null     ❌ (ikke i BBR_Enhed via adgangsadresse)
62A, 1.   areal=null     ❌ (samme)

+ alle 4: BFE=0 (Vurderingsportalen returnerede ingen match)
+ alle 4: købspris=null (afhænger af BIZZ-685/693 salgshistorik-fix)`,
    'text'
  ),
  h(3, 'Hvad der skal gøres for full PASS'),
  ul(
    li(p(strong('62A BBR_Enhed-resolution: '), txt('undersøg om '), code('BBR_Enhed.adresseIdentificerer'), txt(' bruger '), strong('adresse-UUID med etage/dør'), txt(' (ikke kun adgangsadresse) for 62A. Prøv direct lookup med dawaId før adgangsadresse-fallback. Alternativt: query via '), code('BBR_Ejerlejlighed'), txt(' eller matrikel-join.'))),
    li(p(strong('BFE-lookup fallback: '), txt('når Vurderingsportalen fejler, prøv '), code('public.ejf_ejerskab'), txt(' DISTINCT på '), code('bfe_nummer'), txt(' hvor navnet matcher adressens adgangsadresse-parent. Vores lokale 7.6M rows burde dække.'))),
    li(p(strong('Købspris (blocked af BIZZ-685/693): '), txt('når salgshistorik-refactor er landed, tilføj '), code('/api/salgshistorik?bfeNummer=<lejlighed-BFE>'), txt(' efter BFE-resolution.'))),
  ),
  h(3, 'Shipped i denne iteration'),
  ul(
    li(p(code('resolveEnhedByDawaId()'), txt(' helper tilføjet (commit '), code('a6ba604'), txt(').'))),
    li(p(code('fe78c44'), txt(' enricher liste med bfe/areal/købsdato hvor muligt.'))),
    li(p(code('virkning_fra'), txt(' fra '), code('ejf_ejerskab'), txt(' bruges som købsdato-fallback.'))),
  ),
  p(strong('→ Tilbage til To Do. '), txt('50% dækning shipped — resterende arbejde er velafgrænset og kan leveres i næste iteration.'))
), 'To Do');
