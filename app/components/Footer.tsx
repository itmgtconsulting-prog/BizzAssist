'use client';

import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

export default function Footer() {
  const { lang } = useLanguage();
  const footer = translations[lang].footer;

  return (
    <footer className="bg-[#0f172a] text-slate-400 py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid md:grid-cols-5 gap-10 mb-12">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">B</span>
              </div>
              <span className="text-white font-bold text-xl">
                Bizz<span className="text-blue-400">Assist</span>
              </span>
            </div>
            <p className="text-slate-500 text-sm leading-relaxed">{footer.tagline}</p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-white font-semibold mb-4">{footer.product}</h4>
            <ul className="space-y-3 text-sm">
              {[footer.links.features, footer.links.pricing, footer.links.api].map((l) => (
                <li key={l}>
                  <Link href="#" className="hover:text-white transition-colors">
                    {l}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-white font-semibold mb-4">{footer.company}</h4>
            <ul className="space-y-3 text-sm">
              {[footer.links.about, footer.links.blog, footer.links.careers].map((l) => (
                <li key={l}>
                  <Link href="#" className="hover:text-white transition-colors">
                    {l}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-white font-semibold mb-4">{footer.legal}</h4>
            <ul className="space-y-3 text-sm">
              {[footer.links.privacy, footer.links.terms, footer.links.cookies].map((l) => (
                <li key={l}>
                  <Link href="#" className="hover:text-white transition-colors">
                    {l}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-white font-semibold mb-4">{footer.contact}</h4>
            <ul className="space-y-3 text-sm">
              <li>
                <span className="text-slate-500 block text-xs mb-0.5">{footer.links.business}</span>
                <a href="mailto:info@pecuniait.com" className="hover:text-white transition-colors">
                  info@pecuniait.com
                </a>
              </li>
              <li>
                <span className="text-slate-500 block text-xs mb-0.5">{footer.links.support}</span>
                <a
                  href="mailto:support@pecuniait.com"
                  className="hover:text-white transition-colors"
                >
                  support@pecuniait.com
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/10 pt-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-slate-500 text-sm">{footer.copyright}</p>
            <p className="text-slate-600 text-xs">
              {footer.supplier.label}:{' '}
              <span className="text-slate-500">{footer.supplier.name}</span>
              {' · '}
              <span className="text-slate-600">{footer.supplier.cvr}</span>
              {' · '}
              <span className="text-slate-600">{footer.supplier.address}</span>
            </p>
          </div>
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <span className="w-2 h-2 bg-green-400 rounded-full" />
            {lang === 'da' ? 'Alle systemer kører' : 'All systems operational'}
          </div>
        </div>
      </div>
    </footer>
  );
}
