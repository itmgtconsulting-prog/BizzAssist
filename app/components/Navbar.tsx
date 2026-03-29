'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

export default function Navbar() {
  const { lang, setLang } = useLanguage();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = translations[lang].nav;

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? 'bg-[#0f172a]/95 backdrop-blur-md shadow-lg' : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">B</span>
            </div>
            <span className="text-white font-bold text-xl tracking-tight">
              Bizz<span className="text-blue-400">Assist</span>
            </span>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-8">
            {[
              { href: '#features', label: nav.features },
              { href: '#use-cases', label: nav.useCases },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-slate-300 hover:text-white text-sm font-medium transition-colors"
              >
                {item.label}
              </a>
            ))}
            <Link
              href="/login/signup"
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
            >
              {nav.getStarted}
            </Link>
          </nav>

          {/* Right side */}
          <div className="hidden md:flex items-center gap-4">
            {/* Language Toggle */}
            <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
              <button
                onClick={() => setLang('da')}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  lang === 'da' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
              >
                DA
              </button>
              <button
                onClick={() => setLang('en')}
                className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  lang === 'en' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
              >
                EN
              </button>
            </div>

            <Link
              href="/login"
              className="text-slate-300 hover:text-white text-sm font-medium transition-colors"
            >
              {nav.login}
            </Link>
          </div>

          {/* Mobile menu button */}
          <button className="md:hidden text-white p-2" onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-[#0f172a] border-t border-white/10">
          <div className="px-4 py-6 space-y-4">
            {[
              { href: '#features', label: nav.features },
              { href: '#use-cases', label: nav.useCases },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className="block text-slate-300 hover:text-white font-medium py-2"
              >
                {item.label}
              </a>
            ))}
            <div className="pt-4 border-t border-white/10 space-y-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLang('da')}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                    lang === 'da'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 border border-white/20'
                  }`}
                >
                  Dansk
                </button>
                <button
                  onClick={() => setLang('en')}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                    lang === 'en'
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 border border-white/20'
                  }`}
                >
                  English
                </button>
              </div>
              <Link
                href="/login"
                className="block text-center border border-white/20 text-white font-semibold py-3 rounded-lg"
              >
                {nav.login}
              </Link>
              <Link
                href="/login"
                className="block text-center bg-blue-600 text-white font-semibold py-3 rounded-lg"
              >
                {nav.getStarted}
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
