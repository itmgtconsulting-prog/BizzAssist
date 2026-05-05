/**
 * GET /api/vurdering
 *
 * Henter ejendomsvurdering + udvidede data fra Datafordeler VUR GraphQL v2.
 *
 * Flow:
 *   1. Hent OAuth Bearer token via client_credentials
 *   2. Forespørg VUR_BFEKrydsreference for at finde vurderings-IDs for BFEnummeret
 *   3. Forespørg VUR_Ejendomsvurdering — prøver udvidet query med afgiftspligtige
 *      beløb, falder tilbage til basis-query hvis skemaet ikke understøtter de nye felter
 *   4. Parallelt: hent Fordeling, Grundværdispecifikation, Loftansættelse,
 *      Fritagelse, FradragForForbedring for den nyeste vurdering
 *   5. Beregn estimeret grundskyld fra afgiftspligtig grundværdi × kommunens promille
 *   6. Returner nyeste + historik + udvidede data
 *
 * @param request - Next.js request med ?bfeNummer=xxx&kommunekode=xxx
 * @returns VurderingResponse
 */

import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { checkRateLimit, heavyRateLimit } from '@/app/lib/rateLimit';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';

/** Zod schema for /api/vurdering query parameters */
const vurderingQuerySchema = z.object({
  bfeNummer: z.string().regex(/^\d+$/),
  kommunekode: z.string().regex(/^\d+$/).optional(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

/** Ejendomsvurderingsdata returneret til klienten */
export interface VurderingData {
  bfeNummer: number;
  /** Offentlig ejendomsværdi i DKK */
  ejendomsvaerdi: number | null;
  /** Grundværdi i DKK */
  grundvaerdi: number | null;
  /** Afgiftspligtig ejendomsværdi — kan afvige fra ejendomsværdi */
  afgiftspligtigEjendomsvaerdi: number | null;
  /** Afgiftspligtig grundværdi — bruges til beregning af grundskyld */
  afgiftspligtigGrundvaerdi: number | null;
  /** Estimeret årlig grundskyld (afgiftspligtig grundværdi × kommunens promille) */
  estimereretGrundskyld: number | null;
  /** Grundskyldspromille for kommunen (‰) */
  grundskyldspromille: number | null;
  /** Vurderingsår */
  aar: number | null;
  /** Bebyggelsesprocent (0–100) */
  bebyggelsesprocent: number | null;
  /** Vurderet areal i m² */
  vurderetAreal: number | null;
  /** Benyttelses-kode */
  benyttelseskode: string | null;
  /** Juridisk kategori (f.eks. "Beboelsesejendom") */
  juridiskKategori: string | null;
  /** Juridisk kategori-kode (0 = gammelt system, 1100+ = nyt system) */
  juridiskKategoriKode: string | null;
  /** True hvis vurderingen er fra det nye vurderingssystem (2020+) */
  erNytSystem: boolean;
  /** Ændringsdato og -kode */
  aendringDato: string | null;
  aendringKode: string | null;
}

/** Ejerboligfordeling — fordeling af ejendomsværdi pr. bolig */
export interface FordelingData {
  ejerboligvaerdi: number | null;
  ejerboliggrundvaerdi: number | null;
  ejerboligvaerdiKode: string | null;
}

/** Grundværdispecifikation — nedbrydning af grundværdiberegning */
export interface GrundvaerdispecifikationData {
  loebenummer: number;
  areal: number | null;
  enhedBeloeb: number | null;
  beloeb: number | null;
  prisKode: string | null;
  tekst: string | null;
}

/** Loftansættelse — grundskatteloft */
export interface LoftansaettelseData {
  basisaar: number | null;
  grundvaerdi: number | null;
  pgf11: string | null;
}

/** Fritagelse — skattefritagelser */
export interface FritagelseData {
  loebenummer: number;
  artKode: string | null;
  beloeb: number | null;
  ejendomTypeKode: string | null;
  omfangKode: string | null;
}

/** Fradrag for forbedring — kloakering, vej etc. */
export interface FradragData {
  foersteGangAar: number | null;
  vaerdiSum: number | null;
  poster: { aar: number | null; tekst: string | null; vaerdi: number | null }[];
}

/** API-svaret fra denne route */
export interface VurderingResponse {
  /** Nyeste/gældende vurdering */
  vurdering: VurderingData | null;
  /** Alle vurderinger, sorteret nyeste først */
  alle: VurderingData[];
  /** Ejerboligfordeling for nyeste vurdering */
  fordeling: FordelingData[];
  /** Grundværdispecifikation for nyeste vurdering */
  grundvaerdispec: GrundvaerdispecifikationData[];
  /** Loftansættelse (grundskatteloft) for nyeste vurdering */
  loft: LoftansaettelseData[];
  /** Skattefritagelser for nyeste vurdering */
  fritagelser: FritagelseData[];
  /** Fradrag for forbedringer for nyeste vurdering */
  fradrag: FradragData | null;
  fejl: string | null;
  manglerNoegle: boolean;
}

// ─── Rå typer fra VUR GraphQL ────────────────────────────────────────────────

interface RawVURBFEKrydsreference {
  fkEjendomsvurderingID: number;
}

interface RawVURVurdering {
  id: number;
  aar: number | null;
  ejendomvaerdiBeloeb: number | null;
  grundvaerdiBeloeb: number | null;
  ejendomvaerdiAfgiftspligtigBeloeb?: number | null;
  grundvaerdiAfgiftspligtigBeloeb?: number | null;
  vurderetAreal: number | null;
  benyttelseKode: string | null;
  juridiskKategoriTekst?: string | null;
  juridiskKategoriKode?: string | null;
  aendringDato?: string | null;
  aendringKode?: string | null;
}

interface RawFordeling {
  ejerboligvaerdi: number | null;
  ejerboliggrundvaerdi: number | null;
  ejerboligvaerdiKode: string | null;
}

interface RawGrundvaerdispec {
  loebenummer: number;
  areal: number | null;
  enhedBeloeb: number | null;
  beloeb: number | null;
  prisKode: string | null;
  tekst: string | null;
}

interface RawLoft {
  basisaar: number | null;
  grundvaerdi: number | null;
  pgf11: string | null;
}

interface RawFritagelse {
  loebenummer: number;
  artKode: string | null;
  beloeb: number | null;
  ejendomTypeKode: string | null;
  omfangKode: string | null;
}

interface RawFradragOverordnet {
  foersteGangAar: number | null;
  vaerdiSum: number | null;
  FradragForForbedringOverordnetID: number;
}

interface RawFradragPost {
  aar: number | null;
  tekst: string | null;
  vaerdi: number | null;
  fkFradragForForbedringOverordnetID: number;
}

// ─── Grundskyldspromiller (Indenrigs- og Sundhedsministeriet) ────────────────

/**
 * BIZZ-269: Historiske grundskyldspromiller per år.
 * Bruges til at estimere grundskyld for historiske vurderinger.
 *
 * 2021-2024: Satserne var fastfrosne for de fleste kommuner (uændrede).
 * 2025: Nye satser efter ejendomsvurderingsreformen.
 *
 * Kilde: Indenrigs- og Sundhedsministeriets kommunale nøgletal.
 * Fallback: 2025-satser bruges hvis historisk promille ikke er tilgængelig.
 */
const GRUNDSKYLDSPROMILLE_2024: Record<number, number> = {
  101: 34.0,
  147: 23.0,
  151: 23.0,
  153: 26.74,
  155: 23.0,
  157: 16.0,
  159: 23.4,
  161: 25.74,
  163: 24.0,
  165: 26.0,
  167: 23.4,
  169: 23.0,
  173: 18.5,
  175: 24.0,
  183: 28.0,
  185: 24.0,
  187: 21.0,
  190: 22.0,
  201: 22.0,
  210: 22.44,
  217: 24.8,
  219: 21.68,
  223: 16.0,
  230: 16.0,
  240: 21.0,
  250: 22.0,
  253: 22.0,
  259: 22.22,
  260: 24.0,
  265: 21.71,
  269: 20.0,
  270: 22.5,
  306: 27.0,
  316: 23.0,
  320: 24.0,
  326: 24.68,
  329: 22.0,
  330: 25.0,
  336: 21.0,
  340: 21.68,
  350: 21.0,
  360: 26.0,
  370: 23.0,
  376: 26.0,
  390: 26.0,
  400: 24.68,
  410: 22.0,
  420: 23.0,
  430: 22.0,
  440: 22.0,
  450: 23.0,
  461: 24.68,
  479: 24.0,
  480: 22.0,
  482: 26.0,
  492: 26.0,
  510: 22.68,
  530: 18.0,
  540: 22.68,
};

/**
 * Henter grundskyldspromille for et givet år og kommunekode.
 * Bruger 2024-satser for 2020-2024 og 2025-satser for 2025+.
 */
function getPromille(kommunekode: number, aar: number | null): number | null {
  if (aar != null && aar <= 2024) {
    return GRUNDSKYLDSPROMILLE_2024[kommunekode] ?? GRUNDSKYLDSPROMILLE[kommunekode] ?? null;
  }
  return GRUNDSKYLDSPROMILLE[kommunekode] ?? null;
}

/**
 * Grundskyldspromiller (‰) pr. kommunekode, 2025-satser.
 * Kilde: Indenrigs- og Sundhedsministeriets kommunale nøgletal 2025.
 */
const GRUNDSKYLDSPROMILLE: Record<number, number> = {
  101: 34.0, // København
  147: 29.34, // Frederiksberg
  151: 26.9, // Ballerup
  153: 30.74, // Brøndby
  155: 25.55, // Dragør
  157: 21.3, // Gentofte
  159: 27.2, // Gladsaxe
  161: 30.74, // Glostrup
  163: 28.5, // Herlev
  165: 30.5, // Albertslund
  167: 27.2, // Hvidovre
  169: 27.9, // Høje-Taastrup
  173: 22.4, // Lyngby-Taarbæk
  175: 28.3, // Rødovre
  183: 31.8, // Ishøj
  185: 27.8, // Tårnby
  187: 25.4, // Vallensbæk
  190: 23.5, // Furesø
  201: 22.0, // Allerød
  210: 23.5, // Fredensborg
  217: 27.8, // Helsingør
  219: 25.7, // Hillerød
  223: 21.0, // Hørsholm
  230: 20.8, // Rudersdal
  240: 24.2, // Egedal
  250: 26.0, // Frederikssund
  253: 25.5, // Greve
  259: 25.9, // Køge
  260: 27.4, // Halsnæs
  265: 24.5, // Roskilde
  269: 23.4, // Solrød
  270: 26.5, // Gribskov
  306: 31.2, // Odsherred
  316: 27.0, // Holbæk
  320: 27.0, // Faxe
  326: 27.5, // Kalundborg
  329: 26.0, // Ringsted
  330: 29.3, // Slagelse
  336: 24.6, // Stevns
  340: 24.6, // Sorø
  350: 24.4, // Lejre
  360: 30.2, // Lolland
  370: 27.8, // Næstved
  376: 30.5, // Guldborgsund
  390: 29.7, // Vordingborg
  400: 28.8, // Bornholm
  410: 25.4, // Middelfart
  420: 26.5, // Assens
  430: 25.5, // Faaborg-Midtfyn
  440: 25.0, // Kerteminde
  450: 26.7, // Nyborg
  461: 28.5, // Odense
  479: 27.4, // Svendborg
  480: 25.5, // Nordfyns
  482: 30.5, // Langeland
  492: 30.2, // Ærø
  510: 26.4, // Haderslev
  530: 22.5, // Billund
  540: 26.2, // Sønderborg
  550: 27.5, // Tønder
  561: 28.1, // Esbjerg
  563: 24.6, // Fanø
  573: 26.0, // Varde
  575: 25.5, // Vejen
  580: 26.5, // Aabenraa
  607: 27.7, // Fredericia
  615: 27.2, // Horsens
  621: 25.6, // Kolding
  630: 25.0, // Vejle
  657: 25.5, // Herning
  661: 26.0, // Holstebro
  665: 26.5, // Lemvig
  671: 26.0, // Struer
  706: 25.5, // Syddjurs
  707: 27.5, // Norddjurs
  710: 24.0, // Favrskov
  727: 23.0, // Odder
  730: 27.0, // Randers
  740: 24.8, // Silkeborg
  741: 26.5, // Samsø
  746: 22.5, // Skanderborg
  751: 27.1, // Aarhus
  756: 25.5, // Ikast-Brande
  760: 24.0, // Ringkøbing-Skjern
  766: 23.5, // Hedensted
  773: 28.5, // Morsø
  779: 27.5, // Skive
  787: 26.5, // Thisted
  791: 25.5, // Viborg
  810: 27.5, // Brønderslev
  813: 28.0, // Frederikshavn
  820: 27.5, // Vesthimmerlands
  825: 27.5, // Læsø
  840: 23.5, // Rebild
  846: 26.5, // Mariagerfjord
  849: 26.5, // Jammerbugt
  851: 27.4, // Aalborg
  860: 27.5, // Hjørring
};

// ─── OAuth token cache ────────────────────────────────────────────────────────

const VUR_GQL_URL = 'https://graphql.datafordeler.dk/VUR/v2';
const TOKEN_URL = 'https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token';

let _cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Henter et gyldigt OAuth Bearer token fra Datafordeler.
 * Cacher tokenet i serverprocessen og fornyr automatisk 60 sek. inden udløb.
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

/**
 * Sender en GraphQL-forespørgsel til Datafordeler VUR/v2 med Bearer token.
 *
 * @param query - GraphQL query string
 * @param token - OAuth Bearer token
 * @returns Parsed JSON data-objekt eller null ved fejl/GraphQL-errors
 */
async function fetchVURGraphQL(
  query: string,
  token: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(proxyUrl(VUR_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query, variables: {} }),
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown[];
    };
    if (json.errors?.length) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

// ─── Helpers: hent udvidede data parallelt ──────────────────────────────────

/**
 * Henter Fordeling, Grundværdispec, Loft, Fritagelser og Fradrag
 * for en given vurderings-ID — alle kald køres parallelt.
 *
 * @param vurId - VUR_Ejendomsvurdering id
 * @param token - OAuth Bearer token
 */
async function fetchUdvidedeData(
  vurId: number,
  allVurIds: number[],
  token: string
): Promise<{
  fordeling: FordelingData[];
  grundvaerdispec: GrundvaerdispecifikationData[];
  loft: LoftansaettelseData[];
  fritagelser: FritagelseData[];
  fradrag: FradragData | null;
}> {
  const empty = {
    fordeling: [] as FordelingData[],
    grundvaerdispec: [] as GrundvaerdispecifikationData[],
    loft: [] as LoftansaettelseData[],
    fritagelser: [] as FritagelseData[],
    fradrag: null as FradragData | null,
  };

  // Kør alle 5 queries parallelt
  const [fordelingData, specData, loftData, fritagelseData, fradragOverordnetData] =
    await Promise.all([
      fetchVURGraphQL(
        `{ VUR_Fordeling(first: 50, where: { fkEjendomsvurderingID: { eq: ${vurId} } }) {
          nodes { ejerboligvaerdi ejerboliggrundvaerdi ejerboligvaerdiKode }
        }}`,
        token
      ),
      fetchVURGraphQL(
        `{ VUR_Grundvaerdispecifikation(first: 50, where: { fkEjendomsvurderingID: { eq: ${vurId} } }) {
          nodes { loebenummer areal enhedBeloeb beloeb prisKode tekst }
        }}`,
        token
      ),
      // BIZZ-490: Loft henter fra ALLE vurderinger, ikke kun nyeste, da
      // VUR_Loftansaettelse ofte kun eksisterer på den igangværende vurdering
      // (ikke foreløbige). Hvis flere findes vælges nyeste af UI-kodet.
      fetchVURGraphQL(
        `{ VUR_Loftansaettelse(first: 50, where: { fkEjendomsvurderingID: { in: [${allVurIds.join(', ')}] } }) {
          nodes { basisaar grundvaerdi pgf11 }
        }}`,
        token
      ),
      fetchVURGraphQL(
        `{ VUR_Fritagelse(first: 50, where: { fkEjendomsvurderingID: { eq: ${vurId} } }) {
          nodes { loebenummer artKode beloeb ejendomTypeKode omfangKode }
        }}`,
        token
      ),
      fetchVURGraphQL(
        `{ VUR_FradragForForbedringOverordnet(first: 10, where: { fkEjendomsvurderingID: { eq: ${vurId} } }) {
          nodes { FradragForForbedringOverordnetID foersteGangAar vaerdiSum }
        }}`,
        token
      ),
    ]);

  // ── Fordeling ──
  const fordelingNodes = (fordelingData?.['VUR_Fordeling'] as { nodes: RawFordeling[] } | undefined)
    ?.nodes;
  empty.fordeling = (fordelingNodes ?? []).map((n) => ({
    ejerboligvaerdi: n.ejerboligvaerdi,
    ejerboliggrundvaerdi: n.ejerboliggrundvaerdi,
    ejerboligvaerdiKode: n.ejerboligvaerdiKode,
  }));

  // ── Grundværdispecifikation ──
  const specNodes = (
    specData?.['VUR_Grundvaerdispecifikation'] as { nodes: RawGrundvaerdispec[] } | undefined
  )?.nodes;
  empty.grundvaerdispec = (specNodes ?? [])
    .sort((a, b) => a.loebenummer - b.loebenummer)
    .map((n) => ({
      loebenummer: n.loebenummer,
      areal: n.areal,
      enhedBeloeb: n.enhedBeloeb,
      beloeb: n.beloeb,
      prisKode: n.prisKode,
      tekst: n.tekst,
    }));

  // ── Loftansættelse ──
  const loftNodes = (loftData?.['VUR_Loftansaettelse'] as { nodes: RawLoft[] } | undefined)?.nodes;
  empty.loft = (loftNodes ?? []).map((n) => ({
    basisaar: n.basisaar,
    grundvaerdi: n.grundvaerdi,
    pgf11: n.pgf11,
  }));

  // ── Fritagelser ──
  const fritagelseNodes = (
    fritagelseData?.['VUR_Fritagelse'] as { nodes: RawFritagelse[] } | undefined
  )?.nodes;
  empty.fritagelser = (fritagelseNodes ?? [])
    .sort((a, b) => a.loebenummer - b.loebenummer)
    .map((n) => ({
      loebenummer: n.loebenummer,
      artKode: n.artKode,
      beloeb: n.beloeb,
      ejendomTypeKode: n.ejendomTypeKode,
      omfangKode: n.omfangKode,
    }));

  // ── Fradrag for forbedring ──
  const fradragOverordnetNodes = (
    fradragOverordnetData?.['VUR_FradragForForbedringOverordnet'] as
      | {
          nodes: RawFradragOverordnet[];
        }
      | undefined
  )?.nodes;

  if (fradragOverordnetNodes?.length) {
    const overordnet = fradragOverordnetNodes[0];
    // Hent individuelle fradragsposter
    const posterData = await fetchVURGraphQL(
      `{ VUR_FradragForForbedring(first: 100, where: {
          fkFradragForForbedringOverordnetID: { eq: ${overordnet.FradragForForbedringOverordnetID} }
        }) {
          nodes { aar tekst vaerdi }
        }}`,
      token
    );
    const posterNodes = (
      posterData?.['VUR_FradragForForbedring'] as { nodes: RawFradragPost[] } | undefined
    )?.nodes;

    empty.fradrag = {
      foersteGangAar: overordnet.foersteGangAar,
      vaerdiSum: overordnet.vaerdiSum,
      poster: (posterNodes ?? []).map((p) => ({
        aar: p.aar,
        tekst: p.tekst,
        vaerdi: p.vaerdi,
      })),
    };
  }

  return empty;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse<VurderingResponse>> {
  const limited = await checkRateLimit(request, heavyRateLimit);
  if (limited) return limited as NextResponse<VurderingResponse>;
  const auth = await resolveTenantId();
  if (!auth)
    return NextResponse.json({ error: 'Unauthorized' } as unknown as VurderingResponse, {
      status: 401,
    });

  const emptyExtended = {
    fordeling: [] as FordelingData[],
    grundvaerdispec: [] as GrundvaerdispecifikationData[],
    loft: [] as LoftansaettelseData[],
    fritagelser: [] as FritagelseData[],
    fradrag: null as FradragData | null,
  };

  const clientId = process.env.DATAFORDELER_OAUTH_CLIENT_ID;
  const clientSecret = process.env.DATAFORDELER_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { vurdering: null, alle: [], ...emptyExtended, fejl: null, manglerNoegle: true },
      { status: 200 }
    );
  }

  // Validate query params with Zod schema
  const parsed = parseQuery(request, vurderingQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<VurderingResponse>;

  /* BIZZ-1094: Cache-first — tjek vurdering_cache før live API-kald */
  const bfeParam = parsed.data.bfeNummer;
  if (bfeParam) {
    try {
      const { createAdminClient } = await import('@/lib/supabase/admin');
      const admin = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: cached } = (await (admin as any)
        .from('vurdering_cache')
        .select('vurderinger, grundvaerdispec, fordeling, loft, fritagelser, fradrag, stale_after')
        .eq('bfe_nummer', Number(bfeParam))
        .maybeSingle()) as { data: Record<string, unknown> | null };

      if (
        cached?.vurderinger &&
        cached.stale_after &&
        new Date(String(cached.stale_after)) > new Date()
      ) {
        const vurderinger = cached.vurderinger as VurderingData[];
        const nyeste = vurderinger.length > 0 ? vurderinger[0] : null;
        return NextResponse.json(
          {
            vurdering: nyeste,
            alle: vurderinger,
            fordeling: (cached.fordeling ?? []) as FordelingData[],
            grundvaerdispec: (cached.grundvaerdispec ?? []) as GrundvaerdispecifikationData[],
            loft: (cached.loft ?? []) as LoftansaettelseData[],
            fritagelser: (cached.fritagelser ?? []) as FritagelseData[],
            fradrag: (cached.fradrag as FradragData) ?? null,
            fejl: null,
            manglerNoegle: false,
          },
          { headers: { 'Cache-Control': 'public, s-maxage=3600', 'X-Cache': 'HIT' } }
        );
      }
    } catch {
      /* Cache miss — fall through til live API */
    }
  }

  const bfeNummer = parseInt(parsed.data.bfeNummer, 10);
  const kommunekode = parsed.data.kommunekode ? parseInt(parsed.data.kommunekode, 10) : null;
  const promille = (kommunekode && GRUNDSKYLDSPROMILLE[kommunekode]) ?? null;

  const token = await getSharedOAuthToken();
  if (!token) {
    logger.error(
      '[vurdering] OAuth token kunne ikke hentes — tjek DATAFORDELER_OAUTH_CLIENT_ID og _SECRET'
    );
    return NextResponse.json(
      {
        vurdering: null,
        alle: [],
        ...emptyExtended,
        fejl: 'Ekstern API fejl',
        manglerNoegle: false,
      },
      { status: 200 }
    );
  }

  try {
    // Trin 1: Find vurderings-IDs via BFEKrydsreference
    const xrefQuery = `{
      VUR_BFEKrydsreference(first: 500, where: { BFEnummer: { eq: ${bfeNummer} } }) {
        nodes { fkEjendomsvurderingID }
      }
    }`;
    const xrefData = await fetchVURGraphQL(xrefQuery, token);

    const xrefNodes = (
      xrefData?.['VUR_BFEKrydsreference'] as { nodes: RawVURBFEKrydsreference[] } | undefined
    )?.nodes;

    if (!xrefNodes?.length) {
      return NextResponse.json(
        {
          vurdering: null,
          alle: [],
          ...emptyExtended,
          fejl: 'Ingen vurderingsdata fundet for dette BFEnummer',
          manglerNoegle: false,
        },
        { status: 200 }
      );
    }

    const ids = xrefNodes.map((n) => n.fkEjendomsvurderingID);
    const inClause = ids.join(', ');

    // Trin 2a: Udvidet query med juridisk kategori + ændringsdato + afgiftspligtige beløb
    const udvidetVurQuery = `{
      VUR_Ejendomsvurdering(
        first: 500,
        where: { id: { in: [${inClause}] } }
      ) {
        nodes {
          id aar
          ejendomvaerdiBeloeb grundvaerdiBeloeb
          ejendomvaerdiAfgiftspligtigBeloeb grundvaerdiAfgiftspligtigBeloeb
          vurderetAreal benyttelseKode
          juridiskKategoriTekst juridiskKategoriKode aendringDato aendringKode
        }
      }
    }`;

    // Trin 2b: Basis-query som fallback (uden afgiftspligtige beløb, men med juridisk kategori)
    const basisVurQuery = `{
      VUR_Ejendomsvurdering(
        first: 500,
        where: { id: { in: [${inClause}] } }
      ) {
        nodes {
          id aar
          ejendomvaerdiBeloeb grundvaerdiBeloeb
          vurderetAreal benyttelseKode
          juridiskKategoriTekst juridiskKategoriKode aendringDato aendringKode
        }
      }
    }`;

    // Prøv udvidet — fald tilbage til basis ved GraphQL-fejl
    let vurData = await fetchVURGraphQL(udvidetVurQuery, token);
    let harAfgiftspligtige = true;
    if (!vurData) {
      vurData = await fetchVURGraphQL(basisVurQuery, token);
      harAfgiftspligtige = false;
    }

    const vurNodes = (
      vurData?.['VUR_Ejendomsvurdering'] as { nodes: RawVURVurdering[] } | undefined
    )?.nodes;

    if (!vurNodes?.length) {
      return NextResponse.json(
        {
          vurdering: null,
          alle: [],
          ...emptyExtended,
          fejl: 'Ingen vurderingsdata fundet for dette BFEnummer',
          manglerNoegle: false,
        },
        { status: 200 }
      );
    }

    const sorted = [...vurNodes].sort(
      (a, b) =>
        (b.aar ?? 0) - (a.aar ?? 0) || (b.ejendomvaerdiBeloeb ?? 0) - (a.ejendomvaerdiBeloeb ?? 0)
    );
    const nyesteNode = sorted[0];

    /**
     * Mapper én rå VUR-node til VurderingData.
     * Beregner estimeret grundskyld hvis afgiftspligtig grundværdi og promille er kendte.
     */
    const mapNode = (n: RawVURVurdering): VurderingData => {
      const afgiftspligtigGrundvaerdi = harAfgiftspligtige
        ? (n.grundvaerdiAfgiftspligtigBeloeb ?? null)
        : null;
      const afgiftspligtigEjendomsvaerdi = harAfgiftspligtige
        ? (n.ejendomvaerdiAfgiftspligtigBeloeb ?? null)
        : null;

      const grundskyldGrundlag = afgiftspligtigGrundvaerdi ?? n.grundvaerdiBeloeb ?? null;
      // BIZZ-269: Use year-specific promille for historical accuracy
      const yearPromille = kommunekode ? getPromille(kommunekode, n.aar ?? null) : promille;
      const estimereretGrundskyld =
        grundskyldGrundlag !== null && yearPromille !== null
          ? Math.round(grundskyldGrundlag * (yearPromille / 1000))
          : null;

      return {
        bfeNummer,
        ejendomsvaerdi: n.ejendomvaerdiBeloeb ?? null,
        grundvaerdi: n.grundvaerdiBeloeb ?? null,
        afgiftspligtigEjendomsvaerdi,
        afgiftspligtigGrundvaerdi,
        estimereretGrundskyld,
        grundskyldspromille: yearPromille,
        aar: n.aar ?? null,
        bebyggelsesprocent: null,
        vurderetAreal: n.vurderetAreal ?? null,
        benyttelseskode: n.benyttelseKode ?? null,
        juridiskKategori: n.juridiskKategoriTekst ?? null,
        juridiskKategoriKode: n.juridiskKategoriKode ?? null,
        erNytSystem: !!n.juridiskKategoriKode && n.juridiskKategoriKode !== '0',
        aendringDato: n.aendringDato ?? null,
        aendringKode: n.aendringKode ?? null,
      };
    };

    // Trin 3: Hent udvidede data for den nyeste vurdering parallelt
    const udvidede = await fetchUdvidedeData(nyesteNode.id, ids, token);

    const vurdering = mapNode(nyesteNode);
    const alle = sorted.map(mapNode);

    return NextResponse.json(
      {
        vurdering,
        alle,
        ...udvidede,
        fejl: null,
        manglerNoegle: false,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      }
    );
  } catch (err) {
    Sentry.captureException(err);
    logger.error('[vurdering] Fejl:', err);
    return NextResponse.json(
      {
        vurdering: null,
        alle: [],
        ...emptyExtended,
        fejl: 'Ekstern API fejl',
        manglerNoegle: false,
      },
      { status: 200 }
    );
  }
}
