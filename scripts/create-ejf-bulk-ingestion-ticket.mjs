/**
 * Creates JIRA ticket for EJF bulk-ingestion feature (person → ejendomme lookup).
 *
 * Context: BizzAssist's live EJF API (EJFCustom_EjerskabBegraenset) only supports
 * filtering by BFE or CVR. Person-based lookups require either (a) additional
 * Datafordeler grants we cannot obtain, or (b) bulk-ingesting the public EJF
 * dataset into our own indexed table in Supabase. This ticket scopes option (b).
 *
 * Run: JIRA_API_TOKEN=xxx node scripts/create-ejf-bulk-ingestion-ticket.mjs
 */

const JIRA_HOST = 'bizzassist.atlassian.net';
const JIRA_EMAIL = 'itmgtconsulting@gmail.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'BIZZ';

if (!JIRA_TOKEN) {
  console.error('Missing JIRA_API_TOKEN environment variable');
  process.exit(1);
}

const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL = `https://${JIRA_HOST}/rest/api/3`;

async function jira(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`JIRA ${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const doc = (parts) => ({ type: 'doc', version: 1, content: parts });
const p = (...text) => ({
  type: 'paragraph',
  content: text.map((t) => (typeof t === 'string' ? { type: 'text', text: t } : t)),
});
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const code = (text, lang = 'typescript') => ({
  type: 'codeBlock',
  attrs: { language: lang },
  content: [{ type: 'text', text }],
});
const bullets = (items) => ({
  type: 'bulletList',
  content: items.map((item) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: item }] }],
  })),
});

const description = doc([
  h(2, 'Problem'),
  p(
    'BizzAssist kan ikke finde en persons personligt ejede ejendomme ud fra CVR ES enhedsNummer. ' +
      'EJFCustom_EjerskabBegraenset (vores eneste adgang til EJF) understøtter KUN filter på ' +
      'bestemtFastEjendomBFENr og ejendeVirksomhedCVRNr — ingen person-filtre. ' +
      'De fulde EJF-tjenester (EJF_Ejerskab, EJF_PersonVirksomhedsoplys, EJF_Handelsoplysninger) ' +
      'eksisterer men returnerer DAF-AUTH-0001 med vores nuværende grant.'
  ),
  p(
    'Grundlæggende problem: CVR ES og EJF bruger forskellige person-identifikatorer. ' +
      'Vi kan pege navn + bopælsadresse via CVR ES og derfra få fødselsdato via EJF, men ' +
      'vi kan ikke bruge dette til at finde andre ejendomme personen ejer.'
  ),
  h(2, 'Løsning: Bulk-ingestion af offentlige EJF-data'),
  p(
    'Datafordeler tilbyder EJF-udtræk som offentlige data uden speciel grant — samme data der i dag ' +
      'er tilgængelige via GraphQL/REST på individuel BFE-basis. Vi downloader hele datasættet ' +
      'dagligt, ingesterer til Supabase med (navn, foedselsdato) som primary lookup-nøgle, og ' +
      'bygger person→ejendomme som deterministisk SQL-query.'
  ),
  h(2, 'Hvorfor det virker deterministisk'),
  bullets([
    'EJF-udtræk indeholder foedselsdato på hver person-ejer (offentligt data)',
    'Kombinationen (navn, foedselsdato) er praksis-unik — kollision < 1 per million',
    'Vi får foedselsdato fra Jakobs egen bopæls-BFE via allerede-byggede person-bridge',
    'Bopæl-anker verificerer at navnet matcher den rigtige person før vi søger videre',
  ]),
  h(2, 'Schema'),
  code(
    `CREATE TABLE public.ejf_ejerskab (
  bfe_nummer         BIGINT NOT NULL,
  ejer_ejf_id        UUID NOT NULL,       -- ejendePersonBegraenset.id fra EJF
  ejer_navn          TEXT NOT NULL,
  ejer_foedselsdato  DATE,                -- NULL for virksomheder
  ejer_cvr           TEXT,                -- NULL for personer
  ejer_type          TEXT CHECK (ejer_type IN ('person','virksomhed')),
  ejerandel_taeller  INT,
  ejerandel_naevner  INT,
  status             TEXT,                -- 'gældende' | 'historisk'
  virkning_fra       TIMESTAMPTZ,
  virkning_til       TIMESTAMPTZ,
  sidst_opdateret    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (bfe_nummer, ejer_ejf_id, virkning_fra)
);

CREATE INDEX ix_ejf_person_lookup
  ON public.ejf_ejerskab (lower(ejer_navn), ejer_foedselsdato)
  WHERE ejer_type = 'person' AND status = 'gældende';

CREATE INDEX ix_ejf_bfe
  ON public.ejf_ejerskab (bfe_nummer) WHERE status = 'gældende';

CREATE INDEX ix_ejf_cvr
  ON public.ejf_ejerskab (ejer_cvr)
  WHERE ejer_cvr IS NOT NULL AND status = 'gældende';`,
    'sql'
  ),
  h(2, 'Runtime-flow efter implementering'),
  code(
    `[User klikker Udvid på Jakob]
  ↓
/api/cvr-public/person?enhedsNummer=4000115446     (eksisterende)
  → navn + bopælsadresse
/api/ejerskab/person-bridge?enhedsNummer=...        (eksisterende)
  → navn + foedselsdato via hjem-BFE
  ↓
SELECT bfe_nummer FROM ejf_ejerskab
WHERE lower(ejer_navn) = lower($1)
  AND ejer_foedselsdato = $2
  AND ejer_type = 'person' AND status = 'gældende';
  ↓
For hver BFE: DAWA-adresse-opslag (eksisterende cache)
  ↓
Returner property-noder til diagrammet`,
    'typescript'
  ),
  h(2, 'Arbejdsopgaver'),
  bullets([
    'Abonnér på EJF-udtræk hos SDFI (standard offentlig adgang — ikke speciel grant)',
    'Supabase migration: ejf_ejerskab-tabel + indekser (SQL ovenfor)',
    'Ingestion-cron (/api/cron/ingest-ejf) — streaming JSON-parser, upsert i batches',
    'Delta-opdatering + soft-delete for fjernede records',
    'Erstat hentBfeByPersonKey i /api/ejendomme-by-owner med Supabase-query',
    'Genaktiver personKey-parameter i route + DiagramForce person-expand',
    'Verificer at Jakob Juul Rasmussen returnerer Søbyvej 11 + Hovager 8 + Vigerslevvej 146',
  ]),
  h(2, 'Datavolumen'),
  bullets([
    '~6-8 mio ejerskab-records i hele DK',
    'Fuld udtræk: ~500 MB komprimeret per dag',
    'Daglige ændringer (delta): 10-50 MB',
    'Supabase storage: ~5 GB med historik',
    'Lookup-tid: <5 ms via B-tree indeks',
  ]),
  h(2, 'GDPR / compliance'),
  bullets([
    'EJF-ejerskab er offentlige data (samme som vises på tingbogen.dk)',
    'Fødselsdato er ikke beskyttet når den er en del af offentlig ejerskabs-post',
    'Ingen CPR involveret',
    'Tenant-isolation uændret (delt offentlig-data-tabel, ikke tenant-specifik)',
  ]),
  h(2, 'Eksisterende scaffolding klar at bruge'),
  bullets([
    '/api/ejerskab/person-bridge — resolver CVR enhedsNummer → EJF navn + foedselsdato via hjem-adresse',
    '/api/cvr-public/person — returnerer personens bopælsadresse',
    '/api/ejendomme-by-owner — har personKey-parameter stub (udkommenteret, klar til aktivering)',
    'hentBfeByPersonKey-funktion i ejendomme-by-owner route (udkommenteret)',
    'DiagramForce expandPersonDynamic har bridge-kald (udkommenteret indtil data-backend er klar)',
  ]),
  h(2, 'Effort'),
  bullets([
    'Abonnér på EJF-udtræk: S (1-2 dage admin)',
    'Supabase migration: XS (<1 dag)',
    'Ingestion-cron: M (3-5 dage)',
    'Delta-opdatering: S (1-2 dage)',
    'Re-enable client-kode: XS (<1 dag)',
    'Total: L (1-2 uger)',
  ]),
  h(2, 'Alternativ der blev fravalgt'),
  p(
    'Ansøge om EJF_Ejerskab-grant hos SDFI blev overvejet men fravalgt: ' +
      'det kræver at bede om yderligere adgang, hvilket bryder med vores princip om ' +
      'at bygge på offentlige data. Bulk-sporet er også teknisk bedre (lavere latency, ' +
      'ingen afhængighed af live-API-stabilitet).'
  ),
  h(2, 'Udvidelse: CVR bulk-ingestion'),
  p(
    'Samme arkitektur bør overvejes for CVR-data. I dag laver vi live-kald til CVR ES for ' +
      'hver virksomhed/deltager — det skaber latency på virksomhedsdiagrammer og sårbarhed ' +
      "ved CVR-API-udfald. CVR's fulde datasæt er offentligt tilgængeligt som daglige udtræk."
  ),
  bullets([
    'cvr_virksomhed-tabel (cvr-nr, navn, form, status, branche, beliggenhedsadresse)',
    'cvr_deltager-tabel (enhedsNummer, navn, type)',
    'cvr_deltagerrelation-tabel (cvr, enhedsNummer, rolle, ejerandel, periode)',
    'Samme daglige cron-arkitektur som EJF',
    'Virksomhedsdiagrammer bliver ~10x hurtigere (SQL vs CVR ES GraphQL)',
    'Ingen afhængighed af CVR-API-stabilitet for eksisterende data',
    'Kan laves i samme sprint som EJF-ingestion da infrastrukturen er fælles',
  ]),
  p('Anbefaling: udvid denne story til at dække BEGGE registre, eller split til sub-ticket.'),
  h(2, 'Reference'),
  p('Diagnose-routes (udkommenteret i hovedgrenen, kan re-aktiveres):'),
  bullets([
    'app/api/ejerskab/raw/route.ts — probe EJF GraphQL-felter',
    'app/api/ejerskab/filter-probe/route.ts — systematic filter-field probing',
    'app/api/ejerskab/tl-person-probe/route.ts — Tinglysning person-endpoint probing',
    'app/api/ejerskab/rest-probe/route.ts — Datafordeler REST-endpoints',
    'app/api/cvr-public/person/raw/route.ts — CVR ES deltager rå-output',
  ]),
]);

const payload = {
  fields: {
    project: { key: PROJECT_KEY },
    summary:
      '[P1] EJF + CVR bulk-ingestion — person→ejendomme lookup + hurtigere diagrammer via eget indeks',
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    labels: ['feature', 'ejf', 'ingestion', 'person-page', 'p1', 'ejendomme'],
    description,
  },
};

try {
  const created = await jira('POST', '/issue', payload);
  console.log(`Created: ${created.key}`);
  console.log(`URL: https://${JIRA_HOST}/browse/${created.key}`);
} catch (err) {
  console.error('Failed:', err?.message ?? err);
  process.exit(1);
}
