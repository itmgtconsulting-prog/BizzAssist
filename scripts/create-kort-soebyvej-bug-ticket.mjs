#!/usr/bin/env node
/**
 * BIZZ-bug: Kort-søgning lander ud for Afrika i stedet for korrekt dansk adresse.
 *
 * Repro: søg "Søbyvej 11, 2650 Hvidovre" på /dashboard/kort → pin dropper ved
 * ~5°E 0°N (Golfen af Guinea), zoom-niveau forbliver 2.0.
 *
 * Root cause identificeret i KortPageClient.tsx:1272-1293:
 *   DAWA darAutocomplete kan returnere { x: 0, y: 0 } for adresser uden
 *   resolved koordinater. BIZZ-370 ændrede betingelsen fra `!x || !y` til
 *   `x == null || y == null` for at undgå at legitime 0-værdier triggede
 *   fallback — men (0,0) er ALDRIG en valid dansk adresse (DK ligger ca.
 *   8-15°E, 54-58°N). Resultat: flyTo([0,0]) → midt på ækvator, lige syd
 *   for Ghana.
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
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';

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

const para = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const em = (s) => txt(s, [{ type: 'em' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const heading = (level, text) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });
const ol = (...items) => ({ type: 'orderedList', attrs: { order: 1 }, content: items });
const codeBlock = (text, lang) => ({
  type: 'codeBlock',
  attrs: lang ? { language: lang } : {},
  content: [{ type: 'text', text }],
});

const description = {
  type: 'doc',
  version: 1,
  content: [
    heading(2, 'Bug'),
    para(
      txt('Søgning på '),
      code('Søbyvej 11, 2650 Hvidovre'),
      txt(' via stort-kort-søgefeltet på '),
      code('/dashboard/kort'),
      txt(' får kortet til at flyve til '),
      strong('Golfen af Guinea (~5°E, 0°N)'),
      txt(' — ca. 6500 km fra den ønskede adresse. Zoom-niveau 2.0 (verdensbillede) bevares.')
    ),
    heading(2, 'Reproduktion'),
    ol(
      li(para(txt('Log ind på '), code('test.bizzassist.dk'), txt(', åbn '), code('/dashboard/kort'), txt('.'))),
      li(para(txt('Skriv '), code('Søbyvej 11, 2650 Hvidovre'), txt(' i søgefeltet.'))),
      li(para(txt('Vælg forslaget der kommer op, eller tryk Enter.'))),
      li(para(txt('Observer: pin dropper midt i Atlanterhavet ud for Vestafrika; zoom forbliver på 2.0 (verdensbillede).'))),
    ),
    heading(2, 'Forventet adfærd'),
    ul(
      li(para(txt('Enten: flyto til korrekt dansk adresse ved zoom 17 (hvis adressen findes i DAWA/DAR).'))),
      li(para(txt('Eller: toast-besked "Adresse ikke fundet" uden at flytte kortet — hvis adressen ikke eksisterer. Kortet skal '), strong('aldrig'), txt(' lande uden for Danmark.'))),
    ),
    heading(2, 'Root cause (identificeret via kode-analyse)'),
    para(
      txt('Fejlen sidder i '),
      code('app/dashboard/kort/KortPageClient.tsx:1272-1294'),
      txt(' i '),
      code('vælgForslag()'),
      txt('-callbacket:')
    ),
    codeBlock(
      `let lng = r.adresse.x;
let lat = r.adresse.y;
// BIZZ-370: brug != null så 0 ikke fejlagtigt trigger fallback-opslaget
if (lng == null || lat == null) {
  // fallback via /api/adresse/lookup
  ...
}
if (lng != null && lat != null) {
  mapRef.current?.flyTo({ center: [lng, lat], zoom: 17, duration: 1000 });
  setSøgtMarkør({ lng, lat });
}`,
      'typescript'
    ),
    para(
      txt('DAWA '),
      code('darAutocomplete'),
      txt('-endpointet returnerer '),
      code('{ x: 0, y: 0 }'),
      txt(' for adresser uden resolved koordinater (fx nyoprettede adresser eller adresser der er i DAR/BBR men ikke har et adgangspunkt endnu). '),
      strong('BIZZ-370'),
      txt(' flyttede betingelsen fra '),
      code('!x || !y'),
      txt(' til '),
      code('x == null || y == null'),
      txt(' for at undgå at legitime 0-værdier ved ækvator/Greenwich triggede fallback. Problemet er at '),
      strong('Danmark ligger ca. 8-15°E og 54-58°N'),
      txt(' — '),
      code('(0, 0)'),
      txt(' er '),
      em('aldrig'),
      txt(' en valid dansk adresse. Resultatet bliver '),
      code('flyTo([0, 0])'),
      txt(' → pin midt i Atlanterhavet.')
    ),
    heading(2, 'Foreslået fix'),
    ul(
      li(
        para(
          strong('Option A (minimal):'),
          txt(' Behandl '),
          code('(0, 0)'),
          txt(' som "ingen koordinater" og trigger fallback — plus en sidste sanity-check om resultatet er inden for Danmarks bounding box.')
        )
      ),
      li(
        para(
          strong('Option B (robust):'),
          txt(' Validér at '),
          code('lng'),
          txt(' er i intervallet '),
          code('[7, 16]'),
          txt(' og '),
          code('lat'),
          txt(' i '),
          code('[54, 58]'),
          txt(' før '),
          code('flyTo'),
          txt('. Hvis uden for, vis toast "Kunne ikke finde koordinater til denne adresse" og flyt ikke kortet.')
        )
      ),
    ),
    codeBlock(
      `// Option B — validering inden flyTo
const DK_BBOX = { minLng: 7, maxLng: 16, minLat: 54, maxLat: 58 };
const isInDenmark = (lng: number, lat: number) =>
  lng >= DK_BBOX.minLng && lng <= DK_BBOX.maxLng &&
  lat >= DK_BBOX.minLat && lat <= DK_BBOX.maxLat;

if (lng != null && lat != null && isInDenmark(lng, lat)) {
  mapRef.current?.flyTo({ center: [lng, lat], zoom: 17, duration: 1000 });
  setSøgtMarkør({ lng, lat });
} else {
  // Tilføj eksisterende toast-helper her
  logger.warn('[kort] ugyldige koordinater fra DAWA:', { id: r.adresse.id, lng, lat });
  showToast(da ? 'Adresse ikke fundet' : 'Address not found');
}`,
      'typescript'
    ),
    heading(2, 'Acceptance criteria'),
    ul(
      li(para(txt('Søgning på adresse der ikke kan resolves til koordinater viser toast — flytter ikke kortet.'))),
      li(para(txt('Kortet lander '), strong('aldrig'), txt(' uden for Danmarks bounding box (7-16°E, 54-58°N).'))),
      li(para(txt('Søgning på '), code('Søbyvej 11, 2650 Hvidovre'), txt(' lander korrekt hvis adressen findes, eller viser toast hvis den ikke findes (obs: verificér i DAWA om adressen overhovedet eksisterer i 2650 Hvidovre — det kan være en validerings-fejl i kraften af postnummer-mismatch).'))),
      li(para(txt('Regression-test: søgning på valide adresser (fx '), code('Rådhuspladsen 1, 1550 København V'), txt(') fungerer uændret.'))),
      li(para(txt('Sentry logger warning når (0,0) eller out-of-DK koordinater returneres fra DAWA — så vi kan tracke frekvens.'))),
    ),
    heading(2, 'Note — verificér om "Søbyvej 11, 2650 Hvidovre" eksisterer'),
    para(
      txt('Der er '),
      code('Søbyvej'),
      txt(' i flere danske postnumre (bl.a. 5250 Odense SV og 7500 Holstebro), men det er uklart om der findes en '),
      code('Søbyvej 11 i 2650 Hvidovre'),
      txt('. Hvis DAWA returnerer en match alligevel (fuzzy postnummer) med (0,0), er fixet ovenfor den rigtige afhjælpning. Hvis DAWA ikke matcher overhovedet, er dette en autocomplete-UX-ticket snarere end en kort-bug.')
    ),
    heading(2, 'Reference'),
    ul(
      li(para(code('app/dashboard/kort/KortPageClient.tsx:1272-1294'), txt(' — '), code('vælgForslag()'), txt('-callback hvor fixet skal ind'))),
      li(para(txt('Relaterer til '), strong('BIZZ-370'), txt(' (fallback-betingelse ændret — regression indført her))'))),
    ),
  ],
};

// ─── Kør ────────────────────────────────────────────────────────────────────

const meta = await req(
  'GET',
  `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`
);
const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
const bug = types.find((t) => /^bug$/i.test(t.name)) ?? types.find((t) => /^task$/i.test(t.name));

const res = await req('POST', '/rest/api/3/issue', {
  fields: {
    project: { key: PROJECT },
    summary: 'Kort-søgning: adresse uden koordinater lander pin ud for Afrika (0°N, 5°E) i stedet for toast',
    description,
    issuetype: { id: bug.id },
    priority: { name: 'High' },
    labels: ['kort', 'map', 'dawa', 'bug', 'regression-bizz-370'],
  },
});

if (res.status === 201) {
  const key = JSON.parse(res.body).key;
  console.log(`✅ ${key}  —  ${JSON.parse(res.body).fields?.summary ?? ''}`);
  console.log(`   https://${HOST}/browse/${key}`);
} else {
  console.log(`❌ FAILED (${res.status}):`, res.body.slice(0, 500));
}
