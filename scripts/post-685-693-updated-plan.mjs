#!/usr/bin/env node
// Supplement BIZZ-685 + BIZZ-693 med udvidet plan der bruger public.ejf_ejerskab
// i stedet for live EJFCustom-opslag, og tilføjer person-identitet + reverse-inference.
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
  h(2, 'Opdateret plan — brug public.ejf_ejerskab + person-identitet + reverse-inference'),
  p(strong('Kontekst: '), txt('Vi har allerede EJF bulk-data lokalt i Supabase ('), code('public.ejf_ejerskab'), txt(', migration 046, BIZZ-534 — 7,6M rækker, synkroniseret dagligt via '), code('/api/cron/pull-tinglysning-aendringer'), txt('). Det ændrer det oprindelige forslag ovenfor markant.')),

  h(3, 'Data vi allerede har i Supabase'),
  codeblock(
`public.ejf_ejerskab (PK: bfe_nummer + ejer_ejf_id + virkning_fra)
  bfe_nummer          bigint
  ejer_ejf_id         uuid   -- stabil EJF-identitet pr. person/virksomhed
  ejer_navn           text
  ejer_foedselsdato   date   -- null for virksomheder
  ejer_cvr            text   -- null for personer
  ejer_type           'person' | 'virksomhed'
  ejerandel_taeller   integer
  ejerandel_naevner   integer
  status              'gældende' | 'historisk'
  virkning_fra        timestamptz
  virkning_til        timestamptz

Index:  ix_ejf_person_lookup (lower(ejer_navn), ejer_foedselsdato)
        ix_ejf_bfe (bfe_nummer)
        ix_ejf_cvr (ejer_cvr)`
  ),

  h(3, 'Hvad det muliggør'),
  ul(
    li(p(strong('Drop live EJF-kald'), txt(' i '), code('/api/salgshistorik'), txt(' — erstat '), code('queryEJF(EJFCustom_EjerskabBegraenset)'), txt(' med SQL mod '), code('ejf_ejerskab'), txt('. Ingen Datafordeler-rate-limits, ingen grant-afhængighed, ~10× hurtigere ('), code('~50ms'), txt(' vs '), code('~500ms'), txt(').'))),
    li(p(strong('Stabil person-identitet via '), code('ejer_ejf_id'), txt(' UUID — bedre end '), code('navn+foedselsdato'), txt(' fordi EJF holder den konstant på tværs af navneændringer.'))),
    li(p(strong('Krydssøgning på person-portefølje: '), txt('fra én persons transaktion kan vi slå op i '), code('ejf_ejerskab'), txt(' hvilke '), strong('andre'), txt(' ejendomme samme '), code('ejer_ejf_id'), txt(' har ejet — og for hver af dem checke om modparten var en CVR.'))),
  ),

  h(3, 'Opdateret flow i /api/salgshistorik'),
  codeblock(
`GET /api/salgshistorik?bfeNummer=X
  │
  ├─ [1] SQL: SELECT ejer_ejf_id, ejer_navn, ejer_foedselsdato,
  │              ejer_cvr, ejer_type, ejerandel_*, virkning_fra, virkning_til
  │         FROM public.ejf_ejerskab
  │         WHERE bfe_nummer = X
  │         ORDER BY virkning_fra DESC
  │     → handler[] med alle historiske ejerskab-episoder
  │
  ├─ [2] For unikke CVRer i handler[]:
  │         GET /tinglysning/ssl/soegvirksomhed/cvr?cvr=Y&bog=1&rolle=ejer
  │         (via tlFetch, resultat cacheet pr. CVR i LRU 1h)
  │       → filter bfe === X → dokumentIds[]
  │       For hvert dokumentId:
  │         GET /tinglysning/ssl/dokaktuel/uuid/{uuid}
  │         → parse XML: KontantKoebesum, IAltKoebesum,
  │                      SkoedeOvertagelsesDato, KoebsaftaleDato, AdkomstType
  │     → berig CVR-rows med priser (kilde = "tinglysning-direct")
  │
  ├─ [3] Sekventiel reverse-inference for person-ejere:
  │     handler[] er sorteret kronologisk. For hver person-række i
  │     hvor handler[i+1] (næste ejer frem i tid) er en CVR med
  │     fundet pris → personens exit-pris = CVR-efterfølgerens købspris
  │     (kilde = "inferred_successor", vises som "≈ 1.900.000 kr")
  │
  ├─ [4] Tværgående person-enrichment (edge cases):
  │     For person-ejere stadig uden pris → find andre BFEer hvor
  │     samme ejer_ejf_id optræder i ejf_ejerskab. Kør samme CVR-modpart-
  │     logik på dem. Sjældent nyttigt for den aktuelle BFE, men
  │     fremtidigt grundlag for person-portefølje-visning.
  │
  └─ [5] Uopløselige person→person transaktioner:
        marker koebesumKilde = "ikke_oplyst_privat_person".
        UI: "Ikke oplyst" + tooltip om grant-begrænsning.`
  ),

  h(3, 'Forventet dækning pr. BFE efter fix'),
  codeblock(
`BFE         direct (CVR)   inferred (succ.)   ikke_oplyst
2091166     ~1-2 handler   ~1 handler         ~1 handler
425479      ~1-2 handler   ~1 handler         ~1 handler
2091185     ~1-2 handler   ~1 handler         ~1 handler
2024847     0 handler      de ~2 seneste      de ~5 ældste
100065801   0 handler      de ~1 seneste      de ~4 ældste`
  ),
  p(txt('Estimaterne er baseret på hvor ofte en CVR er modpart i historikken. JAJR/ArnBo-ejendomme får stort set fuld dækning; familie-ejendomme (Hovager, Kildegårdsvej) får kun den seneste række direkte + evt. én via succession.')),

  h(3, 'Konkrete implementerings-skridt'),
  ol(
    li(p(strong('1. '), code('app/lib/ejfLocal.ts'), txt(' (ny helper): '), code('getEjerskabsHistorik(bfe: number)'), txt(' → queryer '), code('ejf_ejerskab'), txt(' og grupperer til handler-rækker.'))),
    li(p(strong('2. '), code('app/lib/tinglysningEnrichment.ts'), txt(' (ny helper): '), code('enrichWithCvrPrices(handler)'), txt(' kalder '), code('tlFetch'), txt(' mod '), code('/soegvirksomhed/cvr'), txt(' + '), code('/dokaktuel/uuid/{uuid}'), txt('. Cacher i eksisterende LRU.'))),
    li(p(strong('3. '), code('app/lib/salgshistorikInference.ts'), txt(' (ny helper): '), code('inferFromSuccessor(handler)'), txt(' — rent funktionelt, testbart i isolation.'))),
    li(p(strong('4. Refactor '), code('app/api/salgshistorik/route.ts'), txt(' — fjern '), code('queryEJF'), txt(', kald de tre nye helpers sekventielt. Bevar LRU-cache + response-shape.'))),
    li(p(strong('5. Fjern klient-side merge-logik'), txt(' i '), code('EjendomDetaljeClient.tsx'), txt(' (linje 1420-1497) — al enrichment sker nu server-side, UI kan vise '), code('handler[]'), txt(' direkte + '), code('koebesumKilde'), txt(' badge.'))),
    li(p(strong('6. Tilføj E2E-test'), txt(' der verificerer '), code('koebesum != null'), txt(' på mindst 2 af 4 rækker for BFE 425479 efter fix.'))),
  ),

  h(3, 'GDPR / retention'),
  ul(
    li(p(code('ejf_ejerskab'), txt(' findes allerede — ingen nye PII-felter lagres.'))),
    li(p(txt('Tinglysning-dokument-XML må jf. '), code('CLAUDE.md'), txt(' ikke caches lokalt. LRU for dokument-UUID-pointers er OK (metadata, ikke registerdata); parsed pris kan caches pr. request men ikke persistent.'))),
    li(p(txt('Ingen ny sub-processor — Tinglysning er allerede listed.'))),
  ),

  h(3, 'Følgetickets (foreslået)'),
  ul(
    li(p(strong('BIZZ-??? — Refactor /api/salgshistorik til local-first + Tinglysning-enrichment'), txt(' (primær implementation).'))),
    li(p(strong('BIZZ-??? — Person-detalje: vis transaction-history via ejer_ejf_id'), txt(' (udnyt at vi allerede har dataen).'))),
    li(p(strong('BIZZ-??? — UI: koebesumKilde-badge + tooltip'), txt(' ('), code('"Direkte fra Tinglysning"'), txt(' / '), code('"Estimeret fra efterfølger"'), txt(' / '), code('"Ikke oplyst (privat person uden CPR-grant)"'), txt(').'))),
  ),
];

for (const key of ['BIZZ-685', 'BIZZ-693']) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: { type: 'doc', version: 1, content: body } });
  console.log(c.status === 201 ? `✅ ${key} updated plan posted` : `❌ ${key} ${c.status} ${c.body.slice(0, 200)}`);
}
