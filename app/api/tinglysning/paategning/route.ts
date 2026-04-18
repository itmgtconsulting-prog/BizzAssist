/**
 * GET /api/tinglysning/paategning?uuid={dokumentUuid}
 * GET /api/tinglysning/paategning?alias={dato-loebenummer}
 *
 * Henter det fulde revisionsspor for et tinglyst dokument fra
 * Tinglysningsrettens HTTP API — ændringer, delindfrielser, annulleringer,
 * påtegnede servitut-tilføjelser m.fl. siden den oprindelige tinglysning.
 *
 * Baggrund (BIZZ-522): Paategning-endpointet er kritisk for due diligence —
 * især for pantebreve hvor det er vigtigt at se om hæftelsen er delvist
 * indfriet, renteprocenten er ændret, eller dokumentet er aflyst. Indtil nu
 * har vi ikke brugt endpointet overhovedet.
 *
 * Endpoint-reference: http_api_beskrivelse_v1.12 afsnit 4.6.
 *
 * Retention: Tinglysning-data er offentligt tilgængelig; CDN-cache 7 dage
 * da påtegninger sjældent ændres efter de er registreret.
 *
 * @param uuid  - Dokument-UUID (alternativ til alias)
 * @param alias - Dato-løbenummer i formatet YYYYMMDD-NNNNNN (alternativ til uuid)
 * @returns PaategningData med kronologisk sorteret liste af revisioner
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { tlFetch as tlFetchShared } from '@/app/lib/tlFetch';
import { parseQuery } from '@/app/lib/validate';

export const runtime = 'nodejs';
export const maxDuration = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Én revision/påtegning på et dokument — typisk én linje i en timeline.
 * Rækkefølge i arrayet er kronologisk (ældste først) efter registreringsdato.
 */
export interface PaategningRevision {
  /** Revision-nummer (1 = oprindelig, 2+ = påtegninger) */
  nummer: number | null;
  /** Registreringsdato (ISO YYYY-MM-DD) — ældste til nyeste */
  dato: string | null;
  /** Påtegningstype — fx "paategning", "delindfrielse", "aflysning", "rettelse" */
  type: string;
  /** Fri beskrivelse/bemærkning fra e-TL hvis angivet */
  beskrivelse: string | null;
  /** Anmelders navn (person eller virksomhed) */
  anmelderNavn: string | null;
  /** Anmelders CVR hvis virksomhed */
  anmelderCvr: string | null;
  /** Dokument-UUID for selve revisions-dokumentet (til PDF-download) */
  dokumentId: string | null;
  /** Dato-løbenummer for revisions-dokumentet (menneskeligt læsbart) */
  dokumentAlias: string | null;
}

export interface PaategningData {
  /** Dokument-UUID søgt på (echoed eller resolveret fra alias) */
  uuid: string | null;
  /** Revisioner kronologisk — ældste først */
  revisioner: PaategningRevision[];
  /** Fejlbesked ved ekstern API-fejl */
  fejl?: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Paategning bruger /tinglysning/ssl/ prefix for S2S adgang. */
function tlFetchSsl(urlPath: string): Promise<{ status: number; body: string }> {
  return tlFetchShared(urlPath, { apiPath: '/tinglysning/ssl' });
}

/**
 * Normaliserer påtegningstype til vores standardtyper. Rå værdier fra e-TL
 * kan variere mellem fx "paategning", "delindfrielse", "aflysning",
 * "rettelse", "tilfoejelse". Ukendte strenge returneres uændret så de
 * overflader i UI'en frem for at blive tavst droppet.
 */
function normaliserType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('aflys')) return 'aflysning';
  if (lower.includes('delindfri')) return 'delindfrielse';
  if (lower.includes('indfri')) return 'indfrielse';
  if (lower.includes('rettelse') || lower.includes('korrektion')) return 'rettelse';
  if (lower.includes('tilfoejelse') || lower.includes('tilføjelse')) return 'tilfoejelse';
  if (lower.includes('paategn') || lower.includes('påtegn')) return 'paategning';
  return raw;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parser DokumentRevisionssporHentResultat XML og udtrækker revisioner.
 *
 * XML-skemaet er et DokumentRevisionsspor-element med en serie af
 * DokumentRevision-blokke, hver med revisionsnummer, type, dato,
 * anmelder-info og dokument-identifikatorer.
 *
 * @param xml - Rå XML-body fra /paategning/uuid/{uuid} eller /paategning/alias/{alias}
 * @returns Kronologisk sorteret liste af revisioner (ældste først)
 * @internal Eksporteret til tests
 */
export function parsePaategningXml(xml: string): PaategningRevision[] {
  const revisioner: PaategningRevision[] = [];

  // Hver revision findes i en DokumentRevision-blok. Regex tolererer både
  // bare tag-navn og namespace-prefix (fx "ns:DokumentRevision").
  const entries = [
    ...xml.matchAll(
      /<(?:[a-zA-Z0-9]+:)?DokumentRevision>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?DokumentRevision>/g
    ),
  ];

  for (const [, entry] of entries) {
    const nummerStr = entry.match(/RevisionNummer[^>]*>([^<]+)/)?.[1];
    const nummer = nummerStr ? parseInt(nummerStr, 10) : null;

    // Dato — forsøg flere feltnavne. e-TL bruger typisk RegistreringsDato
    // eller TinglysningsDato pr. revision.
    const datoRaw =
      entry.match(/RegistreringsDato[^>]*>([^<]+)/)?.[1] ??
      entry.match(/TinglysningsDato[^>]*>([^<]+)/)?.[1] ??
      entry.match(/DatoTid[^>]*>([^<]+)/)?.[1] ??
      null;
    const dato = datoRaw ? datoRaw.split('T')[0] : null;

    const rawType =
      entry.match(/PaategningType[^>]*>([^<]+)/)?.[1] ??
      entry.match(/RevisionType[^>]*>([^<]+)/)?.[1] ??
      entry.match(/DokumentType[^>]*>([^<]+)/)?.[1] ??
      'paategning';
    const type = normaliserType(rawType);

    // Beskrivelse — forsøg flere feltnavne
    const beskrivelse =
      entry.match(/Bemaerkning[^>]*>([^<]+)/)?.[1] ??
      entry.match(/Beskrivelse[^>]*>([^<]+)/)?.[1] ??
      entry.match(/Tekst[^>]*>([^<]+)/)?.[1] ??
      null;

    // Anmelder
    const anmelderBlock =
      entry.match(/AnmelderInformation[\s\S]*?<\/[^>]*AnmelderInformation/)?.[0] ?? '';
    const anmelderNavn =
      anmelderBlock.match(/PersonName[^>]*>([^<]+)/)?.[1] ??
      anmelderBlock.match(/LegalUnitName[^>]*>([^<]+)/)?.[1] ??
      null;
    const anmelderCvr = anmelderBlock.match(/CVRnumberIdentifier[^>]*>([^<]+)/)?.[1] ?? null;

    // Dokument-identifikatorer
    const dokumentId =
      entry.match(/DokumentIdentifikator[^>]*>([^<]+)/)?.[1] ??
      entry.match(/DokumentUUID[^>]*>([^<]+)/)?.[1] ??
      null;
    const dokumentAlias =
      entry.match(/DokumentAliasIdentifikator[^>]*>([^<]+)/)?.[1] ??
      entry.match(/AktHistoriskIdentifikator[^>]*>([^<]+)/)?.[1] ??
      null;

    revisioner.push({
      nummer,
      dato,
      type,
      beskrivelse,
      anmelderNavn,
      anmelderCvr,
      dokumentId,
      dokumentAlias,
    });
  }

  // Sortér kronologisk — primært på dato, sekundært på nummer.
  // Manglende datoer havner i slutningen.
  revisioner.sort((a, b) => {
    if (a.dato && !b.dato) return -1;
    if (!a.dato && b.dato) return 1;
    if (a.dato && b.dato && a.dato !== b.dato) return a.dato.localeCompare(b.dato);
    const na = a.nummer ?? Number.MAX_SAFE_INTEGER;
    const nb = b.nummer ?? Number.MAX_SAFE_INTEGER;
    return na - nb;
  });

  return revisioner;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

const querySchema = z
  .object({
    uuid: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'uuid skal være et UUID'
      )
      .optional(),
    alias: z
      .string()
      .regex(/^\d{8}-\d{6,}(-\d+)?$/, 'alias skal være dato-løbenummer (fx 19921016-900131-01)')
      .optional(),
  })
  .refine((v) => !!v.uuid || !!v.alias, {
    message: 'uuid eller alias kræves',
  });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'uuid eller alias parameter kræves' }, { status: 400 });
  }
  const { uuid, alias } = parsed.data;

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    const empty: PaategningData = {
      uuid: uuid ?? null,
      revisioner: [],
      fejl: 'Tinglysning certifikat ikke konfigureret',
    };
    return NextResponse.json(empty);
  }

  try {
    const path = uuid ? `/paategning/uuid/${uuid}` : `/paategning/alias/${alias}`;
    const res = await tlFetchSsl(path);

    if (res.status === 404) {
      // Dokument uden påtegninger — returner tom liste uden fejl
      return NextResponse.json({ uuid: uuid ?? null, revisioner: [] } satisfies PaategningData, {
        headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
      });
    }

    if (res.status !== 200) {
      logger.warn(`[tinglysning/paategning] HTTP ${res.status} for ${path}`);
      return NextResponse.json(
        { uuid: uuid ?? null, revisioner: [], fejl: 'Ekstern API fejl' } satisfies PaategningData,
        { status: res.status >= 500 ? 502 : res.status }
      );
    }

    const revisioner = parsePaategningXml(res.body);
    const data: PaategningData = { uuid: uuid ?? null, revisioner };

    return NextResponse.json(data, {
      headers: {
        // Påtegninger er så godt som immutable efter registrering — cache 7 dage.
        'Cache-Control': 'public, s-maxage=604800, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    logger.error('[tinglysning/paategning] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
