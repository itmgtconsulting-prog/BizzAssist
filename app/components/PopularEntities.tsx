'use client';

import Link from 'next/link';
import { Building2, Briefcase, ArrowRight } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

/**
 * Curated list of well-known Danish companies for internal SEO linking.
 * Slugs match generateVirksomhedSlug() output from app/lib/slug.ts.
 */
const POPULAR_COMPANIES = [
  {
    name: 'Novo Nordisk A/S',
    cvr: '24256790',
    slug: 'novo-nordisk-a-s',
    industry: 'Medicinalindustri',
  },
  {
    name: 'A.P. Møller - Mærsk A/S',
    cvr: '22756214',
    slug: 'a-p-moeller-maersk-a-s',
    industry: 'Shipping',
  },
  { name: 'Carlsberg A/S', cvr: '61056416', slug: 'carlsberg-a-s', industry: 'Bryggerier' },
  {
    name: 'Vestas Wind Systems A/S',
    cvr: '10403782',
    slug: 'vestas-wind-systems-a-s',
    industry: 'Vindenergi',
  },
  { name: 'LEGO System A/S', cvr: '47458714', slug: 'lego-system-a-s', industry: 'Legetøj' },
  { name: 'Danske Bank A/S', cvr: '61126228', slug: 'danske-bank-a-s', industry: 'Bankvirksomhed' },
  { name: 'DSV A/S', cvr: '58233528', slug: 'dsv-a-s', industry: 'Transport & logistik' },
  { name: 'Coloplast A/S', cvr: '69749917', slug: 'coloplast-a-s', industry: 'Medicoudstyr' },
];

/**
 * Curated list of well-known Danish properties for internal SEO linking.
 * BFE numbers and slugs sourced from sitemap_entries.
 */
const POPULAR_PROPERTIES = [
  {
    name: 'Christiansborg Slot',
    bfe: '219563',
    slug: 'christiansborg-slotsplads-1-1218-koebenhavn-k',
  },
  { name: 'Amalienborg', bfe: '219370', slug: 'amalienborg-slotsplads-5-1257-koebenhavn-k' },
  { name: 'Rundetaarn', bfe: '219460', slug: 'koebmagergade-52a-1150-koebenhavn-k' },
  {
    name: 'Den Sorte Diamant',
    bfe: '219698',
    slug: 'soeren-kierkegaards-plads-1-1221-koebenhavn-k',
  },
  { name: 'Tivoli', bfe: '219616', slug: 'vesterbrogade-3-1630-koebenhavn-v' },
  { name: 'Operaen', bfe: '6072932', slug: 'ekvipagemestervej-10-1438-koebenhavn-k' },
  { name: 'Rådhuspladsen 1', bfe: '219617', slug: 'raadhuspladsen-1-1550-koebenhavn-v' },
  { name: 'Nyhavn 17', bfe: '219398', slug: 'nyhavn-17-1051-koebenhavn-k' },
];

/**
 * Homepage section that links to popular public company and property pages.
 * Provides internal linking for SEO — helps Google discover the 2.3M
 * public pages via crawling from the homepage.
 *
 * @returns Section with two grids of linked cards
 */
export default function PopularEntities() {
  const { lang } = useLanguage();
  const t = translations[lang].popularEntities;

  return (
    <section id="popular" className="py-24 bg-[#0a1020]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">{t.title}</h2>
          <p className="text-xl text-slate-400">{t.subtitle}</p>
        </div>

        {/* Companies */}
        <div className="mb-12">
          <h3 className="text-lg font-semibold text-blue-400 mb-5 flex items-center gap-2">
            <Briefcase size={20} />
            {t.companiesTitle}
          </h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {POPULAR_COMPANIES.map((c) => (
              <Link
                key={c.cvr}
                href={`/virksomhed/${c.slug}/${c.cvr}`}
                className="rounded-xl border border-blue-500/20 hover:border-blue-500/40 bg-white/[0.03] hover:bg-white/[0.06] p-5 transition-all group"
              >
                <p className="text-white font-semibold text-sm mb-1 group-hover:text-blue-300 transition-colors">
                  {c.name}
                </p>
                <p className="text-slate-500 text-xs">
                  CVR {c.cvr} &middot; {c.industry}
                </p>
              </Link>
            ))}
          </div>
        </div>

        {/* Properties */}
        <div>
          <h3 className="text-lg font-semibold text-emerald-400 mb-5 flex items-center gap-2">
            <Building2 size={20} />
            {t.propertiesTitle}
          </h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {POPULAR_PROPERTIES.map((p) => (
              <Link
                key={p.bfe}
                href={`/ejendom/${p.slug}/${p.bfe}`}
                className="rounded-xl border border-emerald-500/20 hover:border-emerald-500/40 bg-white/[0.03] hover:bg-white/[0.06] p-5 transition-all group"
              >
                <p className="text-white font-semibold text-sm mb-1 group-hover:text-emerald-300 transition-colors">
                  {p.name}
                </p>
                <p className="text-slate-500 text-xs">BFE {p.bfe}</p>
              </Link>
            ))}
          </div>
        </div>

        {/* View more link */}
        <div className="mt-10 text-center">
          <Link
            href="/sitemap/0.xml"
            className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
            aria-label={t.viewAll}
          >
            {t.viewAll}
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}
