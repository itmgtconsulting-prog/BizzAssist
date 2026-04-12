/**
 * Offentlig SEO-side for en dansk ejendom.
 *
 * URL-format: /ejendom/arnold-nielsens-boulevard-62a-2650-hvidovre/226630
 *
 * Viser offentligt tilgængeligt basis-data fra BBR og Vurderingsportalen
 * uden login-krav. Avancerede data (ejere, tinglysning, salgshistorik)
 * kræver login og vises bag en CTA-blok.
 *
 * ISR: revalidate = 3600 (1 time)
 *
 * @param params.slug - SEO-venlig adresse-slug (dekorativ, bruges ikke til datahentning)
 * @param params.bfe  - BFE-nummer (BBR-ejendomsnummer), bruges til alle API-kald
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import JsonLdScript from '@/app/components/JsonLd';
import {
  MapPin,
  Home,
  Calendar,
  Hash,
  Building2,
  TrendingUp,
  Lock,
  ArrowRight,
} from 'lucide-react';
import { bygAnvendelseTekst, ejerforholdTekst } from '@/app/lib/bbrKoder';
import { generateEjendomSlug } from '@/app/lib/slug';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { darHentAdresse } from '@/app/lib/dar';
import PublicPricingSection from '@/app/(public)/components/PublicPricingSection';
import { logger } from '@/app/lib/logger';

// ─── Vurderingsportalen ES types ─────────────────────────────────────────────

/** Rå _source fra Vurderingsportalens Elasticsearch */
interface VPEsSource {
  adgangsAdresseID?: string;
  roadName?: string;
  houseNumber?: string;
  door?: string;
  floor?: string;
  zipcode?: string;
  postDistrict?: string;
  municipalityNumber?: string;
  isParentProperty?: boolean;
  bfeNumbers?: string;
}

/** Elasticsearch response wrapper */
interface VPEsResponse {
  hits?: {
    hits?: Array<{ _source: VPEsSource }>;
  };
}

// ─── ISR cache-periode ───────────────────────────────────────────────────────
// 3600 sekunder (1 time) — BBR-data bekræftet fungerende.
export const revalidate = 3600;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Komprimeret adresse-data fra DAWA */
interface DawaAdresse {
  id: string;
  /** Alle adgangsadresse-UUIDs på samme jordstykke — bruges til BBR-opslag */
  alleIds: string[];
  vejnavn: string;
  husnr: string;
  etage: string | null;
  dør: string | null;
  postnr: string;
  postnrnavn: string;
  kommunenavn: string;
  kommunekode: string;
  x: number;
  y: number;
  jordstykke?: {
    matrikelnr: string;
    ejerlav: { navn: string };
    registreretAreal: number;
  } | null;
}

/** Subset af BBR bygning-data vi bruger på den offentlige side */
interface BbrBygning {
  byg026Opfoerelsesaar?: number;
  byg038SamletBygningsareal?: number;
  byg039BygningensSamledeBoligAreal?: number;
  byg041BebyggetAreal?: number;
  byg054AntalEtager?: number;
  byg021BygningensAnvendelse?: string;
  byg066Ejerforhold?: string;
  status?: string;
}

/** Subset af vurderings-data vi bruger på den offentlige side */
interface VurderingData {
  ejendomsvaerdi?: number;
  grundvaerdi?: number;
  vurderingsaar?: number;
}

/** Samlet data til siden */
interface EjendomPublicData {
  adresse: DawaAdresse | null;
  bbr: BbrBygning | null;
  vurdering: VurderingData | null;
  fejl: string | null;
}

// ─── Data fetching ──────────────────────────────────────────────────────────

/**
 * Henter adresse-data via Vurderingsportalens Elasticsearch-API og DAR GraphQL.
 *
 * Strategi (undgår direkte DAWA-kald fra Vercel US-servere):
 *  1. Slår BFE op i Vurderingsportalens ES (api-fs.vurderingsportalen.dk) —
 *     returnerer adgangsAdresseID (DAWA UUID) + basale adressefelter.
 *  2. Kalder darHentAdresse(adgangsAdresseID) via DAR GraphQL (Hetzner-proxy) —
 *     returnerer fuld adresse inkl. koordinater.
 *
 * DAWA (api.dataforsyningen.dk) bruges ikke direkte da det er ustabilt fra
 * Vercels US-servere. Vurderingsportalen ES og DAR GraphQL er begge tilgængelige.
 *
 * @param bfe  - BFE-nummer
 * @param slug - URL-slug fra params (bruges til at matche den rette adresse)
 * @returns Adresse-objekt eller null
 */
async function hentDawaAdresse(bfe: string, slug: string): Promise<DawaAdresse | null> {
  try {
    // Trin 1: BFE → adgangsAdresseID via Vurderingsportalens ES.
    // Browser User-Agent krævet for at undgå CloudFront WAF 403.
    const esRes = await fetch(
      'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({
          size: 10,
          query: { bool: { filter: [{ term: { bfeNumbers: String(bfe) } }] } },
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!esRes.ok) {
      logger.error(`[PUBLIC EJENDOM] VP ES ${esRes.status} for BFE ${bfe}`);
      return null;
    }

    const esData = (await esRes.json()) as VPEsResponse;
    const hits = esData.hits?.hits ?? [];
    if (hits.length === 0) {
      logger.error(`[PUBLIC EJENDOM] Ingen VP ES hits for BFE ${bfe}`);
      return null;
    }

    // Vælg det hit hvis slug matcher URL-parameteret. Fallback til første hit.
    const matchedHit =
      hits.find((h) => {
        const s = h._source;
        const kandidatSlug = generateEjendomSlug(
          s.roadName ?? '',
          s.houseNumber ?? '',
          s.zipcode ?? '',
          s.postDistrict ?? ''
        );
        return kandidatSlug === slug;
      }) ?? hits[0];

    const src = matchedHit._source;
    const adgangsAdresseId = src.adgangsAdresseID;

    if (!adgangsAdresseId) {
      logger.error(`[PUBLIC EJENDOM] Mangler adgangsAdresseID i VP ES svar for BFE ${bfe}`);
      return null;
    }

    // Trin 2: adgangsAdresseID → fuld adresse + koordinater via DAR GraphQL (Hetzner-proxy).
    const darAdresse = await darHentAdresse(adgangsAdresseId);

    // Kommunekode: VP returnerer f.eks. "157", DAR returnerer "0157".
    // Brug DAR's kommunenavn; kommunekode paddes til 4 cifre.
    const kommunekodeRaw = src.municipalityNumber ?? '';
    const kommunekode = kommunekodeRaw.padStart(4, '0');

    if (darAdresse) {
      return {
        id: adgangsAdresseId,
        alleIds: [adgangsAdresseId],
        vejnavn: darAdresse.vejnavn,
        husnr: darAdresse.husnr,
        etage: darAdresse.etage ?? null,
        dør: darAdresse.dør ?? null,
        postnr: darAdresse.postnr || src.zipcode || '',
        postnrnavn: darAdresse.postnrnavn || src.postDistrict || '',
        kommunenavn: darAdresse.kommunenavn,
        kommunekode,
        x: darAdresse.x,
        y: darAdresse.y,
        // Jordstykke (matrikelnr/ejerlav) hentes ikke her — vises som null
        // hvis det ikke allerede er tilgængeligt. Kan udvides via MAT WFS.
        jordstykke: null,
      };
    }

    // Trin 2 fallback: DAR fejlede — brug VP-adressefelter (ingen koordinater)
    logger.warn(`[PUBLIC EJENDOM] DAR fejlede for ${adgangsAdresseId} — bruger VP fallback`);
    return {
      id: adgangsAdresseId,
      alleIds: [adgangsAdresseId],
      vejnavn: src.roadName ?? '',
      husnr: src.houseNumber ?? '',
      etage: src.floor ?? null,
      dør: src.door ?? null,
      postnr: src.zipcode ?? '',
      postnrnavn: src.postDistrict ?? '',
      kommunenavn: '',
      kommunekode,
      x: 0,
      y: 0,
      jordstykke: null,
    };
  } catch (err) {
    logger.error(
      '[PUBLIC EJENDOM] hentDawaAdresse fejl:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Henter BBR bygning-data direkte via fetchBbrForAddress (ingen HTTP round-trip).
 *
 * Kalder det delte utility direkte i stedet for at lave et HTTP-kald til
 * /api/ejendom/[id], som ikke virker pålideligt under Vercel SSR fordi der
 * ikke er en kørende server at kalde under server-side rendering.
 *
 * @param dawaId - DAWA adgangsadresse UUID (første UUID fra jordstykkets adresser)
 * @returns Primær aktiv BBR bygning mappet til BbrBygning, eller null
 */
async function hentBbrBygning(dawaId: string): Promise<BbrBygning | null> {
  try {
    logger.error(`[BBR PUBLIC] fetchBbrForAddress dawaId=${dawaId}`);

    const data = await fetchBbrForAddress(dawaId);

    if (data.bbrFejl) {
      logger.error(`[BBR PUBLIC] bbrFejl=${data.bbrFejl} for dawaId=${dawaId}`);
    }

    if (!data.bbr || data.bbr.length === 0) {
      logger.error(
        `[BBR PUBLIC] Ingen bygninger returneret — dawaId=${dawaId}, bbrFejl=${data.bbrFejl ?? 'null'}`
      );
      return null;
    }

    logger.error(`[BBR PUBLIC] ${data.bbr.length} bygning(er) for dawaId=${dawaId}`);

    // Vælg primær bygning: foretræk beboelsesbygninger (110–199) frem for
    // udhuse/carporte (500+). Sekundær sortering på samlet areal (størst = primær).
    // status er normaliseret tekst fra normaliseBygning — "Bygning opført" = aktiv (kode 3+6).
    const isBolig = (b: { anvendelseskode: number | null }) => {
      const kode = b.anvendelseskode ?? 0;
      return kode >= 110 && kode <= 199;
    };

    const aktive = data.bbr.filter((b) => b.status === 'Bygning opført');
    const kandidater = aktive.length > 0 ? aktive : data.bbr;
    const boligBygninger = kandidater.filter(isBolig);
    const pool = boligBygninger.length > 0 ? boligBygninger : kandidater;
    const node = pool.reduce(
      (best, cur) =>
        (cur.samletBygningsareal ?? 0) > (best.samletBygningsareal ?? 0) ? cur : best,
      pool[0]
    );

    logger.error(
      `[BBR PUBLIC] Primær bygning: anvendelseskode=${node.anvendelseskode}, ` +
        `samletBygningsareal=${node.samletBygningsareal}, ` +
        `samletBoligareal=${node.samletBoligareal}, ` +
        `opfoerelsesaar=${node.opfoerelsesaar}, ` +
        `antalEtager=${node.antalEtager}, ` +
        `ejerforholdskode=${node.ejerforholdskode}`
    );

    // Map LiveBBRBygning (normaliseret) tilbage til BbrBygning (rå felter) så render-koden
    // ikke skal ændres. byg021BygningensAnvendelse sendes som numerisk streng da
    // bygAnvendelseTekst() kalder Number() på det.
    return {
      byg026Opfoerelsesaar: node.opfoerelsesaar ?? undefined,
      byg038SamletBygningsareal: node.samletBygningsareal ?? undefined,
      byg039BygningensSamledeBoligAreal: node.samletBoligareal ?? undefined,
      byg041BebyggetAreal: node.bebyggetAreal ?? undefined,
      byg054AntalEtager: node.antalEtager ?? undefined,
      byg021BygningensAnvendelse:
        node.anvendelseskode != null ? String(node.anvendelseskode) : undefined,
      byg066Ejerforhold: node.ejerforholdskode ?? undefined,
      status: node.status ?? undefined,
    };
  } catch (err) {
    logger.error('[BBR PUBLIC] Uventet fejl:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Henter den seneste offentlige vurdering fra Vurderingsportalen via intern proxy.
 *
 * @param bfe - BFE-nummer
 * @param kommunekode - 3-cifret kommunekode (til grundskyldberegning)
 * @param baseUrl - Absolut URL til applikationen
 * @returns Vurderings-data eller null
 */
async function hentVurdering(
  bfe: string,
  kommunekode: string,
  baseUrl: string
): Promise<VurderingData | null> {
  try {
    const params = new URLSearchParams({ bfeNummer: bfe });
    if (kommunekode) params.set('kommunekode', kommunekode);

    const res = await fetch(`${baseUrl}/api/vurdering?${params}`, {
      next: { revalidate: 604800 },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      vurdering?: {
        ejendomsvaerdi?: number;
        grundvaerdi?: number;
        vurderingsaar?: number;
      } | null;
      fejl?: string | null;
    };

    if (!data.vurdering) return null;

    return {
      ejendomsvaerdi: data.vurdering.ejendomsvaerdi,
      grundvaerdi: data.vurdering.grundvaerdi,
      vurderingsaar: data.vurdering.vurderingsaar,
    };
  } catch {
    return null;
  }
}

/**
 * Aggregerer alle offentlige data til en ejendom.
 *
 * @param bfe  - BFE-nummer fra URL
 * @param slug - URL-slug fra params (bruges til adresse-matching)
 * @returns EjendomPublicData med adresse, BBR og vurdering
 */
async function hentEjendomData(bfe: string, slug: string): Promise<EjendomPublicData> {
  // Appens base URL — nødvendig for at kalde interne API-routes server-side (vurdering)
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  // Hent adresse fra DAWA (gratis, ingen auth)
  const adresse = await hentDawaAdresse(bfe, slug);

  if (!adresse) {
    return { adresse: null, bbr: null, vurdering: null, fejl: 'Ejendom ikke fundet' };
  }

  // Hent BBR og vurdering parallelt.
  // BBR hentes via fetchBbrForAddress direkte (ingen HTTP round-trip) — se app/lib/fetchBbrData.ts.
  // adresse.id er det første adgangsadresse-UUID fra jordstykket.
  const [bbr, vurdering] = await Promise.all([
    hentBbrBygning(adresse.id),
    hentVurdering(bfe, adresse.kommunekode, baseUrl),
  ]);

  return { adresse, bbr, vurdering, fejl: null };
}

// ─── generateMetadata ───────────────────────────────────────────────────────

/**
 * Genererer unik SEO-metadata for ejendomssiden.
 *
 * @param params - URL-parametre (slug + bfe)
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; bfe: string }>;
}): Promise<Metadata> {
  const { bfe, slug } = await params;
  const { adresse, bbr, vurdering } = await hentEjendomData(bfe, slug);

  if (!adresse) {
    return {
      title: 'Ejendom ikke fundet — BizzAssist',
      description: 'Ejendomsdata ikke tilgængeligt.',
    };
  }

  const adresseStr = `${adresse.vejnavn} ${adresse.husnr}, ${adresse.postnr} ${adresse.postnrnavn}`;
  const type = bbr?.byg021BygningensAnvendelse
    ? bygAnvendelseTekst(Number(bbr.byg021BygningensAnvendelse))
    : 'Ejendom';
  const vurderingStr = vurdering?.ejendomsvaerdi
    ? ` · Vurdering: ${formatKr(vurdering.ejendomsvaerdi)}`
    : '';
  const arealStr = bbr?.byg039BygningensSamledeBoligAreal
    ? ` · ${bbr.byg039BygningensSamledeBoligAreal} m²`
    : '';
  const aarStr = bbr?.byg026Opfoerelsesaar ? ` · Opført ${bbr.byg026Opfoerelsesaar}` : '';

  const description =
    `${type} på ${adresseStr}${arealStr}${aarStr}${vurderingStr}. ` +
    `Se ejere, tinglysning, salgshistorik og AI-analyse på BizzAssist.`;

  const canonicalSlug = generateEjendomSlug(
    adresse.vejnavn,
    adresse.husnr,
    adresse.postnr,
    adresse.postnrnavn
  );

  const canonicalUrl = `https://bizzassist.dk/ejendom/${canonicalSlug}/${bfe}`;

  return {
    title: `${adresseStr} — BizzAssist`,
    description,
    alternates: {
      canonical: canonicalUrl,
      languages: {
        da: canonicalUrl,
        en: canonicalUrl,
      },
    },
    openGraph: {
      title: `${adresseStr} — BizzAssist`,
      description,
      type: 'website',
      url: canonicalUrl,
      images: [
        { url: '/images/dashboard-preview.png', width: 1902, height: 915, alt: 'BizzAssist' },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${adresseStr} — BizzAssist`,
      description,
      images: ['/images/dashboard-preview.png'],
    },
  };
}

// ─── Hjælpefunktioner ────────────────────────────────────────────────────────

/** Formaterer et beløb som dansk valuta (f.eks. 3.450.000 kr.) */
function formatKr(beloeb: number): string {
  return new Intl.NumberFormat('da-DK').format(beloeb) + ' kr.';
}

// ─── Subkomponenter ──────────────────────────────────────────────────────────

/**
 * Viser et enkelt data-kort med ikon, label og værdi.
 */
function DataCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="bg-slate-800/50 border border-white/10 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} className="text-blue-400 flex-shrink-0" />
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-white font-semibold text-base leading-snug">{value ?? '–'}</p>
    </div>
  );
}

/**
 * CTA-blok der opfordrer brugere til at logge ind for mere data.
 */
function LoginCTA({ adresseStr }: { adresseStr: string }) {
  const features = [
    'Ejere og ejerskabshistorik',
    'Tinglysningsdokumenter og pantebreve',
    'Salgshistorik med priser',
    'AI-analyse og vurderingssammenligning',
    'Følg ejendommen og få notifikationer',
  ];

  return (
    <div className="bg-gradient-to-br from-blue-600/20 to-blue-800/10 border border-blue-500/30 rounded-2xl p-6 md:p-8">
      <div className="flex items-start gap-3 mb-4">
        <Lock size={20} className="text-blue-400 mt-0.5 flex-shrink-0" />
        <div>
          <h2 className="text-lg font-bold text-white mb-1">
            Se fuld ejendomsprofil for {adresseStr}
          </h2>
          <p className="text-slate-400 text-sm">
            Få adgang til alle registreringer og AI-analyse med en gratis BizzAssist-konto.
          </p>
        </div>
      </div>

      <ul className="space-y-2 mb-6 ml-8">
        {features.map((f) => (
          <li key={f} className="text-sm text-slate-300 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full flex-shrink-0" />
            {f}
          </li>
        ))}
      </ul>

      <div className="flex flex-col sm:flex-row gap-3 ml-8">
        <Link
          href="/login/signup"
          className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors text-sm"
        >
          Opret gratis konto
          <ArrowRight size={14} />
        </Link>
        <Link
          href="/login"
          className="flex items-center justify-center gap-2 border border-white/20 text-slate-300 hover:text-white hover:border-white/40 font-medium px-5 py-2.5 rounded-lg transition-colors text-sm"
        >
          Log ind
        </Link>
      </div>
    </div>
  );
}

// ─── JSON-LD ─────────────────────────────────────────────────────────────────

/**
 * Genererer schema.org JSON-LD structured data for ejendomssiden.
 * Inkluderer RealEstateListing-schema og BreadcrumbList for SEO-brødkrummer.
 *
 * @param adresse - DAWA adresse-objekt
 * @param bbr     - BBR bygning-data
 * @param slug    - SEO-venlig adresse-slug til kanonisk URL
 * @param bfe     - BFE-nummer til kanonisk URL
 */
function JsonLd({
  adresse,
  bbr,
  slug,
  bfe,
}: {
  adresse: DawaAdresse;
  bbr: BbrBygning | null;
  slug: string;
  bfe: string;
}) {
  const adresseNavn = `${adresse.vejnavn} ${adresse.husnr}, ${adresse.postnr} ${adresse.postnrnavn}`;
  const adresseKort = `${adresse.vejnavn} ${adresse.husnr}`;
  const canonicalUrl = `https://bizzassist.dk/ejendom/${slug}/${bfe}`;

  const realEstateSchema = {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: adresseNavn,
    address: {
      '@type': 'PostalAddress',
      streetAddress: adresseKort,
      postalCode: adresse.postnr,
      addressLocality: adresse.postnrnavn,
      addressRegion: adresse.kommunenavn,
      addressCountry: 'DK',
    },
    ...(adresse.x && adresse.y
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            longitude: adresse.x,
            latitude: adresse.y,
          },
        }
      : {}),
    ...(bbr?.byg039BygningensSamledeBoligAreal
      ? {
          floorSize: {
            '@type': 'QuantitativeValue',
            value: bbr.byg039BygningensSamledeBoligAreal,
            unitCode: 'MTK',
          },
        }
      : {}),
    ...(bbr?.byg026Opfoerelsesaar ? { yearBuilt: bbr.byg026Opfoerelsesaar } : {}),
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Hjem', item: 'https://bizzassist.dk' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Ejendomme',
        item: 'https://bizzassist.dk/ejendomme',
      },
      { '@type': 'ListItem', position: 3, name: adresseKort, item: canonicalUrl },
    ],
  };

  return (
    <>
      {/* BIZZ-219: JSON-LD structured data via safe helper component */}
      <JsonLdScript data={realEstateSchema} />
      <JsonLdScript data={breadcrumbSchema} />
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * Offentlig ejendomsside — vises uden login, ISR-cachet 7 dage.
 *
 * @param params - { slug: string; bfe: string }
 */
export default async function EjendomPublicPage({
  params,
}: {
  params: Promise<{ slug: string; bfe: string }>;
}) {
  const { bfe, slug } = await params;
  const { adresse, bbr, vurdering, fejl } = await hentEjendomData(bfe, slug);

  // 404-tilstand
  if (fejl || !adresse) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <MapPin size={40} className="text-slate-600 mb-4" />
        <h1 className="text-2xl font-bold text-white mb-2">Ejendom ikke fundet</h1>
        <p className="text-slate-400 mb-6">
          BFE-nummer {bfe} findes ikke i registrene, eller data er midlertidigt utilgængeligt.
        </p>
        <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm transition-colors">
          ← Tilbage til forsiden
        </Link>
      </div>
    );
  }

  const adresseStr = `${adresse.vejnavn} ${adresse.husnr}`;
  const byStr = `${adresse.postnr} ${adresse.postnrnavn}`;
  const ejendomstype = bbr?.byg021BygningensAnvendelse
    ? bygAnvendelseTekst(Number(bbr.byg021BygningensAnvendelse))
    : null;
  const ejerforhold = bbr?.byg066Ejerforhold ? ejerforholdTekst(bbr.byg066Ejerforhold) : null;
  // Kanonisk slug — konsistent med generateMetadata og JSON-LD
  const canonicalSlug = generateEjendomSlug(
    adresse.vejnavn,
    adresse.husnr,
    adresse.postnr,
    adresse.postnrnavn
  );

  return (
    <>
      {/* JSON-LD: RealEstateListing + BreadcrumbList */}
      <JsonLd adresse={adresse} bbr={bbr} slug={canonicalSlug} bfe={bfe} />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 md:py-12">
        {/* Breadcrumb */}
        <nav className="text-xs text-slate-500 mb-6 flex items-center gap-1.5 flex-wrap">
          <Link href="/" className="hover:text-slate-300 transition-colors">
            Forside
          </Link>
          <span>/</span>
          <span>Ejendomme</span>
          <span>/</span>
          <span className="text-slate-300">{adresseStr}</span>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-10 h-10 bg-blue-600/20 border border-blue-500/30 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5">
              <Home size={18} className="text-blue-400" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight">
                {adresseStr}
              </h1>
              <p className="text-slate-400 text-lg mt-1 flex items-center gap-1.5">
                <MapPin size={14} className="text-slate-500" />
                {byStr}
                {adresse.kommunenavn && adresse.kommunenavn !== adresse.postnrnavn && (
                  <span className="text-slate-600"> · {adresse.kommunenavn} Kommune</span>
                )}
              </p>
            </div>
          </div>

          {ejendomstype && (
            <span className="inline-flex items-center gap-1.5 bg-slate-800 border border-white/10 text-slate-300 text-xs font-medium px-3 py-1.5 rounded-full">
              <Building2 size={11} />
              {ejendomstype}
            </span>
          )}
          {ejerforhold && (
            <span className="inline-flex items-center gap-1.5 bg-slate-800 border border-white/10 text-slate-400 text-xs font-medium px-3 py-1.5 rounded-full ml-2">
              {ejerforhold}
            </span>
          )}
        </div>

        {/* Data-grid */}
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-4">
            Registerdata
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <DataCard
              icon={Home}
              label="Boligareal"
              value={
                bbr?.byg039BygningensSamledeBoligAreal
                  ? `${bbr.byg039BygningensSamledeBoligAreal} m²`
                  : null
              }
            />
            <DataCard
              icon={Home}
              label="Samlet areal"
              value={bbr?.byg038SamletBygningsareal ? `${bbr.byg038SamletBygningsareal} m²` : null}
            />
            <DataCard
              icon={MapPin}
              label="Grundareal"
              value={
                adresse.jordstykke?.registreretAreal
                  ? `${adresse.jordstykke.registreretAreal} m²`
                  : null
              }
            />
            <DataCard
              icon={Calendar}
              label="Byggeår"
              value={bbr?.byg026Opfoerelsesaar ? String(bbr.byg026Opfoerelsesaar) : null}
            />
            <DataCard icon={Hash} label="BFE-nummer" value={bfe} />
            <DataCard
              icon={MapPin}
              label="Matrikelnr"
              value={
                adresse.jordstykke
                  ? `${adresse.jordstykke.matrikelnr} · ${adresse.jordstykke.ejerlav.navn}`
                  : null
              }
            />
            <DataCard
              icon={Building2}
              label="Kommune"
              value={adresse.kommunenavn ? `${adresse.kommunenavn} (${adresse.kommunekode})` : null}
            />
            <DataCard
              icon={Building2}
              label="Etager"
              value={bbr?.byg054AntalEtager ? String(bbr.byg054AntalEtager) : null}
            />
          </div>
        </section>

        {/* Vurdering */}
        {vurdering && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-4">
              Offentlig vurdering{vurdering.vurderingsaar ? ` ${vurdering.vurderingsaar}` : ''}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-slate-800/50 border border-white/10 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp size={14} className="text-green-400" />
                  <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                    Ejendomsværdi
                  </span>
                </div>
                <p className="text-2xl font-bold text-white">
                  {vurdering.ejendomsvaerdi ? formatKr(vurdering.ejendomsvaerdi) : '–'}
                </p>
                <p className="text-xs text-slate-500 mt-1">Seneste offentlige vurdering</p>
              </div>
              <div className="bg-slate-800/50 border border-white/10 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-2">
                  <MapPin size={14} className="text-amber-400" />
                  <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                    Grundværdi
                  </span>
                </div>
                <p className="text-2xl font-bold text-white">
                  {vurdering.grundvaerdi ? formatKr(vurdering.grundvaerdi) : '–'}
                </p>
                <p className="text-xs text-slate-500 mt-1">Offentlig grundvurdering</p>
              </div>
            </div>
          </section>
        )}

        {/* CTA */}
        <LoginCTA adresseStr={`${adresseStr}, ${byStr}`} />

        {/* Pricing */}
        <PublicPricingSection />

        {/* Datakilde-note */}
        <p className="mt-8 text-xs text-slate-600 text-center">
          Data fra BBR (Bygnings- og Boligregistret), DAR (Danmarks Adresseregister) og
          Vurderingsstyrelsen. Sidst opdateret:{' '}
          {new Date().toLocaleDateString('da-DK', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
          .
        </p>
      </div>
    </>
  );
}
