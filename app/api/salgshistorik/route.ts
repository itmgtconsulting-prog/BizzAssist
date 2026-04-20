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

/** EJF_Ejerskifte — kobler BFE til handelsoplysning */
interface RawEjerskifte {
  bestemtFastEjendomBFENr: number | null;
  overtagelsesdato: string | null;
  overdragelsesmaade: string | null;
  handelsoplysningerLokalId: string | null;
  status: string | null;
  // BIZZ-481: Udvidede felter
  betinget?: boolean | null;
  fristDato?: string | null;
  forretningshaendelse?: string | null;
  virkningTil?: string | null;
}

/** EJF_Handelsoplysninger — prisdata for en handel */
interface RawHandelsoplysning {
  id_lokalId: string;
  kontantKoebesum: number | null;
  samletKoebesum: number | null;
  loesoeresum: number | null;
  entreprisesum: number | null;
  koebsaftaleDato: string | null;
  valutakode: string | null;
  status: string | null;
  // BIZZ-480: Udvidede felter
  skoedetekst?: string | null;
  afstaaelsesdato?: string | null;
  betalingsforpligtelsesdato?: string | null;
  husdyrbesaetningsum?: number | null;
}

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
    // ── Trin 1: Hent ejerskifter for BFE → få handelsoplysningerLokalId ──
    // BIZZ-481: Udvidet med betinget, fristDato, forretningshaendelse, virkningTil
    const ejerskifteQuery = `{
      EJF_Ejerskifte(
        first: 200
        where: {
          bestemtFastEjendomBFENr: { eq: ${bfeNummer} }
        }
      ) {
        nodes {
          bestemtFastEjendomBFENr
          overtagelsesdato
          overdragelsesmaade
          handelsoplysningerLokalId
          status
          betinget
          fristDato
          forretningshaendelse
          virkningTil
        }
      }
    }`;

    // BIZZ-633: Query FlexibleCurrent (aktuelle) + HistoriskCurrent (alle
    // historiske ejerskifter) parallelt og merge på
    // handelsoplysningerLokalId. FlexibleCurrent returnerer kun gældende
    // ejerskifter; HistoriskCurrent returnerer også udslettede/afsluttede
    // ejerskifter — nødvendigt for den fulde handelskæde når en ejendom
    // har skiftet ejer flere gange.
    const [flexibleResult, historiskResult] = await Promise.allSettled([
      queryEJF<RawEjerskifte>(ejerskifteQuery, 'EJF_Ejerskifte', token),
      queryEJF<RawEjerskifte>(ejerskifteQuery, 'EJF_Ejerskifte', token, EJF_GQL_HISTORISK_ENDPOINT),
    ]);

    const ejerskifteResult = flexibleResult.status === 'fulfilled' ? flexibleResult.value : null;
    const historiskEjerskifte =
      historiskResult.status === 'fulfilled' ? historiskResult.value : null;

    if (ejerskifteResult?.authError) {
      return NextResponse.json(
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    if (!ejerskifteResult && !historiskEjerskifte) {
      return NextResponse.json(
        {
          bfeNummer,
          handler: [],
          fejl: 'EJF_Ejerskifte query fejlede',
          manglerNoegle: false,
          manglerAdgang: false,
        },
        { status: 200 }
      );
    }

    // Merge ejerskifter fra begge kilder, dedupliker på
    // handelsoplysningerLokalId (unikt pr. handel). Nogle records findes
    // kun i en af de to — derfor union, ikke intersection.
    const ejerskifterById = new Map<string, RawEjerskifte>();
    const flexibleNodes = ejerskifteResult?.nodes ?? [];
    const historiskNodes = historiskEjerskifte?.nodes ?? [];
    for (const e of [...flexibleNodes, ...historiskNodes]) {
      const key =
        e.handelsoplysningerLokalId ?? `${e.bestemtFastEjendomBFENr}-${e.overtagelsesdato}`;
      if (!key) continue;
      if (!ejerskifterById.has(key)) ejerskifterById.set(key, e);
    }
    const ejerskifter = Array.from(ejerskifterById.values());

    // Saml unikke handelsoplysningerLokalIds
    const handelsIds = [
      ...new Set(
        ejerskifter
          .map((e) => e.handelsoplysningerLokalId)
          .filter((id): id is string => id != null && id.length > 0)
      ),
    ];

    // Hvis ingen handelsoplysninger → returner ejerskifter uden prisdata
    if (handelsIds.length === 0) {
      const handler: HandelData[] = ejerskifter
        .filter((e) => e.overtagelsesdato != null)
        .map((e) => ({
          kontantKoebesum: null,
          samletKoebesum: null,
          loesoeresum: null,
          entreprisesum: null,
          koebsaftaleDato: null,
          overtagelsesdato: e.overtagelsesdato,
          overdragelsesmaade: e.overdragelsesmaade ?? null,
          valutakode: null,
        }))
        .sort((a, b) => (b.overtagelsesdato ?? '').localeCompare(a.overtagelsesdato ?? ''));

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
    }

    // ── Trin 2: Hent handelsoplysninger via id_lokalId ──
    // BIZZ-480: Udvidet med skoedetekst, afstaaelsesdato,
    // betalingsforpligtelsesdato, husdyrbesaetningsum
    const idsStr = handelsIds.map((id) => `"${id}"`).join(', ');
    const handelsQuery = `{
      EJF_Handelsoplysninger(
        first: 200
        where: {
          id_lokalId: { in: [${idsStr}] }
        }
      ) {
        nodes {
          id_lokalId
          kontantKoebesum
          samletKoebesum
          loesoeresum
          entreprisesum
          koebsaftaleDato
          valutakode
          status
          skoedetekst
          afstaaelsesdato
          betalingsforpligtelsesdato
          husdyrbesaetningsum
        }
      }
    }`;

    // BIZZ-633: Merge handelsoplysninger fra begge kilder også. Ældre
    // handler ligger i HistoriskCurrent; nyere i FlexibleCurrent.
    const [handelsFlexible, handelsHistorisk] = await Promise.allSettled([
      queryEJF<RawHandelsoplysning>(handelsQuery, 'EJF_Handelsoplysninger', token),
      queryEJF<RawHandelsoplysning>(
        handelsQuery,
        'EJF_Handelsoplysninger',
        token,
        EJF_GQL_HISTORISK_ENDPOINT
      ),
    ]);

    const handelsResult = handelsFlexible.status === 'fulfilled' ? handelsFlexible.value : null;
    const handelsHistoriskResult =
      handelsHistorisk.status === 'fulfilled' ? handelsHistorisk.value : null;

    if (handelsResult?.authError) {
      return NextResponse.json(
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    // Byg opslag: handelsoplysningerLokalId → prisdata (union af kilder)
    const handelsMap = new Map<string, RawHandelsoplysning>();
    for (const h of [...(handelsResult?.nodes ?? []), ...(handelsHistoriskResult?.nodes ?? [])]) {
      if (!handelsMap.has(h.id_lokalId)) handelsMap.set(h.id_lokalId, h);
    }

    // ── Sammenkobl ejerskifter med handelsoplysninger ──
    // BIZZ-480 + 481: Inkluderer udvidede felter fra begge entiteter.
    const handler: HandelData[] = ejerskifter
      .map((e) => {
        const h = e.handelsoplysningerLokalId
          ? handelsMap.get(e.handelsoplysningerLokalId)
          : undefined;
        return {
          kontantKoebesum: h?.kontantKoebesum ?? null,
          samletKoebesum: h?.samletKoebesum ?? null,
          loesoeresum: h?.loesoeresum ?? null,
          entreprisesum: h?.entreprisesum ?? null,
          koebsaftaleDato: h?.koebsaftaleDato ?? null,
          overtagelsesdato: e.overtagelsesdato ?? null,
          overdragelsesmaade: e.overdragelsesmaade ?? null,
          valutakode: h?.valutakode ?? null,
          // BIZZ-480
          skoedetekst: h?.skoedetekst ?? null,
          afstaaelsesdato: h?.afstaaelsesdato ?? null,
          betalingsforpligtelsesdato: h?.betalingsforpligtelsesdato ?? null,
          husdyrbesaetningsum: h?.husdyrbesaetningsum ?? null,
          // BIZZ-481
          betinget: e.betinget ?? null,
          fristDato: e.fristDato ?? null,
          forretningshaendelse: e.forretningshaendelse ?? null,
          virkningTil: e.virkningTil ?? null,
        };
      })
      .filter(
        (h) => h.kontantKoebesum != null || h.samletKoebesum != null || h.overtagelsesdato != null
      )
      .sort((a, b) => {
        const da = a.koebsaftaleDato ?? a.overtagelsesdato ?? '';
        const db = b.koebsaftaleDato ?? b.overtagelsesdato ?? '';
        return db.localeCompare(da); // nyeste først
      });

    logger.log(
      `[salgshistorik] ${handler.length} handler fundet for BFE ${bfeNummer} (${ejerskifter.length} ejerskifter, ${handelsIds.length} handelsoplysninger)`
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
