'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

export default function CTABanner() {
  const { lang } = useLanguage();
  const cta = translations[lang].cta;

  return (
    <section className="py-24 bg-[#0f172a]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-3xl overflow-hidden border border-blue-500/20 bg-gradient-to-br from-blue-600/20 via-blue-900/20 to-[#0f172a]">
          {/* Glow */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-px bg-gradient-to-r from-transparent via-blue-500/50 to-transparent" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(37,99,235,0.15),transparent_60%)]" />

          <div className="relative px-8 py-16 md:py-20 text-center">
            <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">{cta.title}</h2>
            <p className="text-slate-400 text-xl mb-10 max-w-xl mx-auto">{cta.subtitle}</p>
            <div className="flex justify-center">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold text-lg px-8 py-4 rounded-xl transition-colors"
              >
                {cta.button}
                <ArrowRight size={20} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
