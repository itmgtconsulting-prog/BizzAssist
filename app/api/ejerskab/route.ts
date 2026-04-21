/**
 * GET /api/ejerskab
 *
 * Henter ejeroplysninger (Ejerfortegnelsen) fra Datafordeler FlexibleCurrent custom tjeneste.
 *
 * Endpoint: https://graphql.datafordeler.dk/flexibleCurrent/v1/
 * Query: EJFCustom_EjerskabBegraenset (custom tjeneste — ikke entitetsbaseret)
 * Kræver: Dataadgang-tilladelse til EJF Custom fra Geodatastyrelsen
 *
 * Flow:
 *   1. Hent OAuth Bearer token via client_credentials (BizzAssist-Dev2 Shared Secret)
 *   2. Forespørg EJFCustom_EjerskabBegraenset med virkningstid=nu og BFE-filter
 *   3. For virksomhedsejere returneres CVR-nummer
 *   4. For personejere returneres navn (ikke CPR) via ejendePersonBegraenset
 *
 * NB: Returnerer manglerAdgang: true hvis 403 fra Datafordeler (Dataadgang ikke godkendt endnu).
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns { ejere: EjerData[], fejl: string | null, manglerNoegle: boolean, manglerAdgang: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { logger } from '@/app/lib/logger';
import { hentCvrStatusBatch } from '@/app/lib/cvrStatus';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';

/** Zod schema for /api/ejerskab query parameters */
const ejerskabQuerySchema = z.object({
  bfeNummer: z.coerce.number().int().positive(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt ejer fra Ejerfortegnelsen */
export interface EjerData {
  /** CVR-nummer hvis selskabsejer — ellers null */
  cvr: string | null;
  /** Personnavn fra EJFCustom_EjerskabBegraenset — null hvis navnebeskyttet eller selskab */
  personNavn: string | null;
  /** Ejerandel som brøk: taeller/naevner (f.eks. 1/1 = 100%) */
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
  /** Ejerskab-type kode fra EJF */
  ejerforholdskode: string | null;
  /** "selskab" | "person" | "pvoplys" | "ukendt" — 'pvoplys' = parter uden CVR/CPR (dødsboer, udenlandske ejere, fonde) */
  ejertype: 'selskab' | 'person' | 'pvoplys' | 'ukendt';
  /** ISO 8601 dato for hvornår ejerskab trådte i kraft */
  virkningFra: string | null;
  /**
   * BIZZ-477: Virksomhedsnavn slået op i CVR ES (kun for selskabsejere).
   * Undgår at UI'en viser rå "CVR 12345678" som eneste identifikation.
   */
  virksomhedsnavn?: string | null;
  /**
   * BIZZ-482: EJF_PersonVirksomhedsoplys-felter — parter uden CVR/CPR
   * (dødsboer, udenlandske selskaber/personer, fonde, stiftelser, ejer-
   * foreninger, kommunale enheder). Kun udfyldt når ejertype='pvoplys'
   * og extended-queryen mod EJF lykkedes.
   */
  /** Persistent identifikator for parter uden CVR/CPR */
  fiktivtPVnummer?: string | null;
  /** Landekode (numerisk ISO 3166-1) for udenlandske ejere */
  landekode?: string | null;
  /**
   * Samlet udlandsadresse (adresselinje 1–10 fra EJF). Når dansk adresse
   * bruges adresseLokalId (koblet DAR-ID) i stedet, men det er ikke
   * eksponeret i dette svar endnu.
   */
  udlandsadresse?: string | null;
  /**
   * Navn på administrator der handler på vegne af ejeren (advokat,
   * bobestyrer m.fl.). Vises separat i UI'en under ejeren når sat.
   */
  administrator?: string | null;
}

/** API-svaret fra denne route */
export interface EjerskabResponse {
  bfeNummer: number | null;
  ejere: EjerData[];
  fejl: string | null;
  manglerNoegle: boolean;
  /** true hvis Datafordeler returnerer 403 — Dataadgang-ansøgning mangler */
  manglerAdgang: boolean;
}

// ─── Datafordeler EJF GraphQL ────────────────────────────────────────────────

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

/** OAuth token cache — deles med vurdering/route.ts i serverprocessen */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler.
 * Cacher tokenet i serverprocessen — fornyar automatisk 60 sek. inden udløb.
 *
 * @returns Bearer token som streng, eller null hvis auth-miljøvariabler mangler
 */
async function _getOAuthToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(proxyUrl(TOKEN_URL), {
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

/** Rå node fra EJFCustom_EjerskabBegraenset (FlexibleCurrent) */
interface RawEJFEjerskab {
  bestemtFastEjendomBFENr: number | null;
  ejendeVirksomhedCVRNr: number | null;
  /** EJF-specifik enhedsNummer for ejer — kan bruges til reverse lookup */
  ejendeEnhedsNummer: number | null;
  /** Person-data fra custom tjeneste — indeholder navn (ikke CPR) */
  ejendePersonBegraenset: { navn: { navn: string } | null } | null;
  ejerforholdskode: string | null;
  faktiskEjerandel_taeller: number | null;
  faktiskEjerandel_naevner: number | null;
  status: string | null;
  virkningFra: string | null;
  /**
   * BIZZ-482: EJF_PersonVirksomhedsoplys inline via oplysningerEjesAfEjerskab-
   * relationen. Optional fordi felterne først blev tilføjet extended-query'en
   * og kan mangle hvis Datafordeler-schemaet endnu ikke eksponerer dem.
   */
  oplysningerEjesAfEjerskab?: {
    fiktivtPVnummer?: string | null;
    navn?: string | null;
    landeKodeNumerisk?: string | null;
    adresselinje1?: string | null;
    adresselinje2?: string | null;
    adresselinje3?: string | null;
    adresselinje4?: string | null;
    adresselinje5?: string | null;
  } | null;
  /** Administrator (advokat/bobestyrer m.fl.) der handler på vegne af ejeren */
  ejerskabAdministreresAfPersonEllerVirksomhedsoplysninger?: {
    navn?: string | null;
  } | null;
}

// ─── Hjælpefunktioner ─────────────────────────────────────────────────────────

/**
 * Bestemmer ejertype ud fra ejerforholdskode-streng (f.eks. fra Datafordeler).
 * Bruges som fallback når CVR/CPR-felter ikke kan afgøre typen.
 *
 * @param kode - Ejerforholdskode fra Datafordeler (f.eks. "10", "20", "S", "P")
 * @returns "selskab" | "person" | "ukendt"
 */
export function parseEjertype(kode?: string): 'selskab' | 'person' | 'ukendt' {
  if (!kode) return 'ukendt';
  const k = kode.toUpperCase().trim();
  // Numeriske koder: 10–19 = person, 20–39 = selskab/virksomhed
  const num = parseInt(k, 10);
  if (!isNaN(num)) {
    if (num >= 10 && num < 20) return 'person';
    if (num >= 20 && num < 40) return 'selskab';
  }
  // Bogstavskoder
  if (k === 'S' || k === 'SELSKAB' || k === 'K') return 'selskab';
  if (k === 'P' || k === 'PERSON' || k === 'F') return 'person';
  return 'ukendt';
}

/**
 * Bestemmer ejertype fra en rå EJF_Ejerskab node.
 * Bruger CVR/CPR-tilstedeværelse som primær indikator,
 * oplysningerEjesAfEjerskab (PV-relationen) som næste, og
 * ejerforholdskode som sidste fallback.
 *
 * BIZZ-482: Nu med 'pvoplys'-case for dødsboer, udenlandske ejere, fonde m.m.
 *
 * @param raw - Rå EJF_Ejerskab node fra GraphQL
 * @returns "selskab" | "person" | "pvoplys" | "ukendt"
 */
function parseEjertypeFraNode(raw: RawEJFEjerskab): 'selskab' | 'person' | 'pvoplys' | 'ukendt' {
  if (raw.ejendeVirksomhedCVRNr != null) return 'selskab';
  if (raw.ejendePersonBegraenset != null) return 'person';
  if (raw.oplysningerEjesAfEjerskab?.fiktivtPVnummer) return 'pvoplys';
  return parseEjertype(raw.ejerforholdskode ?? undefined);
}

// ─── EJF GraphQL query helper ───────────────────────────────────────────────

type EJFQueryResult =
  | { ok: true; nodes: RawEJFEjerskab[] }
  | { ok: false; manglerAdgang: boolean; fejl: string | null };

/**
 * Sender EJF GraphQL forespørgsel med et givet Bearer token.
 *
 * @param bfeNummer - BFE-nummer at slå op
 * @param token - OAuth Bearer token
 * @returns Parsed result eller fejl-info
 */
async function queryEJF(bfeNummer: number, token: string): Promise<EJFQueryResult> {
  const virkningstid = new Date().toISOString();

  /**
   * BIZZ-482 (reverted 2026-04-19): Extended-queryen med
   * oplysningerEjesAfEjerskab + ejerskabAdministreresAf… fik hele EJF-
   * opslaget til at fejle i produktion (tom Ejerskab-tab). Fallbacken
   * ramte ikke — muligvis fordi Datafordeler returnerer partielle data
   * i stedet for errors-only. Roll back til basis-query til schemaet er
   * verificeret via Datafordeler support. EjerData-typen beholder
   * pvoplys-relaterede felter men de forbliver null.
   */
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 500
      virkningstid: "${virkningstid}"
      where: {
        bestemtFastEjendomBFENr: { eq: ${bfeNummer} }
      }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejendeVirksomhedCVRNr
        ejendePersonBegraenset { navn { navn } }
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        status
        virkningFra
      }
    }
  }`;

  const res = await fetch(proxyUrl(EJF_GQL_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...proxyHeaders(),
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(proxyTimeout()),
    next: { revalidate: 3600 },
  });

  if (res.status === 403) {
    return { ok: false, manglerAdgang: true, fejl: null };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(`[ejerskab] Datafordeler EJF HTTP ${res.status}: ${text.slice(0, 400)}`);
    return {
      ok: false,
      manglerAdgang: false,
      fejl: 'Ekstern API fejl',
    };
  }

  const json = (await res.json()) as {
    data?: { EJFCustom_EjerskabBegraenset?: { nodes: RawEJFEjerskab[] } };
    errors?: { message: string; extensions?: { code?: string } }[];
  };

  const authError = json.errors?.find((e) => e.extensions?.code === 'DAF-AUTH-0001');
  if (authError) {
    return { ok: false, manglerAdgang: true, fejl: null };
  }

  return { ok: true, nodes: json.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [] };
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<EjerskabResponse>> {
  const limited = await checkRateLimit(request, heavyRateLimit);
  if (limited) return limited as NextResponse<EjerskabResponse>;

  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json(
      {
        bfeNummer: null,
        ejere: [],
        fejl: 'Unauthorized',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 401 }
    );
  }

  const hasSharedSecret = !!(
    process.env.DATAFORDELER_OAUTH_CLIENT_ID && process.env.DATAFORDELER_OAUTH_CLIENT_SECRET
  );
  const hasCert = isCertAuthConfigured();

  if (!hasSharedSecret && !hasCert) {
    return NextResponse.json(
      { bfeNummer: null, ejere: [], fejl: null, manglerNoegle: true, manglerAdgang: false },
      { status: 200 }
    );
  }

  // Validate query params with Zod schema
  const parsed = parseQuery(request, ejerskabQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<EjerskabResponse>;

  const { bfeNummer } = parsed.data;

  // ── BIZZ-680: DB-first — query ejf_ejerskab (7.6M rows, <15ms) ──
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dbRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select(
        'ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra, status'
      )
      .eq('bfe_nummer', bfeNummer)
      .neq('status', 'historisk')
      .order('virkning_fra', { ascending: false });

    if (dbRows && dbRows.length > 0) {
      // Map DB rows to EjerData + enrich with CVR status
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raaEjere: EjerData[] = dbRows.map((row: any) => ({
        cvr: row.ejer_cvr ?? null,
        personNavn: row.ejer_type === 'person' ? row.ejer_navn : null,
        ejerandel_taeller: row.ejerandel_taeller,
        ejerandel_naevner: row.ejerandel_naevner,
        ejerforholdskode: null,
        ejertype:
          row.ejer_type === 'virksomhed'
            ? ('selskab' as const)
            : row.ejer_type === 'person'
              ? ('person' as const)
              : ('ukendt' as const),
        virkningFra: row.virkning_fra,
      }));

      const cvrIds = raaEjere
        .map((e) => e.cvr)
        .filter((c): c is string => !!c)
        .map((c) => parseInt(c, 10))
        .filter((n) => Number.isFinite(n));

      const statusMap = cvrIds.length > 0 ? await hentCvrStatusBatch(cvrIds) : new Map();

      const ejere: EjerData[] = raaEjere
        .filter((e) => {
          if (!e.cvr) return true;
          const status = statusMap.get(parseInt(e.cvr, 10));
          return !status?.isCeased;
        })
        .map((e) => {
          if (!e.cvr) return e;
          const status = statusMap.get(parseInt(e.cvr, 10));
          return { ...e, virksomhedsnavn: status?.navn ?? null };
        });

      return NextResponse.json(
        { bfeNummer, ejere, fejl: null, manglerNoegle: false, manglerAdgang: false },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
        }
      );
    }
  } catch (dbErr) {
    // DB-first er best-effort — fallback til Datafordeler
    logger.warn(
      '[ejerskab] DB-first fejlede, falder tilbage til Datafordeler:',
      dbErr instanceof Error ? dbErr.message : dbErr
    );
  }

  // ── Fallback: Datafordeler GraphQL (eksisterende flow) ──

  // ── Forsøg 1: OAuth Shared Secret ──
  let result: EJFQueryResult | null = null;

  if (hasSharedSecret) {
    const token = await getSharedOAuthToken();
    if (token) {
      try {
        result = await queryEJF(bfeNummer, token);
        if (result.ok) {
          logger.log('[ejerskab] Shared Secret: OK —', result.nodes.length, 'ejere');
        } else if (result.manglerAdgang) {
          logger.warn('[ejerskab] Shared Secret: 403/manglerAdgang — forsøger certifikat...');
        }
      } catch (err) {
        logger.error('[ejerskab] Shared Secret fejl:', err instanceof Error ? err.message : err);
        Sentry.captureException(err);
      }
    }
  }

  // ── Forsøg 2: OAuth Certifikat (mTLS) — hvis Shared Secret mangler adgang ──
  if ((!result || (!result.ok && result.manglerAdgang)) && hasCert) {
    logger.log('[ejerskab] Forsøger OAuth Certifikat (mTLS)...');
    const certToken = await getCertOAuthToken();
    if (certToken) {
      try {
        const certResult = await queryEJF(bfeNummer, certToken);
        if (certResult.ok) {
          logger.log('[ejerskab] Certifikat: OK —', certResult.nodes.length, 'ejere');
        } else {
          logger.warn(
            '[ejerskab] Certifikat:',
            certResult.manglerAdgang ? '403/manglerAdgang' : certResult.fejl
          );
        }
        result = certResult;
      } catch (err) {
        logger.error('[ejerskab] Certifikat fejl:', err instanceof Error ? err.message : err);
        Sentry.captureException(err);
      }
    } else {
      logger.error('[ejerskab] Certifikat: Kunne ikke hente OAuth token via mTLS');
    }
  }

  // ── Ingen token overhovedet ──
  if (!result) {
    return NextResponse.json(
      {
        bfeNummer,
        ejere: [],
        fejl: 'Hverken OAuth Shared Secret eller Certifikat kunne autentificere',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }

  // ── Fejl-result ──
  if (!result.ok) {
    return NextResponse.json(
      {
        bfeNummer,
        ejere: [],
        fejl: result.fejl,
        manglerNoegle: false,
        manglerAdgang: result.manglerAdgang,
      },
      { status: 200 }
    );
  }

  // ── Succes ──
  const nodes = result.nodes;

  if (!nodes.length) {
    return NextResponse.json(
      { bfeNummer, ejere: [], fejl: null, manglerNoegle: false, manglerAdgang: false },
      { status: 200 }
    );
  }

  // BIZZ-610: EJF returnerer både historiske og gældende ejerskaber for
  // samme BFE når et ejerskifte er sket (både sælger- og køber-posteringer
  // har samme virkningFra-dato). Udnytter EJF's eget status-felt —
  // 'gældende' = aktuel ejer, 'historisk' = tidligere. Vi beholder null
  // konservativt som aktuel, så partielle data ikke skjuler ejere.
  const gaeldendeNodes = nodes.filter((n) => !n.status || n.status.toLowerCase() !== 'historisk');

  const raaEjere: EjerData[] = gaeldendeNodes.map((n) => {
    const ejertype = parseEjertypeFraNode(n);
    const pv = n.oplysningerEjesAfEjerskab ?? null;
    // BIZZ-482: Saml udlandsadresse fra linje 1–5. Tomme linjer filtreres
    // væk så strengen ikke får uønskede kommaer/line-breaks.
    const adresseLinjer = pv
      ? [pv.adresselinje1, pv.adresselinje2, pv.adresselinje3, pv.adresselinje4, pv.adresselinje5]
          .map((l) => (typeof l === 'string' ? l.trim() : ''))
          .filter((l) => l.length > 0)
      : [];
    // For pvoplys-ejere bruger vi PV-navnet som personNavn så UI kan
    // rendere "Boet efter X" / "Udenlandsk selskab Y" uden specialtegn.
    const pvNavn = ejertype === 'pvoplys' ? (pv?.navn ?? null) : null;
    return {
      cvr: n.ejendeVirksomhedCVRNr != null ? String(n.ejendeVirksomhedCVRNr) : null,
      personNavn: n.ejendePersonBegraenset?.navn?.navn ?? pvNavn,
      ejerandel_taeller: n.faktiskEjerandel_taeller ?? null,
      ejerandel_naevner: n.faktiskEjerandel_naevner ?? null,
      ejerforholdskode: n.ejerforholdskode ?? null,
      ejertype,
      virkningFra: n.virkningFra ?? null,
      // BIZZ-482: PV-oplys felter — kun meningsfulde for ejertype='pvoplys'
      fiktivtPVnummer: pv?.fiktivtPVnummer ?? null,
      landekode: pv?.landeKodeNumerisk ?? null,
      udlandsadresse: adresseLinjer.length > 0 ? adresseLinjer.join(', ') : null,
      administrator: n.ejerskabAdministreresAfPersonEllerVirksomhedsoplysninger?.navn ?? null,
    };
  });

  // BIZZ-477: Filtrér ophørte selskabsejere og berig med virksomhedsnavn.
  // EJF registrerer ofte at et selskab "ejer" en ejendom længe efter
  // selskabet er ophørt (adkomst aldrig retinglyst). Disse noder skal
  // ikke fremstå som aktive ejere i UI'en — matcher /api/ejerskab/chain's
  // filter-adfærd og BIZZ-471's ejerstruktur-fix.
  const cvrIds = raaEjere
    .map((e) => e.cvr)
    .filter((c): c is string => !!c)
    .map((c) => parseInt(c, 10))
    .filter((n) => Number.isFinite(n));

  const statusMap = cvrIds.length > 0 ? await hentCvrStatusBatch(cvrIds) : new Map();

  const ejere: EjerData[] = raaEjere
    .filter((e) => {
      if (!e.cvr) return true; // person-ejere passerer altid
      const status = statusMap.get(parseInt(e.cvr, 10));
      return !status?.isCeased;
    })
    .map((e) => {
      if (!e.cvr) return e;
      const status = statusMap.get(parseInt(e.cvr, 10));
      return {
        ...e,
        virksomhedsnavn: status?.navn ?? null,
      };
    });

  return NextResponse.json(
    { bfeNummer, ejere, fejl: null, manglerNoegle: false, manglerAdgang: false },
    {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    }
  );
}
