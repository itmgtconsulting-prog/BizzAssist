#!/usr/bin/env node
/**
 * 1. Transition BIZZ-695 → Done (Option B valgt)
 * 2. Opret 2 nye tickets:
 *    - Søgning inkluderer 62A-lejligheder (DAWA /adresser fallback)
 *    - Areal + købspris enrichment på ejerlejligheder (BBR_Enhed + EJF)
 * 3. Link begge som "relates to" BIZZ-695
 */
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
const ol = (...i) => ({ type: 'orderedList', content: i });
const cb = (t, lang = 'text') => ({ type: 'codeBlock', attrs: { language: lang }, content: [{ type: 'text', text: t }] });
const doc = (...blocks) => ({ type: 'doc', version: 1, content: blocks });

// ─── 1. Close-kommentar på BIZZ-695 ───────────────────────────────────────
await req('POST', '/rest/api/3/issue/BIZZ-695/comment', {
  body: doc(
    h(2, 'Afsluttes (Option B)'),
    p(txt('Fase 1+2 shipped og verificeret. Resterende arbejde spores i 2 nye tickets:')),
    p(code('[NY] BIZZ-???'), txt(' — Søgning: inkluder 62A-lejligheder (DAWA /adresser fallback)')),
    p(code('[NY] BIZZ-???'), txt(' — Areal + købspris enrichment på ejerlejligheder (BBR_Enhed + EJF)')),
    p(strong('BIZZ-695 → Done. '), txt('Datamodel-analysen er komplet og grund-funktionaliteten (hovedejendom → lejlighedsliste) virker i prod.'))
  ),
});
console.log('✅ Close-comment posted to BIZZ-695');

const tr = await req('GET', '/rest/api/3/issue/BIZZ-695/transitions');
const done = (JSON.parse(tr.body).transitions || []).find(t => /^done$/i.test(t.name));
if (done) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-695/transitions', { transition: { id: done.id } });
  console.log(r.status === 204 ? '✅ BIZZ-695 → Done' : `⚠️ ${r.status}`);
}

// ─── 2. Ticket #1: Søgning inkluderer 62A-lejligheder ────────────────────
const searchTicket = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'Søgning: inkluder individuelle lejligheder når adgangsadresse mangler underliggende adresser i DAWA autocomplete',
    labels: ['search', 'dawa', 'ejerlejlighed', 'ejendom'],
    description: doc(
      h(2, 'Problem'),
      p(txt('Søgning på '), code('"Arnold Nielsens Boulevard 62"'), txt(' returnerer asymmetriske resultater:')),
      cb(
`✅ 62A (hovedejendom / adgangsadresse)
✅ 62B (hovedejendom / adgangsadresse)
❌ 62A 1. — MANGLER
❌ 62A st. — MANGLER
✅ 62B 1.
✅ 62B st.`,
        'text'
      ),
      p(strong('62A\'s lejligheder eksisterer'), txt(' i BBR_Enhed (verificeret i BIZZ-695) med DAWA-UUIDs '), code('9152fa99-bac2-...'), txt(' (62A 1.sal) og '), code('5f618945-2b9f-...'), txt(' (62A st.), men de vises ikke i søge-dropdown. Brugeren kan således ikke finde dem via søgning — kun ved at klikke ind på hovedejendommen.')),

      h(2, 'Root cause (fra BIZZ-695 analyse)'),
      p(txt('Vores '), code('/api/search'), txt(' bruger DAWA autocomplete (/adgangsadresser). DAWA autocomplete returnerer kun enheds-adresser hvis de har distinkt etage+dør i '), code('/adresser'), txt('. 62B\'s lejligheder har etage registreret, 62A\'s lejligheder har måske ikke — derfor asymmetrien.')),
      p(txt('Det betyder vi ikke kan stole på DAWA autocomplete alene. Vi har brug for en fallback der tjekker '), code('/adresser?adgangsadresseid=<X>'), txt(' for alle adgangsadresser der matcher query\'en.')),

      h(2, 'Foreslået fix'),
      h(3, 'Option A — fallback på search-server'),
      cb(
`// app/api/search/route.ts
// Efter DAWA /adgangsadresser autocomplete:
for (const accessAddr of autocompleteResults) {
  if (accessAddr.type !== 'adgangsadresse') continue;
  // Probe /adresser for denne adgangsadresse
  const sub = await fetchDawa(\`/adresser?adgangsadresseid=\${accessAddr.id}&struktur=mini\`);
  const children = await sub.json();
  if (children.length > 1) {
    // Der er individuelle lejligheder — tilføj dem som separate search-hits
    for (const child of children) {
      if (!child.etage && !child.dør) continue; // skip "main" entry
      results.push({
        type: 'address',
        id: child.id,
        title: formatAdresse(child),
        subtitle: child.postnummer.navn,
        meta: { etage: child.etage, dør: child.dør, ... },
        href: \`/dashboard/ejendomme/\${child.id}\`,
      });
    }
  }
}`,
        'typescript'
      ),

      h(3, 'Option B — BBR_Enhed-driven søge-index'),
      p(txt('Bygge et lokalt søge-index fra '), code('bbr_enhed'), txt(' tabellen (hvis den findes lokalt) der giver 1:1 mellem adresse og lejlighed. Tungere løsning men giver fuld kontrol over hvad søgning returnerer.')),

      h(2, 'Acceptance'),
      ul(
        li(p(txt('Søgning på '), code('"Arnold Nielsens Boulevard 62"'), txt(' returnerer '), strong('6 resultater'), txt(': 2 hovedejendomme + 4 lejligheder (62A 1., 62A st., 62B 1., 62B st.).'))),
        li(p(txt('Performance: autocomplete svarer stadig < 500 ms p95 (throttle fallback til max 3 parallelle /adresser-opslag).'))),
        li(p(txt('Playwright E2E: skriv "Arnold Nielsens Boulevard 62" i søgefelt → drop-down viser mindst 4 lejligheds-rækker med etage-info.'))),
        li(p(txt('Ingen regression på andre adresser: søg på "Kaffevej 31, 1.tv" virker stadig.'))),
      ),

      h(2, 'Relateret'),
      p(code('BIZZ-695'), txt(' Problem 1 (afsluttet som Done; dette ticket dækker resterende arbejde).')),
      p(code('BIZZ-608'), txt(' etablerede adressesøgning for både ejerlejlighed og hovedejendom — vi bygger videre på samme mønster.'))
    ),
  },
});
if (searchTicket.status !== 201) {
  console.error('Search ticket failed:', searchTicket.status, searchTicket.body.slice(0, 300));
  process.exit(1);
}
const SEARCH_KEY = JSON.parse(searchTicket.body).key;
console.log(`✅ Created ${SEARCH_KEY} (søgning-fallback)`);

await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-695' },
  outwardIssue: { key: SEARCH_KEY },
});

// ─── 3. Ticket #2: Areal + købspris enrichment ──────────────────────────
const enrichTicket = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'Ejerlejligheds-liste: berig med areal + købspris + købsdato + lejligheds-BFE',
    labels: ['ejerlejlighed', 'data-enrichment', 'bbr', 'ejf', 'hovedejendom'],
    description: doc(
      h(2, 'Problem'),
      p(txt('Lejlighedslisten på hovedejendom (implementeret i BIZZ-695 Fase 1) viser ejer korrekt, men '), strong('mangler areal, købspris, købsdato og individuel BFE'), txt(' for hver lejlighed. Kolonnerne Areal / Købspris / Købsdato vises som "–" på alle rækker i UI (verificeret på Arnold Nielsens Boulevard 62A).')),

      h(2, 'Nuværende output fra /api/ejerlejligheder'),
      cb(
`{
  "bfe": 0,                    ❌ should be real lejligheds-BFE
  "adresse": "Arnold Nielsens Boulevard 62A, st., 2650 Hvidovre",  ✅
  "etage": "st",               ✅
  "doer": null,
  "ejer": "Arnbo 62 ApS",       ✅
  "ejertype": "selskab",        ✅
  "areal": null,                ❌ mangler
  "koebspris": null,            ❌ mangler
  "koebsdato": null,            ❌ mangler
  "dawaId": "5f618945-..."      ✅
}`,
        'json'
      ),

      h(2, 'Data-kilder'),
      ul(
        li(p(strong('Lejligheds-BFE: '), txt('fra '), code('BBR_Enhed'), txt(' via '), code('adresseIdentificerer = dawaId'), txt('. Query returnerer '), code('BBR_Enhed.ejendomsrelation.bfeNummer'), txt(' + areal-felter.'))),
        li(p(strong('Areal: '), txt('fra '), code('BBR_Enhed.samletAreal'), txt(' eller '), code('BBR_Enhed.boligareal'), txt(' (afhænger af ejendomstype).'))),
        li(p(strong('Købspris + købsdato: '), txt('fra '), code('ejf_ejerskab'), txt(' lokalt — tabellen har '), code('virkning_fra'), txt(' (købsdato) men ikke pris. Pris skal hentes via '), code('/api/salgshistorik'), txt(' (efter BIZZ-685/693 fix landes) eller fra Tinglysning adkomst-dokument.'))),
      ),

      h(2, 'Foreslået fix'),
      ol(
        li(p(strong('Step 1: '), txt('For hver lejlighed i API-responsen, kald '), code('/api/bbr'), txt(' eller query '), code('bbr_enhed'), txt(' direkte med '), code('adresseIdentificerer=dawaId'), txt(' → udtræk '), code('bfeNummer + samletAreal'), txt('.'))),
        li(p(strong('Step 2: '), txt('Slå '), code('ejf_ejerskab'), txt(' op på den fundne BFE → udtræk '), code('virkning_fra'), txt(' (= købsdato), ejer bekræftet.'))),
        li(p(strong('Step 3: '), txt('Købspris: '), strong('afhænger af BIZZ-685/693'), txt('. Når salgshistorik-fix er shipped kan vi kalde '), code('/api/salgshistorik?bfeNummer=<lejlighed-BFE>'), txt(' og bruge den seneste handler-række\'s købesum. Indtil da: lad prisen stå null (unchanged).'))),
        li(p(strong('Step 4: '), txt('Cache: lejligheds-berigning per adresse i 1h LRU (samme mønster som '), code('salgshistorikCache'), txt(').'))),
      ),

      h(2, 'Acceptance'),
      ul(
        li(p(strong('Lejligheds-BFE udfyldt: '), code('bfe > 0'), txt(' på alle 4 rækker for BFE 226630 hovedejendom.'))),
        li(p(strong('Areal udfyldt: '), txt('verificer mod kendt værdi — Arnold Nielsens Boulevard 62A 1. har areal X m² jf. BBR (slå op inden test).'))),
        li(p(strong('Købsdato udfyldt: '), txt('mindst '), code('virkning_fra'), txt(' fra ejf_ejerskab (fallback hvis købsdato ikke er tilgængelig).'))),
        li(p(strong('Købspris: '), txt('udfyldt når BIZZ-685/693 er landed. Indtil da: tomt felt er OK.'))),
        li(p(strong('UI: '), txt('"–" erstattes med konkrete tal i tabellen. Hvis en enkelt værdi stadig er null, vis "–" for netop den celle (ikke hele rækken).'))),
        li(p(strong('Performance: '), txt('endpoint svarer p95 < 3s (parallelliser BBR-opslag pr. lejlighed).'))),
      ),

      h(2, 'Berørte filer'),
      ul(
        li(p(code('app/api/ejerlejligheder/route.ts'), txt(' — tilføj BBR + ejf_ejerskab enrichment-step.'))),
        li(p(code('app/dashboard/ejendomme/[id]/tabs/EjendomEjerforholdTab.tsx'), txt(' — allerede forberedt til at rendre felterne.'))),
      ),

      h(2, 'Afhængigheder'),
      ul(
        li(p(strong('Blokeret af: '), txt('ingen for Step 1-2 (BFE + areal + dato er lokale opslag).'))),
        li(p(strong('Blokeret af: '), code('BIZZ-685'), txt(' + '), code('BIZZ-693'), txt(' for Step 3 (købspris via salgshistorik-enrichment).'))),
      ),
      p(strong('Forslag: '), txt('ship Step 1-2 først (bfe+areal+dato) uden at vente på pris-fix. Pris tilføjes når salgshistorik-refactor er klar.')),

      h(2, 'Relateret'),
      p(code('BIZZ-695'), txt(' (Done) — datamodel-analyse og core-listening.')),
      p(code('BIZZ-685 / BIZZ-693'), txt(' — købspris via lokal ejf_ejerskab + Tinglysning-enrichment (samme datastruktur vi bruger her).')),
      p(code('BIZZ-694'), txt(' (Done) — dokumenterede BFE=0-limitationen som denne ticket løser.'))
    ),
  },
});
if (enrichTicket.status !== 201) {
  console.error('Enrich ticket failed:', enrichTicket.status, enrichTicket.body.slice(0, 300));
  process.exit(1);
}
const ENRICH_KEY = JSON.parse(enrichTicket.body).key;
console.log(`✅ Created ${ENRICH_KEY} (areal+pris enrichment)`);

await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-695' },
  outwardIssue: { key: ENRICH_KEY },
});
await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-694' },
  outwardIssue: { key: ENRICH_KEY },
});
// Blocks: 685 blocker dette for price-delen
await req('POST', '/rest/api/3/issueLink', {
  type: { name: 'Relates' },
  inwardIssue: { key: 'BIZZ-685' },
  outwardIssue: { key: ENRICH_KEY },
});

console.log(`\nDone.\n  BIZZ-695 → Done\n  ${SEARCH_KEY} (søgning-fallback)\n  ${ENRICH_KEY} (areal+pris enrichment)`);
