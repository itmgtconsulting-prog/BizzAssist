/**
 * Offentligt layout til SEO-sider (ejendomme, virksomheder).
 *
 * Leverer en enkel header med BizzAssist-logo + "Log ind"-knap og en
 * minimal footer — ingen dashboard-sidebar eller auth-navigation.
 *
 * Bruges af:
 *  - /ejendom/[slug]/[bfe]
 *  - /virksomhed/[slug]/[cvr]
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { companyInfo } from '@/app/lib/companyInfo';

// ─── Public Header ──────────────────────────────────────────────────────────

/**
 * Simpel offentlig header med logo og Log ind / Opret konto knapper.
 * Server Component — ingen klienthooks.
 */
function PublicHeader() {
  return (
    <header className="sticky top-0 z-50 bg-[#0f172a]/95 backdrop-blur-md border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-white font-bold text-sm">B</span>
            </div>
            <span className="text-white font-bold text-xl tracking-tight">
              Bizz<span className="text-blue-400">Assist</span>
            </span>
          </Link>

          {/* Actions */}
          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-slate-300 hover:text-white text-sm font-medium transition-colors hidden sm:block"
            >
              Log ind
            </Link>
            <Link
              href="/login/signup"
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              Opret konto
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

// ─── Public Footer ──────────────────────────────────────────────────────────

/**
 * Minimal offentlig footer med juridiske links og copyright.
 * Server Component.
 */
function PublicFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="bg-[#0a1020] border-t border-white/10 mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          {/* Brand */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
              <span className="text-white font-bold text-xs">B</span>
            </div>
            <span className="text-white font-semibold">
              Bizz<span className="text-blue-400">Assist</span>
            </span>
            <span className="text-slate-600 text-sm ml-2">
              © {year} {companyInfo.name}
            </span>
          </div>

          {/* Links */}
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-400">
            <Link href="/login" className="hover:text-white transition-colors">
              Log ind
            </Link>
            <Link href="/login/signup" className="hover:text-white transition-colors">
              Opret konto
            </Link>
            <Link href="/privacy" className="hover:text-white transition-colors">
              Privatlivspolitik
            </Link>
            <Link href="/terms" className="hover:text-white transition-colors">
              Vilkår
            </Link>
            <Link href="/cookies" className="hover:text-white transition-colors">
              Cookies
            </Link>
          </nav>
        </div>

        <p className="mt-6 text-xs text-slate-600 leading-relaxed">
          Data på denne side stammer fra offentlige registre: BBR (Bygnings- og Boligregistret), DAR
          (Danmarks Adresseregister), Datafordeler og CVR (Det Centrale Virksomhedsregister).
          BizzAssist er ikke ansvarlig for fejl i kildedataene.
        </p>
      </div>
    </footer>
  );
}

// ─── Layout ─────────────────────────────────────────────────────────────────

/**
 * Root layout for offentlige SEO-sider.
 *
 * @param children - Side-indhold fra child page.tsx
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-[#0f172a] text-slate-100">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  );
}
