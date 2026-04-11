/**
 * POST /api/dokumenter/zip
 *
 * Henter en liste af dokumenter (PDF-filer) og returnerer dem som én ZIP-fil.
 * Bruges af Dokumenter-tabben til "Download valgte som ZIP".
 *
 * Forventet request body:
 *   { docs: Array<{ filename: string; url: string }>, arkivNavn?: string }
 *
 * - Interne URLs (starter med '/') løses relativt til NEXT_PUBLIC_APP_URL
 * - Externe URLs hentes direkte
 * - Hvert dokument valideres med PDF magic bytes (%PDF) — ikke-PDF svar springes over
 * - Sprungne dokumenter rapporteres i X-Springede-Over response-header
 * - Max 20 dokumenter per kald
 *
 * @param request - Next.js POST request med JSON body
 * @returns ZIP-fil som attachment
 */

import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';

export const runtime = 'nodejs';

/** Et enkelt dokument der skal inkluderes i ZIP-filen */
interface ZipDocInput {
  /** Filnavn i ZIP-arkivet inkl. .pdf extension */
  filename: string;
  /** Absolut eller relativ URL til PDF-filen */
  url: string;
}

/** Request body */
interface ZipRequestBody {
  docs: ZipDocInput[];
  /** Valgfrit filnavn til ZIP-arkivet (uden .zip) */
  arkivNavn?: string;
}

/** Resultat fra hentDokument */
interface DokumentResultat {
  /** Buffer med PDF-indhold, eller null hvis hentning/validering fejlede */
  buf: Buffer | null;
  /** Årsag til fejl, brugt til X-Springede-Over header */
  fejlÅrsag?: string;
}

/** Max antal dokumenter per kald */
const MAX_DOCS = 20;

/** Standard timeout per dokument-fetch (ms) */
const DOC_TIMEOUT_MS = 20000;

/**
 * Forlænget timeout for tunge interne ruter:
 * - /api/jord/pdf    — proxy til Miljøportalen (op til ~30s)
 * - /api/matrikelkort — genererer PDF med Overpass-data (op til ~60s ved langsom Overpass)
 */
const DOC_TIMEOUT_TUNG_MS = 90000;

/** PDF magic bytes: de første 4 bytes skal være %PDF (0x25 0x50 0x44 0x46) */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

/**
 * Tilladte eksterne hostnames som ZIP-ruten må hente dokumenter fra.
 *
 * Alle andre eksterne hosts afvises for at forhindre SSRF-angreb.
 * Interne ruter (/api/...) løses til NEXT_PUBLIC_APP_URL og er gyldige
 * når den resolvede host matcher et af disse eller er "localhost" i
 * udviklingsmiljøet.
 */
const TILLADTE_HOSTS = new Set([
  'bizzassist.dk',
  'www.bizzassist.dk',
  'bizzassist-test.bizzassist.dk',
  'test.bizzassist.dk',
  'api-fs.vurderingsportalen.dk',
  'tinglysning.dk',
  'www.tinglysning.dk',
  'api.dataforsyningen.dk',
  'services.datafordeler.dk',
  'wfs.datafordeler.dk',
  'wms.datafordeler.dk',
  'miljoeportal.dk',
  'arealinfo.miljoeportal.dk',
  'plandata.dk',
  'www.plandata.dk',
]);

/**
 * IPv4-subnets der anses som private/link-local/loopback og aldrig må
 * nås fra en server-side fetch (SSRF-beskyttelse).
 *
 * Format: [network_as_32bit_int, prefix_length]
 */
const PRIVATE_IPV4_RANGES: [number, number][] = [
  [0x7f000000, 8], // 127.0.0.0/8   loopback
  [0x0a000000, 8], // 10.0.0.0/8    RFC-1918
  [0xac100000, 12], // 172.16.0.0/12 RFC-1918
  [0xc0a80000, 16], // 192.168.0.0/16 RFC-1918
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (IMDS)
  [0x00000000, 8], // 0.0.0.0/8     "this" network
  [0xe0000000, 4], // 224.0.0.0/4   multicast
  [0xf0000000, 4], // 240.0.0.0/4   reserved
];

/**
 * Konverterer en IPv4-adresse i punkt-notation til et 32-bit heltal.
 *
 * @param ip - IPv4-adresse, f.eks. "192.168.1.1"
 * @returns 32-bit unsigned integer eller null hvis formatet er ugyldigt
 */
function ipv4TilInt(ip: string): number | null {
  const dele = ip.split('.');
  if (dele.length !== 4) return null;
  let resultat = 0;
  for (const del of dele) {
    const oktet = parseInt(del, 10);
    if (isNaN(oktet) || oktet < 0 || oktet > 255 || del.trim() !== String(oktet)) return null;
    resultat = (resultat << 8) | oktet;
  }
  // >>> 0 konverterer til unsigned 32-bit
  return resultat >>> 0;
}

/**
 * Returnerer true hvis `ip` falder inden for et privat/link-local/loopback-subnet.
 *
 * @param ip - IPv4-adresse som streng
 */
function erPrivatIpv4(ip: string): boolean {
  const val = ipv4TilInt(ip);
  if (val === null) return false;
  return PRIVATE_IPV4_RANGES.some(([net, prefix]) => {
    const maske = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (val & maske) === (net & maske);
  });
}

/**
 * Validerer en absolut URL mod SSRF-angrebsmønstre.
 *
 * Regler (alle skal overholdes):
 * 1. URL skal bruge HTTPS-skema (HTTP er kun tilladt for localhost i development).
 * 2. Hosten må ikke være en privat IPv4-adresse (RFC-1918, IMDS, loopback).
 * 3. IPv6-loopback (::1) er ikke tilladt.
 * 4. "localhost" og "0.0.0.0" er kun tilladt i development (NODE_ENV=development).
 * 5. Hosten skal enten matche TILLADTE_HOSTS ELLER, i development, være "localhost".
 * 6. Hosten skal indeholde mindst ét punktum (FQDN) med mindre det er localhost i dev.
 *
 * @param absoluttUrl - Den fulde absolutte URL der skal valideres
 * @returns `{ ok: true }` hvis URL er tilladt, eller `{ ok: false; fejl: string }` med beskrivelse
 */
export function validerUrl(absoluttUrl: string): { ok: true } | { ok: false; fejl: string } {
  let parsed: URL;
  try {
    parsed = new URL(absoluttUrl);
  } catch {
    return { ok: false, fejl: 'Ugyldig URL-syntaks' };
  }

  const host = parsed.hostname.toLowerCase();
  const erDev = process.env.NODE_ENV === 'development';

  // 1. Kun HTTPS (undtagen localhost i dev)
  if (parsed.protocol !== 'https:') {
    if (!(erDev && parsed.protocol === 'http:' && host === 'localhost')) {
      return { ok: false, fejl: `Kun HTTPS er tilladt (fik: ${parsed.protocol})` };
    }
  }

  // 2. Afvis IPv6-loopback
  if (host === '[::1]' || host === '::1') {
    return { ok: false, fejl: 'IPv6-loopback (::1) er ikke tilladt' };
  }

  // 3. Afvis private IPv4-ranges
  if (erPrivatIpv4(host)) {
    return { ok: false, fejl: `Privat/intern IP-adresse er ikke tilladt: ${host}` };
  }

  // 4. Afvis 0.0.0.0 og localhost i produktion
  if (host === '0.0.0.0') {
    return { ok: false, fejl: '0.0.0.0 er ikke tilladt' };
  }
  if (host === 'localhost' && !erDev) {
    return { ok: false, fejl: 'localhost er ikke tilladt i produktion' };
  }

  // 5. Kræv at hosten er i TILLADTE_HOSTS (eller localhost i dev)
  if (host === 'localhost' && erDev) {
    return { ok: true };
  }

  if (!TILLADTE_HOSTS.has(host)) {
    return {
      ok: false,
      fejl: `Ekstern host er ikke på tilladelseslisten: ${host}`,
    };
  }

  // 6. FQDN-krav: hosten skal indeholde mindst ét punktum
  if (!host.includes('.')) {
    return { ok: false, fejl: `Hosten er ikke et FQDN (mangler punktum): ${host}` };
  }

  return { ok: true };
}

/**
 * Løser en URL til en absolut URL.
 * Relative URL (starter med '/') præfikses med app-baseurl.
 *
 * @param url - Relativ eller absolut URL
 * @returns Absolut URL
 */
function løsUrl(url: string): string {
  if (url.startsWith('/')) {
    const base =
      process.env.NEXT_PUBLIC_APP_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    return `${base}${url}`;
  }
  return url;
}

/**
 * Validerer om en buffer starter med PDF magic bytes (%PDF).
 *
 * @param buf - ArrayBuffer at tjekke
 * @returns true hvis bufferen er en gyldig PDF
 */
function erGyldigPdf(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const bytes = new Uint8Array(buf, 0, 4);
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Henter ét dokument, validerer at det er en PDF, og returnerer det som Buffer.
 * Returnerer { buf: null } hvis hentning fejler, svaret er tomt, eller indholdet
 * ikke er en gyldig PDF (kontrolleret via magic bytes).
 *
 * @param doc - Dokument med filename og url
 * @returns DokumentResultat med buffer eller null + fejlbeskrivelse
 */
async function hentDokument(doc: ZipDocInput): Promise<DokumentResultat> {
  const absolutUrl = løsUrl(doc.url);

  // SSRF-beskyttelse: valider host og skema inden fetch
  const urlValidering = validerUrl(absolutUrl);
  if (!urlValidering.ok) {
    logger.warn(
      `[zip] SSRF-forsøg afvist for ${doc.filename}: ${urlValidering.fejl} (${absolutUrl})`
    );
    return { buf: null, fejlÅrsag: `URL ikke tilladt: ${urlValidering.fejl}` };
  }

  // Tunge interne ruter der fetcher eksternt eller genererer PDF server-side
  const erTungRute = doc.url.startsWith('/api/jord/pdf') || doc.url.startsWith('/api/matrikelkort');
  const timeoutMs = erTungRute ? DOC_TIMEOUT_TUNG_MS : DOC_TIMEOUT_MS;

  try {
    const res = await fetch(absolutUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/pdf,application/octet-stream,*/*' },
    });

    if (!res.ok) {
      const årsag = `HTTP ${res.status}`;
      logger.warn(`[zip] ${årsag} for ${doc.filename}: ${absolutUrl}`);
      return { buf: null, fejlÅrsag: årsag };
    }

    const arrayBuf = await res.arrayBuffer();

    if (arrayBuf.byteLength === 0) {
      logger.warn(`[zip] Tom respons for ${doc.filename}`);
      return { buf: null, fejlÅrsag: 'tomt svar' };
    }

    // Valider PDF magic bytes — afviser HTML-sider, fejlsider mm.
    if (!erGyldigPdf(arrayBuf)) {
      logger.warn(
        `[zip] Ikke en gyldig PDF (forkerte magic bytes) for ${doc.filename} — ` +
          `første bytes: ${Array.from(new Uint8Array(arrayBuf, 0, Math.min(8, arrayBuf.byteLength)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ')}`
      );
      return { buf: null, fejlÅrsag: 'ikke en gyldig PDF' };
    }

    return { buf: Buffer.from(arrayBuf) };
  } catch (err) {
    const årsag = err instanceof Error ? err.message : String(err);
    logger.warn(`[zip] Kunne ikke hente ${doc.filename}:`, årsag);
    return { buf: null, fejlÅrsag: årsag };
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: ZipRequestBody;
  try {
    body = (await request.json()) as ZipRequestBody;
  } catch {
    return NextResponse.json({ fejl: 'Ugyldigt JSON i request body' }, { status: 400 });
  }

  if (!Array.isArray(body.docs) || body.docs.length === 0) {
    return NextResponse.json({ fejl: 'Ingen dokumenter angivet' }, { status: 400 });
  }

  if (body.docs.length > MAX_DOCS) {
    return NextResponse.json({ fejl: `Maks ${MAX_DOCS} dokumenter per kald` }, { status: 400 });
  }

  // Valider at alle entries har filename og url
  for (const doc of body.docs) {
    if (!doc.filename || !doc.url) {
      return NextResponse.json(
        { fejl: 'Hvert dokument skal have filename og url' },
        { status: 400 }
      );
    }
  }

  // SSRF-præ-validering: afvis absolutte URLs der ikke overholder tilladelseslisten.
  // Relative URLs (/api/...) valideres mod den resolvede base-URL inde i hentDokument.
  for (const doc of body.docs) {
    if (!doc.url.startsWith('/')) {
      const validering = validerUrl(doc.url);
      if (!validering.ok) {
        return NextResponse.json(
          { fejl: `Ugyldig URL for "${doc.filename}": ${validering.fejl}` },
          { status: 400 }
        );
      }
    }
  }

  // Hent alle dokumenter parallelt — hvert resultat inkluderer fejlårsag hvis nødvendigt
  const resultater = await Promise.all(body.docs.map(hentDokument));

  // Byg ZIP-arkiv og spor sprungne filer
  const zip = new JSZip();
  let tilføjede = 0;
  const springedeOver: string[] = [];

  for (let i = 0; i < body.docs.length; i++) {
    const { buf, fejlÅrsag } = resultater[i];
    if (buf) {
      // Sikr unikt filnavn i ZIP ved at tilføje index hvis nødvendigt
      let navn = body.docs[i].filename;
      if (zip.files[navn]) {
        const ext = navn.lastIndexOf('.');
        navn = ext >= 0 ? `${navn.slice(0, ext)}_${i + 1}${navn.slice(ext)}` : `${navn}_${i + 1}`;
      }
      zip.file(navn, buf);
      tilføjede++;
    } else {
      // Registrer springet dokument med årsag til X-Springede-Over header
      springedeOver.push(
        fejlÅrsag ? `${body.docs[i].filename} (${fejlÅrsag})` : body.docs[i].filename
      );
    }
  }

  if (tilføjede === 0) {
    return NextResponse.json(
      { fejl: 'Ingen af de valgte dokumenter kunne hentes som gyldige PDF-filer' },
      { status: 502 }
    );
  }

  // Generer ZIP — Uint8Array er kompatibel med Response BodyInit
  const zipUint8 = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const arkivNavn = (body.arkivNavn ?? 'dokumenter').replace(/[^a-zA-Z0-9æøåÆØÅ_-]/g, '_');
  const filename = `${arkivNavn}.zip`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  };

  // Inkludér liste af sprungne filer så klienten kan advare brugeren
  if (springedeOver.length > 0) {
    headers['X-Springede-Over'] = springedeOver.join(' | ');
  }

  // Cast via Buffer for TypeScript BodyInit-kompatibilitet på denne Node.js-version
  return new Response(Buffer.from(zipUint8.buffer as ArrayBuffer) as unknown as BodyInit, {
    status: 200,
    headers,
  });
}
