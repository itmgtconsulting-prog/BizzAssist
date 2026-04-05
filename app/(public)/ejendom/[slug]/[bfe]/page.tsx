/**
 * Offentlig SEO-side for en dansk ejendom.
 *
 * URL-format: /ejendom/arnold-nielsens-boulevard-62a-2650-hvidovre/226630
 *
 * Viser offentligt tilgængeligt basis-data fra BBR og Vurderingsportalen
 * uden login-krav. Avancerede data (ejere, tinglysning, salgshistorik)
 * kræver login og vises bag en CTA-blok.
 *
 * ISR: revalidate = 604800 (7 dage)
 *
 * @param params.slug - SEO-venlig adresse-slug (dekorativ, bruges ikke til datahentning)
 * @param params.bfe  - BFE-nummer (BBR-ejendomsnummer), bruges til alle API-kald
 */

import type { Metadata } from 'next';
import Link from 'next/link';
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

// ─── ISR cache-periode: 7 dage ─────────────────────────────────────────────
export const revalidate = 604800;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Komprimeret adresse-data fra DAWA */
interface DawaAdresse {
  id: string;
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
 * Henter adresse-data fra DAWA's offentlige API baseret på BFE-nummer.
 * Inkluderer jordstykke-data for matrikelnummer og grundareal.
 *
 * DAWA's `adgangsadresser?bfenummer=` filter ignoreres af API'et (returnerer
 * altid den første adresse uanset BFE). Korrekt løsning: slå jordstykket op
 * via `jordstykker?bfenummer=` for at hente ejerlav + matrikelnr + kommunekode,
 * og brug derefter disse tre parametre til at finde den præcise adresse.
 *
 * @param bfe - BFE-nummer
 * @returns DAWA adresse-objekt eller null
 */
async function hentDawaAdresse(bfe: string): Promise<DawaAdresse | null> {
  try {
    // Trin 1: BFE → jordstykke (ejerlav + matrikelnr + kommunekode)
    const jsRes = await fetch(
      `https://api.dataforsyningen.dk/jordstykker?bfenummer=${encodeURIComponent(bfe)}&per_side=1`,
      { next: { revalidate: 604800 }, headers: { Accept: 'application/json' } }
    );
    if (!jsRes.ok) return null;
    const jsData: unknown[] = await jsRes.json();
    if (!Array.isArray(jsData) || jsData.length === 0) return null;

    const jordstykkeRaw = jsData[0] as Record<string, unknown>;
    const ejerlavRaw = jordstykkeRaw['ejerlav'] as Record<string, unknown> | undefined;
    const ejerlavKode = ejerlavRaw?.['kode'];
    const matrikelnr = jordstykkeRaw['matrikelnr'];
    const kommuneRaw = jordstykkeRaw['kommune'] as Record<string, unknown> | undefined;
    const kommunekode = kommuneRaw?.['kode'];

    if (!ejerlavKode || !matrikelnr || !kommunekode) return null;

    // Trin 2: ejerlav + matrikelnr + kommunekode → adgangsadresse
    const url =
      `https://api.dataforsyningen.dk/adgangsadresser` +
      `?matrikelnr=${encodeURIComponent(String(matrikelnr))}` +
      `&landsejerlavkode=${encodeURIComponent(String(ejerlavKode))}` +
      `&kommunekode=${encodeURIComponent(String(kommunekode))}` +
      `&struktur=nestet&per_side=1`;

    const res = await fetch(url, {
      next: { revalidate: 604800 },
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data: unknown[] = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const a = data[0] as Record<string, unknown>;
    // DAWA nestet: vejnavn er i vejstykke.navn (ikke vejnavn.navn som i ældre format)
    const vejstykke = a['vejstykke'] as Record<string, unknown> | undefined;
    const pos = a['postnummer'] as Record<string, unknown> | undefined;
    const kom = a['kommune'] as Record<string, unknown> | undefined;
    const adgPkt = a['adgangspunkt'] as Record<string, unknown> | undefined;
    const koord = adgPkt?.['koordinater'] as [number, number] | undefined;
    const js = a['jordstykke'] as Record<string, unknown> | null | undefined;
    const ejerlav = js?.['ejerlav'] as Record<string, unknown> | undefined;

    return {
      id: String(a['id'] ?? ''),
      vejnavn: String(vejstykke?.['navn'] ?? ''),
      husnr: String(a['husnr'] ?? ''),
      etage: a['etage'] != null ? String(a['etage']) : null,
      dør: a['dør'] != null ? String(a['dør']) : null,
      postnr: String(pos?.['nr'] ?? a['postnr'] ?? ''),
      postnrnavn: String(pos?.['navn'] ?? a['postnrnavn'] ?? ''),
      kommunenavn: String(kom?.['navn'] ?? ''),
      kommunekode: String(kom?.['kode'] ?? ''),
      x: koord?.[0] ?? 0,
      y: koord?.[1] ?? 0,
      jordstykke: js
        ? {
            matrikelnr: String(js['matrikelnr'] ?? ''),
            ejerlav: { navn: String(ejerlav?.['navn'] ?? '') },
            registreretAreal: Number(js['registreretAreal'] ?? 0),
          }
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * Henter BBR bygning-data fra Datafordeler via den interne API-proxy.
 * Kræver DAWA adresse-UUID (dawaId).
 *
 * @param dawaId - DAWA adgangsadresse UUID
 * @param baseUrl - Absolut URL til applikationen
 * @returns Første BBR bygning eller null
 */
async function hentBbrBygning(dawaId: string, baseUrl: string): Promise<BbrBygning | null> {
  try {
    const res = await fetch(`${baseUrl}/api/ejendom/${encodeURIComponent(dawaId)}`, {
      next: { revalidate: 604800 },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      bbr?: BbrBygning[] | null;
      bbrFejl?: string | null;
    };

    return data.bbr?.[0] ?? null;
  } catch {
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
 * @param bfe - BFE-nummer fra URL
 * @returns EjendomPublicData med adresse, BBR og vurdering
 */
async function hentEjendomData(bfe: string): Promise<EjendomPublicData> {
  // Appens base URL — nødvendig for at kalde interne API-routes server-side
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  // Hent adresse fra DAWA (gratis, ingen auth)
  const adresse = await hentDawaAdresse(bfe);

  if (!adresse) {
    return { adresse: null, bbr: null, vurdering: null, fejl: 'Ejendom ikke fundet' };
  }

  // Hent BBR og vurdering parallelt
  const [bbr, vurdering] = await Promise.all([
    adresse.id ? hentBbrBygning(adresse.id, baseUrl) : Promise.resolve(null),
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
  const { bfe } = await params;
  const { adresse, bbr, vurdering } = await hentEjendomData(bfe);

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

  return {
    title: `${adresseStr} — BizzAssist`,
    description,
    alternates: {
      canonical: `/ejendom/${canonicalSlug}/${bfe}`,
    },
    openGraph: {
      title: `${adresseStr} — BizzAssist`,
      description,
      type: 'website',
      url: `/ejendom/${canonicalSlug}/${bfe}`,
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
 *
 * @param adresse - DAWA adresse-objekt
 * @param bbr - BBR bygning-data
 */
function JsonLd({ adresse, bbr }: { adresse: DawaAdresse; bbr: BbrBygning | null }) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: `${adresse.vejnavn} ${adresse.husnr}, ${adresse.postnr} ${adresse.postnrnavn}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: `${adresse.vejnavn} ${adresse.husnr}`,
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

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
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
  const { bfe } = await params;
  const { adresse, bbr, vurdering, fejl } = await hentEjendomData(bfe);

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

  return (
    <>
      {/* JSON-LD */}
      <JsonLd adresse={adresse} bbr={bbr} />

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
