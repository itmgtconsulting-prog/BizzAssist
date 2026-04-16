'use client';

import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';
import { companyInfo } from '@/app/lib/companyInfo';

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

          {/* Legal */}
          <div>
            <h4 className="text-white font-semibold mb-4">{footer.legal}</h4>
            <ul className="space-y-3 text-sm">
              {[
                { label: footer.links.privacy, href: '/privacy' },
                { label: footer.links.terms, href: '/terms' },
                { label: footer.links.cookies, href: '/cookies' },
              ].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-white transition-colors">
                    {l.label}
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
                <span className="text-slate-500 block text-xs mb-0.5">{footer.links.support}</span>
                <a
                  href={`mailto:${companyInfo.supportEmail}`}
                  className="hover:text-white transition-colors"
                >
                  {companyInfo.supportEmail}
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/10 pt-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-slate-500 text-sm">{footer.copyright}</p>
            <p className="text-slate-500 text-xs">
              {footer.supplier.label}:{' '}
              <span className="text-slate-400">{footer.supplier.name}</span>
              {' · '}
              <span className="text-slate-500">{footer.supplier.cvr}</span>
              {' · '}
              <span className="text-slate-500">{footer.supplier.address}</span>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
