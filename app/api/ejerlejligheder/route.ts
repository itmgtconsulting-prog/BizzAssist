/**
 * GET /api/ejerlejligheder
 *
 * Henter alle ejerlejligheder (condominiums) for en given adresse.
 * Bruger Tinglysningsrettens HTTP API (mTLS) til at finde alle enheder på adressen,
 * og Datafordeler EJF GraphQL til at hente ejer- og salgsdata.
 *
 * Query params: vejnavn, husnr, postnr
 *
 * @returns EjerlejlighederResponse med array af lejligheder inkl. ejer, pris, dato
 */

import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
// EJF/Datafordeler er ikke nødvendig — alt data hentes fra tinglysning summarisk XML

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt ejerlejlighed med ejer- og salgsdata */
export interface Ejerlejlighed {
  bfe: number;
  adresse: string;
  etage: string | null;
  doer: string | null;
  beskrivelse: string;
  ejer: string;
  ejertype: 'person' | 'selskab' | 'ukendt';
  areal: number | null;
  koebspris: number | null;
  koebsdato: string | null;
  /** DAWA adresse-UUID for navigation til ejendomsdetalje */
  dawaId: string | null;
}

/** API-svar fra denne route */
export interface EjerlejlighederResponse {
  lejligheder: Ejerlejlighed[];
  fejl: string | null;
}

// ─── Tinglysning mTLS ───────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';
const TL_API_PATH = '/tinglysning/ssl';

/** Tinglysning adressesøgning JSON-svar */
interface TLSearchItem {
  uuid: string;
  adresse: string;
  vedroerende: string;
  ejendomsVurdering: number | null;
  grundVaerdi: number | null;
  vurderingsDato: string | null;
  ejendomsnummer: string | null;
  kommuneNummer: string | null;
}

interface TLSearchResponse {
  items: TLSearchItem[];
}

/**
 * HTTPS request med client-certifikat (mTLS) til Tinglysningsretten.
 *
 * @param urlPath - URL-sti efter /tinglysning/ssl/
 * @returns HTTP status + body
 */
function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(CERT_PATH);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet: ' + certAbsPath));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(TL_BASE + TL_API_PATH + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        timeout: 15000,
        headers: { Accept: 'application/json, application/xml, */*' },
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

// ─── Etage/dør parsing ──────────────────────────────────────────────────────

/**
 * Parser etage+dør fra en tinglysningsadresse.
 * F.eks. "Vejnavn 18, 1. tv, 1799 København" → { etage: "1", doer: "tv" }
 *
 * @param adresse - Fuld adressestreng fra tinglysning
 */
function parseEtageDoer(adresse: string): { etage: string | null; doer: string | null } {
  // Typisk format: "Vejnavn Nr, Etage. Dør, Postnr By"
  // Moderejendom: "Vejnavn Nr, Postnr By" (kun 2 dele, ingen etage)
  const parts = adresse.split(',').map((s) => s.trim());
  // Ejerlejligheder har mindst 3 komma-separerede dele: adresse, etage+dør, postnr
  if (parts.length < 3) return { etage: null, doer: null };

  // Andet element er typisk "1. tv" eller "ST. TH" eller "KL. MF"
  const etageDoer = parts[1].trim();
  const match = etageDoer.match(/^(\d+|st|kl)\.?\s*(.*)$/i);
  if (!match) return { etage: null, doer: null };

  return {
    etage: match[1].toLowerCase(),
    doer: match[2]?.toLowerCase().trim() || null,
  };
}

/**
 * Parser en etagestreng til numerisk værdi for sortering.
 *
 * @param etage - Etagestreng
 * @returns Numerisk sorteringsværdi
 */
function parseEtageSortValue(etage: string | null | undefined): number {
  if (!etage) return -99;
  const lower = etage.toLowerCase().trim();
  if (lower === 'st' || lower === 'st.') return 0;
  if (lower === 'kl' || lower === 'kl.') return -1;
  const num = parseInt(lower, 10);
  return isNaN(num) ? -99 : num;
}

/**
 * Parser en dørstreng til sorteringsværdi.
 *
 * @param doer - Dørstreng
 * @returns Numerisk sorteringsværdi
 */
function parseDoerSortValue(doer: string | null | undefined): number {
  if (!doer) return -99;
  const lower = doer.toLowerCase().trim();
  if (lower === 'tv' || lower === 'tv.') return 0;
  if (lower === 'mf' || lower === 'mf.') return 1;
  if (lower === 'th' || lower === 'th.') return 2;
  const num = parseInt(lower, 10);
  return isNaN(num) ? 50 : num + 10;
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjerlejlighederResponse>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as EjerlejlighederResponse, {
      status: 401,
    });
  const { searchParams } = request.nextUrl;
  const ejerlavKode = searchParams.get('ejerlavKode');
  const matrikelnr = searchParams.get('matrikelnr');

  if (!ejerlavKode || !matrikelnr) {
    return NextResponse.json(
      { lejligheder: [], fejl: 'Manglende ejerlavKode eller matrikelnr' },
      { status: 400 }
    );
  }

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { lejligheder: [], fejl: 'Tinglysning certifikat ikke konfigureret' },
      { status: 200 }
    );
  }

  try {
    // ── Trin 1: Søg alle ejendomme på matriklen via Tinglysningsrettens HTTP API ──
    // Matrikelsøgning returnerer ALLE ejendomme inkl. ejerlejligheder på tværs af opgange
    const searchPath = `/ejendom/landsejerlavmatrikel?landsejerlavid=${encodeURIComponent(ejerlavKode)}&matrikelnr=${encodeURIComponent(matrikelnr)}`;

    const tlResult = await tlFetch(searchPath);

    if (tlResult.status !== 200) {
      logger.error(`[ejerlejligheder] Tinglysning svarede ${tlResult.status}`);
      return NextResponse.json(
        { lejligheder: [], fejl: `Tinglysning svarede ${tlResult.status}` },
        { status: 200 }
      );
    }

    let items: TLSearchItem[];
    try {
      const parsed = JSON.parse(tlResult.body) as TLSearchResponse;
      items = parsed.items ?? [];
    } catch {
      logger.error('[ejerlejligheder] Kunne ikke parse tinglysning JSON');
      return NextResponse.json(
        { lejligheder: [], fejl: 'Ugyldig tinglysning-respons' },
        { status: 200 }
      );
    }

    // Filtrer kun ejendomme med etage/dør i adressen (= ejerlejligheder)
    // Moderejendommen har typisk kun "Vejnavn Nr, Postnr By" uden etage
    const lejlighedItems = items.filter((item) => {
      const { etage } = parseEtageDoer(item.adresse);
      return etage !== null;
    });

    if (lejlighedItems.length === 0) {
      return NextResponse.json(
        { lejligheder: [], fejl: null },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
        }
      );
    }

    logger.log(
      `[ejerlejligheder] ${lejlighedItems.length} lejligheder fundet via tinglysning for ejerlav ${ejerlavKode} matr. ${matrikelnr}`
    );

    // ── Trin 2: Hent summarisk data (areal + ejer + køb) for hver lejlighed ──
    // Alt data hentes fra tinglysning ejdsummarisk XML — kræver ingen EJF
    interface SummariskData {
      areal: number | null;
      ejer: string;
      ejertype: 'person' | 'selskab' | 'ukendt';
      koebspris: number | null;
      koebsdato: string | null;
    }
    const summariskMap = new Map<string, SummariskData>(); // uuid → data
    const CONCURRENCY = 5; // Lav concurrency for at undgå rate limiting fra tinglysning

    for (let i = 0; i < lejlighedItems.length; i += CONCURRENCY) {
      const batch = lejlighedItems.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const sumResult = await tlFetch(`/ejdsummarisk/${item.uuid}`);
            if (sumResult.status !== 200 || !sumResult.body) return;
            const xml = sumResult.body;

            // ── Areal ──
            // Prioritér "Ejerlejlighedens tinglyste areal" over generisk "tinglyste areal"
            // (generisk kan være bygningens samlede areal)
            let areal: number | null = null;
            const ejlArealMatch = xml.match(
              /[Ee]jerlejlighedens\s+tinglyste?\s+areal[^<]*<[^>]*>[^<]*<[^>]*>(\d+)\s*kvm/i
            );
            if (ejlArealMatch) {
              areal = parseInt(ejlArealMatch[1], 10);
            }
            if (!areal) {
              const altAreal = xml.match(/<(?:ns\d+:)?Areal>(\d+)<\/(?:ns\d+:)?Areal>/);
              if (altAreal) areal = parseInt(altAreal[1], 10);
            }

            // ── Ejer (seneste adkomsthaver) ──
            let ejer = 'Ukendt';
            let ejertype: 'person' | 'selskab' | 'ukendt' = 'ukendt';
            const adkomstSection =
              xml.match(/AdkomstSummariskSamling[\s\S]*?<\/[^:]*:?AdkomstSummariskSamling/)?.[0] ??
              '';
            const havere = [
              ...adkomstSection.matchAll(/Adkomsthaver>([\s\S]*?)<\/[^:]*:?Adkomsthaver/g),
            ];
            if (havere.length > 0) {
              // Tag seneste (sidste) adkomsthaver
              const lastHaver = havere[havere.length - 1][1];
              const allNames = [...lastHaver.matchAll(/<[^\/][^>]*(?:Name|Navn)[^>]*>([^<]+)<\//g)];
              const nameStr = allNames
                .map((m) => m[1])
                .filter((n) => n.length > 1)
                .join(' ')
                .trim();
              const cvr = lastHaver.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;
              if (nameStr) ejer = nameStr;
              ejertype = cvr ? 'selskab' : 'person';
            }

            // ── Købesum + dato (seneste adkomst) ──
            let koebspris: number | null = null;
            let koebsdato: string | null = null;
            const adkomstEntries = [
              ...adkomstSection.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g),
            ];
            if (adkomstEntries.length > 0) {
              const lastEntry = adkomstEntries[adkomstEntries.length - 1][1];
              const kontantStr = lastEntry.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1];
              const iAltStr = lastEntry.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1];
              koebspris = kontantStr
                ? parseInt(kontantStr, 10)
                : iAltStr
                  ? parseInt(iAltStr, 10)
                  : null;
              if (isNaN(koebspris ?? 0)) koebspris = null;
              koebsdato =
                lastEntry.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ??
                lastEntry.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ??
                lastEntry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
                null;
            }

            summariskMap.set(item.uuid, { areal, ejer, ejertype, koebspris, koebsdato });
          } catch (err) {
            logger.warn(
              `[ejerlejligheder] Summarisk fejl for ${item.uuid}:`,
              err instanceof Error ? err.message : err
            );
          }
        })
      );
      void results;
    }

    // ── Trin 3: Hent DAWA-adresse-ID'er for navigation ──
    const dawaIdMap = new Map<string, string>(); // uuid → dawaId
    for (let i = 0; i < lejlighedItems.length; i += CONCURRENCY) {
      const batch = lejlighedItems.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const { etage, doer } = parseEtageDoer(item.adresse);
            // Udtræk vejnavn + husnr fra adresse (første komma-separerede del)
            const addrPart = item.adresse.split(',')[0].trim();
            const addrMatch = addrPart.match(/^(.+?)\s+(\d+\w*)$/);
            if (!addrMatch) return;
            const [, vej, nr] = addrMatch;
            // Hent postnr fra adresse (tredje komma-separerede del for ejerlejligheder)
            const parts = item.adresse.split(',');
            const postnrMatch = parts[parts.length - 1]?.trim().match(/^(\d{4})/);
            const postnr = postnrMatch?.[1];
            if (!postnr) return;

            // DAWA adresse-opslag med etage+dør
            const params = new URLSearchParams({ vejnavn: vej, husnr: nr, postnr });
            if (etage) params.set('etage', etage);
            if (doer) params.set('dør', doer);
            const dawaRes = await fetch(`https://api.dataforsyningen.dk/adresser?${params}`, {
              signal: AbortSignal.timeout(5000),
            });
            if (!dawaRes.ok) return;
            const addrs = (await dawaRes.json()) as { id: string }[];
            if (addrs.length > 0) {
              dawaIdMap.set(item.uuid, addrs[0].id);
            }
          } catch {
            /* ignore */
          }
        })
      );
      void results;
    }

    // ── Trin 4: Saml resultat ──
    const lejligheder: Ejerlejlighed[] = lejlighedItems
      .map((item) => {
        const { etage, doer } = parseEtageDoer(item.adresse);
        const bfe = item.ejendomsnummer ? parseInt(item.ejendomsnummer, 10) : 0;
        const sum = summariskMap.get(item.uuid);

        return {
          bfe: bfe || 0,
          adresse: item.adresse,
          etage,
          doer,
          beskrivelse: 'Ejerlejlighed',
          ejer: sum?.ejer ?? 'Ukendt',
          ejertype: sum?.ejertype ?? 'ukendt',
          areal: sum?.areal ?? null,
          koebspris: sum?.koebspris ?? null,
          koebsdato: sum?.koebsdato ?? null,
          dawaId: dawaIdMap.get(item.uuid) ?? null,
        };
      })
      .sort((a, b) => {
        // Primært: sortér på gadenavn + husnummer (første komma-del af adressen)
        const addrA = a.adresse.split(',')[0].trim();
        const addrB = b.adresse.split(',')[0].trim();
        if (addrA !== addrB) return addrA.localeCompare(addrB, 'da');
        // Sekundært: etage
        const etageA = parseEtageSortValue(a.etage);
        const etageB = parseEtageSortValue(b.etage);
        if (etageA !== etageB) return etageA - etageB;
        // Tertiært: dør
        return parseDoerSortValue(a.doer) - parseDoerSortValue(b.doer);
      });

    return NextResponse.json(
      { lejligheder, fejl: null },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    logger.error('[ejerlejligheder] Uventet fejl:', err);
    return NextResponse.json({ lejligheder: [], fejl: 'Intern serverfejl' }, { status: 500 });
  }
}
