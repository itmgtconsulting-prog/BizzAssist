'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

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
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-white leading-tight mb-6">
            {hero.title}{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-sky-300">
              {hero.titleHighlight}
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            {hero.subtitle}
          </p>

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
