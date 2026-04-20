#!/usr/bin/env node
/**
 * Adds SDFI support follow-up answer as a comment on BIZZ-584 and transitions
 * the issue to Done — the question has been answered by Datafordeler support.
 *
 * Key finding: EJFCustom_PersonSimpelBegraenset is a TYPE, not a query field.
 * Persondata skal hentes via traversal gennem en af de 3 rod-queries:
 *   - EJFCustom_EjerskabBegraenset                → ejendePersonBegraenset
 *   - EJFCustom_EjendomsadministratorBegraenset   → personBegraenset
 *   - EJFCustom_PersonEllerVirksomhedsadminiBegraenset → personBegraenset
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
const ISSUE = 'BIZZ-584';
const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

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

const para = (...children) => ({ type: 'paragraph', content: children });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const heading = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (...children) => ({ type: 'listItem', content: children });
const ul = (...items) => ({ type: 'bulletList', content: items });
const codeBlock = (text, lang) => ({
  type: 'codeBlock',
  attrs: lang ? { language: lang } : {},
  content: [{ type: 'text', text }],
});

// ─── Comment body ───────────────────────────────────────────────────────────

const commentBody = {
  type: 'doc',
  version: 1,
  content: [
    heading(2, 'Svar fra Datafordeler / SDFI support (2026-04-20)'),
    para(
      txt(
        'Citat fra support: '
      ),
      txt(
        '"EJFCustom_PersonSimpelBegraenset er ikke et felt-navn, men et type-navn, og der er flere felter som har denne type – f.eks. personBegraenset under query EJFCustom_EjendomsadministratorBegraenset, og ejendePersonBegraenset under EJFCustom_EjerskabBegraenset. … Servicen findes ikke på et andet endpoint end https://graphql.datafordeler.dk/flexibleCurrent/v1/ for flexibleCurrent. Hvis I har fået godkendt adgang til EJFCustom_PersonSimpelBegraenset fra EJF, burde I have adgang til data."',
        [{ type: 'em' }]
      )
    ),
    heading(2, 'Konklusion'),
    para(
      code('EJFCustom_PersonSimpelBegraenset'),
      txt(' er en '),
      strong('type'),
      txt(' — ikke en query. Alle 8 navne vi probede (inkl. varianter uden præfiks) returnerede korrekt "field does not exist", fordi der '),
      strong('ikke findes'),
      txt(' en rod-query med det navn. Persondata hentes udelukkende ved traversal gennem én af de 3 Custom-rod-queries.')
    ),
    heading(2, 'Verificeret mod live schema'),
    para(
      txt('Schema hentet fra '),
      code('https://graphql.datafordeler.dk/flexibleCurrent/v1/schema?apikey=…'),
      txt('. Query-typen har '),
      strong('kun 3'),
      txt(' EJFCustom-rod-felter:')
    ),
    ul(
      li(
        para(
          code('EJFCustom_EjerskabBegraenset(first, virkningstid!, where)'),
          txt(' → '),
          code('EJFCustom_EjerskabBegraensetConnection')
        )
      ),
      li(
        para(
          code('EJFCustom_EjendomsadministratorBegraenset(first, virkningstid!, where)'),
          txt(' → '),
          code('EJFCustom_EjendomsadministratorBegraensetConnection')
        )
      ),
      li(
        para(
          code('EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first, virkningstid!, where)'),
          txt(' → '),
          code('EJFCustom_PersonEllerVirksomhedsadminiBegraensetConnection')
        )
      )
    ),
    para(
      txt('Typen '),
      code('EJFCustom_PersonSimpelBegraenset'),
      txt(' tilgås som sub-felt på ovennævnte og har disse traversalfelter på interfacet '),
      code('EJFCustom_PersonSimpelInterfaceType'),
      txt(':')
    ),
    ul(
      li(para(code('personBegraenset'), txt(' (på Ejendomsadministrator og PersonEllerVirksomhedsadmini)'))),
      li(para(code('ejendePersonBegraenset'), txt(' (på Ejerskab)'))),
      li(para(code('administrerendePersonBegraenset'))),
      li(para(code('administreretPersonBegraenset')))
    ),
    heading(2, 'Korrekt query (virker når auth er OAuth-bearer, ikke apikey=)'),
    codeBlock(
      `{
  EJFCustom_EjerskabBegraenset(
    first: 50,
    virkningstid: "2026-04-20T12:00:00+02:00",
    where: { bestemtFastEjendomBFENr: { eq: 100165718 } }
  ) {
    nodes {
      id_lokalId
      ejerforholdskode
      ejeroplysningerLokalId
      ejendePersonBegraenset {
        id
        foedselsdato
        status
        navn { navn }           # OBS: enkelt felt — ikke fornavn/efternavn
        cprAdresse { ... }
      }
    }
  }
}`,
      'graphql'
    ),
    heading(2, 'Gotchas fundet under verifikation'),
    ul(
      li(
        para(
          code('EJFCustom_PersonSimpelNavn'),
          txt(' har kun '),
          code('navn: String!'),
          txt(' — ikke '),
          code('{fornavn, efternavn}'),
          txt('. Parser selv hvis splittet navn skal vises.')
        )
      ),
      li(
        para(
          txt('Rod-queryen '),
          code('EJFCustom_EjerskabBegraenset'),
          txt(' har IKKE et '),
          code('ejendePersonPersonNr'),
          txt('-felt direkte (har '),
          code('ejeroplysningerLokalId'),
          txt('). Personnummer må hentes via '),
          code('ejendePersonBegraenset.id'),
          txt('.')
        )
      ),
      li(
        para(
          txt('Der findes '),
          strong('ingen'),
          txt(' måde at lookuppe en person direkte på personnummer — man skal altid gå via Ejerskab/Administrator. Det har implikationer for '),
          strong('BIZZ-534'),
          txt(' (person→ejendomme): vi kan ikke søge på CPR direkte, men skal i stedet scanne alle Ejerskaber og filtrere på person-ID, eller vente på bulk-ingest.')
        )
      ),
      li(
        para(
          txt('Schema kan ikke introspect\'es ('),
          code('__type'),
          txt(' blokeret med HC0046) — brug '),
          code('/schema?apikey=…'),
          txt(' endpoint til feltopslag fremover.')
        )
      )
    ),
    heading(2, 'Acceptance criteria — status'),
    ul(
      li(para(txt('✅ Korrekt GraphQL-"field-navn" identificeret: der ER ingen — typen bruges via traversal.'))),
      li(
        para(
          txt('✅ Memory '),
          code('reference_datafordeler_ejf.md'),
          txt(' opdateres med denne note + eksempel-query.')
        )
      ),
      li(
        para(
          code('/api/debug/ejf-probe'),
          txt(' kan nu parkeres/fjernes — har tjent sit formål.')
        )
      )
    ),
    heading(2, 'Follow-up'),
    ul(
      li(
        para(
          strong('BIZZ-583'),
          txt(' (vis administrator via EJFCustom_EjendomsadministratorBegraenset): kan implementeres nu — skal bruge '),
          code('personBegraenset'),
          txt('-traversalen til at få administrators navn/fødselsdato.')
        )
      ),
      li(
        para(
          strong('BIZZ-534'),
          txt(' (EJF bulk-ingestion): skal tage højde for at person-data kun fås via Ejerskab-traversal — bulk-indexet skal bygges ud fra Ejerskab-nodes, ikke ud fra en Person-query.')
        )
      ),
      li(
        para(
          strong('BIZZ-576'),
          txt(' (ejerlejlighed-BFE drill-down): bliver nemmere når Ejerskab-nodes tilgås med '),
          code('bestemtFastEjendomBFENr'),
          txt(' filter direkte.')
        )
      )
    ),
  ],
};

// ─── Kør ────────────────────────────────────────────────────────────────────

const commentRes = await req('POST', `/rest/api/3/issue/${ISSUE}/comment`, { body: commentBody });
if (commentRes.status !== 201) {
  console.error(`FAILED to add comment (${commentRes.status}):`, commentRes.body.slice(0, 500));
  process.exit(1);
}
console.log(`✅ Comment added to ${ISSUE}`);

// Find Done-transition
const transitions = await req('GET', `/rest/api/3/issue/${ISSUE}/transitions`);
const trList = JSON.parse(transitions.body).transitions ?? [];
const done = trList.find((t) => /^done$/i.test(t.name)) ?? trList.find((t) => /done/i.test(t.name));

if (!done) {
  console.log('⚠️  No Done transition found. Available:', trList.map((t) => `${t.id}:${t.name}`).join(', '));
} else {
  const trRes = await req('POST', `/rest/api/3/issue/${ISSUE}/transitions`, {
    transition: { id: done.id },
  });
  if (trRes.status === 204) {
    console.log(`✅ ${ISSUE} transitioned → Done (transition id ${done.id})`);
  } else {
    console.log(`⚠️  Transition failed (${trRes.status}):`, trRes.body.slice(0, 300));
  }
}

console.log(`\nURL: https://${HOST}/browse/${ISSUE}`);
