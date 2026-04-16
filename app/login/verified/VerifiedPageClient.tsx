'use client';

/**
 * Email verification success page — app/login/verified/page.tsx
 *
 * Shown after the user clicks the verification link in their signup email
 * and Supabase successfully confirms their email address.
 *
 * Flow: signup → /login/verify-email (pending) → click email link
 *       → /auth/callback (exchanges code) → /login/verified (this page)
 *
 * @returns A confirmation screen with a "Log ind" button.
 */

import Link from 'next/link';
import { CheckCircle2, ArrowRight, Mail } from 'lucide-react';
import { companyInfo } from '@/app/lib/companyInfo';

export default function VerifiedPageClient() {
  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col items-center justify-center px-4">
      {/* BizzAssist logo top-left */}
      <div className="absolute top-5 left-6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-xs">B</span>
          </div>
          <span className="text-white font-bold text-lg">
            Bizz<span className="text-blue-400">Assist</span>
          </span>
        </div>
      </div>

      <div className="w-full max-w-md">
        <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl text-center">
          {/* Animated checkmark icon */}
          <div className="relative w-20 h-20 mx-auto mb-6">
            {/* Outer glow ring */}
            <div className="absolute inset-0 rounded-full bg-emerald-500/10 animate-pulse" />
            <div className="w-20 h-20 bg-emerald-500/15 rounded-full flex items-center justify-center">
              <CheckCircle2 size={42} className="text-emerald-400" />
            </div>
          </div>

          {/* Mail icon badge */}
          <div className="inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
            <Mail size={12} />
            E-mail verificeret
          </div>

          <h1 className="text-2xl font-bold text-white mb-3">Din konto er klar!</h1>

          <p className="text-slate-400 text-sm leading-relaxed mb-8 max-w-xs mx-auto">
            Din e-mailadresse er bekræftet og din konto på BizzAssist er nu aktiveret. Du er klar
            til at logge ind.
          </p>

          {/* Divider */}
          <div className="border-t border-white/8 mb-6" />

          <Link
            href="/login"
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Log ind på BizzAssist
            <ArrowRight size={16} />
          </Link>

          <p className="text-slate-600 text-xs mt-4">
            Har du problemer med at logge ind?{' '}
            <a
              href={`mailto:${companyInfo.supportEmail}`}
              className="text-slate-500 hover:text-slate-300 underline underline-offset-2 transition-colors"
            >
              Kontakt support
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
