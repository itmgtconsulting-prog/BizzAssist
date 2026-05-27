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
import { createAdminClient } from '@/lib/supabase/admin';
import path from 'path';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { fetchDawa } from '@/app/lib/dawa';
import { darResolveAdresseId } from '@/app/lib/dar';
import { resolveEnhedByDawaId } from '@/app/lib/fetchBbrData';
import { fetchTinglysningPriceRowsByBfe } from '@/app/lib/tinglysningPrices';
import { fetchEjfEjereDirekt } from '@/app/lib/ejerskab/fetchEjfEjereDirekt';

// ─── Query param validation ─────────────────────────────────────────────────

const ejerlejlighederQuerySchema = z.object({
  ejerlavKode: z.string().regex(/^\d+$/, 'ejerlavKode skal være et heltal'),
  matrikelnr: z.string().min(1, 'matrikelnr er påkrævet'),
  /** BIZZ-695: Optional moderBfe for DAWA fallback owner lookup */
  moderBfe: z.coerce.number().int().positive().optional(),
  /**
   * BIZZ-784: When false (default), the response filters out properties
   * flagged udfaset=true. Clients pass true to get the full list including
   * retired registrations.
   */
  includeUdfasede: z.coerce.boolean().optional().default(false),
});

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
  /**
   * BIZZ-784: Heuristic "udfaset" marker. For Tinglysning-path we use
   * ejendomsVurdering=0 AND grundVaerdi=0 as a proxy for a retired
   * property (proper BBR-status lookup is deferred to iter 2). Null when
   * the data is insufficient to decide.
   */
  udfaset: boolean | null;
  /**
   * BIZZ-880 (845c): BBR bygning-id (UUID) som ejerlejligheden fysisk
   * ligger i. Resolves via BBR_Enhed.bygning-feltet når dawaId → UUID
   * mapping findes. Bruges af BIZZ-846 til at gruppere komponenter på
   * ægte FK i stedet for adresse-prefix-parsing.
   */
  bygningId: string | null;
  /**
   * BIZZ-880 (845c): Menneske-læsbar bygnings-betegnelse (typisk
   * anvendelses-tekst fra LiveBBRBygning). Null hvis bygningId ikke
   * kunne resolves.
   */
  bygningBetegnelse: string | null;
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

// ─── DAWA fallback ──────────────────────────────────────────────────────────

/**
 * BIZZ-695: Fallback til DAWA + ejf_ejerskab når Tinglysning returnerer 0 lejligheder.
 *
 * Flow:
 *   1. Find adgangsadresser på matriklen via DAWA /jordstykker → husnumre
 *   2. For hver adgangsadresse: hent alle adresser med etage/dør via DAWA /adresser
 *   3. For hver adresse: slå BFE op og hent ejerskab fra ejf_ejerskab DB
 *
 * @param ejerlavKode - Ejerlavkode fra BBR ejendomsrelation
 * @param matrikelnr - Matrikelnummer fra BBR ejendomsrelation
 * @returns Array af Ejerlejlighed med adresse, ejer og DAWA-id
 */
async function resolveLejlighederViaDawa(
  ejerlavKode: string,
  matrikelnr: string,
  _moderBfe?: number
): Promise<Ejerlejlighed[]> {
  const DAWA_BASE = 'https://dawa.aws.dk';

  // Step 1: Find adgangsadresser på matriklen
  const adgRes = await fetchDawa(
    `${DAWA_BASE}/adgangsadresser?ejerlavkode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}&per_side=20`,
    { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 } },
    { caller: 'ejerlejligheder.dawa-fallback' }
  );
  if (!adgRes.ok) return [];
  const adgangsadresser = (await adgRes.json()) as Array<{ id: string; adressebetegnelse: string }>;
  if (adgangsadresser.length === 0) return [];

  // BIZZ-1677: cachedOwner FJERNET — kopierede moder-ejer til alle children-EL.
  // TL-berigelsen (BIZZ-724 iter 3) populerer korrekt ejer pr. EL-BFE.

  // Step 3: For each adgangsadresse, find all adresser with etage/dør
  const lejligheder: Ejerlejlighed[] = [];

  for (const adg of adgangsadresser) {
    const adrRes = await fetchDawa(
      `${DAWA_BASE}/adresser?adgangsadresseid=${adg.id}&per_side=50&struktur=mini`,
      { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
      { caller: 'ejerlejligheder.dawa-adresser' }
    );
    if (!adrRes.ok) continue;
    const adresser = (await adrRes.json()) as Array<{
      id: string;
      betegnelse: string;
      etage: string | null;
      dør: string | null;
      adgangsadresseid: string;
    }>;

    // Only include addresses WITH etage (= individual units, not the access address itself)
    const units = adresser.filter((a) => a.etage != null && a.etage !== '');

    for (const unit of units) {
      lejligheder.push({
        bfe: 0,
        adresse: unit.betegnelse,
        etage: unit.etage,
        doer: unit.dør,
        beskrivelse: unit.betegnelse,
        // BIZZ-1677: Sæt IKKE moder-ejer på alle units — det giver forkert
        // data (alle EL viser samme person). TL-berigelsen nedenfor populerer
        // den korrekte ejer pr. BFE via /ejdsummarisk.
        ejer: '–',
        ejertype: 'ukendt',
        areal: null,
        koebspris: null,
        koebsdato: null,
        dawaId: unit.id,
        // BIZZ-784: DAWA-fallback path has no valuation data — mark null so
        // the filter neither includes nor excludes these by heuristic.
        udfaset: null,
        // BIZZ-880 (845c): bygningId/betegnelse ikke tilgængelig i DAWA-
        // fallback path — BBR_Enhed-enrichment nedenfor kan populere
        // via dedikeret lookup når path er aktiveret.
        bygningId: null,
        bygningBetegnelse: null,
      });
    }
  }

  // BIZZ-724 iter 3: Primær per-lejlighed-berigelse via Tinglysning
  // /ejendom/adresse — returnerer den specifikke ejerlejligheds-BFE + UUID
  // pr. adresse med etage/dør. Det er vejen til korrekt lejligheds-BFE
  // (fx 226629 for 62B, 226630 for 62A) og samtidig gateway til summarisk-XML
  // med areal + købspris + købsdato. Fejl på en enkelt lejlighed logges som
  // non-fatal og falder tilbage til BBR_Enhed/matrikel-fallback.
  await Promise.all(
    lejligheder.map(async (lej) => {
      try {
        // Parse vejnavn + husnr fra betegnelse ("Arnold Nielsens Blvd 62A, st., 2650 Hvidovre")
        const addrPart = lej.adresse.split(',')[0].trim();
        const m = addrPart.match(/^(.+?)\s+(\d+\w*)$/);
        const postMatch = lej.adresse.match(/(\d{4})/);
        if (!m || !postMatch) return;
        const [, vejnavn, husnummer] = m;
        const postnummer = postMatch[1];
        // Tinglysning test-miljø returnerer {} når etage/sidedoer er sat, selv
        // om ejerlejligheden findes uden disse filtre. Vi søger uden etage/dør
        // og filtrerer derefter på vedroerende='Ejerlejlighed:' — alle etager
        // i samme opgang hører typisk til samme juridiske ejerlejlighed.
        const params = new URLSearchParams({ vejnavn, husnummer, postnummer });
        const res = await tlFetch(`/ejendom/adresse?${params.toString()}`);
        if (res.status !== 200 || !res.body) return;
        let items: TLSearchItem[] = [];
        try {
          const parsed = JSON.parse(res.body) as TLSearchResponse;
          items = parsed.items ?? [];
        } catch {
          return;
        }
        // Prefer the ejerlejlighed entry over hovedejendom — hovedejendom har
        // typisk ejendomsVurdering=0 og vedroerende indeholder 'Hovedejendom'.
        const tlItem =
          items.find((it) => /ejerlejlighed/i.test(it.vedroerende)) ??
          items.find((it) => !/hovedejendom/i.test(it.vedroerende)) ??
          items[0];
        if (!tlItem) return;
        // ejendomsnummer is the unit-specific BFE
        const bfe = tlItem.ejendomsnummer ? parseInt(tlItem.ejendomsnummer, 10) : 0;
        if (bfe > 0) lej.bfe = bfe;

        // Fetch summarisk XML → areal + købspris + købsdato + ejer-navn
        const sumRes = await tlFetch(`/ejdsummarisk/${tlItem.uuid}`);
        if (sumRes.status === 200 && sumRes.body) {
          const xml = sumRes.body;
          // Ejerlejlighedens areal (primær) eller generisk areal
          const ejlAreal = xml.match(
            /[Ee]jerlejlighedens\s+tinglyste?\s+areal[^<]*<[^>]*>[^<]*<[^>]*>(\d+)\s*kvm/i
          );
          if (ejlAreal) {
            lej.areal = parseInt(ejlAreal[1], 10);
          } else {
            const alt = xml.match(/<(?:ns\d+:)?Areal>(\d+)<\/(?:ns\d+:)?Areal>/);
            if (alt) lej.areal = parseInt(alt[1], 10);
          }

          // Seneste adkomst: koebspris + koebsdato + ejer
          const adkomstSection =
            xml.match(/AdkomstSummariskSamling[\s\S]*?<\/[^:]*:?AdkomstSummariskSamling/)?.[0] ??
            '';
          const adkomstEntries = [
            ...adkomstSection.matchAll(/AdkomstSummarisk>([\s\S]*?)<\/[^:]*:?AdkomstSummarisk/g),
          ];
          if (adkomstEntries.length > 0) {
            const last = adkomstEntries[adkomstEntries.length - 1][1];
            const kontant = last.match(/KontantKoebesum[^>]*>([^<]+)/)?.[1];
            const iAlt = last.match(/IAltKoebesum[^>]*>([^<]+)/)?.[1];
            const price = kontant ? parseInt(kontant, 10) : iAlt ? parseInt(iAlt, 10) : null;
            if (price != null && !isNaN(price)) lej.koebspris = price;
            const dato =
              last.match(/KoebsaftaleDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ??
              last.match(/SkoedeOvertagelsesDato[^>]*>([^<]+)/)?.[1]?.split('+')[0] ??
              last.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1]?.split('T')[0] ??
              null;
            if (dato) lej.koebsdato = dato;
          }
        }
      } catch (err) {
        logger.warn('[ejerlejligheder] per-lejlighed TL enrichment fejl:', err);
      }
    })
  );

  // Fallback: for lejligheder der stadig mangler BFE eller areal, prøv
  // BBR_Enhed → adgangsadresse → matrikel-BFE chain'en. Kun et sikkerhedsnet
  // — primær-pathen ovenfor dækker ejerlejligheder som er tinglyst med
  // individuel ejendomsnummer, hvilket er ~alle bolig-ejerlejligheder.
  await Promise.all(
    lejligheder.map(async (lej) => {
      // BIZZ-880: vi henter stadig enhed hvis bygningId mangler — selv når
      // bfe+areal allerede er sat — så SFE-gruppering kan ske på ægte FK.
      const alreadyEnriched = lej.bfe > 0 && lej.areal != null && lej.bygningId != null;
      if (alreadyEnriched) return;
      if (!lej.dawaId) return;
      try {
        const enhed = await resolveEnhedByDawaId(lej.dawaId);
        if (enhed?.bfe && lej.bfe === 0) lej.bfe = enhed.bfe;
        if (enhed?.areal != null && lej.areal == null) lej.areal = enhed.areal;
        if (enhed?.bygningId && lej.bygningId == null) lej.bygningId = enhed.bygningId;
      } catch {
        /* non-fatal */
      }
    })
  );

  // BIZZ-1678: VP BFE-fallback for lejligheder med bfe===0 efter TL+DAWA.
  // Vurderingsportalen ES har BFE for de fleste ejerlejligheder og er hurtigere
  // end TL (single batch query vs. N serial TL-kald).
  const missingBfe = lejligheder.filter((l) => l.bfe === 0 && l.adresse);
  if (missingBfe.length > 0) {
    try {
      // Batch: hent alle adresser på denne matrikel fra VP i ét kald
      const firstAddr = lejligheder[0]?.adresse ?? '';
      const vejMatch = firstAddr
        .split(',')[0]
        .trim()
        .match(/^(.+?)\s+\d/);
      const postMatch = firstAddr.match(/(\d{4})\s+\S/);
      if (vejMatch && postMatch) {
        const vpRes = await fetch(
          'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
            },
            body: JSON.stringify({
              query: {
                bool: {
                  must: [
                    { prefix: { 'roadName.keyword': vejMatch[1] } },
                    { term: { zipcode: postMatch[1] } },
                  ],
                },
              },
              size: 200,
              _source: ['bfeNumbers', 'roadName', 'houseNumber', 'floor', 'door', 'address'],
            }),
            signal: AbortSignal.timeout(8000),
          }
        );
        if (vpRes.ok) {
          const vpData = (await vpRes.json()) as {
            hits?: {
              hits?: Array<{
                _source?: {
                  bfeNumbers?: number[];
                  address?: string;
                  floor?: string;
                  door?: string;
                  houseNumber?: string;
                };
              }>;
            };
          };
          // Build address→BFE map from VP results
          const vpBfeMap = new Map<string, number>();
          for (const hit of vpData.hits?.hits ?? []) {
            const src = hit._source;
            if (!src?.bfeNumbers?.[0] || !src.address) continue;
            // Normaliser: "Skyttegårdvej 1, st. th, 2500 Valby" → lowercase trimmed
            vpBfeMap.set(src.address.toLowerCase().trim(), src.bfeNumbers[0]);
          }
          // Match missing lejligheder
          let resolved = 0;
          for (const lej of missingBfe) {
            const normAddr = lej.adresse.toLowerCase().trim();
            const bfe = vpBfeMap.get(normAddr);
            if (bfe && bfe > 0) {
              lej.bfe = bfe;
              resolved++;
            }
          }
          if (resolved > 0) {
            logger.log(
              `[ejerlejligheder] VP BFE fallback: ${resolved}/${missingBfe.length} resolved`
            );
          }
        }
      }
    } catch {
      /* VP fallback non-fatal */
    }
  }

  // Sidste skridt: for lejligheder med BFE men ingen koebspris/koebsdato fra
  // summarisk, prøv salgshistorik-API (BIZZ-685) som nu indeholder Tinglysning
  // /dokaktuel pris-enrichment + reverse-inference. Giver pris på rækker hvor
  // den seneste adkomst var en arv/gave uden pris, men tidligere handler havde.
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    // BIZZ-1870: Batched pris-fallback med concurrency limit (var Promise.all ubegrænset)
    const PRICE_CONCURRENCY = 5;
    const needsPrice = lejligheder.filter(
      (l) => l.bfe && l.bfe > 0 && (l.koebspris == null || !l.koebsdato)
    );
    for (let pi = 0; pi < needsPrice.length; pi += PRICE_CONCURRENCY) {
      const priceBatch = needsPrice.slice(pi, pi + PRICE_CONCURRENCY);
      await Promise.all(
        priceBatch.map(async (lej) => {
          if (lej.koebspris != null && lej.koebsdato) return;
          try {
            const priceRows = await fetchTinglysningPriceRowsByBfe(lej.bfe);
            if (priceRows.length > 0) {
              const latest = priceRows[priceRows.length - 1];
              if (lej.koebspris == null) {
                lej.koebspris = latest.kontantKoebesum ?? latest.iAltKoebesum ?? null;
              }
              if (!lej.koebsdato) {
                lej.koebsdato =
                  latest.overtagelsesdato ??
                  latest.koebsaftaleDato ??
                  latest.tinglysningsdato ??
                  null;
              }
            }

            // Ejf_ejerskab fallback for koebsdato når summarisk mangler
            if (!lej.koebsdato) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: rows } = (await (admin as any)
                .from('ejf_ejerskab')
                .select('virkning_fra')
                .eq('bfe_nummer', lej.bfe)
                .eq('status', 'gældende')
                .order('virkning_fra', { ascending: false })
                .limit(1)) as { data: Array<{ virkning_fra: string | null }> | null };
              const virkningFra = rows?.[0]?.virkning_fra ?? null;
              if (virkningFra) lej.koebsdato = virkningFra;
            }
          } catch {
            /* non-fatal */
          }
        })
      );
    }
  } catch (err) {
    logger.warn('[ejerlejligheder] Salgshistorik-fallback fejlede:', err);
  }

  // Sort: by adresse → etage → dør
  lejligheder.sort((a, b) => {
    const aEtage = parseEtageSortValue(a.etage);
    const bEtage = parseEtageSortValue(b.etage);
    if (aEtage !== bEtage) return aEtage - bEtage;
    return parseDoerSortValue(a.doer) - parseDoerSortValue(b.doer);
  });

  return lejligheder;
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjerlejlighederResponse>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as EjerlejlighederResponse, {
      status: 401,
    });

  const parsed = parseQuery(request, ejerlejlighederQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<EjerlejlighederResponse>;
  const { ejerlavKode, matrikelnr, moderBfe, includeUdfasede } = parsed.data;

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
      logger.warn(
        `[ejerlejligheder] Tinglysning svarede ${tlResult.status} — prøver DAWA fallback`
      );
      // BIZZ-1585: Kør DAWA fallback når TL fejler (404/500) — TL mangler
      // data for mange matrikler. DAWA finder adresser med etage/dør.
      try {
        const dawaFallback = await resolveLejlighederViaDawa(ejerlavKode, matrikelnr, moderBfe);
        if (dawaFallback.length > 0) {
          logger.log(
            `[ejerlejligheder] DAWA fallback (TL ${tlResult.status}): ${dawaFallback.length} lejligheder for ejerlav ${ejerlavKode} matr. ${matrikelnr}`
          );
          return NextResponse.json(
            { lejligheder: dawaFallback, fejl: null },
            {
              status: 200,
              headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
            }
          );
        }
      } catch (dawaErr) {
        logger.warn(
          '[ejerlejligheder] DAWA fallback fejlede:',
          dawaErr instanceof Error ? dawaErr.message : dawaErr
        );
      }
      return NextResponse.json({ lejligheder: [], fejl: null }, { status: 200 });
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
      // BIZZ-695: Tinglysning dækker ikke alle matrikler. Fallback til DAWA:
      // Find alle adgangsadresser på matriklen → hent adresser med etage/dør → berig med EJF ejerskab fra DB.
      try {
        const dawaFallback = await resolveLejlighederViaDawa(ejerlavKode, matrikelnr, moderBfe);
        if (dawaFallback.length > 0) {
          logger.log(
            `[ejerlejligheder] DAWA fallback: ${dawaFallback.length} lejligheder for ejerlav ${ejerlavKode} matr. ${matrikelnr}`
          );
          return NextResponse.json(
            { lejligheder: dawaFallback, fejl: null },
            {
              status: 200,
              headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
            }
          );
        }
      } catch (dawaErr) {
        logger.warn(
          '[ejerlejligheder] DAWA fallback fejlede:',
          dawaErr instanceof Error ? dawaErr.message : dawaErr
        );
      }

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
    // BIZZ-1820: EJF cache-first — hent ejere fra ejf_ejerskab for ALLE lejligheder
    // i stedet for at kalde TL for hver enkelt. Meget hurtigere + ingen cap.
    const ejfEjerMap = new Map<number, { navn: string; type: string }>();
    try {
      const bfes = lejlighedItems
        .map((it) => parseInt(it.ejendomsnummer ?? '0', 10))
        .filter((b) => b > 0);
      if (bfes.length > 0) {
        const admin = createAdminClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: ejfRows } = await (admin as any)
          .from('ejf_ejerskab')
          .select('bfe_nummer, ejer_navn, ejer_type')
          .in('bfe_nummer', bfes)
          .eq('status', 'gældende')
          .limit(200);
        for (const row of (ejfRows ?? []) as Array<{
          bfe_nummer: number;
          ejer_navn: string;
          ejer_type: string;
        }>) {
          if (!ejfEjerMap.has(row.bfe_nummer)) {
            ejfEjerMap.set(row.bfe_nummer, { navn: row.ejer_navn, type: row.ejer_type });
          }
        }
        logger.log(
          `[ejerlejligheder] EJF cache: ${ejfEjerMap.size} ejere for ${bfes.length} BFE'er`
        );
      }
    } catch {
      /* EJF cache non-fatal */
    }

    const CONCURRENCY = 3;
    const MAX_TL_ENRICH = 60;
    const itemsToEnrich = lejlighedItems.slice(0, MAX_TL_ENRICH);

    // Cache-first: hent allerede-parsed data fra tinglysning_summarisk_cache
    // i stedet for at kalde TL S2S for hver lejlighed (undgår 429 rate-limit).
    const cachedSummarisk = new Map<
      string,
      {
        ejere?: Array<{
          navn?: string;
          cvr?: string | null;
          type?: string;
          kontantKoebesum?: number | null;
          iAltKoebesum?: number | null;
          overtagelsesdato?: string | null;
        }>;
      }
    >();
    try {
      const cacheAdmin = createAdminClient();
      const uuids = itemsToEnrich.map((it) => it.uuid);
      if (uuids.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: cacheRows } = await (cacheAdmin as any)
          .from('tinglysning_summarisk_cache')
          .select('uuid, payload')
          .in('uuid', uuids);
        for (const row of (cacheRows ?? []) as Array<{
          uuid: string;
          payload: Record<string, unknown> | null;
        }>) {
          if (row.payload) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cachedSummarisk.set(row.uuid, row.payload as any);
          }
        }
        logger.log(
          `[ejerlejligheder] Cache hit: ${cachedSummarisk.size}/${uuids.length} summarisk`
        );
      }
    } catch {
      /* cache lookup non-fatal */
    }

    for (let i = 0; i < itemsToEnrich.length; i += CONCURRENCY) {
      const batch = itemsToEnrich.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          // Cache-first: brug cached payload hvis tilgængeligt
          const cached = cachedSummarisk.get(item.uuid);
          if (cached?.ejere && cached.ejere.length > 0) {
            const lastEjer = cached.ejere[cached.ejere.length - 1];
            const ejer = lastEjer.navn ?? 'Ukendt';
            const ejertype = lastEjer.cvr
              ? ('selskab' as const)
              : lastEjer.type === 'selskab'
                ? ('selskab' as const)
                : ('person' as const);
            const koebspris = lastEjer.kontantKoebesum ?? lastEjer.iAltKoebesum ?? null;
            const koebsdato = lastEjer.overtagelsesdato ?? null;
            summariskMap.set(item.uuid, { areal: null, ejer, ejertype, koebspris, koebsdato });
            return;
          }

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

            // Cache-write: gem parsed data så næste kald er instant
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              void (createAdminClient() as any)
                .from('tinglysning_summarisk_cache')
                .upsert(
                  {
                    uuid: item.uuid,
                    bfe_nummer: null,
                    payload: {
                      ejere: [
                        {
                          navn: ejer,
                          type: ejertype,
                          kontantKoebesum: koebspris,
                          overtagelsesdato: koebsdato,
                        },
                      ],
                      haeftelser: [],
                      servitutter: [],
                      fejl: null,
                    },
                    fetched_at: new Date().toISOString(),
                  },
                  { onConflict: 'uuid' }
                )
                .then(() => {});
            } catch {
              /* cache write non-fatal */
            }
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

    // ── Trin 3: Hent adresse-UUID'er for navigation (BIZZ-506) ──
    //
    // Flow: DAR GraphQL først (chained NavngivenVej → Postnummer → Husnummer
    // → Adresse) → DAWA /adresser fallback hvis DAR null'er. Resultatet er
    // den DAR adresse-UUID der bruges som `adresseIdentificerer` i BBR_Enhed
    // queries og til in-app navigation.
    const dawaIdMap = new Map<string, string>(); // uuid → adresseId (from DAR or DAWA)
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

            // BIZZ-506: Primær — DAR GraphQL chained lookup
            const darId = await darResolveAdresseId({
              vejnavn: vej,
              husnr: nr,
              postnr,
              etage: etage ?? null,
              doer: doer ?? null,
            });
            if (darId) {
              dawaIdMap.set(item.uuid, darId);
              return;
            }

            // Fallback — DAWA /adresser. Tagget så telemetri kan tælle
            // hvor mange ejerlejlighed-opslag der stadig falder tilbage.
            const params = new URLSearchParams({ vejnavn: vej, husnr: nr, postnr });
            if (etage) params.set('etage', etage);
            if (doer) params.set('dør', doer);
            const dawaRes = await fetchDawa(
              `https://api.dataforsyningen.dk/adresser?${params}`,
              { signal: AbortSignal.timeout(5000) },
              { caller: 'ejerlejligheder.adresser.fallback' }
            );
            if (!dawaRes.ok) return;
            const addrs = (await dawaRes.json()) as { id: string }[];
            if (addrs.length > 0) {
              dawaIdMap.set(item.uuid, addrs[0].id);
            }
          } catch {
            /* ignore — individual lookup failures are non-fatal */
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

        // BIZZ-784: heuristic — Tinglysning doesn't expose an explicit
        // "retired" status but valuation=0 AND grundVærdi=0 is a reliable
        // proxy: active properties are always assessed with non-zero values.
        // Proper BBR-status lookup (status codes 4/10/11) is iter 2.
        const udfaset =
          item.ejendomsVurdering != null && item.grundVaerdi != null
            ? item.ejendomsVurdering === 0 && item.grundVaerdi === 0
            : null;

        return {
          bfe: bfe || 0,
          adresse: item.adresse,
          etage,
          doer,
          beskrivelse: 'Ejerlejlighed',
          // BIZZ-1820: EJF cache fallback for lejligheder uden TL-data
          ejer: sum?.ejer ?? ejfEjerMap.get(bfe)?.navn ?? 'Ukendt',
          ejertype:
            sum?.ejertype ??
            ((ejfEjerMap.get(bfe)?.type === 'person'
              ? 'person'
              : ejfEjerMap.get(bfe)?.type === 'selskab'
                ? 'selskab'
                : 'ukendt') as 'person' | 'selskab' | 'ukendt'),
          areal: sum?.areal ?? null,
          koebspris: sum?.koebspris ?? null,
          koebsdato: sum?.koebsdato ?? null,
          dawaId: dawaIdMap.get(item.uuid) ?? null,
          udfaset,
          // BIZZ-880: bygningId populeres via BBR_Enhed-enrichment (efter denne map)
          bygningId: null,
          bygningBetegnelse: null,
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

    // ── Trin 4b: EJF-fallback for lejligheder med "Ukendt" ejer ──
    // Tinglysning summarisk XML mangler ofte adkomst for ejerlejligheder.
    // Hent fra EJF Datafordeler (cache → live GraphQL) for de BFE'er der
    // stadig er "Ukendt" efter TL-enrichment + ejf_ejerskab cache.
    const ukendte = lejligheder.filter((l) => l.ejer === 'Ukendt' && l.bfe > 0);
    if (ukendte.length > 0) {
      const EJF_FALLBACK_MAX = 30;
      const EJF_CONCURRENCY = 3;
      const bfesToResolve = ukendte.slice(0, EJF_FALLBACK_MAX);
      const ejfMap = new Map<number, { navn: string; type: 'person' | 'selskab' | 'ukendt' }>();

      for (let i = 0; i < bfesToResolve.length; i += EJF_CONCURRENCY) {
        const batch = bfesToResolve.slice(i, i + EJF_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (l) => {
            try {
              const { ejere } = await fetchEjfEjereDirekt(l.bfe);
              if (ejere.length > 0) {
                const e = ejere[0];
                const navn = e.personNavn ?? e.virksomhedsnavn ?? null;
                if (navn) {
                  ejfMap.set(l.bfe, {
                    navn,
                    type:
                      e.ejertype === 'selskab'
                        ? 'selskab'
                        : e.ejertype === 'person'
                          ? 'person'
                          : 'ukendt',
                  });
                }
              }
            } catch {
              /* non-fatal */
            }
          })
        );
        void results;
      }

      if (ejfMap.size > 0) {
        for (const l of lejligheder) {
          const hit = ejfMap.get(l.bfe);
          if (hit && l.ejer === 'Ukendt') {
            l.ejer = hit.navn;
            l.ejertype = hit.type;
          }
        }
        logger.log(
          `[ejerlejligheder] EJF fallback: resolved ${ejfMap.size}/${ukendte.length} ukendte ejere`
        );
      }
    }

    // BIZZ-1656: Augmentér med DAWA — TL matrikelsøgning kan returnere
    // delvise resultater (fx kun 1. sal men ikke stuen). DAWA finder ALLE
    // adresser på matriklen. Tilføj units DAWA kender men TL ikke fandt.
    try {
      const dawaExtra = await resolveLejlighederViaDawa(ejerlavKode, matrikelnr, moderBfe);
      if (dawaExtra.length > 0) {
        const existingAddrs = new Set(
          lejligheder.map((l) => l.adresse.toLowerCase().replace(/\s+/g, ' ').trim())
        );
        let added = 0;
        for (const dLej of dawaExtra) {
          const normAddr = dLej.adresse.toLowerCase().replace(/\s+/g, ' ').trim();
          if (!existingAddrs.has(normAddr)) {
            lejligheder.push(dLej);
            existingAddrs.add(normAddr);
            added++;
          }
        }
        if (added > 0) {
          logger.log(
            `[ejerlejligheder] DAWA augment: ${added} ekstra lejligheder tilføjet for ejerlav ${ejerlavKode} matr. ${matrikelnr}`
          );
          // Re-sort after merge
          lejligheder.sort((a, b) => {
            const addrA = a.adresse.split(',')[0].trim();
            const addrB = b.adresse.split(',')[0].trim();
            if (addrA !== addrB) return addrA.localeCompare(addrB, 'da');
            const etageA = parseEtageSortValue(a.etage);
            const etageB = parseEtageSortValue(b.etage);
            if (etageA !== etageB) return etageA - etageB;
            return parseDoerSortValue(a.doer) - parseDoerSortValue(b.doer);
          });
        }
      }
    } catch (dawaErr) {
      logger.warn(
        '[ejerlejligheder] DAWA augment fejlede (non-fatal):',
        dawaErr instanceof Error ? dawaErr.message : dawaErr
      );
    }

    // BIZZ-1842: Pris-fallback for TL-path lejligheder uden koebspris/koebsdato.
    // Strategi: (1) batch-lookup v_ejerskifte_handel (985k rækker med priser
    // fra EJF backfill — primær kilde), (2) live TL-kald som sidste fallback
    // for BFE'er der ikke er i cachen. Fanger lejligheder hvor MAX_TL_ENRICH
    // cap (15) blev ramt, eller summarisk XML manglede pris (arv/gave).
    try {
      const { createAdminClient } = await import('@/lib/supabase/admin');
      const admin = createAdminClient();
      const missingPrice = lejligheder.filter(
        (l) => l.bfe > 0 && (l.koebspris == null || !l.koebsdato)
      );

      if (missingPrice.length > 0) {
        // Trin 1: Batch-lookup i v_ejerskifte_handel (EJF pre-joined view)
        const bfeList = missingPrice.map((l) => l.bfe);

        type HistRow = {
          bfe_nummer: number;
          overtagelsesdato: string | null;
          kontant_koebesum: number | null;
          samlet_koebesum: number | null;
          koebsaftale_dato: string | null;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: histRows } = (await (admin as any)
          .from('v_ejerskifte_handel')
          .select(
            'bfe_nummer, overtagelsesdato, kontant_koebesum, samlet_koebesum, koebsaftale_dato'
          )
          .in('bfe_nummer', bfeList)
          .gt('kontant_koebesum', 0)
          .order('overtagelsesdato', { ascending: false })) as {
          data: HistRow[] | null;
        };

        // Gruppér per BFE — første række per BFE er nyeste (DESC sort)
        const histMap = new Map<number, HistRow>();
        for (const row of histRows ?? []) {
          if (!histMap.has(row.bfe_nummer)) {
            histMap.set(row.bfe_nummer, row);
          }
        }

        let enrichedFromCache = 0;
        for (const lej of missingPrice) {
          const hist = histMap.get(lej.bfe);
          if (!hist) continue;
          if (lej.koebspris == null) {
            lej.koebspris = hist.kontant_koebesum ?? hist.samlet_koebesum ?? null;
          }
          if (!lej.koebsdato) {
            // overtagelsesdato er timestamptz — convertér til date-streng
            lej.koebsdato = hist.overtagelsesdato
              ? hist.overtagelsesdato.split('T')[0]
              : (hist.koebsaftale_dato ?? null);
          }
          if (lej.koebspris != null || lej.koebsdato) enrichedFromCache++;
        }
        if (enrichedFromCache > 0) {
          logger.log(
            `[ejerlejligheder] TL-path cache-fallback: ${enrichedFromCache}/${missingPrice.length} berigede fra v_ejerskifte_handel`
          );
        }

        // Trin 2: Live TL fallback for BFE'er stadig uden pris (max 20 for perf)
        const stillMissing = missingPrice.filter((l) => l.koebspris == null || !l.koebsdato);
        const PRICE_LIVE_MAX = 20;
        const PRICE_CONCURRENCY = 3;
        const toResolveLive = stillMissing.slice(0, PRICE_LIVE_MAX);

        for (let i = 0; i < toResolveLive.length; i += PRICE_CONCURRENCY) {
          const batch = toResolveLive.slice(i, i + PRICE_CONCURRENCY);
          await Promise.allSettled(
            batch.map(async (lej) => {
              try {
                const priceRows = await fetchTinglysningPriceRowsByBfe(lej.bfe);
                if (priceRows.length > 0) {
                  const latest = priceRows[priceRows.length - 1];
                  if (lej.koebspris == null) {
                    lej.koebspris = latest.kontantKoebesum ?? latest.iAltKoebesum ?? null;
                  }
                  if (!lej.koebsdato) {
                    lej.koebsdato =
                      latest.overtagelsesdato ??
                      latest.koebsaftaleDato ??
                      latest.tinglysningsdato ??
                      null;
                  }
                }

                // ejf_ejerskab fallback for koebsdato når TL ikke har pris
                if (!lej.koebsdato) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const { data: rows } = (await (admin as any)
                    .from('ejf_ejerskab')
                    .select('virkning_fra')
                    .eq('bfe_nummer', lej.bfe)
                    .eq('status', 'gældende')
                    .order('virkning_fra', { ascending: false })
                    .limit(1)) as { data: Array<{ virkning_fra: string | null }> | null };
                  if (rows && rows.length > 0 && rows[0].virkning_fra) {
                    lej.koebsdato = rows[0].virkning_fra;
                  }
                }
              } catch {
                /* per-lejlighed live fallback non-fatal */
              }
            })
          );
        }
      }
    } catch {
      /* pris-fallback non-fatal */
    }

    // BIZZ-784: filter udfasede ejerlejligheder unless klienten eksplicit
    // beder om dem. `udfaset=null` (ukendt) tæller som aktiv så vi ikke
    // skjuler enheder på basis af en heuristic der ikke kunne afgøres.
    const filtered = includeUdfasede ? lejligheder : lejligheder.filter((l) => l.udfaset !== true);

    return NextResponse.json(
      { lejligheder: filtered, fejl: null },
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
