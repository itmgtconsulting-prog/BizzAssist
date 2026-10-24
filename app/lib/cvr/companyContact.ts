/**
 * getCompanyContact — henter OFFENTLIG virksomheds-kontakt (adresse, telefon,
 * email) for et CVR-nummer fra Erhvervsstyrelsens CVR OpenData
 * (distribution.virk.dk / CVR_ES_USER+PASS).
 *
 * Telefon og email er ofte tomme på virksomheds-niveau i den officielle
 * distribution; i så fald hentes de fra virksomhedens aktive produktionsenhed
 * (P-enhed), hvor de typisk er registreret (samme kilde som /api/cvr-public).
 *
 * BIZZ-2303: Bruges af person-kontaktsøgningen til at berige med selskabs-
 * kontakt — web-søgning alene finder sjældent kontakt for danske privatpersoner.
 *
 * Databeskyttelse: KUN offentlige virksomhedsdata fra CVR — ingen person-PII.
 * Retention: ingen persistens; CVR ES-svar caches 1 time (next.revalidate).
 *
 * @module app/lib/cvr/companyContact
 */

import { logger } from '@/app/lib/logger';

/** Rod-URL til Erhvervsstyrelsens CVR OpenData ElasticSearch. */
const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

/** Normaliseret offentlig virksomheds-kontakt. */
export interface CompanyContact {
  /** 8-cifret CVR-nummer (streng) */
  cvr: string;
  /** Virksomhedsnavn (gældende) eller null */
  navn: string | null;
  /** Formateret adresse "Vejnavn 42A, 2650 Hvidovre" eller null */
  adresse: string | null;
  /** Telefonnummer (virksomhed eller P-enhed) eller null */
  telefon: string | null;
  /** Email (virksomhed eller P-enhed) eller null */
  email: string | null;
}

/** Tidsbestemt CVR-element med åben/lukket periode. */
type Periodic = { periode?: { gyldigTil?: string | null } };

/**
 * Finder det gældende (åbne) element i et tidsbestemt CVR-array; falder tilbage
 * til det sidst kendte element.
 *
 * @param arr - Array med tidsbestemte CVR-objekter
 * @returns Det gældende element eller null
 */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/** Henter kontaktoplysning-strengen fra et gældende kontakt-array (tlf/email). */
function kontaktNu(arr: unknown): string | null {
  const list = Array.isArray(arr) ? (arr as (Periodic & { kontaktoplysning?: string })[]) : [];
  return gyldigNu(list)?.kontaktoplysning ?? null;
}

/**
 * Kører en ES _search mod et CVR-index og returnerer hits-arrayet (best-effort).
 *
 * @param index - ES-index ("virksomhed" | "produktionsenhed")
 * @param body  - ES query-body
 * @param auth  - Base64 Basic-auth streng
 * @returns Array af ES-hits (tom ved fejl)
 */
async function esSearch(
  index: string,
  body: unknown,
  auth: string
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${CVR_ES_BASE}/${index}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { hits?: { hits?: Record<string, unknown>[] } };
  return data.hits?.hits ?? [];
}

/**
 * Formaterer en CVR-beliggenhedsadresse til "Vejnavn 42A, 2650 By".
 *
 * @param adr - Rå beliggenhedsadresse-objekt eller null
 * @returns Formateret adresse eller null
 */
function formatAdresse(adr: Record<string, unknown> | null): string | null {
  if (!adr) return null;
  const vej = typeof adr.vejnavn === 'string' ? adr.vejnavn : '';
  const hus = typeof adr.husnummerFra === 'number' ? String(adr.husnummerFra) : '';
  const bogstav = typeof adr.bogstavFra === 'string' ? adr.bogstavFra : '';
  const postnr = typeof adr.postnummer === 'number' ? String(adr.postnummer) : '';
  const by = typeof adr.postdistrikt === 'string' ? adr.postdistrikt : '';
  const linje1 = `${vej} ${hus}${bogstav}`.trim();
  const linje2 = `${postnr} ${by}`.trim();
  const full = [linje1, linje2].filter(Boolean).join(', ');
  return full || null;
}

/**
 * Henter offentlig kontakt (adresse + telefon + email) for ét CVR-nummer.
 * Returnerer null hvis CVR-adgang mangler, selskabet ikke findes, eller der
 * ikke kunne udledes nogen kontaktoplysning.
 *
 * @param cvr - 8-cifret CVR-nummer
 * @returns CompanyContact eller null
 */
export async function getCompanyContact(cvr: number): Promise<CompanyContact | null> {
  const user = process.env.CVR_ES_USER;
  const pass = process.env.CVR_ES_PASS;
  if (!user || !pass || !Number.isFinite(cvr)) return null;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');

  try {
    // ── 1) Virksomhed: navn, adresse, (evt.) telefon/email ──
    const vHits = await esSearch(
      'virksomhed',
      {
        query: { term: { 'Vrvirksomhed.cvrNummer': cvr } },
        _source: [
          'Vrvirksomhed.navne',
          'Vrvirksomhed.beliggenhedsadresse',
          'Vrvirksomhed.telefonnummer',
          'Vrvirksomhed.emailadresse',
        ],
        size: 1,
      },
      auth
    );
    const v = (vHits[0]?._source as Record<string, unknown> | undefined)?.Vrvirksomhed as
      | Record<string, unknown>
      | undefined;
    if (!v) return null;

    const navn = gyldigNu((v.navne as (Periodic & { navn?: string })[]) ?? [])?.navn ?? null;
    const adresse = formatAdresse(
      gyldigNu((v.beliggenhedsadresse as (Periodic & Record<string, unknown>)[]) ?? [])
    );
    let telefon = kontaktNu(v.telefonnummer);
    let email = kontaktNu(v.emailadresse);

    // ── 2) Fald tilbage til aktiv P-enhed for telefon/email hvis tomt ──
    if (!telefon || !email) {
      const peHits = await esSearch(
        'produktionsenhed',
        {
          query: {
            nested: {
              path: 'VrproduktionsEnhed.virksomhedsrelation',
              query: {
                bool: {
                  must: [{ term: { 'VrproduktionsEnhed.virksomhedsrelation.cvrNummer': cvr } }],
                  must_not: [
                    {
                      exists: {
                        field: 'VrproduktionsEnhed.virksomhedsrelation.periode.gyldigTil',
                      },
                    },
                  ],
                },
              },
            },
          },
          _source: ['VrproduktionsEnhed.telefonNummer', 'VrproduktionsEnhed.elektroniskPost'],
          size: 5,
        },
        auth
      );
      for (const hit of peHits) {
        const pe = (hit._source as Record<string, unknown> | undefined)?.VrproduktionsEnhed as
          | Record<string, unknown>
          | undefined;
        if (!pe) continue;
        telefon = telefon ?? kontaktNu(pe.telefonNummer);
        email = email ?? kontaktNu(pe.elektroniskPost);
        if (telefon && email) break;
      }
    }

    if (!adresse && !telefon && !email) return null;
    return { cvr: String(cvr), navn, adresse, telefon, email };
  } catch (e: unknown) {
    logger.warn('[getCompanyContact] fejl:', e instanceof Error ? e.message : e);
    return null;
  }
}
