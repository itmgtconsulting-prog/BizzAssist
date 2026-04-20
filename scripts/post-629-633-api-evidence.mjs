#!/usr/bin/env node
/**
 * Post definitiv API-level evidens på BIZZ-629 + BIZZ-633.
 * Begge bugs er bekræftet via direkte fetch fra authenticated browser-context.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => marks ? { type: 'text', text, marks } : { type: 'text', text };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });
const codeBlock = (text, lang) => ({ type: 'codeBlock', attrs: lang ? { language: lang } : {}, content: [{ type: 'text', text }] });

const evidence = {
  'BIZZ-629': {
    type: 'doc', version: 1, content: [
      h(2, 'API-level verifikation — BUG BEKRÆFTET'),
      p(txt('Direkte fetch af '), code('/api/ejendomme-by-owner?cvr=<datterselskab>'), txt(' fra authenticated browser-context returnerer '), strong('null'), txt(' for alle areal-felter på alle 6 berørte BFE\'er:')),
      codeBlock(
`CVR 43924931 (Arnbo 62 ApS) — 2 ejendomme:
  BFE 226630  bolig=null  erhv=null  matr=null  Arnold Nielsens Boulevard 62A
  BFE 226629  bolig=null  erhv=null  matr=null  Arnold Nielsens Boulevard 62B

CVR 44364484 (ArnBo 64b ApS) — 1 ejendom:
  BFE 2091185 bolig=null  erhv=null  matr=null  Arnold Nielsens Boulevard 64B

CVR 41370025 (HP Properties ApS) — 3 ejendomme:
  BFE 2091179 bolig=null  erhv=null  matr=null  Høvedstensvej 33
  BFE 2091191 bolig=null  erhv=null  matr=null  Høvedstensvej 39
  BFE 2091198 bolig=null  erhv=null  matr=null  Høvedstensvej 43`,
        'text'
      ),
      h(3, 'Root cause'),
      p(txt('Backend ('), code('/api/ejendomme-by-owner/route.ts'), txt(') returnerer '), code('boligAreal: null'), txt(', '), code('erhvervsAreal: null'), txt(', '), code('matrikelAreal: null'), txt(' for disse ejendomme. Frontend fallback '), code('(enriched.boligAreal ?? 0).toLocaleString()'), txt(' i '), code('PropertyOwnerCard.tsx:263'), txt(' viser derfor "0 m²".')),
      p(txt('Bugget er en REGRESSION — samme ejendomme viste tidligere korrekte værdier (62B = 1.105 m², Høvedstensvej 33 = 586 m², 43 = 1.406 m²). Regression landede sandsynligvis i BIZZ-534/-596 alignment-arbejdet.')),
      h(3, 'Næste skridt'),
      ul(
        li(p(txt('Undersøg '), code('hentBfeByCvr()'), txt('-funktionen i '), code('/api/ejendomme-by-owner/route.ts'), txt(' — mapper den '), code('samletEtageareal'), txt(' / '), code('samletBoligareal'), txt(' / '), code('samletErhvervsareal'), txt(' fra BBR_Ejendomsrelation?'))),
        li(p(txt('Tjek om BBR-query pr. BFE returnerer felterne — prøv manuelt i Datafordeler GraphQL explorer for BFE 226629.'))),
        li(p(txt('Sammenlign med '), code('fetchBbrData.ts'), txt(' som bruges på ejendoms-detaljesiden (hvor m² vises korrekt) — der må være en forskel i felter/query.'))),
      ),
    ],
  },
  'BIZZ-633': {
    type: 'doc', version: 1, content: [
      h(2, 'API-level verifikation — BUG BEKRÆFTET + BREDERE END RAPPORTERET'),
      p(txt('Direkte fetch af '), code('/api/salgshistorik?bfeNummer=<X>'), txt(' returnerer '), strong('handler.length: 0 med fejl "EJF_Ejerskifte query fejlede"'), txt(' for '), strong('alle'), txt(' testede BFE\'er:')),
      codeBlock(
`GET /api/salgshistorik?bfeNummer=425479  (Kaffevej 31 1.tv — ejerlejlighed)
  → handler.length: 0, fejl: "EJF_Ejerskifte query fejlede"

GET /api/salgshistorik?bfeNummer=226629  (Arnold Nielsens Blvd 62B — almindelig ejd.)
  → handler.length: 0, fejl: "EJF_Ejerskifte query fejlede"

GET /api/salgshistorik?bfeNummer=100165718 (Thorvald Bindesbølls Plads 18 — hovedejendom)
  → handler.length: 0, fejl: "EJF_Ejerskifte query fejlede"`,
        'text'
      ),
      h(3, 'Bredere end oprindeligt rapporteret'),
      p(txt('Ticketen sagde "kun 1 linje vises" — men '), strong('API\'et returnerer 0 handler overalt'), txt(' nu. Den "1 linje" som UI viser kommer sandsynligvis fra fallback-kilde '),
        code('Tinglysning adkomster'), txt(' (se '), code('EjendomDetaljeClient.tsx:850'),
        txt(' — "Tinglysning adkomster (ejerskifter) — bruges til at berige salgshistorik med købernavne"). Dvs. salgshistorik-API\'et bidrager 0.')),
      h(3, 'Root cause hypotese'),
      p(txt('Per BIZZ-584 har vi ikke adgang til '), code('EJF_Ejerskifte'), txt(' direkte — kun '), code('EJFCustom_EjerskabBegraenset'), txt(' via flexibleCurrent. Men '), code('/api/salgshistorik/route.ts'),
        txt(' forsøger stadig at kalde '), code('EJF_Ejerskifte'), txt(' og returnerer fejlen.')),
      p(strong('Fix: skift fra EJF_Ejerskifte til tinglysning-adkomster eller EJFCustom_EjerskabBegraenset som primær kilde.'), txt(' Virkningstidsintervaller fra EJFCustom kan bruges til at udlede ejerskifter.')),
      h(3, 'Relaterer'),
      ul(
        li(p(strong('BIZZ-584'), txt(' — SDFI bekræftet at EJF_Ejerskifte ikke er i vores grant'))),
        li(p(strong('BIZZ-480/481'), txt(' — skulle have udvidet EJF_Handelsoplysninger/Ejerskifte-opslag; disse kan ikke leveres uden grant'))),
      ),
    ],
  },
};

for (const [key, body] of Object.entries(evidence)) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  console.log(c.status === 201 ? `✅ ${key} API-evidence posted` : `❌ ${key} failed (${c.status})`);
}
