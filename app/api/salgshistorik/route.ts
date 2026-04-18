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
import { EJF_GQL_ENDPOINT, DATAFORDELER_TOKEN_URL } from '@/app/lib/serviceEndpoints';

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
  /**
   * BIZZ-480: Udvidede felter fra EJF — alle optional da feltet først blev
   * tilføjet efter eksisterende schema var etableret, og da Datafordeler
   * kan nægte adgang pr. scope. Når extended-query fejler falder vi tilbage
   * til basis-queryen og sætter disse til null.
   */
  /** Afståelsesdato (dato hvor den tidligere ejer afstod ejendommen) */
  afstaaelsesdato?: string | null;
  /** Dato hvor betalingsforpligtelsen indtraadte */
  betalingsforpligtelsesdato?: string | null;
  /** Husdyrbesætning-værdi (relevant for landbrug) */
  husdyrbesaetningsum?: number | null;
  /** Forretningshændelse fra EJF_Ejerskifte (fx "Frit salg", "Arv", "Gave", "Tvangsauktion") */
  forretningshaendelse?: string | null;
  /**
   * BIZZ-481: Yderligere EJF_Ejerskifte-felter til betingede/annullerede/
   * rettede handler. Alle optional da datafordeler-schemaet kan nægte
   * ukendte felter — extended-query falder tilbage til basis ved fejl.
   */
  /** True hvis handlen er betinget (betingelser ikke opfyldt endnu) */
  betinget?: boolean | null;
  /** Frist-dato for betingelsernes opfyldelse (ISO 8601) */
  fristDato?: string | null;
  /** Virkning-Til dato — hvis i fortiden er handlen annulleret/erstattet */
  virkningTil?: string | null;
  /** Dato hvor handlen blev anmeldt til tinglysning */
  anmeldelsesdato?: string | null;
  /** Anmeldelses-ID (krydsreference mod Tinglysning) */
  anmeldelsesidentifikator?: string | null;
  /** Registrering-Fra — bruges sammen med virkningFra til at markere rettede handler */
  registreringFra?: string | null;
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
  /** BIZZ-480: Udvidet — kun sat når extended-queryen lykkes */
  afstaaelsesdato?: string | null;
  forretningshaendelse?: string | null;
  /** BIZZ-481: Yderligere extended felter — kun sat når extended-queryen lykkes */
  betinget?: boolean | null;
  fristDato?: string | null;
  virkningFra?: string | null;
  virkningTil?: string | null;
  anmeldelsesdato?: string | null;
  anmeldelsesidentifikator?: string | null;
  registreringFra?: string | null;
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
  /** BIZZ-480: Udvidede felter — kun sat når extended-queryen lykkes */
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
  token: string
): Promise<{ nodes: T[]; authError: boolean } | null> {
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
    // BIZZ-480: Vi prøver først en udvidet query med ekstra felter
    // (afstaaelsesdato + forretningshaendelse). Hvis Datafordeler afviser
    // ukendte felter (schema-fejl), falder vi tilbage til basis-queryen så
    // eksisterende salgshistorik ikke går tabt. Når Datafordeler schema bliver
    // opdateret vil extended-queryen begynde at lykkes automatisk.
    // BIZZ-481 udvider extended-listen med betinget/frist/virkning/anmeldelse/
    // registrering-felter. Hvis Datafordeler-schemaet afviser ukendte feltnavne,
    // falder buildEjerskifteQuery(false) tilbage til basis-felterne og henter i
    // det mindste stadig overtagelsesdato + overdragelsesmaade.
    const buildEjerskifteQuery = (extended: boolean) => `{
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
          ${
            extended
              ? `afstaaelsesdato
          forretningshaendelse
          betinget
          fristDato
          virkningFra
          virkningTil
          anmeldelsesdato
          anmeldelsesidentifikator
          registreringFra`
              : ''
          }
        }
      }
    }`;

    let ejerskifteResult = await queryEJF<RawEjerskifte>(
      buildEjerskifteQuery(true),
      'EJF_Ejerskifte',
      token
    );
    // null-svar = schema-fejl eller netværksfejl. Prøv basis-queryen uden
    // extended-felter så eksisterende salgshistorik ikke går tabt blot fordi
    // EJF endnu ikke har fx afstaaelsesdato i schemaet. Empty-svar betragtes
    // som succes (ejendom har ingen handler) og udløser ikke retry.
    if (!ejerskifteResult) {
      logger.warn('[salgshistorik] Extended EJF_Ejerskifte query fejlede — falder tilbage');
      ejerskifteResult = await queryEJF<RawEjerskifte>(
        buildEjerskifteQuery(false),
        'EJF_Ejerskifte',
        token
      );
    }

    if (ejerskifteResult?.authError) {
      return NextResponse.json(
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    if (!ejerskifteResult) {
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

    // BIZZ-481: Filtrer annullerede/erstattede ejerskifter. Hvis virkningTil
    // er sat og ligger i fortiden er handlen ikke længere gyldig og bør ikke
    // vises som historik. Vi bevarer handler uden virkningTil (null = stadig
    // gyldig) og handler hvor virkningTil ligger i fremtiden.
    const now = new Date().toISOString();
    const ejerskifter = ejerskifteResult.nodes.filter((e) => {
      if (!e.virkningTil) return true;
      return e.virkningTil > now;
    });

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
          // BIZZ-480: Udvidede EJF-felter — tilgængelige når extended-queryen lykkes
          afstaaelsesdato: e.afstaaelsesdato ?? null,
          forretningshaendelse: e.forretningshaendelse ?? null,
          betalingsforpligtelsesdato: null,
          husdyrbesaetningsum: null,
          // BIZZ-481: Yderligere EJF-felter til betingede/anmeldte handler.
          // rettet = true når handlen er efter-registreret (registreringFra > virkningFra).
          betinget: e.betinget ?? null,
          fristDato: e.fristDato ?? null,
          virkningTil: e.virkningTil ?? null,
          anmeldelsesdato: e.anmeldelsesdato ?? null,
          anmeldelsesidentifikator: e.anmeldelsesidentifikator ?? null,
          registreringFra: e.registreringFra ?? null,
        }))
        .sort((a, b) => (b.overtagelsesdato ?? '').localeCompare(a.overtagelsesdato ?? ''));

      return NextResponse.json(
        { bfeNummer, handler, fejl: null, manglerNoegle: false, manglerAdgang: false },
        {
          status: 200,
          headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
        }
      );
    }

    // ── Trin 2: Hent handelsoplysninger via id_lokalId ──
    // BIZZ-480: Samme extended/fallback-pattern som Ejerskifte — prøver at
    // hente betalingsforpligtelsesdato + husdyrbesaetningsum, fall back hvis
    // schemaet endnu ikke understøtter dem.
    const idsStr = handelsIds.map((id) => `"${id}"`).join(', ');
    const buildHandelsQuery = (extended: boolean) => `{
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
          ${extended ? 'betalingsforpligtelsesdato\n          husdyrbesaetningsum' : ''}
        }
      }
    }`;

    let handelsResult = await queryEJF<RawHandelsoplysning>(
      buildHandelsQuery(true),
      'EJF_Handelsoplysninger',
      token
    );
    if (!handelsResult) {
      logger.warn('[salgshistorik] Extended EJF_Handelsoplysninger query fejlede — falder tilbage');
      handelsResult = await queryEJF<RawHandelsoplysning>(
        buildHandelsQuery(false),
        'EJF_Handelsoplysninger',
        token
      );
    }

    if (handelsResult?.authError) {
      return NextResponse.json(
        { bfeNummer, handler: [], fejl: null, manglerNoegle: false, manglerAdgang: true },
        { status: 200 }
      );
    }

    // Byg opslag: handelsoplysningerLokalId → prisdata
    const handelsMap = new Map<string, RawHandelsoplysning>();
    if (handelsResult?.nodes) {
      for (const h of handelsResult.nodes) {
        handelsMap.set(h.id_lokalId, h);
      }
    }

    // ── Sammenkobl ejerskifter med handelsoplysninger ──
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
          // BIZZ-480: Udvidede EJF-felter
          afstaaelsesdato: e.afstaaelsesdato ?? null,
          forretningshaendelse: e.forretningshaendelse ?? null,
          betalingsforpligtelsesdato: h?.betalingsforpligtelsesdato ?? null,
          husdyrbesaetningsum: h?.husdyrbesaetningsum ?? null,
          // BIZZ-481: Yderligere EJF-felter
          betinget: e.betinget ?? null,
          fristDato: e.fristDato ?? null,
          virkningTil: e.virkningTil ?? null,
          anmeldelsesdato: e.anmeldelsesdato ?? null,
          anmeldelsesidentifikator: e.anmeldelsesidentifikator ?? null,
          registreringFra: e.registreringFra ?? null,
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

    return NextResponse.json(
      { bfeNummer, handler, fejl: null, manglerNoegle: false, manglerAdgang: false },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
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
