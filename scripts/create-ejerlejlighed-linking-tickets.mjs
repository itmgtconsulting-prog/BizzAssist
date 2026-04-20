#!/usr/bin/env node
/**
 * Creates two JIRA tickets related to ejerlejlighed ↔ hovedejendom navigation:
 *
 *   1. Diagram + ejendomstab på virksomhed/person skal linke til ejerlejligheder,
 *      og fra ejerlejlighedens ejendomsside skal man kunne navigere til hovedejendom.
 *
 *   2. Adressesøgning skal skelne mellem ejerlejlighed og hovedejendom — enten
 *      ved at vise flere resultater eller ved altid at åbne ejerlejligheden
 *      først med mulighed for at navigere til hovedejendom.
 *
 * Begge tickets bruger Arnold Nielsens Boulevard 62, Hvidovre som konkret eksempel.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

/** Thin JIRA REST client. */
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// ─── Helpers til ADF-dokumenter ─────────────────────────────────────────────

const p = (...children) => ({ type: 'paragraph', content: children });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const strong = (text) => t(text, [{ type: 'strong' }]);
const code = (text) => t(text, [{ type: 'code' }]);
const h = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (...children) => ({ type: 'listItem', content: children });
const ul = (...items) => ({ type: 'bulletList', content: items });
const ol = (...items) => ({ type: 'orderedList', attrs: { order: 1 }, content: items });

// ─── Fælles baggrundsanalyse (Arnold Nielsens Boulevard 62) ─────────────────

const analyseSektion = [
  h(2, 'Datagrundlag — Arnold Nielsens Boulevard 62, 2650 Hvidovre'),
  p(
    t(
      'Matrikel: Hvidovre By, Risbjerg, matr.nr. 21by (ejerlavskode 12851). Tinglysning-søgning på ejerlav/matrikel returnerer 3 separate ejendomme:'
    )
  ),
  ul(
    li(
      p(
        strong('Hovedejendom (SFE, BFE 2091165)'),
        t(' — Arnold Nielsens Boulevard 62A. VUR: INGEN offentlig vurdering (alle år har ejendomsværdi = 0, juridisk kategori = moderejendom). Dette er den samlede faste ejendom som ejerlejlighederne er opdelt under.')
      )
    ),
    li(
      p(
        strong('Ejerlejlighed 2 (BFE 136648)'),
        t(' — Arnold Nielsens Boulevard 62A. Offentlig vurdering 2022: 5.469.000 kr (grundværdi 4.011.000 kr). BBR-anvendelseskode 222, areal 432 m².')
      )
    ),
    li(
      p(
        strong('Ejerlejlighed 1 (BFE 136621)'),
        t(' — Arnold Nielsens Boulevard 62B. Offentlig vurdering 2022: 2.414.000 kr (grundværdi 1.663.000 kr). BBR-anvendelseskoder 321/323/531 (erhverv), areal i alt ~592 m².')
      )
    ),
    li(
      p(
        t('62C findes som DAWA-adgangsadresse, men er '),
        strong('ikke'),
        t(' en selvstændig ejendom — ingen ejendom i Tinglysning, ingen BBR-enheder. Biadresse til bygningen.')
      )
    )
  ),
  p(
    t('I produktionsmiljøet (test.bizzassist.dk) vises ejerlejlighederne under JaJR Holding ApS (CVR 41092807, ejer "Arnbo 62 ApS") som:'),
  ),
  ul(
    li(p(t('Arnold Nielsens Boulevard 62A — BFE 226630, 432 m² erhverv, grundværdi 4,8 mio DKK (2025), ingen handel'))),
    li(p(t('Arnold Nielsens Boulevard 62B — BFE 226629, 1.105 m² erhverv, grundværdi 10,6 mio DKK (2025), købt 7,5 mio DKK (jun. 2023)')))
  ),
  p(
    t('(BFE-numrene 226629/226630 vist i app\'en er de aktuelle BFE\'er; 136621/136648 i Tinglysning-responsen er gamle kommunale ejendomsnumre.)')
  ),
];

// ─── Ticket 1: Diagram + ejendomstab → lejlighed, samt lejlighed → hovedejendom ─

const ticket1 = {
  summary:
    'Ejerlejligheder: link fra diagram/ejendomstab til selve lejligheden, og fra lejlighedssiden tilbage til hovedejendom',
  description: {
    type: 'doc',
    version: 1,
    content: [
      h(2, 'Problem'),
      p(
        t(
          'Når en virksomhed eller person ejer en '
        ),
        strong('ejerlejlighed'),
        t(
          ' (ikke en hel SFE), har vi i dag ingen robust navigation mellem ejerlejlighed og dens hovedejendom:'
        )
      ),
      ul(
        li(
          p(
            t('På '),
            strong('virksomhedssiden'),
            t(' og '),
            strong('personsiden'),
            t(' viser "Ejendomme"-tabben og ejerskabsdiagrammet ejendomme tilknyttet ejeren. For ejerlejligheder er det uklart, om kortene/noderne linker til '),
            strong('ejerlejlighedens'),
            t(' BFE eller til '),
            strong('hovedejendommens'),
            t(' BFE — linket går i flere tilfælde til hovedejendommen, som ikke har offentlig vurdering og ikke er dét, brugeren ejer.')
          )
        ),
        li(
          p(
            t('På '),
            strong('ejendomsdetaljesiden for en ejerlejlighed'),
            t(' mangler der en synlig måde at navigere til hovedejendommen (fx for at se hele matriklens servitutter, grund, bygninger, kort osv.).')
          )
        )
      ),
      ...analyseSektion,
      h(2, 'Reproduktion'),
      ol(
        li(p(t('Log ind på test.bizzassist.dk som en bruger med adgang til JaJR Holding ApS.'))),
        li(
          p(
            t('Åbn '),
            code('/dashboard/companies/41092807'),
            t(' → fanen "Ejendomme". Klik på kortet "Arnold Nielsens Boulevard 62A".')
          )
        ),
        li(
          p(
            t('Forventet: ejendomssiden for '),
            strong('ejerlejligheden'),
            t(' (BFE 226630) med offentlig vurdering og 432 m² erhverv.')
          )
        ),
        li(
          p(
            t('Gentag med fanen "Diagram" — klik på node for 62A/62B og observer at linket går til samme BFE som ejendomstabben.')
          )
        ),
        li(
          p(
            t('På ejendomssiden: prøv at navigere til hovedejendom (BFE for SFE\'en på matrikel 21by). Der er ingen direkte knap.')
          )
        )
      ),
      h(2, 'Ønsket adfærd'),
      h(3, '1) Virksomheds-/personside: link til ejerlejlighedens BFE'),
      ul(
        li(
          p(
            t('Både ejendomstabben og ejerskabsdiagrammet skal linke til '),
            strong('ejerlejlighedens'),
            t(' ejendomsside (dens egen BFE), når ejeren faktisk ejer ejerlejligheden — ikke til hovedejendommen.')
          )
        ),
        li(
          p(
            t('Hvis ejeren ejer '),
            strong('hovedejendommen'),
            t(' (SFE) direkte, skal linket gå til SFE\'en. Identifikation sker via adkomst/ejerskab i EJF på det konkrete BFE.')
          )
        ),
        li(
          p(
            t('Kortet/noden skal vise en tydelig badge ("Lejlighed" / "Hovedejendom") så brugeren kan se typen uden at klikke.')
          )
        )
      ),
      h(3, '2) Ejerlejlighedens ejendomsside: navigation til hovedejendom'),
      ul(
        li(
          p(
            t('I header/infoboks på ejendomsdetaljesiden for en ejerlejlighed: tilføj en synlig knap/link "Gå til hovedejendom (BFE XXXX)".')
          )
        ),
        li(
          p(
            t('Hovedejendommens BFE findes via MAT_SamletFastEjendom på samme jordstykke (ejerlav + matrikelnr). Alternativt via EJF\'s relation fra ejerlejlighed → SFE.')
          )
        ),
        li(
          p(
            t('På hovedejendomssiden: tilsvarende sektion "Ejerlejligheder på denne matrikel" som lister alle ejerlejligheder (allerede delvist understøttet via '),
            code('/api/ejerlejligheder'),
            t(') med link til hver ejerlejligheds BFE.')
          )
        )
      ),
      h(2, 'Acceptance criteria'),
      ul(
        li(
          p(
            t('Fra '),
            code('/dashboard/companies/41092807'),
            t(' → "Ejendomme" fører klik på 62A/62B til hhv. BFE 226630 og BFE 226629 (ikke hovedejendommens SFE-BFE).')
          )
        ),
        li(
          p(
            t('Samme navigation gælder i Diagram-tabben.')
          )
        ),
        li(
          p(
            t('På ejerlejlighedens ejendomsside er en tydelig knap "Gå til hovedejendom" synlig øverst.')
          )
        ),
        li(
          p(
            t('På hovedejendomssiden (matrikel 21by, BFE for SFE) er alle ejerlejligheder på matriklen listet med klikbare links.')
          )
        ),
        li(
          p(
            t('Ingen cross-tenant data: alle opslag går via tenant-scoped API-ruter.')
          )
        )
      ),
      h(2, 'Teknisk note'),
      ul(
        li(
          p(
            t('Datagrundlag til at skelne ejerlejlighed vs. SFE: VUR_BFEKrydsreference ('),
            code('juridiskKategoriKode'),
            t(' / '),
            code('benyttelseKode'),
            t(') eller MAT\'s ejendomstype på BFE.')
          )
        ),
        li(
          p(
            t('Relateret kode: '),
            code('app/api/ejerlejligheder/route.ts'),
            t(', '),
            code('app/dashboard/companies/[cvr]/VirksomhedDetaljeClient.tsx'),
            t(', '),
            code('app/components/diagrams/DiagramData.ts'),
            t(', '),
            code('app/dashboard/ejendomme/[id]/EjendomDetaljeClient.tsx'),
            t('.')
          )
        )
      ),
    ],
  },
};

// ─── Ticket 2: Adressesøgning → lejlighed + hovedejendom ────────────────────

const ticket2 = {
  summary:
    'Adressesøgning: vis både ejerlejlighed og hovedejendom (eller åbn lejlighed først med link til hovedejendom)',
  description: {
    type: 'doc',
    version: 1,
    content: [
      h(2, 'Problem'),
      p(
        t(
          'Når en bruger søger en adresse der dækker både en ejerlejlighed og en hovedejendom (SFE), viser søgefeltet kun ét resultat — og det er ikke konsistent hvilken ejendom der åbnes. Det er umuligt for brugeren at nå den anden ejendom fra søgefeltet alene.'
        )
      ),
      ...analyseSektion,
      h(2, 'Reproduktion'),
      ol(
        li(
          p(
            t('Åbn et hvilket som helst søgefelt ('),
            code('/dashboard'),
            t(' eller dashboard-søg i toppen).')
          )
        ),
        li(p(t('Søg: "Arnold Nielsens Boulevard 62A 2650".'))),
        li(
          p(
            t('Observer: kun ét resultat. Enten åbnes hovedejendommen (ingen vurdering, ingen handel) eller ejerlejligheden — ikke begge, og uden label der fortæller hvilken type ejendom der åbnes.')
          )
        )
      ),
      h(2, 'Ønsket adfærd — to varianter, vælg én'),
      h(3, 'Variant A — to resultater med tydelig skelnen'),
      ul(
        li(
          p(
            t('Søgeforslag viser '),
            strong('både'),
            t(' ejerlejligheden og hovedejendommen når en adresse dækker begge:')
          )
        ),
        li(
          p(
            code('Arnold Nielsens Boulevard 62A · Ejerlejlighed · BFE 226630 · 432 m² · 4,8 mio DKK (2025)')
          )
        ),
        li(
          p(
            code('Arnold Nielsens Boulevard 62A · Hovedejendom (SFE) · BFE 2091165 · matrikel 21by')
          )
        ),
        li(
          p(
            t('Hver linje har en badge (Lejlighed / Hovedejendom) og en kort forklaring.')
          )
        )
      ),
      h(3, 'Variant B — åbn altid ejerlejligheden først, link til hovedejendom'),
      ul(
        li(
          p(
            t('Ét søgeresultat — altid ejerlejligheden (fordi den er det brugeren typisk mener når de skriver en adresse).')
          )
        ),
        li(
          p(
            t('På ejendomssiden vises øverst en tydelig knap: '),
            strong('"Gå til hovedejendom (BFE …)"'),
            t(' — samme knap som i søsterticket om diagram/ejendomstab-linking.')
          )
        ),
        li(
          p(
            t('Fordel: enklere UX, ingen duplikerede rækker i dropdown.'),
          )
        ),
        li(
          p(
            t('Ulempe: brugeren kan ikke lande direkte på hovedejendommen fra søg (men kan komme dertil i to klik).'),
          )
        )
      ),
      h(2, 'Anbefaling'),
      p(
        t('Variant A giver størst transparens og matcher datamodellen bedst. Variant B er simplere at implementere og føles mere intuitivt for typiske brugere. '),
        strong('Beslut i ticketet hvilken variant vi går med før implementering.')
      ),
      h(2, 'Acceptance criteria'),
      ul(
        li(
          p(
            t('Søgning på "Arnold Nielsens Boulevard 62A" returnerer både ejerlejlighed (BFE 226630) og hovedejendom (BFE for SFE på matrikel 21by) — ELLER åbner ejerlejligheden med tydeligt link til hovedejendom.')
          )
        ),
        li(
          p(
            t('Samme adfærd for 62B (BFE 226629) og for alle adresser hvor en SFE er opdelt i ejerlejligheder.')
          )
        ),
        li(
          p(
            t('Adresser uden ejerlejligheder (almindelige parcelhuse, SFE uden opdeling) virker uændret — stadig ét resultat.')
          )
        ),
        li(
          p(
            t('Ingen regression på adressesøg-performance (p95 < 500 ms).')
          )
        ),
      ),
      h(2, 'Teknisk note'),
      ul(
        li(
          p(
            t('Eksisterende endpoints: '),
            code('/api/ejerlejligheder'),
            t(' kan slå ejerlejligheder op på ejerlav + matrikelnr. Fra en adgangsadresse-UUID har vi allerede matrikel via DAWA jordstykker.')
          )
        ),
        li(
          p(
            t('Identifikation af hovedejendom vs. ejerlejlighed: VUR_BFEKrydsreference '),
            code('benyttelseKode=20'),
            t(' = moderejendom (SFE uden egen vurdering), kode 21+ = ejerlejlighed med vurdering.')
          )
        ),
        li(
          p(
            t('Relateret kode: '),
            code('app/components/Search*.tsx'),
            t(' (dashboard-søg), '),
            code('app/api/search/*'),
            t(' (backend), '),
            code('app/lib/fetchBbrData.ts'),
            t(' (BFE-resolution).')
          )
        ),
      ),
      h(2, 'Relaterer til'),
      ul(
        li(
          p(
            t('Søster-ticket: "Ejerlejligheder: link fra diagram/ejendomstab til selve lejligheden, og fra lejlighedssiden tilbage til hovedejendom" (oprettes samme dag).')
          )
        )
      ),
    ],
  },
};

// ─── Kør ────────────────────────────────────────────────────────────────────

const meta = await req(
  'GET',
  `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`
);
const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
const issueType =
  types.find((t) => /^task$/i.test(t.name)) ??
  types.find((t) => /^story$/i.test(t.name)) ??
  types.find((t) => !t.subtask);

if (!issueType) {
  console.error('Kunne ikke finde issueType i JIRA createmeta');
  process.exit(1);
}

for (const tk of [ticket1, ticket2]) {
  const payload = {
    fields: {
      project: { key: PROJECT },
      summary: tk.summary,
      description: tk.description,
      issuetype: { id: issueType.id },
      priority: { name: 'Medium' },
    },
  };
  const res = await req('POST', '/rest/api/3/issue', payload);
  if (res.status === 201) {
    const key = JSON.parse(res.body).key;
    console.log(`Created: ${key}  —  ${tk.summary}`);
    console.log(`  URL: https://${HOST}/browse/${key}`);
  } else {
    console.log(`FAILED (${res.status}) for "${tk.summary}":`, res.body.slice(0, 500));
  }
}
