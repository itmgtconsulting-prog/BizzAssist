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
import { fetchMatEjerlejlighederByBfe } from '@/app/lib/matEjerlejlighed';
// EJF/Datafordeler er ikke nødvendig — alt data hentes fra tinglysning summarisk XML

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
  /**
   * BIZZ-2057: KOMMUNALT ESR-ejendomsnummer (entydigt KUN sammen med
   * kommuneNummer), IKKE et BFE-nummer. Må aldrig bruges som BFE — det reelle
   * BFE (BestemtFastEjendomNummer) hentes via ejdsummarisk-opslag på uuid.
   */
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

// ─── BFE-opslag ─────────────────────────────────────────────────────────────

/**
 * BIZZ-2057: Udtrækker det reelle BFE (BestemtFastEjendomNummer) fra en
 * ejdsummarisk-XML-respons. TL-søgesvar indeholder kun det kommunale ESR-nummer.
 *
 * @param xml - ejdsummarisk XML-body
 * @returns BFE-nummer eller 0 hvis ikke fundet
 */
function parseBfeFromSummarisk(xml: string): number {
  const m = xml.match(/BestemtFastEjendomNummer>\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * BIZZ-2057: Batch-resolver reelle BFE-numre for TL-uuid'er via ejdsummarisk.
 * Kører i CONCURRENCY-batcher så vi ikke overbelaster TL med N parallelle kald.
 *
 * @param uuids - TL-objekt-uuid'er
 * @param concurrency - antal parallelle kald pr. batch
 * @returns Map fra uuid → reelt BFE (kun entries der kunne resolves)
 */
async function fetchBfeBatch(uuids: string[], concurrency = 3): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < uuids.length; i += concurrency) {
    const batch = uuids.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (uuid) => {
        const res = await tlFetch(`/ejdsummarisk/${uuid}`);
        if (res.status !== 200 || !res.body) return { uuid, bfe: 0 };
        return { uuid, bfe: parseBfeFromSummarisk(res.body) };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.bfe > 0) map.set(r.value.uuid, r.value.bfe);
    }
  }
  return map;
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

        // Fetch summarisk XML → reelt BFE + areal + købspris + købsdato + ejer-navn
        const sumRes = await tlFetch(`/ejdsummarisk/${tlItem.uuid}`);
        if (sumRes.status === 200 && sumRes.body) {
          const xml = sumRes.body;
          // BIZZ-2057: reelt BFE (BestemtFastEjendomNummer) — ALDRIG det
          // kommunale ESR-ejendomsnummer fra TL-søgesvaret.
          const bfe = parseBfeFromSummarisk(xml);
          if (bfe > 0) lej.bfe = bfe;
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
    await Promise.all(
      lejligheder.map(async (lej) => {
        if (!lej.bfe || lej.bfe === 0) return;
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

/**
 * BIZZ-2057 / BIZZ-2060: Autoritativ cache-first resolver for ejerlejligheder.
 *
 * Tinglysningens matrikelsøgning kollapser alle ejerlejligheder under én
 * hovedejendoms-UUID til ÉT BFE (ejdsummarisk returnerer kun ét
 * BestemtFastEjendomNummer pr. UUID). Det gav forkert individuel BFE og
 * forkert/"ukendt" ejer for hver enhed på multi-unit-matrikler (fx
 * Hammerholmen 44-48 hvor 18 enheder kollapsede til moderejendommens BFE).
 *
 * Denne resolver bygger den korrekte enhedsliste direkte fra eksisterende
 * cache-tabeller (ingen nye tabeller):
 *   1. DAWA /adgangsadresser → matriklens vejnavn+husnr-sæt
 *   2. bfe_adresse_cache → individuel BFE pr. (adresse, etage, dør)
 *   3. ejf_ejerskab (status='gældende') → ejer pr. BFE
 *   4. cvr_virksomhed → selskabsnavn for CVR-ejere
 *   5. MAT_Ejerlejlighed (Matriklen v2) → tinglyst areal + ejerlejlighedsnr
 *   6. ejerskifte_historik → seneste handel (pris + dato), med
 *      fetchTinglysningPriceRowsByBfe som fallback pr. BFE
 *
 * Falder igennem (returnerer []) når cachen ikke dækker matriklen, så
 * GET-handleren bruger den eksisterende TL/DAWA-flow uændret — ingen
 * regression for matrikler uden cache-dækning.
 *
 * @param ejerlavKode - Landsejerlav-kode (DAWA ejerlavkode)
 * @param matrikelnr - Matrikelnummer på ejerlavet
 * @param moderBfe - SFE/hovedejendoms-BFE der udelades fra enhedslisten
 * @returns Ejerlejlighed[] med korrekt individuel BFE + ejer, eller [] ved cache-miss
 */
async function resolveLejlighederViaBfeCache(
  ejerlavKode: string,
  matrikelnr: string,
  moderBfe?: number
): Promise<Ejerlejlighed[]> {
  const DAWA_BASE = 'https://dawa.aws.dk';

  // Trin 1: Matriklens adgangsadresser → sæt af "Vejnavn Husnr" + postnr.
  // Samme matrikel-scoping som den eksisterende DAWA-resolver, så vi kun
  // henter enheder der faktisk ligger på denne matrikel.
  const adgRes = await fetchDawa(
    `${DAWA_BASE}/adgangsadresser?ejerlavkode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}&per_side=100`,
    { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 } },
    { caller: 'ejerlejligheder.bfe-cache' }
  );
  if (!adgRes.ok) return [];
  const adgangsadresser = (await adgRes.json()) as Array<{
    id: string;
    adressebetegnelse: string;
  }>;
  if (adgangsadresser.length === 0) return [];

  // adressebetegnelse: "Hammerholmen 46A, 2650 Hvidovre" → adresse "Hammerholmen 46A"
  const adresseSet = new Set<string>();
  const postnrSet = new Set<string>();
  // BIZZ-2061: Adgangsadresse-id-sæt bruges til at frasortere SFE-cache-rækker.
  // SFE'ens bfe_adresse_cache-række (kilde 'cache_dar') har dawa_id = en
  // ADGANGSADRESSE-id, mens ejerlejligheds-rækker har enhedsadresse-ids.
  // Uden filteret lækkede SFE-BFE'en (fx 2160256) ind som "Ukendt"-enhed
  // når klienten ikke sender moderBfe (SFE-siden gør det ikke).
  const adgIdSet = new Set<string>();
  for (const adg of adgangsadresser) {
    if (adg.id) adgIdSet.add(adg.id);
    const street = adg.adressebetegnelse.split(',')[0].trim();
    if (street) adresseSet.add(street);
    const post = adg.adressebetegnelse.match(/(\d{4})/);
    if (post) postnrSet.add(post[1]);
  }
  if (adresseSet.size === 0) return [];

  const admin = createAdminClient();

  // Trin 2: bfe_adresse_cache → én række pr. individuel ejerlejlighed-BFE.
  // Adresse-sættet kommer fra denne matrikels DAWA-svar, så scoping er korrekt.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cacheQuery = (admin as any)
    .from('bfe_adresse_cache')
    .select('bfe_nummer, adresse, etage, doer, postnr, postnrnavn, dawa_id')
    .in('adresse', [...adresseSet]);
  if (postnrSet.size > 0) cacheQuery = cacheQuery.in('postnr', [...postnrSet]);
  const { data: cacheRows } = (await cacheQuery.limit(500)) as {
    data: Array<{
      bfe_nummer: number;
      adresse: string;
      etage: string | null;
      doer: string | null;
      postnr: string | null;
      postnrnavn: string | null;
      dawa_id: string | null;
    }> | null;
  };
  const units = (cacheRows ?? []).filter(
    (r) =>
      r.bfe_nummer > 0 &&
      // BIZZ-2061: SFE-rækken har en adgangsadresse-id som dawa_id — udelad
      !(r.dawa_id && adgIdSet.has(r.dawa_id)) &&
      // BIZZ-2061: moderBfe-rækken udelades KUN når den ikke har sin egen
      // enhedsadresse (dawa_id). Klienten sender bbrData.ejerlejlighedBfe som
      // moderBfe — på adgangsadresse-niveau kan det være en ÆGTE leaf-enhed
      // (fx Hammerholmen 44 → BFE 221045). Uden dette mistede enheden sin
      // egen række, BFE-match fejlede i UI'et og vejnavn-fallback viste en
      // søster-enheds data. SFE/moder-selvrækker fanges af adgIdSet-filteret.
      (moderBfe == null || r.bfe_nummer !== moderBfe || !!r.dawa_id)
  );
  if (units.length === 0) return [];

  // Trin 3: ejer pr. BFE fra ejf_ejerskab (gældende). Første ejer pr. BFE.
  const bfes = [...new Set(units.map((u) => u.bfe_nummer))];
  const ejerMap = new Map<number, { navn: string; type: string; cvr: string | null }>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejfRows } = (await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_navn, ejer_type, ejer_cvr')
      .in('bfe_nummer', bfes)
      .eq('status', 'gældende')
      .limit(1000)) as {
      data: Array<{
        bfe_nummer: number;
        ejer_navn: string | null;
        ejer_type: string | null;
        ejer_cvr: string | null;
      }> | null;
    };
    for (const row of ejfRows ?? []) {
      if (!ejerMap.has(row.bfe_nummer)) {
        ejerMap.set(row.bfe_nummer, {
          navn: row.ejer_navn ?? '',
          type: row.ejer_type ?? '',
          cvr: row.ejer_cvr ?? null,
        });
      }
    }
  } catch {
    /* ejer-opslag non-fatal — enheder returneres med 'Ukendt' */
  }

  // Trin 4: selskabsnavn for CVR-ejere (ejf_ejerskab.ejer_navn er typisk
  // "CVR 12345678" for selskaber — vi foretrækker det rigtige firmanavn).
  const cvrSet = [
    ...new Set([...ejerMap.values()].map((e) => e.cvr).filter((c): c is string => !!c)),
  ];
  const cvrNavnMap = new Map<string, string>();
  if (cvrSet.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: cvrRows } = (await (admin as any)
        .from('cvr_virksomhed')
        .select('cvr, navn')
        .in('cvr', cvrSet)
        .limit(1000)) as { data: Array<{ cvr: string; navn: string | null }> | null };
      for (const row of cvrRows ?? []) {
        if (row.navn) cvrNavnMap.set(row.cvr, row.navn);
      }
    } catch {
      /* CVR-navn non-fatal */
    }
  }

  // Trin 4b (BIZZ-2061, Resights-paritet): tinglyst areal pr. BFE fra
  // Matriklen. Erhvervs-ejerlejligheder findes typisk ikke i BBR_Enhed,
  // så MAT_Ejerlejlighed.samletAreal er den autoritative areal-kilde.
  // Ét batch-kald for alle BFE'er; non-fatal (areal forbliver null).
  let matMap = new Map<number, { areal: number | null; ejerlejlighedsnummer: string | null }>();
  try {
    matMap = await fetchMatEjerlejlighederByBfe(bfes);
  } catch {
    /* areal-berigelse non-fatal */
  }

  // Trin 5: byg Ejerlejlighed-liste med korrekt individuel BFE + ejer
  const lejligheder: Ejerlejlighed[] = units.map((u) => {
    const etage = u.etage && u.etage !== '' ? u.etage : null;
    const doer = u.doer && u.doer !== '' ? u.doer : null;
    const loc = [etage ? `${etage}.` : null, doer].filter(Boolean).join(' ');
    const postSuffix = u.postnr ? `, ${u.postnr}${u.postnrnavn ? ' ' + u.postnrnavn : ''}` : '';
    const adresse = `${u.adresse}${loc ? ', ' + loc : ''}${postSuffix}`;

    const ejerInfo = ejerMap.get(u.bfe_nummer);
    let ejer = 'Ukendt';
    let ejertype: 'person' | 'selskab' | 'ukendt' = 'ukendt';
    if (ejerInfo) {
      const isSelskab =
        ejerInfo.type === 'virksomhed' || ejerInfo.type === 'selskab' || !!ejerInfo.cvr;
      if (isSelskab) {
        ejer = (ejerInfo.cvr && cvrNavnMap.get(ejerInfo.cvr)) || ejerInfo.navn || 'Ukendt';
        ejertype = 'selskab';
      } else {
        ejer = ejerInfo.navn || 'Ukendt';
        ejertype = ejerInfo.navn ? 'person' : 'ukendt';
      }
    }

    const matInfo = matMap.get(u.bfe_nummer);
    return {
      bfe: u.bfe_nummer,
      adresse,
      etage,
      doer,
      beskrivelse: matInfo?.ejerlejlighedsnummer
        ? `Ejerlejlighed nr. ${matInfo.ejerlejlighedsnummer}`
        : 'Ejerlejlighed',
      ejer,
      ejertype,
      areal: matInfo?.areal ?? null,
      koebspris: null,
      koebsdato: null,
      dawaId: u.dawa_id ?? null,
      udfaset: null,
      bygningId: null,
      bygningBetegnelse: null,
    };
  });

  // Trin 6 (BIZZ-2061, Resights-paritet): seneste handel pr. BFE.
  // Primær kilde er ejerskifte_historik (ét batch-opslag) — den bærer den
  // reelle SkoedeOvertagelsesDato + KontantKoebesum/IAltKoebesum fra adkomst-
  // dokumentet. ejendomshandel-tabellen (som fetchTinglysningPriceRowsByBfe
  // tjekker først) har for flere backfillede BFE'er tinglysningsdato som
  // 'dato' og en afvigende sum (fx 221037: 973.000/1988-05-03 mod adkomstens
  // 784.128/1988-01-17) — derfor foretrækkes historik-rækken når den findes.
  // Dato-præference koebsaftale → overtagelse matcher branchekonvention.
  const handelMap = new Map<number, { pris: number | null; dato: string | null }>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: histRows } = (await (admin as any)
      .from('ejerskifte_historik')
      .select('bfe_nummer, overtagelsesdato, koebsaftale_dato, kontant_koebesum, i_alt_koebesum')
      .in('bfe_nummer', bfes)
      .order('overtagelsesdato', { ascending: false, nullsFirst: false })
      .limit(1000)) as {
      data: Array<{
        bfe_nummer: number;
        overtagelsesdato: string | null;
        koebsaftale_dato: string | null;
        kontant_koebesum: number | null;
        i_alt_koebesum: number | null;
      }> | null;
    };
    for (const row of histRows ?? []) {
      // Rækker er sorteret nyeste-først — første række pr. BFE er seneste handel
      if (handelMap.has(row.bfe_nummer)) continue;
      const pris = row.kontant_koebesum ?? row.i_alt_koebesum ?? null;
      const dato = row.koebsaftale_dato ?? row.overtagelsesdato ?? null;
      if (pris == null && dato == null) continue;
      handelMap.set(row.bfe_nummer, { pris, dato });
    }
  } catch {
    /* historik-opslag non-fatal — fallback dækker */
  }

  // Fallback pr. enhed uden historik-række: eksisterende cache-first kæde
  // (ejendomshandel → live e-TL). Non-fatal pr. enhed.
  await Promise.all(
    lejligheder.map(async (lej) => {
      const handel = handelMap.get(lej.bfe);
      if (handel) {
        lej.koebspris = handel.pris;
        lej.koebsdato = handel.dato;
        return;
      }
      try {
        const priceRows = await fetchTinglysningPriceRowsByBfe(lej.bfe);
        if (priceRows.length > 0) {
          const latest = priceRows[0];
          lej.koebspris = latest.kontantKoebesum ?? latest.iAltKoebesum ?? null;
          lej.koebsdato =
            latest.overtagelsesdato ?? latest.koebsaftaleDato ?? latest.tinglysningsdato ?? null;
        }
      } catch {
        /* pris-berigelse non-fatal */
      }
    })
  );

  // Sort: adresse → etage → dør (samme orden som de øvrige resolvere)
  lejligheder.sort((a, b) => {
    const addrA = a.adresse.split(',')[0].trim();
    const addrB = b.adresse.split(',')[0].trim();
    if (addrA !== addrB) return addrA.localeCompare(addrB, 'da');
    const etageA = parseEtageSortValue(a.etage);
    const etageB = parseEtageSortValue(b.etage);
    if (etageA !== etageB) return etageA - etageB;
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
    // ── Trin 0 (BIZZ-2057/2060): Autoritativ cache-first resolver ──
    // bfe_adresse_cache + ejf_ejerskab(gældende) + cvr_virksomhed giver den
    // korrekte individuelle BFE + ejer pr. enhed. TL-matrikelsøgningen
    // kollapser multi-unit-hovedejendomme til ét BFE → forkert ejer. Når
    // cachen dækker matriklen bruger vi den; ellers falder vi igennem til
    // den eksisterende TL/DAWA-flow uændret (ingen regression).
    try {
      const cacheLejligheder = await resolveLejlighederViaBfeCache(
        ejerlavKode,
        matrikelnr,
        moderBfe
      );
      if (cacheLejligheder.length > 0) {
        logger.log(
          `[ejerlejligheder] BFE-cache resolver: ${cacheLejligheder.length} lejligheder for ejerlav ${ejerlavKode} matr. ${matrikelnr}`
        );
        const filtered = includeUdfasede
          ? cacheLejligheder
          : cacheLejligheder.filter((l) => l.udfaset !== true);
        return NextResponse.json(
          { lejligheder: filtered, fejl: null },
          {
            status: 200,
            headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
          }
        );
      }
    } catch (cacheErr) {
      logger.warn(
        '[ejerlejligheder] BFE-cache resolver fejlede (non-fatal, falder tilbage til TL):',
        cacheErr instanceof Error ? cacheErr.message : cacheErr
      );
    }

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

    // ── Trin 1b: Resolve reelle BFE-numre (BIZZ-2057) ──
    // TL-søgesvaret indeholder kun det kommunale ESR-ejendomsnummer. Tidligere
    // blev ESR fejltolket som BFE, så lejligheder fik forkert BFE → forkerte
    // links, forkert/tom ejer (EJF-opslag ramte SFE-BFE) og forkert vurdering.
    // Vi slår det reelle BFE op pr. uuid via ejdsummarisk for ALLE lejligheder.
    const bfeByUuid = await fetchBfeBatch(lejlighedItems.map((it) => it.uuid));

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
      const bfes = lejlighedItems.map((it) => bfeByUuid.get(it.uuid) ?? 0).filter((b) => b > 0);
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
    const MAX_TL_ENRICH = 15;
    const itemsToEnrich = lejlighedItems.slice(0, MAX_TL_ENRICH);

    for (let i = 0; i < itemsToEnrich.length; i += CONCURRENCY) {
      const batch = itemsToEnrich.slice(i, i + CONCURRENCY);
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
              // BIZZ-2087: Validér DAR-id'et mod DAWA før det bruges til
              // navigation — ejendomssiden henter adressen fra DAWA, og et
              // henlagt DAR-record giver hård "Adresse ikke fundet"-fejlside.
              // Ved 404 falder vi videre til DAWA-søgningen nedenfor.
              try {
                const check = await fetchDawa(
                  `https://api.dataforsyningen.dk/adresser/${darId}`,
                  { signal: AbortSignal.timeout(5000) },
                  { caller: 'ejerlejligheder.adresser.validate' }
                );
                if (check.ok) {
                  dawaIdMap.set(item.uuid, darId);
                  return;
                }
                logger.warn(
                  `[ejerlejligheder] DAR-id ${darId} findes ikke i DAWA — falder tilbage til DAWA-søgning`
                );
              } catch {
                // DAWA nede → stol på DAR-id'et frem for at miste navigation
                dawaIdMap.set(item.uuid, darId);
                return;
              }
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
        // BIZZ-2057: reelt BFE fra ejdsummarisk — ALDRIG det kommunale ESR-nummer.
        const bfe = bfeByUuid.get(item.uuid) ?? 0;
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
