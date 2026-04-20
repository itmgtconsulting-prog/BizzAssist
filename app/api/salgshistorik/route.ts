/**
 * GET /api/salgshistorik
 *
 * Henter historiske salgsoplysninger fra Datafordeler FlexibleCurrent custom tjeneste.
 * Bruger samme OAuth-flow som /api/ejerskab.
 *
 * Endpoint: https://graphql.datafordeler.dk/flexibleCurrent/v1/
 *
 * Trin 1: EJF_Ejerskifte  → filtrér på bestemtFastEjendomBFENr → hent handelsoplysningerLokalId
 * Trin 2: EJF_Handelsoplysninger → filtrér på id_lokalId ∈ [ids] → hent prisdata
 * NB: Ejerskifte/Handelsoplysninger kan kræve custom query-navne — testes efter deploy.
 *
 * @param request - Next.js request med ?bfeNummer=xxx
 * @returns { handler: HandelData[], fejl, manglerNoegle, manglerAdgang }
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import {
  EJF_GQL_ENDPOINT,
  EJF_GQL_HISTORISK_ENDPOINT,
  DATAFORDELER_TOKEN_URL,
} from '@/app/lib/serviceEndpoints';
import { LruCache } from '@/app/lib/lruCache';

// BIZZ-633: LRU-cache for salgshistorik-svar. Samme BFE slås op mange
// gange i samme session (økonomi-tab, ejendoms-kort, diagram-berigelse).
// Uden cache fyrer hver visning to EJF-GraphQL-kald (ejerskifte + handels-
// oplysninger) med ~800ms samlet latency. Cache holder 150 entries i
// 1 time — handelsdata ændrer sig sjældent på den skala.
const salgshistorikCache = new LruCache<number, SalgshistorikResponse>({
  maxSize: 150,
  ttlMs: 3_600_000,
});

/** Zod schema for /api/salgshistorik query parameters */
const salgshistorikQuerySchema = z.object({
  bfeNummer: z.coerce.number().int().positive(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** En enkelt historisk handel fra Ejerfortegnelsen */
export interface HandelData {
  /** Kontant købesum i DKK */
  kontantKoebesum: number | null;
  /** Samlet købesum (inkl. løsøre etc.) */
  samletKoebesum: number | null;
  /** Løsøreværdi */
  loesoeresum: number | null;
  /** Entreprisesum */
  entreprisesum: number | null;
  /** Dato for købsaftale (ISO 8601) */
  koebsaftaleDato: string | null;
  /** Overtagelsesdato fra ejerskifte (ISO 8601) */
  overtagelsesdato: string | null;
  /** Overdragelsesmåde (frit salg, arv, gave, tvangsauktion, etc.) */
  overdragelsesmaade: string | null;
  /** Valutakode (typisk DKK) */
  valutakode: string | null;

  // ─── BIZZ-480: Udvidede EJF_Handelsoplysninger felter ─────────────────────
  /** Skødetekst — kontekst om handlen */
  skoedetekst?: string | null;
  /** Afståelsesdato (kan afvige fra overtagelsesdato) */
  afstaaelsesdato?: string | null;
  /** Betalingsforpligtelsesdato — hvornår betalingsforpligtelsen indtraadte */
  betalingsforpligtelsesdato?: string | null;
  /** Husdyrbesaetningsum — relevant for landbrugsejendomme */
  husdyrbesaetningsum?: number | null;

  // ─── BIZZ-481: Udvidede EJF_Ejerskifte felter ─────────────────────────────
  /** True hvis handlen er betinget (skøde med uopfyldte betingelser) */
  betinget?: boolean | null;
  /** Frist for opfyldelse af betingelser (ISO 8601) */
  fristDato?: string | null;
  /** Officiel klassificering: frit salg / arv / gave / tvangsauktion / fusion / spaltning */
  forretningshaendelse?: string | null;
  /** Hvis sat → handlen er annulleret eller ombyttet (ISO 8601) */
  virkningTil?: string | null;
}

/** API-svaret fra denne route */
export interface SalgshistorikResponse {
  bfeNummer: number | null;
  handler: HandelData[];
  fejl: string | null;
  manglerNoegle: boolean;
  manglerAdgang: boolean;
}

// ─── Datafordeler EJF GraphQL ────────────────────────────────────────────────

/** OAuth token cache */
let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler.
 * Cacher tokenet i serverprocessen — fornyer automatisk 60 sek. inden udløb.
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

// ─── Rå typer fra EJF GraphQL schema ────────────────────────────────────────
// BIZZ-633: EJF_Ejerskifte + EJF_Handelsoplysninger er ikke i vores grant
// (jf. BIZZ-584). Vi bruger nu EJFCustom_EjerskabBegraenset som primær kilde
// og merger med Tinglysning-adkomster klient-side for priser.

// ─── GraphQL helpers ─────────────────────────────────────────────────────────

interface GqlResult<T> {
  data?: Record<string, { nodes?: T[] }>;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Sender GraphQL query til EJF.
 *
 * @returns nodes + authError flag, eller null ved netværk/parsefejl
 */
async function queryEJF<T>(
  query: string,
  entityName: string,
  token: string,
  endpoint: string = EJF_GQL_ENDPOINT
): Promise<{ nodes: T[]; authError: boolean } | null> {
  try {
    const res = await fetch(proxyUrl(endpoint), {
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

    if (res.status === 403) return { nodes: [], authError: true };
    if (!res.ok) return null;

    const json = (await res.json()) as GqlResult<T>;

    // Auth-fejl kan komme som GraphQL error selv ved 200
    const authErr =
      json.errors?.some(
        (e) => e.extensions?.code === 'DAF-AUTH-0001' || e.message?.includes('not authorized')
      ) ?? false;
    if (authErr) return { nodes: [], authError: true };

    // Schema/field-fejl
    if (json.errors?.length && !json.data?.[entityName]) {
      logger.warn(`[salgshistorik] ${entityName} fejl:`, json.errors[0].message);
      return null;
    }

    return {
      nodes: json.data?.[entityName]?.nodes ?? [],
      authError: false,
    };
  } catch (err) {
    logger.error('[salgshistorik] queryEJF netværksfejl:', err);
    return null;
  }
}

// ─── Route handler ───────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<SalgshistorikResponse>> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited as NextResponse<SalgshistorikResponse>;
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as SalgshistorikResponse, {
      status: 401,
    });

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { bfeNummer: null, handler: [], fejl: null, manglerNoegle: true, manglerAdgang: false },
      { status: 200 }
    );
  }

  // Validate query params with Zod schema
  const parsed = parseQuery(request, salgshistorikQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<SalgshistorikResponse>;

  const { bfeNummer } = parsed.data;

  // BIZZ-633: LRU cache-hit → undgå hele EJF round-trip'en. Salgshistorik er
  // en særlig hot path fordi både Økonomi-tab, ejendoms-kort og
  // diagram-enrichment trigger samme BFE-lookup.
  const cached = salgshistorikCache.get(bfeNummer);
  if (cached) {
    return NextResponse.json(cached, {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  }

  const token = await getSharedOAuthToken();
  if (!token) {
    return NextResponse.json(
      {
        bfeNummer,
        handler: [],
        fejl: 'OAuth token kunne ikke hentes',
        manglerNoegle: false,
        manglerAdgang: false,
      },
      { status: 200 }
    );
  }

  try {
    // ── BIZZ-633 / BIZZ-584: EJF_Ejerskifte + EJF_Handelsoplysninger er IKKE
    // i vores Datafordeler-grant. De tidligere queries fejlede konstant med
    // "EJF_Ejerskifte query fejlede" og resulterede i 0 handler.
    //
    // Vi har derimod grant til EJFCustom_EjerskabBegraenset (samme kilde som
    // /api/ejerskab og /api/ejendomme-by-owner). Vi bygger ejerskifter ud
    // fra unikke virkningFra-tidspunkter: hver unik ejer-registrering for
    // et BFE repræsenterer en ejerskifte-hændelse. Prisoplysninger er ikke
    // tilgængelige via EJFCustom — klienten merger med Tinglysning-
    // adkomster for købesummer + købernavne.
    const ejerskabQuery = `{
      EJFCustom_EjerskabBegraenset(
        first: 500
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

    interface RawEjerskab {
      bestemtFastEjendomBFENr: number | null;
      ejendeVirksomhedCVRNr: number | null;
      ejendePersonBegraenset?: { navn?: { navn?: string | null } | null } | null;
      ejerforholdskode?: string | null;
      faktiskEjerandel_taeller?: number | null;
      faktiskEjerandel_naevner?: number | null;
      status?: string | null;
      virkningFra?: string | null;
    }

    // Primær-kilde FlexibleCurrent (aktuelle). HistoriskCurrent-forsøget
    // beholdes som parallel fallback — hvis endpointet ikke er i grant
    // rammer det 403 og vi bruger kun FlexibleCurrent's resultat.
    const [flexibleResult, historiskResult] = await Promise.allSettled([
      queryEJF<RawEjerskab>(ejerskabQuery, 'EJFCustom_EjerskabBegraenset', token),
      queryEJF<RawEjerskab>(
        ejerskabQuery,
        'EJFCustom_EjerskabBegraenset',
        token,
        EJF_GQL_HISTORISK_ENDPOINT
      ),
    ]);

    const flexibleEjerskab = flexibleResult.status === 'fulfilled' ? flexibleResult.value : null;
    const historiskEjerskab = historiskResult.status === 'fulfilled' ? historiskResult.value : null;

    if (flexibleEjerskab?.authError && historiskEjerskab?.authError) {
      return NextResponse.json(
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    if (!flexibleEjerskab && !historiskEjerskab) {
      return NextResponse.json(
        {
          bfeNummer,
          handler: [],
          fejl: 'EJFCustom_EjerskabBegraenset query fejlede',
          manglerNoegle: false,
          manglerAdgang: false,
        },
        { status: 200 }
      );
    }

    // Merge ejerskab-noder fra begge kilder, dedupliker på (cvr|person,
    // virkningFra). Hver unik kombination = én ejerskab-episode.
    const ejerskabById = new Map<string, RawEjerskab>();
    const allNodes = [...(flexibleEjerskab?.nodes ?? []), ...(historiskEjerskab?.nodes ?? [])];
    for (const n of allNodes) {
      if (!n.virkningFra) continue;
      const ownerKey =
        n.ejendeVirksomhedCVRNr != null
          ? `cvr-${n.ejendeVirksomhedCVRNr}`
          : `person-${n.ejendePersonBegraenset?.navn?.navn ?? 'ukendt'}`;
      const key = `${ownerKey}__${n.virkningFra}`;
      if (!ejerskabById.has(key)) ejerskabById.set(key, n);
    }

    // Byg ejerandel-label fra taeller/naevner (fx 1/2 → "50%")
    const formatAndel = (n: RawEjerskab): string | null => {
      const t = n.faktiskEjerandel_taeller;
      const na = n.faktiskEjerandel_naevner;
      if (t == null || na == null || na === 0) return null;
      const pct = (t / na) * 100;
      return pct === Math.round(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
    };

    // ejerforholdskode → menneske-læsbar overdragelsesmaade når muligt
    const overdragelseLabel = (n: RawEjerskab): string | null => {
      if (!n.ejerforholdskode) return null;
      // Kode-navne er oftest korte identifiers; vis rå så brugeren kan se
      // dem. UI merger med Tinglysning-adkomsttype som senere tekst-label.
      return n.ejerforholdskode;
    };

    const handler: HandelData[] = Array.from(ejerskabById.values())
      .filter((n) => n.virkningFra != null)
      .map((n) => ({
        kontantKoebesum: null,
        samletKoebesum: null,
        loesoeresum: null,
        entreprisesum: null,
        koebsaftaleDato: null,
        overtagelsesdato: n.virkningFra ?? null,
        overdragelsesmaade: overdragelseLabel(n),
        valutakode: null,
        // BIZZ-633: Ingen handelsoplysninger fra EJFCustom — klienten
        // merger med Tinglysning-adkomster for priser + købernavne.
        skoedetekst: null,
        afstaaelsesdato: null,
        betalingsforpligtelsesdato: null,
        husdyrbesaetningsum: null,
        betinget: null,
        fristDato: null,
        forretningshaendelse: formatAndel(n), // Genbruges til at bære andel
        virkningTil: n.status?.toLowerCase() === 'historisk' ? (n.virkningFra ?? null) : null,
      }))
      .sort((a, b) => (b.overtagelsesdato ?? '').localeCompare(a.overtagelsesdato ?? ''));

    logger.log(
      `[salgshistorik] ${handler.length} ejerskab-events fundet for BFE ${bfeNummer} via EJFCustom`
    );

    // BIZZ-633: Cache response før return
    const responseData: SalgshistorikResponse = {
      bfeNummer,
      handler,
      fejl: null,
      manglerNoegle: false,
      manglerAdgang: false,
    };
    salgshistorikCache.set(bfeNummer, responseData);
    return NextResponse.json(responseData, {
      status: 200,
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
    });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    const body =
      process.env.NODE_ENV === 'development'
        ? {
            bfeNummer,
            handler: [],
            fejl: 'Ekstern API fejl',
            dev_detail: msg,
            manglerNoegle: false,
            manglerAdgang: false,
          }
        : {
            bfeNummer,
            handler: [],
            fejl: 'Ekstern API fejl',
            manglerNoegle: false,
            manglerAdgang: false,
          };
    return NextResponse.json(body, { status: 200 });
  }
}
