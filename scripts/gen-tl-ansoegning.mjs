/**
 * Genererer Word-dokument for ansøgning om adgang til e-TL produktionsmiljø.
 * Output: docs/tinglysning/download/Ansoegning-eTL-produktionsmiljoe-Pecunia-IT.docx
 *
 * Kør med: node scripts/gen-tl-ansoegning.mjs
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType,
  VerticalAlign,
} from 'docx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const BLUE = '1d4ed8';
const DARK = '1e293b';
const GRAY = '64748b';
const BORDER_COLOR = 'e2e8f0';
const HEADER_BG = '1e3a5f';

// ─── Hjælpefunktioner ────────────────────────────────────────────────────────

function h1(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 28, color: DARK, font: 'Calibri' })],
    spacing: { before: 480, after: 160 },
    border: { bottom: { color: BORDER_COLOR, style: BorderStyle.SINGLE, size: 6, space: 1 } },
  });
}

function h2(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 24, color: BLUE, font: 'Calibri' })],
    spacing: { before: 320, after: 120 },
  });
}

function h3(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 20, color: DARK, font: 'Calibri' })],
    spacing: { before: 200, after: 80 },
  });
}

function p(text, opts = {}) {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        size: opts.size ?? 20,
        color: opts.color ?? DARK,
        bold: opts.bold ?? false,
        italics: opts.italics ?? false,
        font: 'Calibri',
      }),
    ],
    spacing: { before: 80, after: 80 },
    alignment: opts.align ?? AlignmentType.LEFT,
  });
}

function b(text, level = 0) {
  return new Paragraph({
    children: [new TextRun({ text, size: 20, color: DARK, font: 'Calibri' })],
    bullet: { level },
    spacing: { before: 60, after: 60 },
  });
}

function spacer() {
  return new Paragraph({ children: [], spacing: { before: 80, after: 80 } });
}

function divider() {
  return new Paragraph({
    children: [],
    border: { bottom: { color: BORDER_COLOR, style: BorderStyle.SINGLE, size: 6, space: 1 } },
    spacing: { before: 240, after: 240 },
  });
}

function metaLine(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: label + ': ', bold: true, size: 20, color: GRAY, font: 'Calibri' }),
      new TextRun({ text: value, size: 20, color: DARK, font: 'Calibri' }),
    ],
    spacing: { before: 60, after: 60 },
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            size: opts.headerRow ? 18 : 18,
            bold: opts.headerRow ?? false,
            color: opts.headerRow ? 'ffffff' : DARK,
            font: 'Calibri',
          }),
        ],
        alignment: AlignmentType.LEFT,
      }),
    ],
    shading: { type: ShadingType.SOLID, color: opts.bg ?? 'ffffff' },
    width: { size: opts.width ?? 33, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 100, bottom: 100, left: 160, right: 160 },
  });
}

function table(headers, rows, widths) {
  const headerRow = new TableRow({
    children: headers.map((h, i) => cell(h, { headerRow: true, bg: HEADER_BG, width: widths[i] })),
    tableHeader: true,
  });
  const dataRows = rows.map(
    (row, ri) =>
      new TableRow({
        children: row.map((v, ci) =>
          cell(v, { bg: ri % 2 === 0 ? 'ffffff' : 'f8fafc', width: widths[ci] })
        ),
      })
  );
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

function checkTable(rows) {
  const headerRow = new TableRow({
    children: [
      cell('Scenarie', { headerRow: true, bg: HEADER_BG, width: 75 }),
      cell('Resultat', { headerRow: true, bg: HEADER_BG, width: 25 }),
    ],
    tableHeader: true,
  });
  const dataRows = rows.map(
    ([scenario, result], ri) =>
      new TableRow({
        children: [
          cell(scenario, { bg: ri % 2 === 0 ? 'ffffff' : 'f8fafc', width: 75 }),
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: result,
                    size: 18,
                    bold: true,
                    color: '16a34a',
                    font: 'Calibri',
                  }),
                ],
              }),
            ],
            shading: { type: ShadingType.SOLID, color: 'f0fdf4' },
            width: { size: 25, type: WidthType.PERCENTAGE },
            margins: { top: 100, bottom: 100, left: 160, right: 160 },
          }),
        ],
      })
  );
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

// ─── Dokumentindhold ─────────────────────────────────────────────────────────

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 20, color: DARK } },
    },
  },
  sections: [
    {
      properties: {
        page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } },
      },
      children: [
        // TITEL
        new Paragraph({
          children: [
            new TextRun({
              text: 'Ansøgning om adgang til e-TL produktionsmiljø',
              bold: true,
              size: 40,
              color: DARK,
              font: 'Calibri',
            }),
          ],
          spacing: { before: 0, after: 80 },
          border: { bottom: { color: BLUE, style: BorderStyle.SINGLE, size: 18, space: 1 } },
        }),

        spacer(),
        metaLine('Til', 'Tinglysningsretten – Driftsafdeling'),
        metaLine('E-mail', 'e-tl-011@domstol.dk'),
        metaLine('Fra', 'Pecunia IT Consulting ApS'),
        metaLine('CVR', '44718502'),
        metaLine('Dato', '7. april 2026'),
        divider(),

        // 1. FORMÅL
        h1('1. Formål med systemadgangen'),
        p(
          'BizzAssist er en dansk business intelligence-platform, der aggregerer og præsenterer offentligt tilgængeligt data om faste ejendomme, virksomheder og personer for professionelle brugere — herunder ejendomsmæglere, advokater, revisorer, banker og erhvervsinvestorer.'
        ),
        spacer(),
        p(
          'Formålet med adgang til e-TL er at give BizzAssist-brugere direkte indsigt i tingbogens offentlige oplysninger som en integreret del af ejendoms- og virksomhedsanalyserne:'
        ),
        b(
          'Ejendomsvisning: Vis tinglyste oplysninger (ejere, adkomsthavere, hæftelser, servitutter, pantebreve) direkte i ejendomsdetaljesiden for en fast ejendom identificeret ved BFE-nummer.'
        ),
        b(
          'Virksomhedsvisning: Vis registrerede hæftelser i Personbogen (virksomhedspant, løsørepant, fordringspant, ejendomsforbehold) for virksomheder identificeret ved CVR-nummer.'
        ),
        b(
          'Dokumentadgang: Hent og præsenter tinglysningsdokumenter (pantebreve, skøder, servitutter) som PDF til brugere med behov for at se det fulde dokument.'
        ),
        spacer(),
        p(
          'Systemet anvender udelukkende forespørgsels-services — der anmeldes ikke dokumenter via systemadgangen.'
        ),
        divider(),

        // 2. SERVICES
        h1('2. Implementerede services'),
        p(
          'BizzAssist anvender HTTP API (forespørgsel) med 2-vejs SSL (OCES systemcertifikat). Følgende services er implementeret:'
        ),

        h2('2.1 Fast ejendom'),
        spacer(),
        table(
          ['Service', 'Endpoint', 'Beskrivelse'],
          [
            [
              'Søgning',
              'GET /tinglysning/ssl/ejendom/hovednoteringsnummer?hovednoteringsnummer={BFE}',
              'Søger ejendom med BFE-nummer, returnerer UUID og summariske oplysninger',
            ],
            [
              'Opslag (summarisk)',
              'GET /tinglysning/ssl/ejdsummarisk/{uuid}',
              'Henter fuld summarisk ejendomsdata inkl. ejere, hæftelser og servitutter (XML)',
            ],
            [
              'Dokumentopslag',
              'GET /tinglysning/ssl/dokaktuel/uuid/{dokumentId}',
              'Henter enkelt dokument som XML (til PDF-konvertering)',
            ],
          ],
          [18, 45, 37]
        ),

        h2('2.2 Personbog (virksomheder)'),
        spacer(),
        table(
          ['Service', 'Endpoint', 'Beskrivelse'],
          [
            [
              'Søgning',
              'GET /tinglysning/unsecuressl/soegpersonbogcvr?cvr={CVR}',
              'Søger i Personbogen med CVR-nummer',
            ],
            [
              'Opslag',
              'GET /tinglysning/unsecuressl/personbog/{uuid}',
              'Henter hæftelser registreret i Personbogen (XML)',
            ],
          ],
          [18, 45, 37]
        ),

        h2('2.3 Snitflade'),
        b('Snitflade: HTTP API (forespørgsel)'),
        b('Autentifikation: 2-vejs SSL med OCES systemcertifikat (NemID/MitID FOCES)'),
        b(
          'Certifikatformat: PFX (PKCS#12), konfigureret som base64-encodet miljøvariabel på Vercel-hosting'
        ),
        b('Anmeldelser: Ikke implementeret — systemet foretager udelukkende forespørgsler'),
        divider(),

        // 3. TEST
        h1('3. Gennemført testforløb'),
        p(
          'Testforløbet er gennemført mod fællestestmiljøet (https://test.tinglysning.dk) med et NETS test-certifikat (devtest4-miljø).'
        ),

        h2('3.1 Funktionelle tests'),
        spacer(),
        checkTable([
          ['Søgning på BFE-nummer returnerer UUID og adresse', '\u2705 Testet og fungerer'],
          [
            'Opslag med UUID returnerer EjendomSummariskHentResultat XML',
            '\u2705 Testet og fungerer',
          ],
          [
            'XML-parser udtrækker ejere, adkomsttype, ejerandel, overtagelsesdato og købesum',
            '\u2705 Valideret mod kendte testdata',
          ],
          [
            'XML-parser udtrækker hæftelser med type, beløb, kreditor og prioritet',
            '\u2705 Valideret mod kendte testdata',
          ],
          ['XML-parser udtrækker servitutter med type og tekst', '\u2705 Testet'],
          ['Personbogssøgning med CVR-nummer returnerer UUID-liste', '\u2705 Testet'],
          ['Personbogsopslag returnerer LoesoereSummariskHentResultat XML', '\u2705 Testet'],
          [
            'Parser udtrækker virksomhedspant, løsørepant og fordringspant korrekt',
            '\u2705 Valideret',
          ],
          ['Dokumentopslag med UUID returnerer DokumentAktuelHentResultat XML', '\u2705 Testet'],
          ['XML-til-PDF konvertering genererer læsbar PDF med korrekte felter', '\u2705 Testet'],
        ]),

        h2('3.2 Fejlhåndtering'),
        p('BizzAssist håndterer følgende fejlsituationer eksplicit:'),

        h3('HTTP-fejl fra e-TL:'),
        b(
          '404 Not Found: Returnerer { error: "Ejendom ikke fundet i tingbogen" } med HTTP 404. UI viser informativ besked.'
        ),
        b(
          '500 / 502: Logges server-side, returneres som { error: "Ekstern API fejl" } uden interne detaljer.'
        ),
        b('Andre 4xx/5xx: Propageres med status-kode og logges.'),

        h3('Netværk og timeout:'),
        b(
          'Alle kald har AbortSignal.timeout(15000) (15 sekunder). Ved timeout destrueres socket og returneres fejlbesked.'
        ),
        b('Netværksfejl fanges og returneres som HTTP 500 med generisk fejlbesked.'),

        h3('Certifikat-fejl:'),
        b(
          'Hvis certifikats-miljøvariablerne ikke er sat, returneres HTTP 503 — systemet deaktiverer sig selv pænt.'
        ),
        b(
          'Certifikatet loades fra base64-encodet miljøvariabel (Vercel-kompatibelt) eller filsti som fallback.'
        ),

        h3('Ugyldigt input:'),
        b('BFE-numre valideres med regex (/^\\d+$/) — ikke-numerisk input afvises med HTTP 400.'),
        b('CVR-numre valideres til præcis 8 cifre — andet afvises med HTTP 400.'),
        b('Dokument-UUIDs valideres med UUID-format-regex inden opslag.'),

        h3('Caching:'),
        b(
          'Svar caches i 1 time (Cache-Control: public, s-maxage=3600) for at reducere belastningen på e-TL.'
        ),
        divider(),

        // 4. ARKITEKTUR
        h1('4. Teknisk arkitektur'),
        b('Hosting: Vercel (serverless, Node.js runtime)'),
        b('Framework: Next.js 16 App Router'),
        b(
          'Certifikat-opbevaring: Base64-encodet PFX i krypteret Vercel-miljøvariabel (NEMLOGIN_CERT_B64)'
        ),
        spacer(),
        p(
          'Alle kald til e-TL afsendes fra en dedikeret proxy med statisk IP-adresse. Nedenstående IP-adresse bedes tilføjes til e-TLs IP-whitelist:'
        ),
        spacer(),
        table(
          ['Miljo', 'IP-adresse', 'Formal'],
          [
            [
              'Test/Produktion',
              '204.168.164.252',
              'Hetzner VPS proxy (statisk egress for Vercel-hosting)',
            ],
          ],
          [25, 25, 50]
        ),
        spacer(),
        p(
          'Bemærk: IP-adressen 93.161.46.78 (lokal udviklingsmaskine) er allerede whitelistet til testmiljøet og benyttes under udviklingstest.',
          { color: GRAY, italics: true }
        ),
        spacer(),
        b(
          'Systemcertifikat (produktion): OCES3 FOCES systemcertifikat udstedt til Pecunia IT Consulting ApS, CVR 44718502, via MitID Erhverv / Nets.'
        ),
        divider(),

        // 5. STORKUNDE
        h1('5. Forudsætninger (storkunde-registrering)'),
        p(
          'Vi er bekendt med, at adgang til produktionsmiljøet kræver registrering som storkunde hos SKAT i henhold til § 20, stk. 3 i bekendtgørelse nr. 1634 af 29. juni 2021 om tekniske krav og forskrifter for tinglysningssystemet.'
        ),
        p(
          'Status: Pecunia IT Consulting ApS er registreret til betaling af tinglysningsafgift, hvilket udgør grundlaget for storkunde-status. Der er ikke udstedt et separat certifikat i forbindelse med registreringen.',
          { bold: true }
        ),
        p(
          'Registreringen som storkunde bekræftes ved dokumentation for registrering til betaling af tinglysningsafgift, som vedlægges som bilag.'
        ),
        divider(),

        // 6. KONTAKT
        h1('6. Kontaktperson (teknisk)'),
        spacer(),
        table(
          ['Felt', 'Oplysning'],
          [
            ['Navn', 'Jakob Juul Rasmussen'],
            ['E-mail', 'support@pecuniait.com'],
            ['Telefon', '+45 2434 2655'],
            ['Virksomhed', 'Pecunia IT Consulting ApS'],
            ['CVR', '44718502'],
            ['Adresse', 'Sobyvej 11, 2650 Hvidovre'],
          ],
          [30, 70]
        ),
        divider(),

        // BILAG
        h1('Bilag'),
        b(
          '1. Dokumentation for implementerede services (kode-eksempler på request/response-håndtering)'
        ),
        b(
          '2. Dokumentation for registrering til betaling af tinglysningsafgift (bekræftelse af storkunde-status hos SKAT)'
        ),
        spacer(),
        spacer(),
        p(
          'Pecunia IT Consulting ApS forbeholder sig retten til at videregive tingbogsdata til egne abonnenter alene inden for rammerne af offentlighedsprincippet og persondataforordningen (GDPR). Der videregives ikke data til tredjeparter uden for platformens brugerbase.',
          { color: GRAY, italics: true, size: 16 }
        ),
      ],
    },
  ],
});

const outDir = path.join(ROOT, 'docs', 'tinglysning', 'download');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'Ansoegning-eTL-produktionsmiljoe-Pecunia-IT.docx');

const buf = await Packer.toBuffer(doc);
fs.writeFileSync(outPath, buf);
console.log('Word-fil genereret:', outPath, '(' + Math.round(buf.length / 1024) + ' KB)');
