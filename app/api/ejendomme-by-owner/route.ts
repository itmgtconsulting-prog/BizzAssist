/**
 * GET /api/ejendomme-by-owner
 *
 * Finder alle ejendomme ejet af virksomheder (CVR) eller personer (enhedsNummer).
 * Bruges til at vise ejendomsportefølje på virksomheds-, person- og ejersider.
 *
 * Flow:
 *   1a. For hvert CVR: forespørg EJFCustom_EjerskabBegraenset via FlexibleCurrent med ejendeVirksomhedCVRNr filter
 *   1b. For hvert enhedsNummer: forespørg EJFCustom_EjerskabBegraenset via FlexibleCurrent med ejendePersonEnhedsNummer filter
 *   2. For hvert unikt BFE: hent adressedata via DAWA /bfe/{bfe} endpoint
 *   3. Returner beriget liste med adresse, ejendomstype og DAWA-id til detaljeside-link
 *
 * Autentificering: OAuth Shared Secret (primær) + mTLS Certifikat (fallback).
 *
 * BIZZ-264: Added enhedsNummer parameter for direct person-owned properties.
 *
 * @param cvr - Kommasepareret liste af CVR-numre (maks. 30) — optional if enhedsNummer provided
 * @param enhedsNummer - Kommasepareret liste af person enhedsNummer (maks. 10) — optional if cvr provided
 * @returns { ejendomme: EjendomSummary[], totalBfe: number, manglerNoegle: boolean, manglerAdgang: boolean, fejl: string | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery as _parseQuery } from '@/app/lib/validate';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  EJF_GQL_ENDPOINT,
  DATAFORDELER_TOKEN_URL,
  DAWA_BASE_URL,
} from '@/app/lib/serviceEndpoints';
import { fetchDawa } from '@/app/lib/dawa';

/** Zod schema for /api/ejendomme-by-owner query params */
const _querySchema = z.object({
  cvr: z.string().min(1),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

/** Forlæng Vercel serverless timeout (kræver Pro-plan) */
export const maxDuration = 60;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Opsummerede data for én ejendom i porteføljeoversigten */
export interface EjendomSummary {
  /** BFE-nummer (Bestemt Fast Ejendom) */
  bfeNummer: number;
  /** CVR-nummer på den virksomhed der ejer ejendommen */
  ownerCvr: string;
  /** Vejnavn + husnr (f.eks. "Nørre Voldgade 11") */
  adresse: string | null;
  /** Postnummer (f.eks. "1358") */
  postnr: string | null;
  /** Postdistrikt/by (f.eks. "København K") */
  by: string | null;
  /** Kommunenavn */
  kommune: string | null;
  /** Kommunekode (4 cifre, f.eks. "0101") — til vurderingsopslag */
  kommuneKode: string | null;
  /** Ejendomstype fra DAWA (f.eks. "Normal ejendom", "Ejerlejlighed") */
  ejendomstype: string | null;
  /** DAWA adgangsadresse UUID — bruges til link til ejendomsdetaljeside */
  dawaId: string | null;
  /** Etage (f.eks. "1", "st") — kun for ejerlejligheder (BIZZ-551) */
  etage: string | null;
  /** Dør (f.eks. "tv", "th", "1") — kun for ejerlejligheder (BIZZ-551) */
  doer: string | null;
  /** Ejer-andel (faktisk ejerandel fra EJF, f.eks. "100%") */
  ejerandel?: string | null;
  /** BIZZ-1672: true hvis ejendommen administreres (ikke ejes) af denne CVR */
  administreret?: boolean;
  /** BIZZ-455: false hvis ejendommen er solgt (CVR ikke længere aktuel ejer) */
  aktiv?: boolean;
  /** BIZZ-455: Dato hvor CVR ophørte som ejer (ISO-dato) — kun for solgte */
  solgtDato?: string | null;
  /**
   * BIZZ-634: Dato hvor den queried CVR/person blev ejer (virkningFra fra
   * EJF). Bruges af enrich-batch til at udvælge ejer-specifik købs-handel
   * på historiske ejendomme (undgår at vise næste ejers købspris).
   */
  ownerBuyDate?: string | null;
  /** BIZZ-397: Progressive enrichment fields — populated client-side after initial load */
  /** Bygningsareal i m² fra BBR */
  areal?: number | null;
  /** Seneste ejendomsvurdering i DKK */
  vurdering?: number | null;
  /** Vurderingsår */
  vurderingsaar?: number | null;
  /** Ejer-navn (person eller virksomhedsnavn) */
  ejerNavn?: string | null;
  /** Købesum i DKK fra seneste handel */
  koebesum?: number | null;
  /** Overtagelsesdato fra seneste handel */
  koebsdato?: string | null;
  /** BIZZ-569: Bolig m² fra BBR (sum over bygninger) */
  boligAreal?: number | null;
  /** BIZZ-569: Erhverv m² fra BBR (sum over bygninger) */
  erhvervsAreal?: number | null;
  /** BIZZ-569: Matrikel m² fra DAWA jordstykker (registreret_areal) */
  matrikelAreal?: number | null;
}

/** API-svaret fra denne route */
export interface EjendommeByOwnerResponse {
  /** Liste af fundne ejendomme for den angivne side */
  ejendomme: EjendomSummary[];
  /** Det totale antal BFE-numre fundet */
  totalBfe: number;
  /** Offset der blev brugt i denne forespørgsel */
  offset: number;
  /** Limit der blev brugt i denne forespørgsel */
  limit: number;
  /** true hvis OAuth-nøgler mangler i miljøvariabler */
  manglerNoegle: boolean;
  /** true hvis Datafordeler returnerer 403 (Dataadgang-ansøgning mangler) */
  manglerAdgang: boolean;
  /** Fejlbesked eller null */
  fejl: string | null;
}

// ─── Konstanter ─────────────────────────────────────────────────────────────

/** Maks antal CVR-numre der accepteres per kald */
const MAX_CVR = 30;
/** Maks antal BFE-numre per batch (sikkerhedsloft) — BIZZ-982: hævet fra 50 til 200 */
const MAX_BATCH = 200;
/** Standard antal BFE-numre i første batch */
/** BIZZ-1167: Øget fra 5 til 10 for hurtigere initial load */
const DEFAULT_LIMIT = 10;
/** BIZZ-1167: Øget fra 10 til 20 samtidige DAWA BFE-opslag */
const DAWA_CONCURRENCY = 20;

// ─── OAuth token cache ───────────────────────────────────────────────────────

/** Delt token-cache (genbruges på tværs af requests i serverprocessen) */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler via client_credentials.
 * Cacher tokenet og fornyer automatisk 60 sek. inden udløb.
 *
 * @returns Bearer token som streng, eller null hvis credentials mangler
 */
async function _getOAuthToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(proxyUrl(DATAFORDELER_TOKEN_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...proxyHeaders() },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}`,
      signal: AbortSignal.timeout(proxyTimeout()),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token: string; expires_in: number };
    _cachedToken = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return _cachedToken.token;
  } catch {
    return null;
  }
}

// ─── Rå typer fra EJF GraphQL ────────────────────────────────────────────────

interface RawEjerskab {
  bestemtFastEjendomBFENr: number | null;
  ejendeVirksomhedCVRNr: number | null;
  virkningFra: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
}

interface GqlResult<T> {
  data?: Record<string, { nodes?: T[] }>;
  errors?: { message: string; extensions?: { code?: string } }[];
}

// ─── EJF GraphQL hjælpefunktion ──────────────────────────────────────────────

/**
 * Sender EJF GraphQL forespørgsel for ét CVR-nummer og returnerer aktuelle BFE-numre.
 *
 * @param cvr - CVR-nummer (numerisk) at forespørge
 * @param token - OAuth Bearer token
 * @returns { bfeNumre: number[]; authError: boolean } eller null ved netværksfejl
 */
async function hentBfeByCvr(
  cvr: number,
  token: string
): Promise<{
  bfeNumre: number[];
  ejerandelByBfe: Map<number, string>;
  authError: boolean;
} | null> {
  const virkningstid = new Date().toISOString();

  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        ejendeVirksomhedCVRNr: { eq: ${cvr} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejendeVirksomhedCVRNr
        virkningFra
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
      // BIZZ-367: Revalidate frequently so a fixed auth credential is picked up within
      // minutes rather than the previous 3600s window. EJF ownership data changes slowly
      // so 300s is still cache-friendly for normal use.
      next: { revalidate: 300 },
    });

    if (res.status === 403) return { bfeNumre: [], ejerandelByBfe: new Map(), authError: true };
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<RawEjerskab>;

    const authError =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authError) return { bfeNumre: [], ejerandelByBfe: new Map(), authError: true };

    const nodes = json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
    const bfeNumre = nodes
      .map((n) => n.bestemtFastEjendomBFENr)
      .filter((b): b is number => b != null);

    // Build map of BFE → ejerandel string (e.g. "50%", "100%")
    const ejerandelByBfe = new Map<number, string>();
    for (const n of nodes) {
      if (n.bestemtFastEjendomBFENr == null) continue;
      const t = n.faktiskEjerandel_taeller;
      const nav = n.faktiskEjerandel_naevner;
      if (t != null && nav != null && nav > 0) {
        const pct = Math.round((t / nav) * 100);
        ejerandelByBfe.set(n.bestemtFastEjendomBFENr, `${pct}%`);
      }
    }

    return { bfeNumre, ejerandelByBfe, authError: false };
  } catch {
    return null;
  }
}

/**
 * Sender EJF GraphQL forespørgsel for ét person enhedsNummer og returnerer aktuelle BFE-numre.
 * BIZZ-264: Direkte personejede ejendomme via EJF.
 *
 * @param enhedsNummer - Person enhedsNummer at forespørge
 * @param token - OAuth Bearer token
 * @returns { bfeNumre: number[]; authError: boolean } eller null ved netværksfejl
 */
async function hentBfeByPerson(
  enhedsNummer: number,
  token: string
): Promise<{
  bfeNumre: number[];
  ejerandelByBfe: Map<number, string>;
  authError: boolean;
} | null> {
  const virkningstid = new Date().toISOString();

  // BIZZ-597 Fase 1: Hent ejerandel-brøk så person-query er symmetrisk med
  // CVR-query (tidligere returnerede person-pathen kun bfeNumre[] — det gav
  // forkert 100%-ejerskab på kort hvor personen kun ejer 50% fx Søbyvej 11).
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        ejendePersonEnhedsNummer: { eq: ${enhedsNummer} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        virkningFra
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
      // BIZZ-369: Same short revalidation as hentBfeByCvr — ensures a fixed EJF
      // credential is reflected within ~5 minutes rather than 1 hour.
      next: { revalidate: 300 },
    });

    if (res.status === 403) return { bfeNumre: [], ejerandelByBfe: new Map(), authError: true };
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<RawEjerskab>;

    const authError =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authError) return { bfeNumre: [], ejerandelByBfe: new Map(), authError: true };

    const nodes = json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
    const bfeNumre = nodes
      .map((n) => n.bestemtFastEjendomBFENr)
      .filter((b): b is number => b != null);

    // BIZZ-597 Fase 1: Byg map af BFE → ejerandel-streng ("50%", "100%").
    // Samme logik som hentBfeByCvr bruger, så downstream konsumenter kan
    // behandle person- og CVR-resultater identisk.
    const ejerandelByBfe = new Map<number, string>();
    for (const n of nodes) {
      if (n.bestemtFastEjendomBFENr == null) continue;
      const t = n.faktiskEjerandel_taeller;
      const nav = n.faktiskEjerandel_naevner;
      if (t != null && nav != null && nav > 0) {
        const pct = Math.round((t / nav) * 100);
        ejerandelByBfe.set(n.bestemtFastEjendomBFENr, `${pct}%`);
      }
    }

    return { bfeNumre, ejerandelByBfe, authError: false };
  } catch {
    return null;
  }
}

// ─── DAWA BFE adresse-opslag ─────────────────────────────────────────────────

interface DawaBfeAdresse {
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  kommune: string | null;
  kommuneKode: string | null;
  ejendomstype: string | null;
  dawaId: string | null;
  /** Etage (f.eks. "1", "st") — kun for ejerlejligheder */
  etage: string | null;
  /** Dør (f.eks. "tv", "th", "1") — kun for ejerlejligheder */
  doer: string | null;
}

/**
 * Internal implementation — fetches address and property type for a BFE number via DAWA.
 * Call hentDawaBfeData (the deduplicated wrapper) instead of this directly.
 *
 * @param bfe - BFE-nummer at slå op
 * @returns Adresseoplysninger og DAWA adgangsadresse-UUID
 */
async function _hentDawaBfeDataImpl(bfe: number): Promise<DawaBfeAdresse> {
  const empty: DawaBfeAdresse = {
    adresse: null,
    postnr: null,
    by: null,
    kommune: null,
    kommuneKode: null,
    ejendomstype: null,
    dawaId: null,
    etage: null,
    doer: null,
  };

  try {
    const res = await fetchDawa(
      `${DAWA_BASE_URL}/bfe/${bfe}`,
      { signal: AbortSignal.timeout(10000), next: { revalidate: 86400 } },
      { caller: 'ejendomme-by-owner.bfe' }
    );
    if (!res.ok) return empty;

    const json = (await res.json()) as {
      ejendomstype?: string;
      beliggenhedsadresse?: {
        id?: string;
        vejnavn?: string;
        husnr?: string;
        etage?: string;
        dør?: string;
        postnr?: string;
        postnrnavn?: string;
        kommunekode?: string;
        kommunenavn?: string;
      };
      jordstykker?: Array<{
        husnumre?: Array<{ id?: string }>;
        ejerlav?: { navn?: string };
        kommune?: { kode?: string; navn?: string };
      }>;
    };

    const bel = json.beliggenhedsadresse;
    if (bel) {
      const adresseStr = bel.vejnavn ? `${bel.vejnavn} ${bel.husnr ?? ''}`.trim() : null;
      /* Hent DAWA adgangsadresse UUID — enten direkte fra beliggenhedsadresse.id
         eller fra jordstykker[0].husnumre[0].id (fallback) */
      const dawaId = bel.id ?? json.jordstykker?.[0]?.husnumre?.[0]?.id ?? null;

      let etage = bel.etage ?? null;
      let doer = bel.dør ?? null;

      // BIZZ-1444: For ejerlejligheder uden etage/dør i beliggenhedsadresse —
      // hent via DAR enhedsadresser (DAWA /adgangsadresser/{id}/enhedsadresser)
      if (!etage && dawaId && json.ejendomstype === 'Ejerlejlighed') {
        try {
          const enhedRes = await fetchDawa(
            `${DAWA_BASE_URL}/adgangsadresser/${dawaId}/enhedsadresser`,
            { signal: AbortSignal.timeout(5000) },
            { caller: 'ejendomme-by-owner.enhedsadresse' }
          );
          if (enhedRes.ok) {
            const enheder = (await enhedRes.json()) as Array<{
              etage?: string;
              dør?: string;
            }>;
            if (enheder.length > 0) {
              etage = enheder[0].etage ?? null;
              doer = enheder[0].dør ?? null;
            }
          }
        } catch {
          /* non-critical */
        }
      }

      return {
        adresse: adresseStr,
        postnr: bel.postnr ?? null,
        by: bel.postnrnavn ?? null,
        kommune: bel.kommunenavn ?? null,
        kommuneKode: bel.kommunekode ?? null,
        ejendomstype: json.ejendomstype ?? null,
        dawaId: dawaId ?? null,
        etage,
        doer,
      };
    }

    /* Fallback: resolve address from jordstykker → husnumre → adgangsadresse.
     * Samlet ejendomme without beliggenhedsadresse often have jordstykker with
     * husnumre UUIDs that point to actual street addresses in DAWA. */
    const js = json.jordstykker?.[0];
    const husnumreId = js?.husnumre?.[0]?.id as string | undefined;

    if (husnumreId) {
      try {
        const addrRes = await fetchDawa(
          `${DAWA_BASE_URL}/adgangsadresser/${husnumreId}?struktur=mini`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'ejendomme-by-owner.adgangsadresser.husnumre' }
        );
        if (addrRes.ok) {
          const addr = (await addrRes.json()) as {
            id?: string;
            vejnavn?: string;
            husnr?: string;
            postnr?: string;
            postnrnavn?: string;
            kommunekode?: string;
            kommunenavn?: string;
          };
          if (addr.vejnavn) {
            return {
              adresse: `${addr.vejnavn} ${addr.husnr ?? ''}`.trim(),
              postnr: addr.postnr ?? null,
              by: addr.postnrnavn ?? null,
              kommune: addr.kommunenavn ?? null,
              kommuneKode: addr.kommunekode ?? null,
              ejendomstype: json.ejendomstype ?? null,
              dawaId: addr.id ?? husnumreId,
              etage: null,
              doer: null,
            };
          }
        }
      } catch {
        /* ignore — fallback to ejerlav below */
      }
    }

    /* Last resort: use ejerlav name (cadastral district) as address */
    if (js?.ejerlav?.navn) {
      return {
        adresse: js.ejerlav.navn,
        postnr: null,
        by: null,
        kommune: js.kommune?.navn ?? null,
        kommuneKode: js.kommune?.kode ?? null,
        ejendomstype: json.ejendomstype ?? null,
        dawaId: husnumreId ?? null,
        etage: null,
        doer: null,
      };
    }

    return { ...empty, ejendomstype: json.ejendomstype ?? null };
  } catch {
    return empty;
  }
}

// ─── BBR GraphQL BFE→address fallback ────────────────────────────────────────

/**
 * Resolves BFE→address via Vurderingsportalen Elasticsearch when DAWA fails.
 * VP is a public API that has address data for most Danish properties.
 * Requires browser-like User-Agent to pass CloudFront WAF.
 *
 * @param bfe - BFE-nummer
 * @returns Partial DawaBfeAdresse with address fields, or empty
 */
async function _hentVPAdresseForBfe(bfe: number): Promise<DawaBfeAdresse> {
  const empty: DawaBfeAdresse = {
    adresse: null,
    postnr: null,
    by: null,
    kommune: null,
    kommuneKode: null,
    ejendomstype: null,
    dawaId: null,
    etage: null,
    doer: null,
  };

  try {
    // Call VP directly (not via proxy) — VP works from Vercel with browser User-Agent.
    // The proxy server doesn't whitelist api-fs.vurderingsportalen.dk.
    const res = await fetch('https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        query: { term: { bfeNumbers: bfe } },
        size: 1,
        _source: [
          'address',
          'roadName',
          'houseNumber',
          'zipcode',
          'postDistrict',
          'adgangsAdresseID',
          // BIZZ-576: Tilføjet adresseID + floor + door så ejerlejligheder
          // kan vise korrekt etage/dør og linke til den specifikke
          // lejligheds-side (ikke moderejendommen).
          'adresseID',
          'floor',
          'door',
          'juridiskKategori',
          'municipalityNumber',
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return empty;

    const data = (await res.json()) as {
      hits?: {
        hits?: Array<{
          _source?: {
            address?: string;
            roadName?: string;
            houseNumber?: string;
            zipcode?: string;
            postDistrict?: string;
            adgangsAdresseID?: string;
            adresseID?: string;
            floor?: string;
            door?: string;
            juridiskKategori?: string;
            municipalityNumber?: string;
          };
        }>;
      };
    };
    const src = data.hits?.hits?.[0]?._source;
    if (!src?.address) return empty;

    const adresse =
      src.roadName && src.houseNumber
        ? `${src.roadName} ${src.houseNumber}`.trim()
        : (src.address.split(',')[0]?.trim() ?? null);

    // BIZZ-578 v2: Vælg dawaId baseret på om det er en ejerlejlighed.
    //  - Ejerlejlighed (floor/door sat): brug adresseID (DAWA-adresse med
    //    etage/dør) så kortet linker til den specifikke lejligheds-side
    //    OG ejendomssidens BBR-fanen kan slå unit op via adresse-id.
    //  - Ikke-ejerlejlighed (floor/door tomme): brug adgangsAdresseID så
    //    BBR_Bygning(husnummer) kan matche bygnings-areal opslag.
    //    Adresse-id ville bryde BBR-areal-fetch fordi husnummer-feltet i
    //    BBR_Bygning kun matcher adgangsadresse-UUID.
    const erEjerlejlighed = !!(src.floor && src.floor.length > 0);
    let freshDawaId: string | null = null;

    if (erEjerlejlighed && src.adresseID) {
      try {
        const probeRes = await fetchDawa(
          `${DAWA_BASE_URL}/adresser/${src.adresseID}?struktur=mini`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'ejendomme-by-owner.vp-adresse-id' }
        );
        if (probeRes.ok) freshDawaId = src.adresseID;
      } catch {
        // Fall through
      }
    } else if (!erEjerlejlighed && src.adgangsAdresseID) {
      try {
        const probeRes = await fetchDawa(
          `${DAWA_BASE_URL}/adgangsadresser/${src.adgangsAdresseID}?struktur=mini`,
          { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
          { caller: 'ejendomme-by-owner.vp-adgangs-id' }
        );
        if (probeRes.ok) freshDawaId = src.adgangsAdresseID;
      } catch {
        // Fall through
      }
    }
    // BIZZ-576 v2: VP's UUIDs er ofte forældet og returnerer 404 mod current
    // DAWA. Fallback-search-strategy:
    //  - Ejerlejlighed (har floor): søg /adresser med etage+dør så vi rammer
    //    den SPECIFIKKE lejlighed (ikke moderejendommens adgangsadresse).
    //    Eksempel: Kaffevej 31 1.tv har lejlighed-ID a89e... og adgangs-ID
    //    7e66... — uden etage/dør-filter rammer vi adgangs-ID (moderen).
    //  - Ikke-ejerlejlighed: søg /adgangsadresser som før.
    if (!freshDawaId && src.roadName && src.houseNumber && src.zipcode) {
      try {
        if (erEjerlejlighed) {
          // Søg /adresser med etage + dør for at få den specifikke lejlighed
          const params = new URLSearchParams({
            vejnavn: src.roadName,
            husnr: src.houseNumber,
            postnr: src.zipcode,
            struktur: 'mini',
            per_side: '5',
          });
          if (src.floor) params.set('etage', src.floor);
          if (src.door) params.set('dør', src.door);
          const probeRes = await fetchDawa(
            `${DAWA_BASE_URL}/adresser?${params.toString()}`,
            { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
            { caller: 'ejendomme-by-owner.vp-adresse-search' }
          );
          if (probeRes.ok) {
            const arr = (await probeRes.json()) as Array<{
              id?: string;
              etage?: string;
              dør?: string;
            }>;
            // Foretræk eksakt match på etage+dør hvis flere hits
            const exact = arr.find(
              (a) =>
                (a.etage ?? '').toLowerCase() === (src.floor ?? '').toLowerCase() &&
                (a.dør ?? '').toLowerCase() === (src.door ?? '').toLowerCase()
            );
            freshDawaId = exact?.id ?? arr?.[0]?.id ?? null;
          }
        } else {
          // Ikke-ejerlejlighed: adgangsadresse-search som før
          const probeRes = await fetchDawa(
            `${DAWA_BASE_URL}/adgangsadresser?vejnavn=${encodeURIComponent(src.roadName)}&husnr=${encodeURIComponent(src.houseNumber)}&postnr=${encodeURIComponent(src.zipcode)}&struktur=mini&per_side=1`,
            { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
            { caller: 'ejendomme-by-owner.vp-fresh-dawa-id' }
          );
          if (probeRes.ok) {
            const arr = (await probeRes.json()) as Array<{ id?: string }>;
            freshDawaId = arr?.[0]?.id ?? null;
          }
        }
      } catch {
        // Lad freshDawaId være null
      }
    }

    return {
      adresse,
      postnr: src.zipcode ?? null,
      by: src.postDistrict ?? null,
      kommune: null,
      kommuneKode: src.municipalityNumber ? String(src.municipalityNumber).padStart(4, '0') : null,
      ejendomstype: src.juridiskKategori ?? null,
      // Kun behold dawaId hvis current DAWA kender den — ellers null så
      // UI falder tilbage til ikke-klikbart kort i stedet for brudt link.
      dawaId: freshDawaId,
      // BIZZ-576: Sæt etage/dør fra VP for ejerlejligheder så kortets
      // adresselinje viser fx "Kaffevej 31, 1. tv" i stedet for kun
      // "Kaffevej 31" (moderejendommens adresse).
      etage: src.floor && src.floor.length > 0 ? src.floor : null,
      doer: src.door && src.door.length > 0 ? src.door : null,
    };
  } catch {
    return empty;
  }
}

// ─── DAWA BFE deduplication ──────────────────────────────────────────────────

/**
 * Module-level map of in-flight DAWA BFE requests.
 * Prevents duplicate concurrent fetches for the same BFE number within a
 * single serverless instance — multiple concurrent route invocations requesting
 * the same BFE will share a single fetch promise.
 */
const _bfeFetchInFlight = new Map<number, Promise<DawaBfeAdresse>>();

/**
 * Deduplicated wrapper around _hentDawaBfeDataImpl.
 * If a fetch for the same BFE is already in flight, returns the existing promise
 * rather than issuing a duplicate HTTP request.
 *
 * @param bfe - BFE-nummer at slå op
 * @returns Adresseoplysninger og DAWA adgangsadresse-UUID
 */
async function hentDawaBfeData(bfe: number): Promise<DawaBfeAdresse> {
  const cached = _bfeFetchInFlight.get(bfe);
  if (cached) return cached;
  const promise = _hentDawaBfeDataImpl(bfe).then(async (result) => {
    // BIZZ-450: If DAWA returned no address, try BBR GraphQL as fallback.
    // DAWA /bfe/{bfe} endpoint is being deprecated; BBR is the authoritative source.
    if (!result.adresse) {
      const vpResult = await _hentVPAdresseForBfe(bfe);
      if (vpResult.adresse) return { ...result, ...vpResult };
    }
    // Fallback 3: bbr_ejendom_status cache → DAWA adgangsadresse resolve.
    // Catches BFE'er where both DAWA /bfe and VP return nothing but we have
    // a cached adgangsadresse_id from prior BBR enrichment (46k+ rows).
    if (!result.adresse) {
      try {
        const admin = createAdminClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: row } = await (admin as any)
          .from('bbr_ejendom_status')
          .select('adgangsadresse_id, kommune_kode')
          .eq('bfe_nummer', bfe)
          .maybeSingle();
        if (row?.adgangsadresse_id) {
          const addrRes = await fetchDawa(
            `${DAWA_BASE_URL}/adgangsadresser/${row.adgangsadresse_id}?struktur=mini`,
            { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
            { caller: 'ejendomme-by-owner.bbr-cache-fallback' }
          );
          if (addrRes.ok) {
            const addr = (await addrRes.json()) as {
              id?: string;
              vejnavn?: string;
              husnr?: string;
              postnr?: string;
              postnrnavn?: string;
              kommunekode?: string;
              kommunenavn?: string;
            };
            if (addr.vejnavn) {
              return {
                ...result,
                adresse: `${addr.vejnavn} ${addr.husnr ?? ''}`.trim(),
                postnr: addr.postnr ?? null,
                by: addr.postnrnavn ?? null,
                kommune: addr.kommunenavn ?? null,
                kommuneKode: addr.kommunekode ?? null,
                dawaId: addr.id ?? row.adgangsadresse_id,
              };
            }
          }
        }
      } catch {
        /* bbr cache fallback is non-critical */
      }
    }
    // BIZZ-1670: Fallback 4 — bfe_adresse_cache (manuelt/backfill-populeret)
    // Fanger BFE'er som DAWA /bfe, VP og bbr_ejendom_status ikke kender.
    if (!result.adresse) {
      try {
        const admin = createAdminClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: cached } = await (admin as any)
          .from('bfe_adresse_cache')
          .select(
            'adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype'
          )
          .eq('bfe_nummer', bfe)
          .maybeSingle();
        if (cached?.adresse) {
          return {
            adresse: cached.adresse,
            postnr: cached.postnr ?? null,
            by: cached.postnrnavn ?? null,
            kommune: cached.kommune ?? null,
            kommuneKode: cached.kommune_kode ?? null,
            ejendomstype: cached.ejendomstype ?? null,
            dawaId: cached.dawa_id ?? null,
            etage: cached.etage ?? null,
            doer: cached.doer ?? null,
          };
        }
      } catch {
        /* bfe_adresse_cache fallback non-critical */
      }
    }
    // BIZZ-1670: Write-through — gem succesfuld resolve i bfe_adresse_cache
    // så næste opslag er instant (fallback 1-3 kører ikke igen for denne BFE).
    if (result.adresse) {
      try {
        const admin = createAdminClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (admin as any).from('bfe_adresse_cache').upsert(
          {
            bfe_nummer: bfe,
            adresse: result.adresse,
            etage: result.etage ?? null,
            doer: result.doer ?? null,
            postnr: result.postnr ?? null,
            postnrnavn: result.by ?? null,
            kommune: result.kommune ?? null,
            kommune_kode: result.kommuneKode ?? null,
            dawa_id: result.dawaId ?? null,
            ejendomstype: result.ejendomstype ?? null,
            kilde: 'auto',
            sidst_opdateret: new Date().toISOString(),
          },
          { onConflict: 'bfe_nummer' }
        );
      } catch {
        /* write-through non-critical */
      }
    }
    return result;
  });
  _bfeFetchInFlight.set(bfe, promise);
  void promise.finally(() => _bfeFetchInFlight.delete(bfe));
  return promise;
}

// ─── Hjælpefunktion: kør med begrænset parallelisme ─────────────────────────

/**
 * Kører en asynkron funktion over et array med maks. `concurrency` samtidige kald.
 *
 * @param items - Input-array
 * @param concurrency - Maks. samtidige promises
 * @param fn - Async funktion der behandler hvert element
 * @returns Array af resultater i samme rækkefølge som input
 */
async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * GET /api/ejendomme-by-owner?cvr=12345678&offset=0&limit=5
 *
 * Returnerer én side af de aktuelt ejede ejendomme for de angivne CVR-numre.
 * Bruges til progressiv load: første kald henter de første `limit` ejendomme,
 * efterfølgende kald øger `offset` for at hente næste batch.
 *
 * @param request - Next.js request med ?cvr= kommasepareret liste, ?offset= og ?limit=
 * @returns EjendommeByOwnerResponse
 */
export async function GET(request: NextRequest): Promise<NextResponse<EjendommeByOwnerResponse>> {
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as EjendommeByOwnerResponse, {
      status: 401,
    });
  const hasSharedSecret = !!(
    process.env.DATAFORDELER_OAUTH_CLIENT_ID && process.env.DATAFORDELER_OAUTH_CLIENT_SECRET
  );
  const hasCert = isCertAuthConfigured();

  const { searchParams } = request.nextUrl;

  /* Paginering: ?offset=0&limit=5 */
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(
    MAX_BATCH,
    Math.max(1, parseInt(searchParams.get('limit') ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT)
  );

  const cvrParam = searchParams.get('cvr') ?? '';
  const enhedsNummerParam = searchParams.get('enhedsNummer') ?? '';

  if (!cvrParam && !enhedsNummerParam) {
    return NextResponse.json(
      {
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'cvr eller enhedsNummer parameter er påkrævet',
      },
      { status: 400 }
    );
  }

  /* Parsér og validér CVR-numre */
  const rawCvrs = cvrParam
    ? cvrParam
        .split(',')
        .map((s) => s.trim().replace(/\D/g, ''))
        .filter((s) => s.length >= 7 && s.length <= 8)
    : [];

  const cvrNumre = [...new Set(rawCvrs.map((s) => parseInt(s, 10)))].slice(0, MAX_CVR);

  /* BIZZ-264: Parsér og validér person enhedsNummer */
  const rawEnheder = enhedsNummerParam
    ? enhedsNummerParam
        .split(',')
        .map((s) => s.trim().replace(/\D/g, ''))
        .filter((s) => s.length >= 1 && s.length <= 15)
    : [];

  const enhedsNumre = [...new Set(rawEnheder.map((s) => parseInt(s, 10)))].slice(0, 10);

  if (cvrNumre.length === 0 && enhedsNumre.length === 0) {
    return NextResponse.json(
      {
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'Ingen gyldige CVR-numre eller enhedsNumre angivet',
      },
      { status: 400 }
    );
  }

  // ── BIZZ-1014 / BIZZ-1588: Cache-first — tjek ejf_ejerskab tabel ──
  // CVR-lookups bruger ejer_cvr; person-lookups bruger ejer_enheds_nummer
  // (kolonnen er backfillet for 1.5M rækker — se reference_ejf_ingestion_hybrid).
  // Tidligere kommentar om manglende enhedsNummer-kolonne var forkert (BIZZ-1588).
  // BIZZ-1872 / BIZZ-1869: Øget fra 7 → 30 dage. Ejerskab ændres sjældent
  // og 7-dages threshold betød at gode cached data blev forkastet, hvorefter
  // live EJF GraphQL returnerede 0 for nogle CVR'er (Belvedere CVR 24301117
  // — 13 dage gammel cache med 16 BFEer blev kasseret, live returnerede 0).
  const EJF_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dage
  let cacheFullHit = false;
  const bfeTilCvr = new Map<number, string>();
  const bfeTilEjerandel = new Map<number, string>();
  const aktivByBfe = new Map<number, boolean>();
  const solgtDatoByBfe = new Map<number, string | null>();
  const ownerBuyDateByBfe = new Map<number, string | null>();

  // BIZZ-1623: Fjernet `&& enhedsNumre.length === 0` — CVR-cache skal køre
  // uanset om personen OGSÅ har enhedsNummer (personer med virksomheder).
  if (cvrNumre.length > 0) {
    try {
      const admin = createAdminClient();
      const cvrStrings = cvrNumre.map((c) => String(c));

      // Hent alle gældende ejerskaber for de forespurgte CVR-numre
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: cached, error: cacheErr } = await (admin as any)
        .from('ejf_ejerskab')
        .select(
          'bfe_nummer, ejer_cvr, ejerandel_taeller, ejerandel_naevner, virkning_fra, sidst_opdateret'
        )
        .in('ejer_cvr', cvrStrings)
        .eq('status', 'gældende')
        .limit(500);

      if (!cacheErr && cached && cached.length > 0) {
        const freshest = Math.max(
          ...cached.map((r: { sidst_opdateret: string | null }) =>
            r.sidst_opdateret ? new Date(r.sidst_opdateret).getTime() : 0
          )
        );
        const isFresh = Date.now() - freshest < EJF_STALE_MS;

        if (isFresh) {
          // Byg BFE-maps fra cache
          for (const row of cached as Array<{
            bfe_nummer: number;
            ejer_cvr: string | null;
            ejerandel_taeller: number | null;
            ejerandel_naevner: number | null;
            virkning_fra: string | null;
          }>) {
            const bfe = row.bfe_nummer;
            const cvr = row.ejer_cvr ?? '';
            if (!bfeTilCvr.has(bfe)) {
              bfeTilCvr.set(bfe, cvr.padStart(8, '0'));
            }
            // Ejerandel
            const t = row.ejerandel_taeller;
            const nav = row.ejerandel_naevner;
            if (t != null && nav != null && nav > 0 && !bfeTilEjerandel.has(bfe)) {
              bfeTilEjerandel.set(bfe, `${Math.round((t / nav) * 100)}%`);
            }
            // BIZZ-634: ownerBuyDate fra virkning_fra
            if (row.virkning_fra) {
              const existing = ownerBuyDateByBfe.get(bfe);
              if (!existing || row.virkning_fra > existing) {
                ownerBuyDateByBfe.set(bfe, row.virkning_fra);
              }
            }
          }

          // Verificér aktivt ejerskab fra cache: for hvert BFE, tjek om den
          // queried CVR stadig er den seneste ejer (baseret på alle gældende
          // ejerskaber for det BFE i ejf_ejerskab).
          const queriedCvrSet = new Set(cvrStrings);
          const bfeList = [...bfeTilCvr.keys()];
          for (const bfe of bfeList) {
            // Hent alle gældende ejere for dette BFE
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: allOwners } = await (admin as any)
              .from('ejf_ejerskab')
              .select('ejer_cvr, virkning_fra')
              .eq('bfe_nummer', bfe)
              .eq('status', 'gældende')
              .order('virkning_fra', { ascending: false })
              .limit(10);

            if (allOwners && allOwners.length > 0) {
              // Tjek om NOGEN gældende ejer matcher vores CVR-sæt — ikke kun
              // den nyeste. Ejerlejligheder har ofte flere samtidige gældende
              // ejere (virksomhed + ejerforening), og ejerforeningens nyere
              // virkning_fra skal ikke markere virksomhedens ejerskab som "solgt".
              const ownerRows = allOwners as Array<{
                ejer_cvr: string | null;
                virkning_fra: string | null;
              }>;
              const hasActiveOwnership = ownerRows.some(
                (o) => o.ejer_cvr && queriedCvrSet.has(o.ejer_cvr)
              );
              if (hasActiveOwnership) {
                aktivByBfe.set(bfe, true);
              } else {
                // Ejendommen er solgt — ingen af de gældende ejere matcher vores CVR
                aktivByBfe.set(bfe, false);
                solgtDatoByBfe.set(bfe, ownerRows[0]?.virkning_fra ?? null);
              }
            } else {
              aktivByBfe.set(bfe, true);
            }
          }

          cacheFullHit = true;
          logger.log(
            `[ejendomme-by-owner] Cache hit: ${bfeTilCvr.size} BFE for ${cvrNumre.length} CVR`
          );
        }
      }
    } catch (err) {
      logger.warn(
        '[ejendomme-by-owner] Cache lookup fejl (falder til live):',
        err instanceof Error ? err.message : err
      );
    }
  }

  // ── BIZZ-1588: Cache-first for person-lookups via ejer_enheds_nummer ──
  // Primær path: direkte match på ejer_enheds_nummer kolonnen i ejf_ejerskab.
  // Mere pålideligt end navnematch (håndterer navneskift, dubletter, mellemnavne).
  // BIZZ-1623: Fjernet `&& cvrNumre.length === 0` — person-cache skal køre
  // uanset om personen OGSÅ har CVR-virksomheder. Paths er additive.
  if (!cacheFullHit && enhedsNumre.length > 0) {
    try {
      const admin = createAdminClient();
      const enhedsStrings = enhedsNumre.map((e) => String(e));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: cached, error: cacheErr } = await (admin as any)
        .from('ejf_ejerskab')
        .select(
          'bfe_nummer, ejer_enheds_nummer, ejer_navn, ejerandel_taeller, ejerandel_naevner, virkning_fra, sidst_opdateret'
        )
        .in('ejer_enheds_nummer', enhedsStrings)
        .eq('status', 'gældende')
        .limit(500);

      if (!cacheErr && cached && cached.length > 0) {
        // BIZZ-1588: Personer skifter sjældent ejerskab — brug 90-dages threshold
        // i stedet for default 7. Live EJF kan ikke lookup person-ejere uden CPR,
        // så alternativet til stale cache er tom liste.
        const PERSON_STALE_MS = 90 * 24 * 60 * 60 * 1000;
        const freshest = Math.max(
          ...cached.map((r: { sidst_opdateret: string | null }) =>
            r.sidst_opdateret ? new Date(r.sidst_opdateret).getTime() : 0
          )
        );
        if (Date.now() - freshest < PERSON_STALE_MS) {
          for (const row of cached as Array<{
            bfe_nummer: number;
            ejer_enheds_nummer: string | null;
            ejer_navn: string;
            ejerandel_taeller: number | null;
            ejerandel_naevner: number | null;
            virkning_fra: string | null;
          }>) {
            const bfe = row.bfe_nummer;
            bfeTilCvr.set(bfe, `person-${row.ejer_enheds_nummer ?? enhedsNumre[0]}`);
            if (
              row.ejerandel_taeller != null &&
              row.ejerandel_naevner != null &&
              row.ejerandel_naevner > 0
            ) {
              bfeTilEjerandel.set(
                bfe,
                `${Math.round((row.ejerandel_taeller / row.ejerandel_naevner) * 100)}%`
              );
            }
            ownerBuyDateByBfe.set(bfe, row.virkning_fra ?? null);
            aktivByBfe.set(bfe, true);
          }
          cacheFullHit = true;
          logger.log(
            `[ejendomme-by-owner] Person cache hit (enhedsNummer): ${bfeTilCvr.size} BFE for ${enhedsNumre.length} enhedsNumre`
          );
        }
      }
    } catch (err) {
      logger.warn(
        '[ejendomme-by-owner] Person cache lookup (enhedsNummer) fejl:',
        err instanceof Error ? err.message : err
      );
    }
  }

  // ── BIZZ-1158: Fallback cache-first for person-lookups via ejer_navn ──
  // Hvis enhedsNummer-match returnerede 0 (gamle rækker uden ejer_enheds_nummer),
  // prøv navnematch som fallback. Resolver personnavn fra cvr_deltager.
  // BIZZ-1623: Fjernet `&& cvrNumre.length === 0` — person fallback skal også
  // køre når personen har virksomheder (CVR + enhedsNummer sammen).
  if (!cacheFullHit && enhedsNumre.length > 0) {
    try {
      const admin = createAdminClient();
      // Hent personnavne for enhedsNumre
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: deltagerRows } = await (admin as any)
        .from('cvr_deltager')
        .select('enhedsnummer, navn')
        .in('enhedsnummer', enhedsNumre.map(Number));
      const personNavne = (deltagerRows ?? []).map((d: { navn: string }) => d.navn).filter(Boolean);

      if (personNavne.length > 0) {
        // Søg ejf_ejerskab for person-ejere med matchende navne
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: cached } = await (admin as any)
          .from('ejf_ejerskab')
          .select(
            'bfe_nummer, ejer_navn, ejerandel_taeller, ejerandel_naevner, virkning_fra, sidst_opdateret'
          )
          .eq('ejer_type', 'person')
          .eq('status', 'gældende')
          .in('ejer_navn', personNavne)
          .limit(200);

        if (cached && cached.length > 0) {
          const freshest = Math.max(
            ...cached.map((r: { sidst_opdateret: string | null }) =>
              r.sidst_opdateret ? new Date(r.sidst_opdateret).getTime() : 0
            )
          );
          if (Date.now() - freshest < EJF_STALE_MS) {
            for (const row of cached as Array<{
              bfe_nummer: number;
              ejer_navn: string;
              ejerandel_taeller: number | null;
              ejerandel_naevner: number | null;
              virkning_fra: string | null;
            }>) {
              const bfe = row.bfe_nummer;
              bfeTilCvr.set(bfe, `person-${enhedsNumre[0]}`);
              if (
                row.ejerandel_taeller != null &&
                row.ejerandel_naevner != null &&
                row.ejerandel_naevner > 0
              ) {
                bfeTilEjerandel.set(
                  bfe,
                  `${Math.round((row.ejerandel_taeller / row.ejerandel_naevner) * 100)}%`
                );
              }
              ownerBuyDateByBfe.set(bfe, row.virkning_fra ?? null);
              aktivByBfe.set(bfe, true);
            }
            cacheFullHit = true;
            logger.log(
              `[ejendomme-by-owner] Person cache hit (navn-fallback): ${bfeTilCvr.size} BFE for ${personNavne.length} navne`
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        '[ejendomme-by-owner] Person cache lookup (navn) fejl:',
        err instanceof Error ? err.message : err
      );
    }
  }

  // ── Fallback til live EJF hvis cache miss ──
  if (!cacheFullHit) {
    if (!hasSharedSecret && !hasCert) {
      return NextResponse.json({
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: true,
        manglerAdgang: false,
        fejl: null,
      });
    }

    /* Hent OAuth token */
    let token: string | null = null;

    if (hasSharedSecret) {
      token = await getSharedOAuthToken();
    }

    /* Fallback: mTLS certifikat */
    if (!token && hasCert) {
      token = await getCertOAuthToken();
    }

    if (!token) {
      return NextResponse.json({
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: 'Kunne ikke hente OAuth token',
      });
    }

    /* ── Trin 1: Find alle BFE-numre (CVR + person lookups parallelt) ── */
    const cvrSettled =
      cvrNumre.length > 0
        ? await Promise.allSettled(cvrNumre.map((cvr) => hentBfeByCvr(cvr, token!)))
        : [];

    // BIZZ-264: Person lookups via enhedsNummer
    const personSettled =
      enhedsNumre.length > 0
        ? await Promise.allSettled(enhedsNumre.map((en) => hentBfeByPerson(en, token!)))
        : [];

    const cvrResults = cvrSettled.map((settled, i) => {
      if (settled.status === 'rejected') {
        logger.error(
          `[ejendomme-by-owner] EJF CVR lookup failed for CVR ${cvrNumre[i]}:`,
          settled.reason
        );
        return null;
      }
      return settled.value;
    });

    const personResults = personSettled.map((settled, i) => {
      if (settled.status === 'rejected') {
        logger.error(
          `[ejendomme-by-owner] EJF person lookup failed for ${enhedsNumre[i]}:`,
          settled.reason
        );
        return null;
      }
      return settled.value;
    });

    /* Tjek om nogen returnerede auth-fejl */
    const harAuthFejl =
      cvrResults.some((r) => r?.authError === true) ||
      personResults.some((r) => r?.authError === true);
    if (harAuthFejl) {
      // BIZZ-1832: Hvis EJF returnerer 403 men vi har stale cache-data,
      // brug den i stedet for at returnere tomt. Stale data er bedre end
      // ingen data — brugeren ser ejendomme med lidt forældet info.
      if (bfeTilCvr.size > 0) {
        logger.log(
          `[ejendomme-by-owner] EJF 403 but stale cache has ${bfeTilCvr.size} BFE — using stale cache`
        );
        // Fortsæt til trin 2 med stale cache-data (skip EJF results)
      } else {
        return NextResponse.json({
          ejendomme: [],
          totalBfe: 0,
          offset,
          limit,
          manglerNoegle: false,
          manglerAdgang: true,
          fejl: null,
        });
      }
    }

    /* Saml unikke BFE-numre med tilhørende ejer-ID + ejer-andel */
    for (let i = 0; i < cvrNumre.length; i++) {
      const result = cvrResults[i];
      if (!result) continue;
      for (const bfe of result.bfeNumre) {
        if (!bfeTilCvr.has(bfe)) {
          bfeTilCvr.set(bfe, String(cvrNumre[i]).padStart(8, '0'));
        }
      }
      // Merge ejer-andel map (first owner wins when multiple CVRs queried)
      for (const [bfe, andel] of result.ejerandelByBfe) {
        if (!bfeTilEjerandel.has(bfe)) bfeTilEjerandel.set(bfe, andel);
      }
    }
    // BIZZ-264: Add person-owned BFEs (use enhedsNummer as ownerCvr placeholder)
    for (let i = 0; i < enhedsNumre.length; i++) {
      const result = personResults[i];
      if (!result) continue;
      for (const bfe of result.bfeNumre) {
        if (!bfeTilCvr.has(bfe)) {
          bfeTilCvr.set(bfe, `person-${enhedsNumre[i]}`);
        }
      }
      // BIZZ-597 Fase 1: Merge person-ejerandel (symmetrisk med CVR-pathen).
      // Tidligere blev person-ejendomme vist med hardcoded 100% i UI fordi
      // ejerandel ikke blev hentet her.
      for (const [bfe, andel] of result.ejerandelByBfe) {
        if (!bfeTilEjerandel.has(bfe)) bfeTilEjerandel.set(bfe, andel);
      }
    }

    /* ── Verificér aktivt ejerskab — markér solgte ejendomme ──
     * BIZZ-455: EJF flexibleCurrent returnerer historiske ejerskaber. For hvert BFE
     * tjekker vi om den seneste ejerpost stadig matcher CVR. Hvis en nyere post med
     * en anden ejer findes, markerer vi ejendommen som solgt (aktiv=false) men
     * beholder den i listen så UI'et kan vise fold-ud med tidligere ejendomme. */
    if (cvrNumre.length > 0) {
      const queriedCvrSet = new Set(cvrNumre);
      const bfeList = [...bfeTilCvr.keys()];
      const VERIFY_BATCH = 20;
      for (let i = 0; i < bfeList.length; i += VERIFY_BATCH) {
        const chunk = bfeList.slice(i, i + VERIFY_BATCH);
        await Promise.allSettled(
          chunk.map(async (bfe) => {
            const ownerCvr = bfeTilCvr.get(bfe);
            if (!ownerCvr || ownerCvr.startsWith('person-')) {
              aktivByBfe.set(bfe, true);
              return;
            }
            const cvrNum = parseInt(ownerCvr, 10);
            const vt = new Date().toISOString();
            const query = `{ EJFCustom_EjerskabBegraenset(first: 10, virkningstid: "${vt}", where: { bestemtFastEjendomBFENr: { eq: ${bfe} } }) { nodes { ejendeVirksomhedCVRNr virkningFra } } }`;
            const res = await fetch(proxyUrl(EJF_GQL_ENDPOINT), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...proxyHeaders(),
              },
              body: JSON.stringify({ query }),
              signal: AbortSignal.timeout(proxyTimeout()),
            });
            if (!res.ok) {
              aktivByBfe.set(bfe, true); // default to active on error
              return;
            }
            const data = (await res.json()) as GqlResult<{
              ejendeVirksomhedCVRNr: number | null;
              virkningFra: string | null;
            }>;
            const nodes = Object.values(data.data ?? {})[0]?.nodes ?? [];
            if (nodes.length === 0) {
              aktivByBfe.set(bfe, true);
              return;
            }
            const newestDate = Math.max(
              ...nodes.map((n) => new Date(n.virkningFra ?? 0).getTime())
            );
            // BIZZ-463: Among ALL nodes at newest date, pick one whose CVR was in
            // our queried list (= actual current owner for this concern). If the
            // current bfeTilCvr mapping points to a different (historical) owner,
            // reassign to the correct current owner.
            const newestNodes = nodes.filter(
              (n) => new Date(n.virkningFra ?? 0).getTime() === newestDate
            );
            const currentOwnerInList = newestNodes.find(
              (n) => n.ejendeVirksomhedCVRNr != null && queriedCvrSet.has(n.ejendeVirksomhedCVRNr)
            );
            if (currentOwnerInList?.ejendeVirksomhedCVRNr) {
              // Reassign bfeTilCvr to the actual current owner
              const actualCvr = currentOwnerInList.ejendeVirksomhedCVRNr;
              bfeTilCvr.set(bfe, String(actualCvr).padStart(8, '0'));
              aktivByBfe.set(bfe, true);
              // BIZZ-634: Gem ownerBuyDate for den aktuelle ejer (virkningFra
              // på det nyeste ejerskab hvor deres CVR optræder).
              const actualCvrDates = nodes
                .filter((n) => n.ejendeVirksomhedCVRNr === actualCvr)
                .map((n) => n.virkningFra)
                .filter((v): v is string => !!v)
                .sort();
              const latestBuy = actualCvrDates[actualCvrDates.length - 1] ?? null;
              if (latestBuy) ownerBuyDateByBfe.set(bfe, latestBuy);
            } else {
              // No queried CVR is the current owner → property was sold externally
              aktivByBfe.set(bfe, false);
              const ourLastDate = nodes
                .filter((n) => n.ejendeVirksomhedCVRNr === cvrNum)
                .map((n) => new Date(n.virkningFra ?? 0).getTime())
                .reduce((a, b) => Math.max(a, b), 0);
              const soldDate = nodes
                .filter((n) => new Date(n.virkningFra ?? 0).getTime() > ourLastDate)
                .map((n) => new Date(n.virkningFra ?? 0).getTime())
                .reduce((a, b) => Math.min(a || Infinity, b), Infinity);
              solgtDatoByBfe.set(
                bfe,
                soldDate && soldDate !== Infinity ? new Date(soldDate).toISOString() : null
              );
              // BIZZ-634: Ejerens købs-dato = virkningFra på deres seneste
              // aktive ejerskab FØR soldDate.
              if (ourLastDate > 0) {
                ownerBuyDateByBfe.set(bfe, new Date(ourLastDate).toISOString());
              }
            }
          })
        );
      }
    }
  } // end !cacheFullHit

  // BIZZ-1851: Pre-resolved adressedata for syntetiske BFEs (andelslejligheder + manglende cache)
  const dawaResolvedMap = new Map<
    number,
    {
      adresse: string;
      etage: string | null;
      doer: string | null;
      postnr: string;
      postnrnavn: string;
      kommune: string | null;
      kommuneKode: string | null;
      ejendomstype: string | null;
      dawaId: string | null;
    }
  >();

  // BIZZ-1672: Administrerede ejendomme fra ejf_administrator.
  // For ejerforeninger (og andre virksomheder) — tilføj BFE'er de administrerer.
  const administreretByBfe = new Set<number>();
  if (cvrNumre.length > 0) {
    try {
      const admin = createAdminClient();
      const cvrStrings = cvrNumre.map((c) => String(c));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: adminRows } = await (admin as any)
        .from('ejf_administrator')
        .select('bfe_nummer, virksomhed_cvr')
        .in('virksomhed_cvr', cvrStrings)
        .eq('status', 'gældende')
        .limit(200);

      if (adminRows && adminRows.length > 0) {
        let addedCount = 0;
        const sfeBfes: number[] = [];
        const cachedMatrikelAddrs = new Set<string>();
        for (const row of adminRows as Array<{
          bfe_nummer: number;
          virksomhed_cvr: string;
        }>) {
          administreretByBfe.add(row.bfe_nummer);
          sfeBfes.push(row.bfe_nummer);
          if (!bfeTilCvr.has(row.bfe_nummer)) {
            bfeTilCvr.set(row.bfe_nummer, row.virksomhed_cvr.padStart(8, '0'));
            aktivByBfe.set(row.bfe_nummer, true);
            addedCount++;
          }
        }

        // BIZZ-1851: Find ejerlejligheder under administrerede SFE'er
        // via DAWA matrikel-afgrænsning (matcher koncernWalk logik).
        // Gadenavn-søgning erstattet med matrikel for præcis scoping.
        try {
          for (const sfeBfe of sfeBfes.slice(0, 5)) {
            try {
              const jordRes = await fetch(
                `https://api.dataforsyningen.dk/jordstykker?bfenummer=${sfeBfe}&format=json`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (!jordRes.ok) continue;
              const jordstykker = (await jordRes.json()) as Array<{
                ejerlav?: { kode?: number };
                matrikelnr?: string;
              }>;
              const ejerlav = jordstykker[0]?.ejerlav?.kode;
              const matr = jordstykker[0]?.matrikelnr;
              if (!ejerlav || !matr) continue;

              // Hent alle adresser på matriklen — kun med etage (lejligheder)
              const adrRes = await fetch(
                `https://api.dataforsyningen.dk/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=500`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (!adrRes.ok) continue;
              const adresser = (await adrRes.json()) as Array<{
                vejnavn: string;
                husnr: string;
                etage: string | null;
                postnr: string;
              }>;

              const lejligheder = adresser.filter((a) => a.etage);
              const gadenavne = [...new Set(lejligheder.map((a) => a.vejnavn))];
              const postnr = lejligheder[0]?.postnr;
              if (!postnr || gadenavne.length === 0) continue;

              const ownerCvr = (
                adminRows as Array<{ bfe_nummer: number; virksomhed_cvr: string }>
              ).find((r) => r.bfe_nummer === sfeBfe)?.virksomhed_cvr;

              // Match mod bfe_adresse_cache med matrikel-verificering
              for (const gade of gadenavne.slice(0, 10)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { data: cacheRows } = await (admin as any)
                  .from('bfe_adresse_cache')
                  .select('bfe_nummer, adresse')
                  .ilike('adresse', `${gade}%`)
                  .eq('postnr', postnr)
                  .not('etage', 'is', null)
                  .limit(500);

                for (const row of (cacheRows ?? []) as Array<{
                  bfe_nummer: number;
                  adresse: string;
                }>) {
                  // Verificér at adressen er på denne matrikel
                  const matchesMatrikel = lejligheder.some((l) =>
                    row.adresse.startsWith(`${l.vejnavn} ${l.husnr}`)
                  );
                  if (!matchesMatrikel) continue;
                  cachedMatrikelAddrs.add(`${row.adresse}`);
                  if (bfeTilCvr.has(row.bfe_nummer)) continue;
                  administreretByBfe.add(row.bfe_nummer);
                  bfeTilCvr.set(row.bfe_nummer, (ownerCvr ?? '').padStart(8, '0'));
                  aktivByBfe.set(row.bfe_nummer, true);
                  addedCount++;
                }
              }

              // BIZZ-1860: Lejligheder på matriklen der IKKE er i cache
              // (f.eks. kælder-lejligheder uden BFE) — tilføj som syntetiske
              const postnrNavn = (adresser as Array<{ postnrnavn?: string }>)[0]?.postnrnavn ?? '';
              for (const l of lejligheder as Array<{
                vejnavn: string;
                husnr: string;
                etage: string | null;
                dør: string | null;
                postnr: string;
              }>) {
                const addr = `${l.vejnavn} ${l.husnr}`;
                if (cachedMatrikelAddrs.has(addr)) continue;
                const synBfe = -(Math.abs(sfeBfe) * 1000 + bfeTilCvr.size);
                if (bfeTilCvr.has(synBfe)) continue;
                administreretByBfe.add(synBfe);
                bfeTilCvr.set(synBfe, (ownerCvr ?? '').padStart(8, '0'));
                aktivByBfe.set(synBfe, true);
                dawaResolvedMap.set(synBfe, {
                  adresse: addr,
                  etage: l.etage ?? null,
                  doer: l.dør ?? null,
                  postnr: l.postnr,
                  postnrnavn: postnrNavn,
                  kommune: null,
                  kommuneKode: null,
                  ejendomstype: 'Ejerlejlighed',
                  dawaId: null,
                });
                addedCount++;
              }
            } catch {
              /* individual SFE expansion non-fatal */
            }
          }
        } catch {
          /* ejerlejlighed lookup non-fatal */
        }

        if (addedCount > 0) {
          logger.log(
            `[ejendomme-by-owner] ejf_administrator: ${addedCount} administrerede BFE tilføjet`
          );
        }
      }
    } catch {
      /* ejf_administrator lookup non-fatal */
    }
  }

  // BIZZ-1862: Tilføj historiske SFE-BFEs til bfeTilCvr FØR SFE-expansion
  // så matrikel-lookup kan finde lejligheder under dem.
  if (cvrNumre.length > 0) {
    try {
      const admin = createAdminClient();
      const cvrStrings = cvrNumre.map((c) => String(c));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: histEjf } = await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer, ejer_cvr')
        .in('ejer_cvr', cvrStrings)
        .eq('status', 'historisk')
        .limit(50);
      for (const row of (histEjf ?? []) as Array<{
        bfe_nummer: number;
        ejer_cvr: string;
      }>) {
        if (bfeTilCvr.has(row.bfe_nummer)) continue;
        bfeTilCvr.set(row.bfe_nummer, row.ejer_cvr.padStart(8, '0'));
        aktivByBfe.set(row.bfe_nummer, true);
      }
    } catch {
      /* historisk ejerskab pre-load non-fatal */
    }
  }

  // BIZZ-1851: SFE-expansion for ejf_ejerskab BFEs (andelsforeninger).
  // ejf_administrator kan være tom men foreningen ejer SFE-BFE'en via ejerskab.
  // Kør matrikel-baseret expansion for BFEs uden etage i cache.
  if (cvrNumre.length > 0) {
    try {
      const admin = createAdminClient();
      const allCurrentBfes = [...bfeTilCvr.keys()];
      if (allCurrentBfes.length > 0 && allCurrentBfes.length <= 20) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: etageCheck } = await (admin as any)
          .from('bfe_adresse_cache')
          .select('bfe_nummer, etage')
          .in('bfe_nummer', allCurrentBfes);

        const bfesWithEtage = new Set(
          ((etageCheck ?? []) as Array<{ bfe_nummer: number; etage: string | null }>)
            .filter((r) => r.etage)
            .map((r) => r.bfe_nummer)
        );
        // BFEs without etage or not in cache → potential SFEs to expand
        const potentialSfes = allCurrentBfes.filter((b) => !bfesWithEtage.has(b));

        if (potentialSfes.length > 0 && potentialSfes.length <= 20) {
          for (const sfeBfe of potentialSfes) {
            try {
              const jordRes = await fetch(
                `https://api.dataforsyningen.dk/jordstykker?bfenummer=${sfeBfe}&format=json`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (!jordRes.ok) continue;
              const jordstykker = (await jordRes.json()) as Array<{
                ejerlav?: { kode?: number };
                matrikelnr?: string;
              }>;
              const ejerlav = jordstykker[0]?.ejerlav?.kode;
              const matr = jordstykker[0]?.matrikelnr;
              if (!ejerlav || !matr) continue;

              const adrRes = await fetch(
                `https://api.dataforsyningen.dk/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=500`,
                { signal: AbortSignal.timeout(8000) }
              );
              if (!adrRes.ok) continue;
              const adresser = (await adrRes.json()) as Array<{
                vejnavn: string;
                husnr: string;
                etage: string | null;
                postnr: string;
              }>;

              const lejligheder = adresser.filter((a) => a.etage);
              if (lejligheder.length === 0) continue;

              const gadenavne = [...new Set(lejligheder.map((a) => a.vejnavn))];
              const postnr = lejligheder[0]?.postnr;
              if (!postnr) continue;

              const ownerCvr = bfeTilCvr.get(sfeBfe) ?? '';

              // Hent cached BFEs for matrikel-adresser
              const cachedOnMatrikel = new Set<string>();
              for (const gade of gadenavne.slice(0, 10)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { data: cacheRows } = await (admin as any)
                  .from('bfe_adresse_cache')
                  .select('bfe_nummer, adresse')
                  .ilike('adresse', `${gade}%`)
                  .eq('postnr', postnr)
                  .not('etage', 'is', null)
                  .limit(500);

                for (const row of (cacheRows ?? []) as Array<{
                  bfe_nummer: number;
                  adresse: string;
                }>) {
                  const matchesMatrikel = lejligheder.some((l) =>
                    row.adresse.startsWith(`${l.vejnavn} ${l.husnr}`)
                  );
                  if (!matchesMatrikel) continue;
                  cachedOnMatrikel.add(`${row.adresse}`);
                  if (bfeTilCvr.has(row.bfe_nummer)) continue;
                  administreretByBfe.add(row.bfe_nummer);
                  bfeTilCvr.set(row.bfe_nummer, ownerCvr);
                  aktivByBfe.set(row.bfe_nummer, true);
                }
              }

              // BIZZ-1851: Lejligheder IKKE i cache (typisk andelsboliger
              // uden individuelle BFE-numre) — tilføj direkte fra DAWA.
              // Bruges af koncernWalk med BFE=0, gør det samme her.
              const postnrNavn = await (async () => {
                try {
                  const adrFull = adresser as Array<{
                    vejnavn: string;
                    husnr: string;
                    etage: string | null;
                    dør: string | null;
                    postnr: string;
                    postnrnavn: string;
                  }>;
                  return adrFull[0]?.postnrnavn ?? '';
                } catch {
                  return '';
                }
              })();
              for (const l of lejligheder as Array<{
                vejnavn: string;
                husnr: string;
                etage: string | null;
                dør: string | null;
                postnr: string;
              }>) {
                const addr = `${l.vejnavn} ${l.husnr}`;
                if (cachedOnMatrikel.has(addr)) continue;
                // Brug negative syntetisk BFE for at undgå konflikter
                const syntheticBfe = -(Math.abs(sfeBfe) * 1000 + bfeTilCvr.size);
                if (bfeTilCvr.has(syntheticBfe)) continue;
                administreretByBfe.add(syntheticBfe);
                bfeTilCvr.set(syntheticBfe, ownerCvr);
                aktivByBfe.set(syntheticBfe, true);
                // Pre-populate adresse data for disse syntetiske BFEs
                dawaResolvedMap.set(syntheticBfe, {
                  adresse: addr,
                  etage: l.etage ?? null,
                  doer: l.dør ?? null,
                  postnr: l.postnr,
                  postnrnavn: postnrNavn,
                  kommune: null,
                  kommuneKode: null,
                  ejendomstype: 'Andelsbolig',
                  dawaId: null,
                });
              }
            } catch {
              /* individual SFE expansion non-fatal */
            }
          }
        }
      }
    } catch {
      /* ejf_ejerskab SFE expansion non-fatal */
    }
  }

  // BIZZ-1860: Fjern SFE/hovedejendom-BFEs når lejligheder er expanded.
  // Hvis vi tilføjede syntetiske (DAWA-resolved) eller cache-baserede
  // lejligheder, fjern den originale SFE-BFE der nu er dækket.
  if (dawaResolvedMap.size > 0) {
    // Vi har DAWA-expanded lejligheder — fjern BFEs uden etage
    for (const bfe of [...bfeTilCvr.keys()]) {
      if (bfe < 0) continue; // Syntetiske, behold
      if (dawaResolvedMap.has(bfe)) continue; // Allerede DAWA-resolved
      // Tjek om denne BFE har etage — hvis ikke, er det en SFE/hovedejendom
      const preResolved = dawaResolvedMap.get(bfe);
      if (preResolved?.etage) continue;
      // Ikke i dawaResolvedMap og ikke syntetisk → tjek cache
      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: etRow } = await (admin as any)
        .from('bfe_adresse_cache')
        .select('etage')
        .eq('bfe_nummer', bfe)
        .maybeSingle();
      if (!(etRow as { etage: string | null } | null)?.etage) {
        // Ingen etage → SFE/hovedejendom, fjern
        bfeTilCvr.delete(bfe);
        administreretByBfe.delete(bfe);
        aktivByBfe.delete(bfe);
      }
    }
  }

  try {
    const alleBfe = [...bfeTilCvr.keys()];
    const totalBfe = alleBfe.length;

    if (totalBfe === 0) {
      return NextResponse.json({
        ejendomme: [],
        totalBfe: 0,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: null,
      });
    }

    /* Sortér: aktive først, så solgte — for konsistent paginering */
    alleBfe.sort((a, b) => {
      const aktivA = aktivByBfe.get(a) ?? true;
      const aktivB = aktivByBfe.get(b) ?? true;
      if (aktivA !== aktivB) return aktivA ? -1 : 1;
      return a - b;
    });

    /* Afgræns batch baseret på offset + limit */
    const begransetBfe = alleBfe.slice(offset, offset + limit);

    /* ── Trin 2: Hent adressedata for hvert BFE (begrænset parallelisme) ── */
    // BIZZ-1851: Syntetiske BFEs (negative) har pre-resolved data fra DAWA
    const adresseData = await pMap(begransetBfe, DAWA_CONCURRENCY, async (bfe) => {
      const preResolved = dawaResolvedMap.get(bfe);
      if (preResolved) {
        return {
          adresse: preResolved.adresse,
          postnr: preResolved.postnr,
          by: preResolved.postnrnavn,
          kommune: preResolved.kommune,
          kommuneKode: preResolved.kommuneKode,
          ejendomstype: preResolved.ejendomstype,
          dawaId: preResolved.dawaId,
          etage: preResolved.etage,
          doer: preResolved.doer,
        };
      }
      return hentDawaBfeData(bfe);
    });

    /* ── Trin 3: Saml resultater ── */
    // BIZZ-1863: Administrerede ejendomme er altid aktive — historisk ejerskab
    // kan sætte aktiv=false men det skal ikke gælde for administrerede BFEs.
    const ejendomme: EjendomSummary[] = begransetBfe.map((bfe, idx) => {
      const isAdmin = administreretByBfe.has(bfe);
      return {
        bfeNummer: bfe < 0 ? 0 : bfe, // Syntetiske BFEs → 0 i output
        ownerCvr: bfeTilCvr.get(bfe) ?? '',
        ...adresseData[idx],
        ejerandel: bfeTilEjerandel.get(bfe) ?? null,
        administreret: isAdmin,
        aktiv: isAdmin ? true : (aktivByBfe.get(bfe) ?? true),
        solgtDato: isAdmin ? null : (solgtDatoByBfe.get(bfe) ?? null),
        ownerBuyDate: ownerBuyDateByBfe.get(bfe) ?? null,
      };
    });

    /* ── BIZZ-1834: SFE-expansion — DEAKTIVERET (BIZZ-1863) ──
       Erstattet af BIZZ-1851 matrikel-baseret expansion (kører FØR pagination).
       Den gamle gadenavn-baserede expansion var for bred og tilføjede
       lejligheder fra andre bygninger på samme gade (94 vs 54 for Carlsberg). */
    try {
      const _sfeDisabled = true;
      const sfeEjendomme = _sfeDisabled
        ? []
        : ejendomme.filter(
            (e) => e.adresse && !e.etage && e.ejendomstype !== 'Ejerlejlighed' && e.postnr
          );

      // BIZZ-1852: Time budget — stop SFE-expansion hvis vi har <10s tilbage
      // af maxDuration=60s. Bedre at returnere ufuldstændige data end 504.
      const requestStart = (request as unknown as { _startTime?: number })._startTime ?? Date.now();
      const SFE_EXPANSION_DEADLINE_MS = 45_000; // 45s budget før vi giver op

      if (sfeEjendomme.length > 0 && Date.now() - requestStart < SFE_EXPANSION_DEADLINE_MS) {
        const admin = createAdminClient();
        // BIZZ-1852: Parallelisér iteration over SFE'er i stedet for sekventiel
        // for at undgå 30s+ aggregat på store ejerforeninger.
        const sfeToExpand = sfeEjendomme.slice(0, 5);
        const sfeExpansionResults = await Promise.allSettled(
          sfeToExpand.map(async (sfe) => {
            // Ekstrahér gadenavn fra SFE-adressen (fjern husnr)
            const gadenavn = (sfe.adresse ?? '')
              .replace(/\s*\(.*?\)\s*/g, '')
              .replace(/\s+\d+[\w-]*.*$/, '')
              .trim();
            if (!gadenavn || !sfe.postnr) return null;

            // Strategy 1: Søg ejerlejligheder i bfe_adresse_cache (hurtigst)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: childRows } = await (admin as any)
              .from('bfe_adresse_cache')
              .select(
                'bfe_nummer, adresse, etage, doer, postnr, postnrnavn, kommune, kommune_kode, dawa_id, ejendomstype'
              )
              .ilike('adresse', `${gadenavn}%`)
              .eq('postnr', sfe.postnr)
              .not('etage', 'is', null)
              .limit(100);

            const childEjendomme = (childRows ?? []) as Array<{
              bfe_nummer: number;
              adresse: string;
              etage: string | null;
              doer: string | null;
              postnr: string | null;
              postnrnavn: string | null;
              kommune: string | null;
              kommune_kode: string | null;
              dawa_id: string | null;
              ejendomstype: string | null;
            }>;

            // Strategy 2: Hvis cache er tom, hent via DAWA jordstykke → adresser
            // Finder ejerlejligheder under SFE'en via matrikel-opslag
            if (childEjendomme.length === 0 && sfe.bfeNummer > 0) {
              try {
                // Find jordstykke for SFE BFE → ejerlavKode + matrikelnr
                const jordRes = await fetchDawa(
                  `${DAWA_BASE_URL}/jordstykker?bfenummer=${sfe.bfeNummer}&format=json`,
                  { signal: AbortSignal.timeout(5000) },
                  { caller: 'ejendomme-by-owner.sfe-jordstykke' }
                );
                if (jordRes.ok) {
                  const jordstykker = (await jordRes.json()) as Array<{
                    ejerlav?: { kode?: number };
                    matrikelnr?: string;
                  }>;
                  const ejerlav = jordstykker[0]?.ejerlav?.kode;
                  const matr = jordstykker[0]?.matrikelnr;

                  if (ejerlav && matr) {
                    // Hent alle adresser på matriklen — inkl. ejerlejligheder med etage
                    // Brug direkte fetch (ikke fetchDawa) for at undgå DAWA
                    // gateway HTML-redirect issues i Vercel serverless.
                    const adrRes = await fetch(
                      `https://api.dataforsyningen.dk/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=200`,
                      {
                        signal: AbortSignal.timeout(10000),
                        headers: { Accept: 'application/json' },
                      }
                    );
                    if (adrRes.ok) {
                      const contentType = adrRes.headers.get('content-type') ?? '';
                      if (!contentType.includes('json')) {
                        logger.warn(
                          `[ejendomme-by-owner] SFE DAWA adresser returned non-JSON: ${contentType}`
                        );
                      }
                      const adresser = (await adrRes.json()) as Array<{
                        id: string;
                        vejnavn: string;
                        husnr: string;
                        etage: string | null;
                        dør: string | null;
                        postnr: string;
                        postnrnavn: string;
                        kommunekode: string;
                        adgangsadresseid: string;
                      }>;
                      logger.log(
                        `[ejendomme-by-owner] SFE ${sfe.bfeNummer}: DAWA returned ${Array.isArray(adresser) ? adresser.length : 'non-array'} adresser for matrikel ${ejerlav}/${matr}. First: ${JSON.stringify(adresser?.[0] ?? null).slice(0, 120)}`
                      );
                      // Filtrer til adresser med etage (= ejerlejligheder)
                      const ejlAdresser = Array.isArray(adresser)
                        ? adresser.filter((a) => a.etage)
                        : [];
                      for (const a of ejlAdresser) {
                        childEjendomme.push({
                          bfe_nummer: 0, // Ukendt BFE — bruger dawaId til navigation
                          adresse: `${a.vejnavn} ${a.husnr}`,
                          etage: a.etage,
                          doer: a.dør,
                          postnr: a.postnr,
                          postnrnavn: a.postnrnavn,
                          kommune: null,
                          kommune_kode: a.kommunekode,
                          dawa_id: a.id,
                          ejendomstype: 'Ejerlejlighed',
                        });
                      }
                      if (ejlAdresser.length > 0) {
                        logger.log(
                          `[ejendomme-by-owner] SFE ${sfe.bfeNummer}: DAWA found ${ejlAdresser.length} ejerlejligheder via matrikel ${ejerlav}/${matr}`
                        );
                      }
                    }
                  }
                }
              } catch (err) {
                logger.warn(
                  '[ejendomme-by-owner] SFE DAWA fallback fejl:',
                  err instanceof Error ? err.message : err
                );
              }
            }

            return { sfe, childEjendomme };
          })
        );

        // Saml resultater fra parallel SFE-expansion og tilføj til ejendomme
        for (const r of sfeExpansionResults) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          const { sfe, childEjendomme } = r.value;
          for (const child of childEjendomme) {
            // Undgå duplikater
            if (ejendomme.some((e) => e.bfeNummer === child.bfe_nummer)) continue;
            ejendomme.push({
              bfeNummer: child.bfe_nummer,
              ownerCvr: sfe.ownerCvr,
              adresse: child.adresse,
              postnr: child.postnr,
              by: child.postnrnavn,
              kommune: child.kommune,
              kommuneKode: child.kommune_kode,
              ejendomstype: child.ejendomstype,
              dawaId: child.dawa_id,
              etage: child.etage,
              doer: child.doer,
              ejerandel: sfe.ejerandel,
              administreret: sfe.administreret,
              aktiv: sfe.aktiv,
              solgtDato: sfe.solgtDato,
              ownerBuyDate: sfe.ownerBuyDate,
            });
          }
        }
      } else if (sfeEjendomme.length > 0) {
        logger.warn(
          `[ejendomme-by-owner] SFE-expansion sprunget over pga. time budget (${sfeEjendomme.length} SFEer)`
        );
      }
    } catch (err) {
      logger.warn(
        '[ejendomme-by-owner] SFE-expansion fejl:',
        err instanceof Error ? err.message : err
      );
    }

    /* Sortér: adresser først, derefter BFE-numre */
    ejendomme.sort((a, b) => {
      if (a.adresse && !b.adresse) return -1;
      if (!a.adresse && b.adresse) return 1;
      if (a.adresse && b.adresse) return a.adresse.localeCompare(b.adresse, 'da');
      return a.bfeNummer - b.bfeNummer;
    });

    // BIZZ-521 follow-up: kortere cache når nogen adresser mangler, så
    // midlertidigt tomme VP-resultater ikke holder i 30 min på CDN'en.
    // Fuld cache kun når alle ejendomme har adresse — da er data stabile.
    const anyMissingAddress = ejendomme.some((e) => !e.adresse);
    // BIZZ-1014: Tilføj X-Cache-Hit header når data kom fra ejf_ejerskab cache
    const cacheHeader = anyMissingAddress
      ? 'public, s-maxage=60, stale-while-revalidate=30'
      : 'public, s-maxage=1800, stale-while-revalidate=300';

    const headers: Record<string, string> = { 'Cache-Control': cacheHeader };
    if (cacheFullHit) headers['X-Cache-Hit'] = 'true';

    return NextResponse.json(
      {
        ejendomme,
        totalBfe,
        offset,
        limit,
        manglerNoegle: false,
        manglerAdgang: false,
        fejl: null,
      },
      { headers }
    );
  } catch (err) {
    logger.error('[ejendomme-by-owner] Fejl:', err instanceof Error ? err.message : err);
    const body =
      process.env.NODE_ENV === 'development'
        ? {
            ejendomme: [],
            totalBfe: 0,
            offset,
            limit,
            manglerNoegle: false,
            manglerAdgang: false,
            fejl: 'Intern serverfejl',
            dev_detail: err instanceof Error ? err.message : 'Ukendt fejl',
          }
        : {
            ejendomme: [],
            totalBfe: 0,
            offset,
            limit,
            manglerNoegle: false,
            manglerAdgang: false,
            fejl: 'Intern serverfejl',
          };
    return NextResponse.json(body);
  }
}
