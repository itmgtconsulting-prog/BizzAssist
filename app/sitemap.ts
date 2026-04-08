/**
 * Dynamisk XML sitemap for BizzAssist offentlige sider.
 *
 * Genererer sitemap-entries for:
 *  1. Statiske sider (forside, login, vilkår etc.)
 *  2. Ejendomssider — de 10.000 største adresser fra DAWA, pagineret
 *  3. Virksomhedssider — de 10.000 største virksomheder fra CVR ES
 *
 * ISR: Revalideres dagligt (86400 sekunder).
 * URL-max per fil: 50.000 (Next.js App Router håndterer automatisk splitting).
 *
 * Fuld coverage via /sitemap/ejendomme/[page] og /sitemap/virksomheder/[page]
 * tilføjes via scheduled task efterhånden som indexering vokser.
 */

import type { MetadataRoute } from 'next';
import { generateEjendomSlug, generateVirksomhedSlug } from '@/app/lib/slug';

// ─── Konstanter ──────────────────────────────────────────────────────────────

/** Antal ejendomme der hentes til sitemap ved hver ISR-kørsel */
const MAX_EJENDOMME = 10_000;

/** Antal virksomheder der hentes til sitemap ved hver ISR-kørsel */
const MAX_VIRKSOMHEDER = 10_000;

/** DAWA paginerings-sidestørrelse (max 1000 pr. request) */
const DAWA_PAGE_SIZE = 1_000;

/** CVR ES paginerings-sidestørrelse */
const CVR_PAGE_SIZE = 1_000;

/** Basis-URL til applikationen */
const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://bizzassist.dk');

// ─── ISR cache: daglig opdatering ────────────────────────────────────────────
export const revalidate = 86400;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal DAWA adresse til sitemap-generering */
interface DawaAdresseMin {
  id: string;
  vejnavn: string;
  husnr: string;
  postnr: string;
  postnrnavn: string;
  bfenummer: number | null;
}

/** Minimal CVR virksomhed til sitemap-generering */
interface CvrVirksomhedMin {
  vat: number;
  name: string;
}

// ─── Data fetching ──────────────────────────────────────────────────────────

/**
 * Henter de {MAX_EJENDOMME} mest relevante adresser fra DAWA API.
 *
 * Sorterer efter kommunestørrelse (kommunekode ASC) for at prioritere
 * de tættest befolkede kommuner (København = 0101, Aarhus = 0751, etc.).
 * Paginerer automatisk med DAWA_PAGE_SIZE pr. request.
 *
 * @returns Liste af adresser med BFE-numre
 */
async function hentDawaAdresser(): Promise<DawaAdresseMin[]> {
  const adresser: DawaAdresseMin[] = [];
  let side = 1;

  while (adresser.length < MAX_EJENDOMME) {
    const hentCount = Math.min(DAWA_PAGE_SIZE, MAX_EJENDOMME - adresser.length);

    try {
      // Brug flad struktur for at få bfenummer direkte på objektet
      const url =
        `https://api.dataforsyningen.dk/adgangsadresser` +
        `?struktur=flad&per_side=${hentCount}&side=${side}` +
        `&sortering=kommunekode`;

      const res = await fetch(url, {
        next: { revalidate: 86400 },
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) break;

      const data: unknown[] = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const item of data) {
        const a = item as Record<string, unknown>;
        // BFE er ikke inkluderet i mini-struktur — vi bruger id som fallback
        adresser.push({
          id: String(a['id'] ?? ''),
          vejnavn: String(a['vejnavn'] ?? ''),
          husnr: String(a['husnr'] ?? ''),
          postnr: String(a['postnr'] ?? ''),
          postnrnavn: String(a['postnrnavn'] ?? ''),
          bfenummer: a['bfenummer'] != null ? Number(a['bfenummer']) : null,
        });
      }

      if (data.length < hentCount) break; // Sidste side
      side++;
    } catch {
      break;
    }
  }

  return adresser;
}

/**
 * Henter de {MAX_VIRKSOMHEDER} største/mest relevante aktive virksomheder
 * fra CVR ElasticSearch via den interne API-proxy.
 *
 * Sorterer efter antal ansatte DESC og filtrerer på aktive virksomheder.
 * Paginerer med CVR_PAGE_SIZE pr. request.
 *
 * @returns Liste af virksomheder med CVR-nummer og navn
 */
async function hentCvrVirksomheder(): Promise<CvrVirksomhedMin[]> {
  const virksomheder: CvrVirksomhedMin[] = [];

  // CVR ES kræver credentials fra environment
  const cvrUser = process.env.CVR_ES_USER ?? '';
  const cvrPass = process.env.CVR_ES_PASS ?? '';
  const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

  if (!cvrUser || !cvrPass) {
    // Credentials ikke konfigureret endnu — returnér tom liste uden fejl
    return virksomheder;
  }

  const authHeader = `Basic ${Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64')}`;

  for (let from = 0; virksomheder.length < MAX_VIRKSOMHEDER; from += CVR_PAGE_SIZE) {
    const hentCount = Math.min(CVR_PAGE_SIZE, MAX_VIRKSOMHEDER - virksomheder.length);

    try {
      // Hent aktive virksomheder sorteret efter antal ansatte DESC
      const query = {
        from,
        size: hentCount,
        sort: [
          {
            'Vrvirksomhed.virksomhedMetadata.nyesteMaanedsbeskaeftigelse.antalAnsatte': {
              order: 'desc',
              missing: '_last',
            },
          },
        ],
        _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn'],
        query: {
          bool: {
            must_not: [{ exists: { field: 'Vrvirksomhed.livsforloeb.periode.gyldigTil' } }],
          },
        },
      };

      const res = await fetch(CVR_ES_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(query),
        next: { revalidate: 86400 },
      });

      if (!res.ok) break;

      const data = (await res.json()) as {
        hits?: {
          hits?: Array<{
            _source: {
              Vrvirksomhed?: {
                cvrNummer?: number;
                virksomhedMetadata?: { nyesteNavn?: { navn?: string } };
              };
            };
          }>;
        };
      };

      const hits = data.hits?.hits;
      if (!Array.isArray(hits) || hits.length === 0) break;

      for (const hit of hits) {
        const vvs = hit._source?.Vrvirksomhed;
        const cvr = vvs?.cvrNummer;
        const navn = vvs?.virksomhedMetadata?.nyesteNavn?.navn;
        if (cvr && navn) {
          virksomheder.push({ vat: cvr, name: navn });
        }
      }

      if (hits.length < hentCount) break;
    } catch {
      break;
    }
  }

  return virksomheder;
}

// ─── Sitemap ─────────────────────────────────────────────────────────────────

/**
 * Genererer XML sitemap for BizzAssist.
 *
 * Next.js App Router kalder denne funktion og konverterer output til
 * sitemap.xml automatisk. Filer over 50.000 URLs splittes i sub-sitemaps.
 *
 * @returns MetadataRoute.Sitemap array med alle URL-entries
 */
/** True kun på bizzassist.dk production */
const isProduction =
  process.env.VERCEL_ENV === 'production' ||
  (!!process.env.NEXT_PUBLIC_APP_URL &&
    process.env.NEXT_PUBLIC_APP_URL.includes('bizzassist.dk') &&
    !process.env.NEXT_PUBLIC_APP_URL.includes('test.bizzassist.dk'));

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date().toISOString();

  // ── Statiske sider ─────────────────────────────────────────────────────────
  const statiske: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/login`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${BASE_URL}/login/signup`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/privacy`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
    {
      url: `${BASE_URL}/terms`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
    {
      url: `${BASE_URL}/cookies`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.1,
    },
  ];

  // På test/preview: returner kun statiske sider — ingen crawling af DAWA/CVR
  if (!isProduction) {
    return statiske;
  }

  // ── Ejendomssider ──────────────────────────────────────────────────────────
  let ejendomEntries: MetadataRoute.Sitemap = [];

  try {
    const adresser = await hentDawaAdresser();

    ejendomEntries = adresser
      .filter((a) => a.bfenummer && a.vejnavn && a.postnr)
      .map((a) => {
        const slug = generateEjendomSlug(a.vejnavn, a.husnr, a.postnr, a.postnrnavn);
        return {
          url: `${BASE_URL}/ejendom/${slug}/${a.bfenummer}`,
          lastModified: now,
          changeFrequency: 'monthly' as const,
          priority: 0.7,
        };
      });
  } catch {
    // Gå videre med tom liste — sitemap fejler ikke pga. DAWA-nedbrud
  }

  // ── Virksomhedssider ───────────────────────────────────────────────────────
  let virksomhedEntries: MetadataRoute.Sitemap = [];

  try {
    const virksomheder = await hentCvrVirksomheder();

    virksomhedEntries = virksomheder
      .filter((v) => v.vat && v.name)
      .map((v) => {
        const slug = generateVirksomhedSlug(v.name);
        return {
          url: `${BASE_URL}/virksomhed/${slug}/${v.vat}`,
          lastModified: now,
          changeFrequency: 'monthly' as const,
          priority: 0.7,
        };
      });
  } catch {
    // Gå videre med tom liste — sitemap fejler ikke pga. CVR-nedbrud
  }

  return [...statiske, ...ejendomEntries, ...virksomhedEntries];
}
