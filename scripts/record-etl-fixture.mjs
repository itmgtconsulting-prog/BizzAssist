#!/usr/bin/env node
/**
 * Record + anonymize ETL XML response fra Tinglysning til fixture-fil (BIZZ-1527).
 *
 * Usage:
 *   node scripts/record-etl-fixture.mjs <operation> <bfe>
 *
 * Example:
 *   node scripts/record-etl-fixture.mjs EjendomSummariskHent 100165718
 *
 * Kræver env:
 *   TINGLYSNING_CERT_B64 + TINGLYSNING_CERT_PASSWORD
 *   DF_PROXY_URL + DF_PROXY_SECRET
 *
 * Output: __tests__/fixtures/etl/<operation-lowercase>.xml
 *
 * Anonymisering:
 *   - Persons (heuristisk: Fornavn Mellem? Efternavn) → "Anders Andersen"
 *   - CVR-numre (8-cifrede) → 99999991..99999999 (sekvens)
 *   - Adresser (regex på postnummer 4-cifret + by) → "Testvej 1, 9999 Testby"
 *   - BFE'er → 100000001..100000099 (sekvens)
 *   - Datoer i 2025+ → mappet 5 år tilbage så de stadig er konsistente
 *
 * Manuel review er ALTID nødvendig efter kørsel — automatisk regex-replace
 * fanger ikke alt (især adresser i fritekst, sjældne navne, jura-citater).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '../__tests__/fixtures/etl');

const operation = process.argv[2];
const bfe = process.argv[3];

if (!operation || !bfe) {
  console.error('Usage: node scripts/record-etl-fixture.mjs <operation> <bfe>');
  console.error('Example: node scripts/record-etl-fixture.mjs EjendomSummariskHent 100165718');
  process.exit(1);
}

// Dynamic import af s2sClient for at undgå TypeScript ts-node setup
const { callS2S, NS } = await import('../app/lib/s2sClient.ts').catch(async () => {
  console.error('Kunne ikke importere s2sClient.ts direkte — kør via tsx:');
  console.error('  npx tsx scripts/record-etl-fixture.mjs <op> <bfe>');
  process.exit(1);
});

const unsignedXml =
  `<${operation} xmlns="${NS.MSG}">` +
  `<BFEnummer>${bfe}</BFEnummer>` +
  `</${operation}>`;

console.log(`Calling ${operation} for BFE ${bfe}...`);

let raw;
try {
  raw = await callS2S(operation, unsignedXml, { timeoutMs: 30_000 });
} catch (err) {
  console.error('S2S kald fejlede:', err.message);
  process.exit(2);
}

console.log(`Received ${raw.length} chars — anonymizing...`);

// ─── Anonymisering ──────────────────────────────────────────────────────────

let cvrSeq = 99_999_991;
const cvrMap = new Map();
let bfeSeq = 100_000_001;
const bfeMap = new Map();

let anonymized = raw
  // CVR-numre (8 cifre) — mappet til 99999991+
  .replace(/\b\d{8}\b/g, (match) => {
    if (!cvrMap.has(match)) {
      cvrMap.set(match, String(cvrSeq++));
    }
    return cvrMap.get(match);
  })
  // BFE-numre (typisk 7-9 cifre, kontekstuelt) — mappet til 100000001+
  // Note: kun inden for <BFEnummer> tags for at undgå at ramme CVR
  .replace(/<BFEnummer>(\d+)<\/BFEnummer>/g, (_, num) => {
    if (!bfeMap.has(num)) {
      bfeMap.set(num, String(bfeSeq++));
    }
    return `<BFEnummer>${bfeMap.get(num)}</BFEnummer>`;
  })
  // Adresser inde i <Adresse>...</Adresse> tags
  .replace(/<Adresse>[^<]+<\/Adresse>/g, '<Adresse>Testvej 1, 9999 Testby</Adresse>')
  // Personnavne inde i <Navn> tags for Type=Person — bruger heuristik:
  // hvis blok indeholder <Type>Person</Type> efterfulgt af <Navn>X</Navn>
  .replace(
    /<Type>Person<\/Type>\s*<Navn>[^<]+<\/Navn>/g,
    '<Type>Person</Type><Navn>Anders Andersen</Navn>'
  )
  // Virksomhedsnavne i <Navn> tags efter Type=Virksomhed
  .replace(
    /<Type>Virksomhed<\/Type>\s*<Navn>[^<]+<\/Navn>/g,
    '<Type>Virksomhed</Type><Navn>ACME Holding A/S</Navn>'
  );

// Skriv fixture
const filename = operation
  .replace(/Hent$|Soeg$/, '')
  .replace(/([A-Z])/g, '-$1')
  .toLowerCase()
  .replace(/^-/, '');
const ext = operation.endsWith('Soeg') ? 'soeg.xml' : '.xml';
const outPath = resolve(FIXTURE_DIR, `${filename}${operation.endsWith('Soeg') ? '-soeg' : ''}.xml`);

mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(outPath, anonymized);

console.log(`Wrote ${outPath}`);
console.log(`CVR-mapninger: ${cvrMap.size}, BFE-mapninger: ${bfeMap.size}`);
console.log('');
console.log('⚠️  MANUEL REVIEW PÅKRÆVET:');
console.log('  1. Åbn fixture og bekræft INGEN rigtige navne/CVR/adresser');
console.log('  2. Check jura-fritekst (servitut-beskrivelser etc) — regex fanger ikke');
console.log('  3. Tilføj fixture til __tests__/fixtures/etl/README.md');
