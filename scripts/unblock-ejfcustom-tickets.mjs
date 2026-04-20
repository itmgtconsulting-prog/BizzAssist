#!/usr/bin/env node
/**
 * Tilføjer "unblocked" follow-up kommentarer til BIZZ-583, BIZZ-534 og BIZZ-576
 * efter at BIZZ-584 har afdækket det korrekte traversal-mønster for
 * EJFCustom_PersonSimpelBegraenset. Hver kommentar indeholder et konkret
 * query-eksempel og beskriver hvad det betyder for den pågældende ticket.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

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

// ─── ADF helpers ────────────────────────────────────────────────────────────

const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const heading = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });
const codeBlock = (text, lang) => ({
  type: 'codeBlock',
  attrs: lang ? { language: lang } : {},
  content: [{ type: 'text', text }],
});

// ─── Fælles header (kontekst) ───────────────────────────────────────────────

const contextHeader = [
  heading(2, 'Unblocked af BIZZ-584 (2026-04-20)'),
  para(
    txt('SDFI support + live schema-verifikation har bekræftet at '),
    code('EJFCustom_PersonSimpelBegraenset'),
    txt(' er en '),
    strong('type'),
    txt(' — ikke en query. Persondata tilgås via traversal på de 3 eksisterende rod-queries. Schema hentet fra '),
    code('https://graphql.datafordeler.dk/flexibleCurrent/v1/schema?apikey=…'),
    txt('.')
  ),
];

// ─── BIZZ-583: Ejendomsadministrator ────────────────────────────────────────

const body583 = {
  type: 'doc',
  version: 1,
  content: [
    ...contextHeader,
    heading(3, 'Konkret query til administrator-kort'),
    codeBlock(
      `{
  EJFCustom_EjendomsadministratorBegraenset(
    first: 50,
    virkningstid: "2026-04-20T12:00:00+02:00",
    where: { bestemtFastEjendomBFENr: { eq: <BFE> } }
  ) {
    nodes {
      id_lokalId
      virkningFra
      virkningTil
      virksomhedCVRNr
      personEllerVirksomhedLokalId
      personBegraenset {
        id
        foedselsdato
        navn { navn }          # OBS: kun ét felt — ikke fornavn/efternavn
        cprAdresse { ... }
      }
    }
  }
}`,
      'graphql'
    ),
    heading(3, 'Implementeringsnote'),
    ul(
      li(
        para(
          txt('Hvis '),
          code('virksomhedCVRNr'),
          txt(' er sat → administrator er virksomhed (slå op via vores eksisterende CVR-API).')
        )
      ),
      li(
        para(
          txt('Hvis '),
          code('personEllerVirksomhedLokalId'),
          txt(' er sat → slå op via '),
          code('EJFCustom_PersonEllerVirksomhedsadminiBegraenset'),
          txt(' → '),
          code('personBegraenset'),
          txt(' for person-stamdata.')
        )
      ),
      li(
        para(
          txt('Navn er kun ét felt '),
          code('navn.navn: String!'),
          txt(' — parse selv hvis splittet visning ønskes.')
        )
      ),
      li(
        para(
          strong('Auth:'),
          txt(' OAuth bearer (samme flow som '),
          code('/api/ejerskab'),
          txt('). apikey= virker ikke på Custom-queries.')
        )
      ),
    ),
  ],
};

// ─── BIZZ-534: Bulk-ingestion arkitektur-note ───────────────────────────────

const body534 = {
  type: 'doc',
  version: 1,
  content: [
    ...contextHeader,
    heading(3, 'Arkitektur-konsekvens for bulk-index'),
    para(
      txt('Der findes '),
      strong('ingen'),
      txt(' rod-query der lookupper person på personnummer i EJFCustom. '),
      code('EJFCustom_PersonSimpelBegraenset'),
      txt(' kan KUN nås ved traversal gennem '),
      code('EJFCustom_EjerskabBegraenset'),
      txt(' (eller Administrator-queries).')
    ),
    para(
      strong('Konsekvens:'),
      txt(' Bulk-indekset skal bygges '),
      strong('Ejerskab-først'),
      txt(', ikke Person-først. Den planlagte '),
      code('ejf_ejerskab'),
      txt('-tabel (se description) er allerede rigtigt designet — person-data ('),
      code('ejer_navn'),
      txt(', '),
      code('ejer_foedselsdato'),
      txt(') materialiseres fra '),
      code('ejendePersonBegraenset'),
      txt('-sub-object på hver Ejerskab-node under ingest.')
    ),
    heading(3, 'Konkret ingest-query (OAuth, flexibleCurrent/v1/)'),
    codeBlock(
      `{
  EJFCustom_EjerskabBegraenset(
    first: 1000,                         # paginér via cursor
    virkningstid: "<now>",
    where: { ejerforholdskode: { eq: "10" } }   # 10 = direkte ejer
  ) {
    nodes {
      id_lokalId
      bestemtFastEjendomBFENr
      ejerforholdskode
      ejerandelTaeller ejerandelNaevner
      virkningFra virkningTil status
      ejendeVirksomhedCVRNr
      ejeroplysningerLokalId
      ejendePersonBegraenset {
        id                               # = personnummer
        foedselsdato
        navn { navn }
      }
    }
  }
}`,
      'graphql'
    ),
    heading(3, 'Fildownload-spor (Mode A)'),
    ul(
      li(
        para(
          txt('Filudtræk "EJF Totaludtræk Flad Prædefineret JSON" bruger sandsynligvis samme datamodel — verificér at totaludtrækket indeholder '),
          code('ejendePersonBegraenset'),
          txt('-strukturen eller tilsvarende felter ('),
          code('ejer_cpr'),
          txt(', '),
          code('ejer_foedselsdato'),
          txt(').')
        )
      ),
      li(
        para(
          txt('Hvis filudtrækket KUN har person-lokalId uden navn/foedselsdato, skal vi supplere med batch-GraphQL-opslag (tung — derfor foretrækkes Filudtræk med alle felter).')
        )
      ),
    ),
  ],
};

// ─── BIZZ-576: Ejerlejlighed-BFE drill-down ─────────────────────────────────

const body576 = {
  type: 'doc',
  version: 1,
  content: [
    ...contextHeader,
    heading(3, 'Forenklet drill-down med EJFCustom_EjerskabBegraenset'),
    para(
      txt('Med den verificerede query-form kan drill-downet implementeres direkte — uden at skulle gennem hovedejendom + liste af ejerlejligheder først:')
    ),
    codeBlock(
      `# Alle ejerlejligheder (+hovedejendom) som CVR ejer — ét kald
{
  EJFCustom_EjerskabBegraenset(
    first: 100,
    virkningstid: "<now>",
    where: { ejendeVirksomhedCVRNr: { eq: "<CVR>" } }
  ) {
    nodes {
      bestemtFastEjendomBFENr       # ← dette ER ejerlejligheds-BFE hvis CVR
      ejerforholdskode              #   ejer lejligheden direkte
      virkningFra virkningTil status
      # Traverse til MAT for at skelne SFE vs. ejerlejlighed:
      ejerskabOmfatterBestemtFastEjendomEJL {
        nodes { BFEnummer ejerlejlighedsnummer hovedejendomBFE }
      }
      ejerskabOmfatterBestemtFastEjendomSFE {
        nodes { BFEnummer }
      }
    }
  }
}`,
      'graphql'
    ),
    heading(3, 'Logik'),
    ul(
      li(
        para(
          txt('Hvis '),
          code('ejerskabOmfatterBestemtFastEjendomEJL.nodes'),
          txt(' er non-empty → ejerskabet er på en '),
          strong('ejerlejlighed'),
          txt(' — returnér ejerlejlighedens BFE.')
        )
      ),
      li(
        para(
          txt('Hvis kun '),
          code('ejerskabOmfatterBestemtFastEjendomSFE'),
          txt(' → ejerskabet er på en hovedejendom (SFE).')
        )
      ),
      li(
        para(
          txt('Cache pr. CVR i 24t (samme TTL som eksisterende EJF-data).')
        )
      ),
    ),
    para(
      txt('Datafordeler-schema har allerede '),
      code('ejerskabOmfatterBestemtFastEjendomEJL/SFE/BPFGF/BPFGP'),
      txt(' som sub-felter — dvs. ingen separat MAT_Ejerlejlighed-join behøves.')
    ),
  ],
};

// ─── Post ───────────────────────────────────────────────────────────────────

const tasks = [
  { key: 'BIZZ-583', body: body583 },
  { key: 'BIZZ-534', body: body534 },
  { key: 'BIZZ-576', body: body576 },
];

for (const { key, body } of tasks) {
  const res = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (res.status === 201) {
    console.log(`✅ Comment added to ${key}  —  https://${HOST}/browse/${key}`);
  } else {
    console.log(`❌ FAILED (${res.status}) for ${key}:`, res.body.slice(0, 300));
  }
}
