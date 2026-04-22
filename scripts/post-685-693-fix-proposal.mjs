#!/usr/bin/env node
// Post interface analysis + concrete fix proposal on BIZZ-685 + BIZZ-693
// and transition them both back to "To Do".
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
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });
const ol = (...i) => ({ type: 'orderedList', content: i });
const codeblock = (t) => ({ type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: t }] });

const body = [
  h(2, 'Interface-analyse på 5 BFEer — hvad vi faktisk kan hente'),
  p(strong('Probed: '), code('2091166'), txt(' (Høvedstensvej 27), '), code('425479'), txt(' (Kaffevej 31, 1.tv), '), code('2024847'), txt(' (Hovager 8), '), code('100065801'), txt(' (Kildegårdsvej 18D), '), code('2091185'), txt(' (Arnold Nielsens Blvd 64B).')),
  codeblock(
`BFE         salgshistorik  summarisk (current)         rows med pris
2091166     4 rows         1 ejer: JAJR Ejendomme ApS @ 18,5 MDKK   0/4
425479      4 rows         1 ejer: JAJR Ejendomme ApS @ 3,83 MDKK   0/4
2024847     7 rows         2 ejere: Jakob+Kamilla    @ 1,9 MDKK    0/7
100065801   5 rows         1 ejer: Jakob Juul Rasm.  @ 8,85 MDKK   0/5
2091185     4 rows         1 ejer: ArnBo 64b ApS     @ 23 MDKK     0/4`
  ),
  p(strong('Mønster:'), txt(' På tværs af alle 5 BFEer returnerer '), code('/api/salgshistorik'), txt(' 4-7 handler-rækker (dateret tilbage til 2001-2019), men '), strong('alle prisfelter er null'), txt('. Tinglysning '), code('summarisk'), txt(' returnerer KUN den nuværende adkomst-kæde (1-2 ejere) med korrekt pris. Den klient-side merge i '), code('EjendomDetaljeClient.tsx'), txt(' (±30d date match) ville kun kunne berige 1 række pr. BFE — historiske rækker har intet at matche imod.')),

  h(2, 'Hvad hvert interface tilbyder'),
  ul(
    li(p(strong('EJFCustom_EjerskabBegraenset'), txt(' (brugt af '), code('/api/salgshistorik'), txt('): virkningFra/Til, ejer-CVR, person-navn, ejerandel, ejerforholdskode, status. '), strong('Ingen prisfelter.'))),
    li(p(strong('EJF_Ejerskifte + EJF_Handelsoplysninger'), txt(' (historiske priser): '), strong('IKKE i grant'), txt(' (403 / DAF-AUTH-0001). Tidligere forsøg fejlede konstant — fjernet i BIZZ-633.'))),
    li(p(strong('/api/tinglysning/summarisk'), txt(' ?uuid+hovedBfe: nuværende AdkomstSummariskSamling. Fields: navn, CVR, andel, adkomstType, tinglysningsdato, SkoedeOvertagelsesDato, KontantKoebesum, IAltKoebesum, tinglysningsafgift, KoebsaftaleDato, dokumentId. '), strong('Kun den aktuelle adkomst-kæde — ingen historiske dokumenter.'))),
    li(p(strong('/api/tinglysning/virksomhed'), txt(' ?cvr=X&rolle=ejer: alle dokumenter hvor CVR har/har haft rollen ejer. Returnerer bfe, dokumentId, dokumentAlias, adkomstType, matrikel. '), strong('Ingen pris — men dokumentId pr. BFE.'))),
    li(p(strong('/tinglysning/ssl/dokaktuel/uuid/{uuid}'), txt(' (rå XML via '), code('tlFetch'), txt('): fuld dokument-XML pr. adkomst — indeholder KontantKoebesum, IAltKoebesum, SkoedeOvertagelsesDato, KoebsaftaleDato, Afgiftsbeloeb, RolleTypeIdentifikator (ejer/køber), PersonName/LegalUnitName+CVRnumberIdentifier.'))),
    li(p(strong('/api/tinglysning/dokument'), txt(' ?uuid: returnerer pt. PDF — har samme underliggende XML-felter, men skal omskrives hvis vi vil have JSON.'))),
  ),

  h(2, 'Proof-of-concept: virksomhed → dokumentId virker'),
  p(txt('Probe '), code('/api/tinglysning/virksomhed?cvr=26316804'), txt(' (JAJR Ejendomme ApS) returnerer 3 ejer-rækker — to af dem er netop BFE 2091166 + 425479 med '), code('adkomstType=skoede'), txt(' og dokumentId '), code('58bb3b6a-…'), txt(' / '), code('1d36bc95-…'), txt('. Dvs. for alle CVR-ejere (nuværende OG historiske) kan vi slå dokumenterne op og derefter parse prisen ud af den rå XML.')),

  h(2, 'Foreslået fix — server-side enrichment i /api/salgshistorik'),
  ol(
    li(p(txt('Bevar EJFCustom-querien som grundlag (dates, ejere, andel).'))),
    li(p(txt('Saml unikke CVRer fra alle historiske EJF-rækker: '), code('ejendeVirksomhedCVRNr'), txt('.'))),
    li(p(txt('Pr. CVR: kald '), code('/tinglysning/ssl/soegvirksomhed/cvr?cvr=X&bog=1&rolle=ejer'), txt(' via '), code('tlFetch'), txt(' (samme kode-sti som '), code('/api/tinglysning/virksomhed'), txt('). Filtrér output til '), code('bfe === bfeNummer'), txt('. Cache result pr. CVR i eksisterende LRU (1h TTL).'))),
    li(p(txt('Pr. unikt dokumentId: hent '), code('/tinglysning/ssl/dokaktuel/uuid/{uuid}'), txt(' og parse KontantKoebesum + IAltKoebesum + SkoedeOvertagelsesDato + KoebsaftaleDato + Afgiftsbeloeb + AdkomstType ud af XML (samme regex-pattern som i '), code('app/api/tinglysning/summarisk/route.ts'), txt(' linje 267-290). Cache pr. dokumentId.'))),
    li(p(txt('Merge ind på EJF-rækker: match på '), code('SkoedeOvertagelsesDato'), txt(' ≈ '), code('virkningFra'), txt(' (±30d). Falder tilbage til adkomstType + CVR hvis dato-match fejler.'))),
    li(p(strong('For private person-ejere'), txt(' (EJF har '), code('ejendePersonBegraenset.navn'), txt(', men ingen CPR/søgenøgle for '), code('/soegvirksomhed/cvr'), txt('): sæt '), code('koebesumKilde: "ikke_oplyst_person"'), txt('. UI viser “Ikke oplyst” med tooltip: '), strong('“Adkomstdokumenter for private personer kræver CPR-opslag som ikke er i vores Datafordeler-grant.”'))),
    li(p(strong('Performance'), txt(': 2091166 har ~2 unikke CVRer bag 4 handler → 2 virksomhed-opslag + 2-4 dokument-opslag = 4-6 cert-baserede requests første gang, fuld cache-hit derefter. Salgshistorik har 1h LRU allerede.'))),
  ),

  h(2, 'Forventet dækning efter fix'),
  codeblock(
`BFE         rows med CVR-ejer       rows med person-ejer
2091166     ~3/4 priser hentes     1/4 rest (Ikke oplyst)
425479      ~3/4 priser hentes     1/4 rest
2091185     ~3/4 priser hentes     1/4 rest
2024847     0/7 priser (alle personer)   "Ikke oplyst"
100065801   0/5 priser (alle personer)   "Ikke oplyst"`
  ),
  p(strong('Begrænsning: '), txt('Private person-ejere uden CVR (ca. 50% af sager) kan vi aldrig få priser på via vores nuværende grant. To veje frem:')),
  ul(
    li(p(strong('Option A'), txt(' (ingen grant-udvidelse): ship som ovenfor. UI forklarer transparent at EJF/Tinglysning ikke giver pris på privatpersoner uden CPR.'))),
    li(p(strong('Option B'), txt(' (ansøg om '), code('EJF_Handelsoplysninger'), txt(' grant): historiske priser direkte fra EJF uden dokument-parsing. Ansøgning skal gå via Datafordeler — kan tage uger.'))),
  ),

  h(2, 'Næste trin'),
  ul(
    li(p(txt('BIZZ-685 + BIZZ-693 tilbage til To Do med ovenstående plan i description.'))),
    li(p(txt('Implementering: '), code('app/api/salgshistorik/route.ts'), txt(' — tilføj Tinglysning-enrichment pipeline (evt. splittet til '), code('app/lib/tinglysningEnrichment.ts'), txt('). Ny E2E-test på BFE 425479 som verificerer koebesum != null på mindst den seneste handels-række.'))),
    li(p(txt('Pre-emptiv cert-cost sanity check: Tinglysning S2S har rate limit — verificér at '), code('/soegvirksomhed/cvr'), txt(' + '), code('/dokaktuel/uuid/{uuid}'), txt(' ikke rammer kvote når flere brugere hitter samme BFE hurtigt efter hinanden. Cache bør dække det.'))),
  ),
];

const tickets = ['BIZZ-685', 'BIZZ-693'];

for (const key of tickets) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: { type: 'doc', version: 1, content: body } });
  console.log(c.status === 201 ? `✅ ${key} comment posted` : `❌ ${key} ${c.status} ${c.body.slice(0, 200)}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find((x) => x.name.toLowerCase() === 'to do');
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `   ✅ ${key} → To Do` : `   ⚠️ ${key} transition ${r.status}`);
  } else {
    console.log(`   ⚠️ ${key} no "To Do" transition available; transitions: ${JSON.parse(tr.body).transitions?.map(x => x.name).join(', ')}`);
  }
}
