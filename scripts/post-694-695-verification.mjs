#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
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
const doc = (...b) => ({ type: 'doc', version: 1, content: b });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });

// ─── BIZZ-694: PASS (10/11) — core regression fixed ──────────────────────
await req('POST', '/rest/api/3/issue/BIZZ-694/comment', {
  body: doc(
    h(2, 'Playwright-verifikation — PASS (10/11 checks)'),
    p(strong('Test-scenarie: '), txt('login på test.bizzassist.dk → '), code('/dashboard/ejendomme/0a3f507c-b62a-32b8-e044-0003ba298018'), txt(' (Arnold Nielsens Boulevard 62A, BFE 226630, DAWA-UUID) → klik Ejerskab-tab.')),

    h(3, 'UI-verifikation ✅'),
    ul(
      li(p(strong('Ejerskab-sektion synlig: '), txt('overskrift "Ejerstruktur" + "Ejendommen er opdelt i ejerlejligheder"-besked.'))),
      li(p(strong('Lejligheds-tabel vises: '), txt('4 rækker med headers Adresse, Ejer, Areal, Købspris, Købsdato.'))),
      li(p(strong('Alle 4 lejligheder synlige i UI: '), txt('Arnold Nielsens Boulevard 62A st., 62B st., 62A 1., 62B 1.'))),
      li(p(strong('Ejer udfyldt: '), txt('"Arnbo 62 ApS" på alle 4 rækker (commit '), code('a7413f1'), txt(' CVR-navne-enrichment).'))),
      li(p(strong('Ingen placeholder-skrald'), txt(' ('), code('undefined'), txt(', '), code('NaN'), txt(', '), code('[object Object]'), txt(' — clean).'))),
      li(p(strong('Klik-navigation: '), txt('klik på lejlighed navigerer til '), code('/dashboard/ejendomme/33a228a1-155e-4d83-a0f4-baf9af0d697d'), txt(' (lejlighedens DAWA-UUID).'))),
    ),

    h(3, 'API-verifikation ✅'),
    cb(
`GET /api/ejerlejligheder?ejerlavKode=12851&matrikelnr=21by&moderBfe=226630

Returnerer {"lejligheder": [4 rows], "fejl": null}

Alle 4 rækker data-kvalitets-verificeret:
  adresse_ok=true  (fuld adresse med by+postnr)
  etage_ok=true    (st, 1)
  ejer_ok=true     ("Arnbo 62 ApS")
  ejertype=selskab
  dawaId_ok=true   (valid UUID for navigation)`,
      'text'
    ),

    h(3, 'Kendt limitation — ikke blocker'),
    p(strong('BFE=0 på alle 4 lejligheder.'), txt(' Matcher Jakob\'s kommentar fra 2026-04-22T07:31: "BFE-opslag fra DAWA nestet ikke returnerer bfenummer for individuelle adresser". Det påvirker ikke navigation (dawaId bruges) eller visning, men '), code('BFE: 226630'), txt(' vises kun på hovedejendommen. Hvis lejligheds-BFE er ønsket kan det løses via '), code('BBR_Enhed → adresseIdentificerer'), txt(' — separat opgave.')),

    h(3, 'Evidens'),
    ul(
      li(p(strong('Screenshot: '), code('/tmp/verify-screenshots/694-62A-v2.png'), txt(' viser "Lejligheder"-tabellen med 4 udfyldte rækker.'))),
      li(p(strong('Commits verificeret: '), code('dd507af'), txt(' (DAWA fallback), '), code('fafe316'), txt(' (ejer-enrichment), '), code('a7413f1'), txt(' (CVR-navn "Arnbo 62 ApS"). Alle 3 commits\' effekt observeret i prod-lignende '), code('test.bizzassist.dk'), txt('.'))),
    ),

    p(strong('BIZZ-694 → Done. '), txt('Regression er løst; core-funktionaliteten matcher BIZZ-362 acceptance.'))
  ),
});
console.log('✅ BIZZ-694 verification comment posted');

const tr1 = await req('GET', '/rest/api/3/issue/BIZZ-694/transitions');
const done1 = (JSON.parse(tr1.body).transitions || []).find(t => /^done$/i.test(t.name));
if (done1) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-694/transitions', { transition: { id: done1.id } });
  console.log(r.status === 204 ? '✅ BIZZ-694 → Done' : `⚠️ transition ${r.status}`);
}

// ─── BIZZ-695: PARTIAL (4/5) — opsummer hvad der er shipped/remaining ────
await req('POST', '/rest/api/3/issue/BIZZ-695/comment', {
  body: doc(
    h(2, 'Playwright-verifikation — PARTIAL (4/5 checks)'),
    p(strong('Fase 1 + 2 shipped og virker. Problem 1 (søgning) ikke løst endnu.')),

    h(3, 'PASS — lejlighedsliste på begge hovedejendomme ✅'),
    ul(
      li(p(strong('62A hovedejendom '), txt('('), code('/dashboard/ejendomme/0a3f507c-b62a-32b8-e044-0003ba298018'), txt('): Ejerskab-tab viser 4 lejligheder (62A st., 62B st., 62A 1., 62B 1.) med ejer "Arnbo 62 ApS".'))),
      li(p(strong('62B hovedejendom '), txt('('), code('/dashboard/ejendomme/<62B-DAWA>'), txt('): Ejerskab-tab viser 62B 1. + 62B st.'))),
      li(p(strong('API '), code('/api/ejerlejligheder?ejerlavKode=12851&matrikelnr=21by&moderBfe=226630'), txt(' returnerer 4 lejligheder med korrekt adresse, ejer, dawaId.'))),
    ),

    h(3, 'PASS — hovedejendomme i søgning ✅'),
    ul(
      li(p(code('GET /api/search?q=Arnold+Nielsens+Boulevard+62'), txt(' returnerer begge hovedejendomme (62A og 62B adgangsadresser).'))),
      li(p(txt('62B\'s lejligheder ('), code('62B 1.'), txt(' + '), code('62B st.'), txt(') vises i søge-dropdown.'))),
    ),

    h(3, 'FAIL — 62A\'s lejligheder vises IKKE i søgning ❌'),
    cb(
`Søge-resultat for "Arnold Nielsens Boulevard 62":
  ✅ 62A (hovedejendom / adgangsadresse)
  ✅ 62B (hovedejendom / adgangsadresse)
  ❌ 62A 1. — MANGLER
  ❌ 62A st. — MANGLER
  ✅ 62B 1.
  ✅ 62B st.`,
      'text'
    ),
    p(txt('Matcher præcist ticket\'ens '), strong('Problem 1'), txt(' sektion: "Søgning viser kun 62A og 62B — mangler 2×62A". Root cause dokumenteret i ticket: "For 62A vises de IKKE — sandsynligvis fordi 62A\'s lejligheder ikke har etage/dør i DAWA autocomplete".')),

    h(3, 'Mangler også (data-kvalitet)'),
    ul(
      li(p(strong('BFE=0 '), txt('på alle lejligheds-rækker (dokumenteret i BIZZ-694). Acceptance-kriteriet "BFE" er ikke teknisk opfyldt i UI for individuelle lejligheder, men kan løses separat via '), code('BBR_Enhed → adresseIdentificerer'), txt('.'))),
      li(p(strong('Areal/købspris/købsdato '), txt('= null på alle 4 rækker (vises som "–" i UI). Matcher Jakob\'s tidligere "Remaining: Ejer og areal vises som –" — ejer blev fikset, areal og priser står stadig åbent.'))),
    ),

    h(3, 'Anbefaling'),
    p(txt('3 muligheder:')),
    ul(
      li(p(strong('Option A: '), txt('Behold BIZZ-695 i "In Review" indtil Problem 1 + areal/pris er fikset (komplet feature).'))),
      li(p(strong('Option B: '), txt('Transition BIZZ-695 → Done (Fase 1 + 2 = primær leverance) og opret 2 nye tickets:'))),
      li(p(ul(
        li(p(txt('BIZZ-XXX: Søgning inkluderer 62A-lejligheder (DAWA /adresser fallback når /adgangsadresser mangler)'))),
        li(p(txt('BIZZ-XXX: Areal + købspris enrichment på ejerlejligheder (via BBR_Enhed + EJF)'))),
      ))),
      li(p(strong('Option C: '), txt('Transition BIZZ-695 → To Do med fokus på Problem 1 + data-enrichment (reopen existing ticket).'))),
    ),
    p(strong('Forslag: Option B '), txt('— BIZZ-695 som overordnet analyse er leveret (datamodel bekræftet), kerne-funktionaliteten virker, og resterende arbejde er velafgrænset nok til dedikerede tickets. Jakob\'s eksisterende kommentar-log følger samme tanke ("Fase 1 shipped... Remaining..."). Afventer din beslutning før transition.'))
  ),
});
console.log('✅ BIZZ-695 partial-verification comment posted');
console.log('⏸ BIZZ-695 holdes i In Review afventer beslutning om Option A/B/C');
