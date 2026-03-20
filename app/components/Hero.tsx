'use client';

import { useState } from 'react';
import { Search, ArrowRight, Play } from 'lucide-react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

export default function Hero() {
  const { lang } = useLanguage();
  const hero = translations[lang].hero;
  const [query, setQuery] = useState('');

  const exampleSearches =
    lang === 'da'
      ? ['ØRSTED A/S', 'Novo Nordisk', 'Maersk', 'H.C. Andersens Boulevard 27']
      : ['ØRSTED A/S', 'Novo Nordisk', 'Maersk', 'H.C. Andersens Boulevard 27'];

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

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-32 pb-20">
        <div className="text-center max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 text-blue-400 text-sm font-medium px-4 py-2 rounded-full mb-8">
            <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
            {hero.badge}
          </div>

          {/* Headline */}
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-white leading-tight mb-6">
            {hero.title}{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-sky-300">
              {hero.titleHighlight}
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-12 leading-relaxed">
            {hero.subtitle}
          </p>

          {/* Search bar */}
          <div className="max-w-2xl mx-auto mb-6">
            <div className="relative flex items-center">
              <Search className="absolute left-5 text-slate-400" size={20} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={hero.searchPlaceholder}
                className="w-full pl-14 pr-40 py-5 bg-white/5 border border-white/10 rounded-2xl text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:bg-white/8 text-base transition-all"
              />
              <Link
                href="/dashboard"
                className="absolute right-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-3 rounded-xl transition-colors flex items-center gap-2 text-sm"
              >
                {hero.ctaPrimary}
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>

          {/* Quick searches */}
          <div className="flex flex-wrap justify-center gap-2 mb-12">
            {exampleSearches.map((s) => (
              <button
                key={s}
                onClick={() => setQuery(s)}
                className="text-xs text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-full transition-all"
              >
                {s}
              </button>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Link
              href="/login"
              className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-medium px-6 py-3 rounded-xl transition-all"
            >
              <Play size={16} className="text-blue-400" />
              {hero.ctaSecondary}
            </Link>
          </div>

          {/* Trusted by */}
          <p className="text-slate-500 text-sm">{hero.trustedBy}</p>
        </div>

        {/* App preview mockup */}
        <div className="mt-20 max-w-5xl mx-auto">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
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
            {/* Mock app content */}
            <div className="p-6 grid grid-cols-3 gap-4">
              <div className="col-span-2 space-y-4">
                <div className="bg-white/5 rounded-xl p-4">
                  <div className="h-3 bg-blue-500/30 rounded w-1/3 mb-3" />
                  <div className="h-2 bg-white/10 rounded w-full mb-2" />
                  <div className="h-2 bg-white/10 rounded w-4/5 mb-2" />
                  <div className="h-2 bg-white/10 rounded w-3/5" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Omsætning', value: '2.4 mia.' },
                    { label: 'Ansatte', value: '1.247' },
                    { label: 'Ejendomme', value: '34' },
                  ].map((stat) => (
                    <div key={stat.label} className="bg-white/5 rounded-xl p-4">
                      <div className="text-xs text-slate-500 mb-1">{stat.label}</div>
                      <div className="text-lg font-bold text-white">{stat.value}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white/5 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-2 h-2 bg-blue-400 rounded-full" />
                  <span className="text-xs text-slate-400">AI Assistent</span>
                </div>
                <div className="space-y-3">
                  <div className="bg-blue-600/20 rounded-lg p-3 text-xs text-slate-300">
                    Hvad er Maersks primære ejere?
                  </div>
                  <div className="bg-white/10 rounded-lg p-3 text-xs text-slate-400">
                    A.P. Møller Holding ejer 41.5% af stemmerettighederne...
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
