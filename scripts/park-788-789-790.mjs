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
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const perTicket = {
  'BIZZ-788': { type: 'doc', version: 1, content: [
    p(strong('Parkeret — epic scope, kræver architect signoff på split + DB-grundlag')),
    p(txt('Ticket beskriver 10 filter-kategorier med 50+ enkeltfiltre. Det er for stort til én ticket og kræver en fælles arkitektur-beslutning. '), code('RecentEjendom'), txt(' i dag har kun '), code('id, adresse, postnr, by, kommune, anvendelse, senestiSet'), txt(' — areal/energimærke/opførelsesår/status er ikke tilgængelige uden lokal DB-berigelse (BIZZ-785 iter 2).')),
    p(strong('Foreslået split (kræver ARCHITECT signoff):')),
    ul(
      li(p(code('BIZZ-788a'), txt(' — Delt '), code('FilterPanel'), txt(' komponent: single-select/multi-select/range/toggle primitiver + URL-query-param sync + live match-count. Genbruges af 788/789/790 + BIZZ-786 iter 2.'))),
      li(p(code('BIZZ-788b'), txt(' — MVP filter-katalog Phase 1 (kræver BIZZ-785 iter 2 '), strong('shipped'), txt('): Ejendomstype multi-select, Skjul udfasede, Kommune multi-select. Alle 3 kan drives af RecentEjendom + kommune-index.'))),
      li(p(code('BIZZ-788c'), txt(' — Phase 2 (kræver BBR-berigelse '), strong('komplet'), txt('): Areal, Opførelsesår, Energimærke, Anvendelseskode.'))),
      li(p(code('BIZZ-788d'), txt(' — Phase 3: Konstruktion (ydervæg/tag), Ejerforhold, Varmekilde, Fredning, Zone.'))),
      li(p(code('BIZZ-788e'), txt(' — Phase 4: VUR/Tinglysning-filtre (Ejendomsværdi, Seneste salg, Pant, Servitutter). Kræver EJF-berigelse i DB.'))),
      li(p(code('BIZZ-788f'), txt(' — Phase 5: Presets (Nybyggeri/Klassiske villaer/Energivenlig/Investeringsejendomme) + gemte filter-præsæt (ny tabel '), code('user_filter_presets'), txt(').'))),
    ),
    p(strong('Hård afhængighed:'), txt(' BIZZ-785 iter 2 (lokal DB-berigelse af ejendomme med BBR-felter) skal shipped '), strong('før'), txt(' 788b/c/d/e kan starte. 788a kan parallelt.')),
    p(strong('→ On Hold.')),
  ]},
  'BIZZ-789': { type: 'doc', version: 1, content: [
    p(strong('Parkeret — epic scope, kræver architect signoff på split')),
    p(txt('10 filter-kategorier med 50+ enkeltfiltre. Delvist dækket af CVR ES + lokal '), code('cvr_virksomhed'), txt(' tabel. Kræver split og potentiel berigelse for regnskab/ejerforhold.')),
    p(strong('Foreslået split:')),
    ul(
      li(p(code('BIZZ-789a'), txt(' — MVP filter-katalog Phase 1 (kan ship direkte mod CVR ES): Status multi-select, Virksomhedsform, Branche hovedgruppe, Kommune, Stiftet år range. Uses eksisterende '), code('cvr_virksomhed.status/virksomhedsform/branche_kode/adresse_json/stiftet'), txt('.'))),
      li(p(code('BIZZ-789b'), txt(' — Phase 2 (kræver regnskabsdata-berigelse): Ansatte range, Omsætning, Egenkapital, Regnskabsklasse, Selskabskapital. Ny tabel '), code('cvr_regnskab'), txt(' + ETL fra CVR ES regnskabsindex.'))),
      li(p(code('BIZZ-789c'), txt(' — Phase 3 (ejerforhold): Reel ejer, Datter-selskaber, Holdingstruktur, Ejet af selskab. Kræver '), code('cvr_ejerskab'), txt(' berigelse.'))),
      li(p(code('BIZZ-789d'), txt(' — Phase 4 (deltagere): Direktør/Bestyrelsesmedlem/Stifter/Revisor søgbar person-input. Kræver fuldtekst-index på '), code('cvr_deltager'), txt('.'))),
      li(p(code('BIZZ-789e'), txt(' — Phase 5 (cross-domain): Ejer ejendom toggle, Antal ejendomme, Samlet ejendomsværdi. Join mod '), code('ejf_ejerskab'), txt('.'))),
      li(p(code('BIZZ-789f'), txt(' — Phase 6: Børsnoteret, Momsregistreret, Reklamebeskyttet, Presets + gemte filter-præsæt.'))),
    ),
    p(strong('Afhængighed:'), txt(' 788a (delt FilterPanel) bør shippes først. 789a kan paralleliseres.')),
    p(strong('→ On Hold.')),
  ]},
  'BIZZ-790': { type: 'doc', version: 1, content: [
    p(strong('Parkeret — epic scope, kræver architect signoff + CVR deltager-index berigelse')),
    p(txt('9 filter-kategorier bygget oven på CVR deltager-index. Kræver berigelse fordi CVR ES deltager-endpoint ikke understøtter aggregerede queries som "antal aktive virksomheder ≥ 5".')),
    p(strong('Foreslået split:')),
    ul(
      li(p(code('BIZZ-790a'), txt(' — MVP Phase 1 (mod CVR ES direkte): Enhedstype, Rolle multi-select, Rollestatus. Kan ship uden DB-berigelse.'))),
      li(p(code('BIZZ-790b'), txt(' — Phase 2 (kræver deltager-berigelse): Antal aktive virksomheder range, Antal roller total, Seriel-iværksætter preset. Ny tabel '), code('cvr_deltager_agg'), txt(' med material-view-agg.'))),
      li(p(code('BIZZ-790c'), txt(' — Phase 3: Branche-eksponering, Kommune (via virksomhedernes adresser).'))),
      li(p(code('BIZZ-790d'), txt(' — Phase 4 (cross-domain): Ejer ejendom direkte, Ejer via selskab, Samlet ejendomsværdi.'))),
      li(p(code('BIZZ-790e'), txt(' — Phase 5: Relateret til CVR/person, Koncern, Alder (kræver CPR — ikke muligt uden ny DPA).'))),
      li(p(code('BIZZ-790f'), txt(' — Phase 6: Risiko-indikatorer (konkurs-historik, tvangsopløsning) — kræver historisk CVR-data.'))),
    ),
    p(strong('Afhængighed:'), txt(' 788a (delt FilterPanel) + 789a (pattern-validering på virksomheder). 790a kan parallelt.')),
    p(strong('→ On Hold.')),
  ]},
};

for (const [key, body] of Object.entries(perTicket)) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${cr.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => /on hold/i.test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → On Hold` : `  ⚠️ ${r.status}`);
  } else {
    console.log(`  ⚠️ ${key}: no on-hold transition. Available: ${(JSON.parse(tr.body).transitions || []).map(t=>t.name).join(', ')}`);
  }
}
