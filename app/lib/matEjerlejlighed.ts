/**
 * MAT (Matriklen) GraphQL helper: tinglyst ejerlejligheds-areal og
 * ejerlejlighedsnummer pr. BFE.
 *
 * BIZZ-2061 (Resights-paritet for Ejendomsstruktur): Erhvervs-ejerlejligheder
 * (fx lager/kontor som Hammerholmen 44-48) findes typisk IKKE i BBR_Enhed —
 * verificeret live 2026-06-10: 0 BBR_Enhed-match for alle 17 enheder på
 * matrikel 21851/43cr, både via enhedsadresse- og adgangsadresse-id. Det
 * autoritative areal for en ejerlejlighed er Matriklens registrerede
 * (tinglyste) areal: MAT_Ejerlejlighed.samletAreal. Samme node giver
 * ejerlejlighedsnummer ("nr. 1"-visning).
 *
 * Ét batch-kald med `BFEnummer: { in: [...] }` dækker alle enheder på en
 * matrikel — ingen per-enhed fan-out mod Datafordeler.
 *
 * @module app/lib/matEjerlejlighed
 */
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { MAT_GQL_ENDPOINT } from '@/app/lib/serviceEndpoints';
import { logger } from '@/app/lib/logger';

/** Matrikel-oplysninger for én ejerlejlighed (delmængde af MAT_Ejerlejlighed). */
export interface MatEjerlejlighedInfo {
  /** Tinglyst samlet areal i m² (MAT_Ejerlejlighed.samletAreal) */
  areal: number | null;
  /** Ejerlejlighedsnummer på hovedejendommen (fx "1") */
  ejerlejlighedsnummer: string | null;
}

/**
 * Bitemporal timestamp i Datafordeler-format med tidszoneoffset
 * (fx "2026-06-10T12:00:00+02:00") — kræves af virkningstid/registreringstid.
 */
function nowDafTimestamp(): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${hh}:${mm}`
  );
}

/**
 * Henter tinglyst areal + ejerlejlighedsnummer for en liste af BFE-numre
 * via MAT_Ejerlejlighed (MAT/v2, batch in-filter).
 *
 * Returnerer kun "Gældende"-noder. Tomt Map ved fejl/manglende API-nøgle —
 * kaldere skal tåle hullet (areal forbliver null).
 *
 * @param bfes - BFE-numre (positive heltal; ugyldige værdier filtreres fra)
 * @returns Map BFE → { areal, ejerlejlighedsnummer }
 */
export async function fetchMatEjerlejlighederByBfe(
  bfes: number[]
): Promise<Map<number, MatEjerlejlighedInfo>> {
  const result = new Map<number, MatEjerlejlighedInfo>();
  // Hård validering: kun positive heltal må interpoleres i query-strengen
  const safeBfes = [...new Set(bfes)].filter((b) => Number.isInteger(b) && b > 0);
  if (safeBfes.length === 0) return result;

  const DF_API_KEY = process.env.DATAFORDELER_API_KEY ?? '';
  if (!DF_API_KEY) return result;

  const now = nowDafTimestamp();
  const query = `{
    MAT_Ejerlejlighed(
      first: ${Math.min(safeBfes.length * 2, 500)}
      virkningstid: "${now}"
      registreringstid: "${now}"
      where: { BFEnummer: { in: [${safeBfes.join(',')}] } }
    ) {
      nodes { BFEnummer ejerlejlighedsnummer samletAreal status }
    }
  }`;

  try {
    const url = proxyUrl(`${MAT_GQL_ENDPOINT}?apiKey=${DF_API_KEY}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...proxyHeaders() },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      logger.warn(`[MAT ejerlejlighed] HTTP ${res.status}`);
      return result;
    }
    const json = (await res.json()) as {
      data?: {
        MAT_Ejerlejlighed?: {
          nodes?: Array<{
            BFEnummer?: number;
            ejerlejlighedsnummer?: string | null;
            samletAreal?: number | null;
            status?: string | null;
          }>;
        };
      };
      errors?: unknown[];
    };
    if (json.errors?.length) {
      logger.warn('[MAT ejerlejlighed] GraphQL errors:', JSON.stringify(json.errors).slice(0, 400));
      return result;
    }
    for (const node of json.data?.MAT_Ejerlejlighed?.nodes ?? []) {
      if (!node.BFEnummer || node.status !== 'Gældende') continue;
      result.set(node.BFEnummer, {
        areal:
          typeof node.samletAreal === 'number' && node.samletAreal > 0 ? node.samletAreal : null,
        ejerlejlighedsnummer: node.ejerlejlighedsnummer ?? null,
      });
    }
  } catch (err) {
    logger.warn('[MAT ejerlejlighed] fetch failed:', err);
  }
  return result;
}
