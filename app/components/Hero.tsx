'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Search, Building2, MapPin } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

/** BIZZ-1097: Søgeresultat fra autocomplete */
interface SearchResult {
  type: 'address' | 'company';
  label: string;
  sublabel: string;
  href: string;
}

/**
 * BIZZ-1097: Søgefelt i hero-sektionen — søg ejendomme og virksomheder uden login.
 * Autocomplete via DAWA (adresser) + CVR (virksomheder). Redirecter til offentlige SEO-sider.
 */
function HeroSearch({ lang }: { lang: 'da' | 'en' }) {
  const da = lang === 'da';
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Debounced search — DAWA + CVR parallelt */
  const handleSearch = (text: string) => {
    setQuery(text);
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    if (text.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const [dawaRes, cvrRes] = await Promise.all([
          fetch(`/api/adresse/autocomplete?q=${encodeURIComponent(text)}`, {
            signal: controller.signal,
          }).catch(() => null),
          /^\d{8}$/.test(text.trim()) || text.trim().length >= 3
            ? fetch(`/api/public/search?q=${encodeURIComponent(text)}&limit=5`, {
                signal: controller.signal,
              }).catch(() => null)
            : null,
        ]);
        if (controller.signal.aborted) return;
        const items: SearchResult[] = [];

        if (dawaRes?.ok) {
          const dawaData = await dawaRes.json();
          for (const r of (
            dawaData as Array<{ tekst: string; data?: { id?: string }; type?: string }>
          ).slice(0, 5)) {
            if (r.type === 'vejnavn') continue;
            const id = r.data?.id;
            if (!id) continue;
            /* Generer SEO-slug fra adresse-tekst */
            const slug = r.tekst
              .toLowerCase()
              .replace(/[^a-z0-9æøå]+/g, '-')
              .replace(/-+$/, '');
            items.push({
              type: 'address',
              label: r.tekst,
              sublabel: da ? 'Ejendom' : 'Property',
              href: `/ejendom/${slug}/0`,
            });
          }
        }

        if (cvrRes?.ok) {
          const cvrData = await cvrRes.json();
          for (const r of (
            (cvrData.results ?? cvrData) as Array<{ cvr: number; name: string; city?: string }>
          ).slice(0, 5)) {
            const slug = r.name
              .toLowerCase()
              .replace(/[^a-z0-9æøå]+/g, '-')
              .replace(/-+$/, '');
            items.push({
              type: 'company',
              label: r.name,
              sublabel: `CVR ${r.cvr}${r.city ? ` · ${r.city}` : ''}`,
              href: `/virksomhed/${slug}/${r.cvr}`,
            });
          }
        }

        setResults(items);
        setOpen(items.length > 0);
      } catch {
        /* abort */
      }
    }, 250);
  };

  return (
    <div className="relative max-w-xl mx-auto mb-8">
      <div className="relative">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          placeholder={
            da ? 'Søg adresse, CVR eller virksomhed...' : 'Search address, CVR or company...'
          }
          className="w-full pl-11 pr-4 py-3.5 bg-white/5 border border-white/10 rounded-xl text-white text-base placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/25 backdrop-blur-sm"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute top-full mt-2 w-full bg-[#1e293b] border border-slate-700/60 rounded-xl shadow-2xl overflow-hidden z-50">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              onMouseDown={() => router.push(r.href)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-700/50 transition-colors text-left"
            >
              {r.type === 'address' ? (
                <MapPin size={14} className="text-emerald-400 shrink-0" />
              ) : (
                <Building2 size={14} className="text-blue-400 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">{r.label}</p>
                <p className="text-slate-500 text-xs">{r.sublabel}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Hero section for the landing page.
 * Shows headline, subtitle, CTA button and a real dashboard screenshot.
 */
export default function Hero() {
  const { lang } = useLanguage();
  const hero = translations[lang].hero;

  return (
    <section className="relative min-h-screen flex flex-col justify-center overflow-hidden bg-[#0f172a]">
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      {/* Gradient orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-blue-400/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-40 pb-20">
        <div className="text-center max-w-4xl mx-auto">
          {/* Headline */}
          <h1 className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-white leading-tight mb-6">
            {hero.title}{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-sky-300">
              {hero.titleHighlight}
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            {hero.subtitle}
          </p>

          {/* BIZZ-1097: Søgefelt — søg ejendomme og virksomheder uden login */}
          <HeroSearch lang={lang} />

          {/* CTA button */}
          <div className="flex justify-center">
            <Link
              href="/login/signup"
              className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold text-lg px-8 py-4 rounded-xl transition-colors shadow-lg shadow-blue-600/25"
            >
              {translations[lang].nav.getStarted}
              <ArrowRight size={20} />
            </Link>
          </div>
        </div>

        {/* App preview — real dashboard screenshot */}
        <div className="mt-20 max-w-5xl mx-auto">
          <div className="relative bg-[#1e293b] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
            {/* Browser bar */}
            <div className="flex items-center gap-2 px-4 py-3 bg-[#0f172a] border-b border-white/10">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500/70" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
                <div className="w-3 h-3 rounded-full bg-green-500/70" />
              </div>
              <div className="flex-1 mx-4 bg-white/5 rounded-lg px-4 py-1.5 text-xs text-slate-500">
                app.bizzassist.dk/dashboard
              </div>
            </div>
            {/* Screenshot with bottom fade */}
            <div className="relative">
              <img
                src="/images/dashboard-preview.png"
                alt="BizzAssist Dashboard"
                className="w-full"
                loading="lazy"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 80vw, 1200px"
                width={1200}
                height={675}
              />
              {/* Fade-out gradient at bottom for smooth blend */}
              <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-[#1e293b] to-transparent" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
