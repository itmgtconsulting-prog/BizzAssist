/**
 * GET /api/cvr-public/person?enhedsNummer=XXXXXXXXXX
 *
 * Henter alle virksomheder en person (eller virksomhed) deltager i fra CVR ES.
 * Returnerer persondata + virksomheder med roller, perioder, ejerandele.
 *
 * @param enhedsNummer - Deltagerens enhedsNummer fra CVR ES
 * @returns PersonPublicData objekt
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { proxyUrl } from '@/app/lib/dfProxy';

/** Zod schema for /api/cvr-public/person query params */
const querySchema = z.object({ enhedsNummer: z.string().regex(/^\d+$/, 'enhedsNummer skal være numerisk') });

// ─── Types ───────────────────────────────────────────────────────────────────

/** En rolle i en virksomhed */
export interface PersonRolle {
  /** Rollenavn (f.eks. DIREKTION, BESTYRELSE, EJER) */
  rolle: string;
  /** Startdato (ISO) */
  fra: string | null;
  /** Slutdato (ISO), null = stadig aktiv */
  til: string | null;
  /** Ejerandel som interval-streng */
  ejerandel: string | null;
  /** Stemmeret som interval-streng */
  stemmeandel: string | null;
}

/** En virksomhed personen har rolle i */
export interface PersonCompanyRole {
  /** CVR-nummer */
  cvr: number;
  /** Virksomhedsnavn */
  navn: string;
  /** Virksomhedsform (f.eks. Anpartsselskab) */
  form: string | null;
  /** Branchebeskrivelse */
  branche: string | null;
  /** Om virksomheden er aktiv */
  aktiv: boolean;
  /** Antal ansatte */
  ansatte: string | null;
  /** Adresse */
  adresse: string | null;
  /** Postnummer */
  postnr: string | null;
  /** By */
  by: string | null;
  /** Stiftelsesdato */
  stiftet: string | null;
  /** Roller personen har i denne virksomhed */
  roller: PersonRolle[];
}

/** API-response */
export interface PersonPublicData {
  /** Personens enhedsNummer */
  enhedsNummer: number;
  /** Personens navn */
  navn: string;
  /** Om personen er en virksomhed */
  erVirksomhed: boolean;
  /** Alle virksomheder personen har roller i */
  virksomheder: PersonCompanyRole[];
}

/** Fejl-response */
export interface PersonPublicError {
  error: string;
}

// ─── ES Config ──────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

/** Finder den gældende (åbne) periode i et tidsbestemt array */
function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/** Interval-koder fra CVR ES → læsbar streng */
const intervalKodeMap: Record<string, string> = {
  ANTAL_0_0: '0',
  ANTAL_1_1: '1',
  ANTAL_2_4: '2-4',
  ANTAL_5_9: '5-9',
  ANTAL_10_19: '10-19',
  ANTAL_20_49: '20-49',
  ANTAL_50_99: '50-99',
  ANTAL_100_199: '100-199',
  ANTAL_200_499: '200-499',
  ANTAL_500_999: '500-999',
  ANTAL_1000_999999: '1.000+',
};

/**
 * Mapper ejerandel decimal til interval-streng.
 *
 * @param val - Decimal-værdi fra EJERANDEL_PROCENT
 * @returns Læsbar interval-streng
 */
function mapEjerandelInterval(val: number): string {
  if (val >= 0.9) return '90-100%';
  if (val >= 0.6667) return '66.67-89.99%';
  if (val >= 0.5) return '50-66.66%';
  if (val >= 0.3334) return '33.34-49.99%';
  if (val >= 0.25) return '25-33.33%';
  if (val >= 0.2) return '20-24.99%';
  if (val >= 0.15) return '15-19.99%';
  if (val >= 0.1) return '10-14.99%';
  if (val >= 0.05) return '5-9.99%';
  return `${(val * 100).toFixed(1)}%`;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest
): Promise<NextResponse<PersonPublicData | PersonPublicError>> {
  const session = await resolveTenantId();
  if (!session)
    return NextResponse.json({ error: 'Unauthorized' } as PersonPublicError, { status: 401 });
  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) return parsed.response as NextResponse<PersonPublicError>;
  const { enhedsNummer } = parsed.data;

  if (!enhedsNummer) {
    return NextResponse.json({ error: 'Angiv ?enhedsNummer= parameter' }, { status: 400 });
  }

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ error: 'CVR-adgang ikke konfigureret' }, { status: 503 });
  }

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
  const enhedsNr = Number(enhedsNummer);

  try {
    // Søg alle virksomheder hvor denne enhedsNummer optræder som deltager
    const esQuery = {
      query: {
        bool: {
          must: [{ term: { 'Vrvirksomhed.deltagerRelation.deltager.enhedsNummer': enhedsNr } }],
        },
      },
      _source: [
        'Vrvirksomhed.cvrNummer',
        'Vrvirksomhed.navne',
        'Vrvirksomhed.virksomhedsform',
        'Vrvirksomhed.hovedbranche',
        'Vrvirksomhed.beliggenhedsadresse',
        'Vrvirksomhed.virksomhedsstatus',
        'Vrvirksomhed.virksomhedMetadata',
        'Vrvirksomhed.livsforloeb',
        'Vrvirksomhed.stiftelsesDato',
        'Vrvirksomhed.deltagerRelation',
      ],
      size: 200,
    };

    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(esQuery),
      signal: AbortSignal.timeout(12000),
      next: { revalidate: 3600 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `CVR ES fejl: ${res.status}` }, { status: 502 });
    }

    const data = (await res.json()) as { hits?: { hits?: Record<string, unknown>[] } };
    const hits = data.hits?.hits ?? [];

    if (hits.length === 0) {
      return NextResponse.json({ error: 'Person ikke fundet' }, { status: 404 });
    }

    // Udtræk personens navn og erVirksomhed fra første hit
    let personNavn = '';
    let erVirksomhed = false;

    const virksomheder: PersonCompanyRole[] = [];

    for (const hit of hits) {
      const src = (hit._source as Record<string, unknown>)?.Vrvirksomhed as
        | Record<string, unknown>
        | undefined;
      if (!src) continue;

      const cvr = typeof src.cvrNummer === 'number' ? src.cvrNummer : null;
      if (!cvr) continue;

      // Virksomhedsnavn
      const navne = Array.isArray(src.navne) ? (src.navne as (Periodic & { navn?: string })[]) : [];
      const navn = gyldigNu(navne)?.navn ?? '';

      // Form
      const formArr = Array.isArray(src.virksomhedsform)
        ? (src.virksomhedsform as (Periodic & { langBeskrivelse?: string })[])
        : [];
      const form = gyldigNu(formArr)?.langBeskrivelse ?? null;

      // Branche
      const brancheArr = Array.isArray(src.hovedbranche)
        ? (src.hovedbranche as (Periodic & { branchetekst?: string })[])
        : [];
      const branche = gyldigNu(brancheArr)?.branchetekst ?? null;

      // Adresse
      const adrArr = Array.isArray(src.beliggenhedsadresse)
        ? (src.beliggenhedsadresse as (Periodic & Record<string, unknown>)[])
        : [];
      const adr = gyldigNu(adrArr);
      const vejnavn = typeof adr?.vejnavn === 'string' ? adr.vejnavn : '';
      const husnr = typeof adr?.husnummerFra === 'number' ? String(adr.husnummerFra) : '';
      const bogstav = typeof adr?.bogstavFra === 'string' ? adr.bogstavFra : '';
      const adresse = vejnavn ? `${vejnavn} ${husnr}${bogstav}`.trim() : null;
      const postnr = typeof adr?.postnummer === 'number' ? String(adr.postnummer) : null;
      const by = typeof adr?.postdistrikt === 'string' ? adr.postdistrikt : null;

      // Status
      const statusArr = Array.isArray(src.virksomhedsstatus)
        ? (src.virksomhedsstatus as (Periodic & { status?: string; statuskode?: string })[])
        : [];
      const statusVal = gyldigNu(statusArr)?.status ?? gyldigNu(statusArr)?.statuskode ?? '';
      const meta = src.virksomhedMetadata as Record<string, unknown> | undefined;
      const sammensatStatus = typeof meta?.sammensatStatus === 'string' ? meta.sammensatStatus : '';
      const livsforloeb = Array.isArray(src.livsforloeb) ? (src.livsforloeb as Periodic[]) : [];
      const harSlutdato = livsforloeb.some((l) => l.periode?.gyldigTil != null);
      const aktiv =
        (statusVal === 'NORMAL' || statusVal === 'AKTIV' || statusVal === '') &&
        sammensatStatus !== 'Ophørt' &&
        !harSlutdato;

      // Ansatte
      const maanedsBeskæf = meta?.nyesteErstMaanedsbeskaeftigelse as
        | Record<string, unknown>
        | undefined;
      const ansatte =
        maanedsBeskæf?.antalAnsatte != null
          ? String(maanedsBeskæf.antalAnsatte)
          : maanedsBeskæf?.intervalKodeAntalAnsatte
            ? (intervalKodeMap[maanedsBeskæf.intervalKodeAntalAnsatte as string] ?? null)
            : null;

      const stiftet = typeof src.stiftelsesDato === 'string' ? src.stiftelsesDato : null;

      // Find personens roller i denne virksomhed
      const relationer = Array.isArray(src.deltagerRelation)
        ? (src.deltagerRelation as Record<string, unknown>[])
        : [];

      const roller: PersonRolle[] = [];

      for (const rel of relationer) {
        const deltager = rel.deltager as Record<string, unknown> | undefined;
        if (!deltager) continue;
        const dEnhedsNr = typeof deltager.enhedsNummer === 'number' ? deltager.enhedsNummer : null;
        if (dEnhedsNr !== enhedsNr) continue;

        // Hent personens navn fra første match
        if (!personNavn) {
          const dnavne = Array.isArray(deltager.navne)
            ? (deltager.navne as (Periodic & { navn?: string })[])
            : [];
          personNavn = gyldigNu(dnavne)?.navn ?? '';
          const enhedstype = typeof deltager.enhedstype === 'string' ? deltager.enhedstype : '';
          erVirksomhed = enhedstype !== '' ? enhedstype !== 'PERSON' : false;
        }

        // Udtræk roller fra organisationer
        const orgs = Array.isArray(rel.organisationer)
          ? (rel.organisationer as Record<string, unknown>[])
          : [];

        for (const org of orgs) {
          const orgNavne = Array.isArray(org.organisationsNavn)
            ? (org.organisationsNavn as (Periodic & { navn?: string })[])
            : [];

          // Alle perioder af denne rolle
          for (const on of orgNavne) {
            const rolleNavn = on.navn ?? '';
            if (!rolleNavn) continue;

            const fra = on.periode?.gyldigFra ?? null;
            const til = on.periode?.gyldigTil ?? null;

            // Find ejerandel/stemmeret fra medlemsData
            let ejerandel: string | null = null;
            let stemmeandel: string | null = null;

            const medl = Array.isArray(org.medlemsData)
              ? (org.medlemsData as Record<string, unknown>[])
              : [];
            for (const m of medl) {
              const attrs = Array.isArray(m.attributter)
                ? (m.attributter as Record<string, unknown>[])
                : [];
              for (const attr of attrs) {
                const type = typeof attr.type === 'string' ? attr.type : '';
                const vaerdier = Array.isArray(attr.vaerdier)
                  ? (attr.vaerdier as (Periodic & { vaerdi?: string | number })[])
                  : [];
                // Only use currently valid values — expired ejerandel should not be returned
                const currentVal = vaerdier.find((v) => v.periode?.gyldigTil == null);
                const val = currentVal?.vaerdi;
                const parsed = typeof val === 'number' ? val : parseFloat(String(val ?? ''));
                if (!isNaN(parsed)) {
                  if (type === 'EJERANDEL_PROCENT') ejerandel = mapEjerandelInterval(parsed);
                  if (type === 'EJERANDEL_STEMMERET_PROCENT')
                    stemmeandel = mapEjerandelInterval(parsed);
                }
              }
            }

            roller.push({ rolle: rolleNavn, fra, til, ejerandel, stemmeandel });
          }
        }
      }

      if (roller.length > 0) {
        // Sortér: aktive først, derefter nyeste
        roller.sort((a, b) => {
          if (!a.til && b.til) return -1;
          if (a.til && !b.til) return 1;
          return (b.fra ?? '').localeCompare(a.fra ?? '');
        });

        virksomheder.push({
          cvr,
          navn,
          form,
          branche,
          aktiv,
          ansatte,
          adresse,
          postnr,
          by,
          stiftet,
          roller,
        });
      }
    }

    // Sortér virksomheder: aktive først, derefter med ejerandel, derefter alfabetisk
    virksomheder.sort((a, b) => {
      if (a.aktiv !== b.aktiv) return a.aktiv ? -1 : 1;
      const aHasOwner = a.roller.some((r) => r.ejerandel != null);
      const bHasOwner = b.roller.some((r) => r.ejerandel != null);
      if (aHasOwner !== bHasOwner) return aHasOwner ? -1 : 1;
      return a.navn.localeCompare(b.navn, 'da');
    });

    return NextResponse.json(
      { enhedsNummer: enhedsNr, navn: personNavn, erVirksomhed, virksomheder },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json({ error: `Netværksfejl: ${msg}` }, { status: 500 });
  }
}
