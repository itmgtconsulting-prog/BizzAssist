/**
 * Offentlig SEO-side for en dansk virksomhed.
 *
 * URL-format: /virksomhed/novo-nordisk-a-s/24256790
 *
 * Viser offentligt tilgængeligt basis-data fra Det Centrale Virksomhedsregister
 * (CVR) uden login-krav. Avancerede data (bestyrelse, ejendomme, regnskaber,
 * AI-analyse) kræver login og vises bag en CTA-blok.
 *
 * ISR: revalidate = 604800 (7 dage)
 *
 * @param params.slug - SEO-venlig virksomhedsnavn-slug (dekorativ)
 * @param params.cvr  - 8-cifret CVR-nummer, bruges til API-kald
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import JsonLdScript from '@/app/components/JsonLd';
import {
  Building2,
  MapPin,
  Calendar,
  Users,
  Hash,
  Briefcase,
  CheckCircle,
  XCircle,
  Lock,
  ArrowRight,
  Globe,
} from 'lucide-react';
import { generateVirksomhedSlug } from '@/app/lib/slug';
import PublicPricingSection from '@/app/(public)/components/PublicPricingSection';

// ─── ISR cache-periode: 7 dage ─────────────────────────────────────────────
export const revalidate = 604800;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Offentlige CVR-data som vist på siden */
interface VirksomhedPublicData {
  cvr: string;
  navn: string;
  adresse: string;
  postnr: string;
  by: string;
  branche: string | null;
  branckekode: string | null;
  selskabsform: string | null;
  stiftet: string | null;
  ansatte: string | null;
  status: string | null;
  aktiv: boolean;
  kommune: string | null;
  email: string | null;
  telefon: string | null;
  hjemmeside: string | null;
  fejl?: string;
}

// ─── Data fetching ──────────────────────────────────────────────────────────

/**
 * Henter virksomhedsdata fra CVR via den interne API-proxy (/api/cvr-public).
 *
 * @param cvr - 8-cifret CVR-nummer
 * @param baseUrl - Absolut URL til applikationen
 * @returns VirksomhedPublicData eller objekt med fejl-property
 */
async function hentVirksomhedData(cvr: string, baseUrl: string): Promise<VirksomhedPublicData> {
  try {
    const res = await fetch(`${baseUrl}/api/cvr-public?vat=${encodeURIComponent(cvr)}`, {
      next: { revalidate: 604800 },
    });

    if (!res.ok) {
      return {
        cvr,
        navn: '',
        adresse: '',
        postnr: '',
        by: '',
        branche: null,
        branckekode: null,
        selskabsform: null,
        stiftet: null,
        ansatte: null,
        status: null,
        aktiv: false,
        kommune: null,
        email: null,
        telefon: null,
        hjemmeside: null,
        fejl: `Virksomhed ikke fundet (HTTP ${res.status})`,
      };
    }

    const d = (await res.json()) as Record<string, unknown>;

    if (d['error']) {
      return {
        cvr,
        navn: '',
        adresse: '',
        postnr: '',
        by: '',
        branche: null,
        branckekode: null,
        selskabsform: null,
        stiftet: null,
        ansatte: null,
        status: null,
        aktiv: false,
        kommune: null,
        email: null,
        telefon: null,
        hjemmeside: null,
        fejl: String(d['error']),
      };
    }

    const aktiv = !d['enddate'] && d['statusTekst'] !== 'OPHOERT';

    return {
      cvr: String(d['vat'] ?? cvr),
      navn: String(d['name'] ?? ''),
      adresse: String(d['address'] ?? ''),
      postnr: String(d['zipcode'] ?? ''),
      by: String(d['city'] ?? ''),
      branche: d['industrydesc'] ? String(d['industrydesc']) : null,
      branckekode: d['industrycode'] ? String(d['industrycode']) : null,
      selskabsform: d['companydesc'] ? String(d['companydesc']) : null,
      stiftet: d['stiftet'] ? String(d['stiftet']) : d['startdate'] ? String(d['startdate']) : null,
      ansatte: d['employees'] ? String(d['employees']) : null,
      status: aktiv ? 'Aktiv' : d['statusTekst'] === 'OPHOERT' ? 'Ophørt' : 'Inaktiv',
      aktiv,
      kommune: d['kommune'] ? String(d['kommune']) : null,
      email: d['email'] ? String(d['email']) : null,
      telefon: d['phone'] ? String(d['phone']) : null,
      hjemmeside: null, // Ikke tilgængeligt fra cvrapi.dk
    };
  } catch (err) {
    return {
      cvr,
      navn: '',
      adresse: '',
      postnr: '',
      by: '',
      branche: null,
      branckekode: null,
      selskabsform: null,
      stiftet: null,
      ansatte: null,
      status: null,
      aktiv: false,
      kommune: null,
      email: null,
      telefon: null,
      hjemmeside: null,
      fejl: err instanceof Error ? err.message : 'Ukendt fejl',
    };
  }
}

// ─── generateMetadata ───────────────────────────────────────────────────────

/**
 * Genererer unik SEO-metadata for virksomhedssiden.
 *
 * @param params - URL-parametre (slug + cvr)
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; cvr: string }>;
}): Promise<Metadata> {
  const { cvr } = await params;
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const v = await hentVirksomhedData(cvr, baseUrl);

  if (v.fejl || !v.navn) {
    return {
      title: 'Virksomhed ikke fundet — BizzAssist',
      description: 'CVR-data ikke tilgængeligt.',
    };
  }

  const adresseStr = [v.adresse, v.postnr, v.by].filter(Boolean).join(', ');
  const brancheStr = v.branche ? ` · ${v.branche}` : '';
  const statusStr = v.aktiv ? 'Aktiv' : 'Ophørt';
  const stiftetStr = v.stiftet ? ` · Stiftet ${formatDato(v.stiftet)}` : '';

  const description =
    `${v.navn} (CVR ${cvr}) — ${statusStr}${brancheStr}${stiftetStr}. ` +
    `${adresseStr}. Se bestyrelse, ejere, ejendomme og regnskaber på BizzAssist.`;

  const canonicalSlug = generateVirksomhedSlug(v.navn);
  const canonicalUrl = `https://bizzassist.dk/virksomhed/${canonicalSlug}/${cvr}`;

  return {
    title: `${v.navn} — CVR ${cvr} — BizzAssist`,
    description,
    alternates: {
      canonical: canonicalUrl,
      languages: {
        da: canonicalUrl,
        en: canonicalUrl,
      },
    },
    openGraph: {
      title: `${v.navn} (CVR ${cvr}) — BizzAssist`,
      description,
      type: 'website',
      url: canonicalUrl,
      images: [
        { url: '/images/dashboard-preview.png', width: 1902, height: 915, alt: 'BizzAssist' },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${v.navn} (CVR ${cvr}) — BizzAssist`,
      description,
      images: ['/images/dashboard-preview.png'],
    },
  };
}

// ─── Hjælpefunktioner ────────────────────────────────────────────────────────

/** Formaterer en ISO-dato til dansk datoformat (f.eks. "15. januar 1989") */
function formatDato(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return isoStr;
  }
}

// ─── Subkomponenter ──────────────────────────────────────────────────────────

/**
 * Viser et enkelt data-felt med ikon, label og værdi.
 */
function DataRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-3 border-b border-white/5 last:border-0">
      <div className="w-7 h-7 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
        <Icon size={13} className="text-blue-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-500 mb-0.5">{label}</p>
        <p className="text-white text-sm font-medium leading-snug break-words">{value}</p>
      </div>
    </div>
  );
}

/**
 * CTA-blok der opfordrer brugere til at logge ind for mere data.
 */
function LoginCTA({ navn }: { navn: string }) {
  const features = [
    'Bestyrelse og direktionsmedlemmer',
    'Ejere og ejerstruktur',
    'Ejendomsportefølje',
    'Regnskaber og nøgletal',
    'Følg virksomheden og få notifikationer',
  ];

  return (
    <div className="bg-gradient-to-br from-blue-600/20 to-blue-800/10 border border-blue-500/30 rounded-2xl p-6 md:p-8">
      <div className="flex items-start gap-3 mb-4">
        <Lock size={20} className="text-blue-400 mt-0.5 flex-shrink-0" />
        <div>
          <h2 className="text-lg font-bold text-white mb-1">
            Se fuld virksomhedsprofil for {navn}
          </h2>
          <p className="text-slate-400 text-sm">
            Få adgang til dybdegående data og AI-analyse med en gratis BizzAssist-konto.
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
 * Genererer schema.org JSON-LD structured data for virksomhedssiden.
 * Inkluderer Organization/LocalBusiness-schema og BreadcrumbList for SEO-brødkrummer.
 *
 * Bruger `@type: "LocalBusiness"` når adresse er tilgængelig, ellers `"Organization"`.
 * Inkluderer `identifier` (CVR), `url`, `address`, `telephone`, `email` og `description`.
 *
 * @param v    - Virksomhedsdata
 * @param slug - SEO-venlig virksomhedsnavn-slug (til kanonisk URL)
 */
function JsonLd({ v, slug }: { v: VirksomhedPublicData; slug: string }) {
  /** Kanonisk URL for virksomhedssiden */
  const canonicalUrl = `https://bizzassist.dk/virksomhed/${slug}/${v.cvr}`;

  /** Brug LocalBusiness når adresse er tilgængelig — giver rigere schema-support */
  const hasAddress = Boolean(v.adresse || v.postnr || v.by);
  const schemaType = hasAddress ? 'LocalBusiness' : 'Organization';

  const organizationSchema = {
    '@context': 'https://schema.org',
    '@type': schemaType,
    name: v.navn,
    identifier: v.cvr,
    url: canonicalUrl,
    ...(hasAddress
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: v.adresse || undefined,
            postalCode: v.postnr || undefined,
            addressLocality: v.by || undefined,
            addressCountry: 'DK',
          },
        }
      : {}),
    ...(v.telefon ? { telephone: v.telefon } : {}),
    ...(v.email ? { email: v.email } : {}),
    ...(v.branche ? { description: v.branche } : {}),
    ...(v.stiftet ? { foundingDate: v.stiftet } : {}),
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Hjem', item: 'https://bizzassist.dk' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Virksomheder',
        item: 'https://bizzassist.dk/virksomheder',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: v.navn,
        item: `https://bizzassist.dk/virksomhed/${slug}/${v.cvr}`,
      },
    ],
  };

  return (
    <>
      {/* BIZZ-219: JSON-LD structured data via safe helper component */}
      <JsonLdScript data={organizationSchema} />
      <JsonLdScript data={breadcrumbSchema} />
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * Offentlig virksomhedsside — vises uden login, ISR-cachet 7 dage.
 *
 * @param params - { slug: string; cvr: string }
 */
export default async function VirksomhedPublicPage({
  params,
}: {
  params: Promise<{ slug: string; cvr: string }>;
}) {
  const { cvr } = await params;

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

  const v = await hentVirksomhedData(cvr, baseUrl);

  // 404-tilstand
  if (v.fejl || !v.navn) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <Building2 size={40} className="text-slate-600 mb-4" />
        <h1 className="text-2xl font-bold text-white mb-2">Virksomhed ikke fundet</h1>
        <p className="text-slate-400 mb-6">
          CVR-nummer {cvr} findes ikke i registrene, eller data er midlertidigt utilgængeligt.
        </p>
        <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm transition-colors">
          ← Tilbage til forsiden
        </Link>
      </div>
    );
  }

  const adresseStr = [v.adresse, v.postnr, v.by].filter(Boolean).join(', ');
  // Brug den kanoniske slug baseret på virksomhedsnavnet (konsistent med generateMetadata)
  const canonicalSlug = generateVirksomhedSlug(v.navn);

  return (
    <>
      {/* JSON-LD: Organization + BreadcrumbList */}
      <JsonLd v={v} slug={canonicalSlug} />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 md:py-12">
        {/* Breadcrumb */}
        <nav className="text-xs text-slate-500 mb-6 flex items-center gap-1.5 flex-wrap">
          <Link href="/" className="hover:text-slate-300 transition-colors">
            Forside
          </Link>
          <span>/</span>
          <span>Virksomheder</span>
          <span>/</span>
          <span className="text-slate-300">{v.navn}</span>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-start gap-4 mb-4">
            {/* Firma-initialer */}
            <div className="w-14 h-14 bg-slate-800 border border-white/10 rounded-xl flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-xl">{v.navn.charAt(0).toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight break-words">
                {v.navn}
              </h1>
              {adresseStr && (
                <p className="text-slate-400 text-base mt-1 flex items-center gap-1.5">
                  <MapPin size={14} className="text-slate-500 flex-shrink-0" />
                  {adresseStr}
                </p>
              )}
            </div>
          </div>

          {/* Status + form badges */}
          <div className="flex flex-wrap gap-2 mt-2">
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full ${
                v.aktiv
                  ? 'bg-green-500/15 border border-green-500/30 text-green-400'
                  : 'bg-red-500/15 border border-red-500/30 text-red-400'
              }`}
            >
              {v.aktiv ? <CheckCircle size={11} /> : <XCircle size={11} />}
              {v.status ?? (v.aktiv ? 'Aktiv' : 'Ophørt')}
            </span>
            {v.selskabsform && (
              <span className="inline-flex items-center gap-1.5 bg-slate-800 border border-white/10 text-slate-300 text-xs font-medium px-3 py-1.5 rounded-full">
                <Briefcase size={11} />
                {v.selskabsform}
              </span>
            )}
            {v.branche && (
              <span className="inline-flex items-center gap-1.5 bg-slate-800 border border-white/10 text-slate-400 text-xs font-medium px-3 py-1.5 rounded-full">
                {v.branche}
                {v.branckekode && <span className="text-slate-600 ml-0.5">({v.branckekode})</span>}
              </span>
            )}
          </div>
        </div>

        {/* Stamdata grid */}
        <div className="grid md:grid-cols-2 gap-4 mb-8">
          {/* Venstre: Virksomhedsinfo */}
          <section className="bg-slate-800/40 border border-white/10 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">
              Virksomhedsdata
            </h2>
            <DataRow icon={Hash} label="CVR-nummer" value={v.cvr} />
            <DataRow
              icon={Calendar}
              label="Stiftelsesdato"
              value={v.stiftet ? formatDato(v.stiftet) : null}
            />
            <DataRow icon={Users} label="Antal ansatte" value={v.ansatte} />
            <DataRow icon={Briefcase} label="Selskabsform" value={v.selskabsform} />
            <DataRow icon={Globe} label="Branche" value={v.branche} />
            <DataRow icon={MapPin} label="Kommune" value={v.kommune} />
          </section>

          {/* Højre: Kontaktinfo */}
          <section className="bg-slate-800/40 border border-white/10 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-3">
              Kontakt &amp; adresse
            </h2>
            <DataRow icon={MapPin} label="Adresse" value={v.adresse || null} />
            <DataRow
              icon={MapPin}
              label="Postnr. og by"
              value={v.postnr && v.by ? `${v.postnr} ${v.by}` : null}
            />
            {v.telefon && (
              <div className="flex items-start gap-3 py-3 border-b border-white/5">
                <div className="w-7 h-7 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Hash size={13} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-0.5">Telefon</p>
                  <a
                    href={`tel:${v.telefon}`}
                    className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors"
                  >
                    {v.telefon}
                  </a>
                </div>
              </div>
            )}
            {v.email && (
              <div className="flex items-start gap-3 py-3">
                <div className="w-7 h-7 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Globe size={13} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-0.5">E-mail</p>
                  <a
                    href={`mailto:${v.email}`}
                    className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors break-all"
                  >
                    {v.email}
                  </a>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* CTA */}
        <LoginCTA navn={v.navn} />

        {/* Pricing */}
        <PublicPricingSection />

        {/* Datakilde-note */}
        <p className="mt-8 text-xs text-slate-600 text-center">
          Data fra Det Centrale Virksomhedsregister (CVR), Erhvervsstyrelsen. Sidst opdateret:{' '}
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
