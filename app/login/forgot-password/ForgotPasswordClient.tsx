'use client';

/**
 * Forgot password page — app/login/forgot-password/page.tsx
 *
 * User enters their email. We call requestPasswordReset() which always
 * returns success (to prevent email enumeration). A "check your email"
 * confirmation is shown regardless of whether the email exists.
 */

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Mail, CheckCircle2 } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { requestPasswordReset } from '@/app/auth/actions';

/**
 * Forgot password form component.
 */
export default function ForgotPasswordClient() {
  const { lang, setLang } = useLanguage();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f172a] flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-5">
        <Link
          href="/login"
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={18} />
          <span className="text-white font-bold text-lg">
            Bizz<span className="text-blue-400">Assist</span>
          </span>
        </Link>
        <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
          {(['da', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${lang === l ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="bg-[#1e293b] border border-white/10 rounded-2xl p-8 shadow-2xl">
            {sent ? (
              /* Success state */
              <div className="text-center">
                <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                  <CheckCircle2 size={32} className="text-emerald-400" />
                </div>
                <h1 className="text-2xl font-bold text-white mb-3">
                  {lang === 'da' ? 'E-mail sendt!' : 'Email sent!'}
                </h1>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  {lang === 'da'
                    ? `Hvis ${email} er registreret, har vi sendt et nulstillingslink. Tjek din indbakke.`
                    : `If ${email} is registered, we've sent a reset link. Check your inbox.`}
                </p>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors"
                >
                  <ArrowLeft size={16} />
                  {lang === 'da' ? 'Tilbage til log ind' : 'Back to log in'}
                </Link>
              </div>
            ) : (
              /* Form state */
              <>
                <div className="text-center mb-8">
                  <div className="w-14 h-14 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Mail size={28} className="text-blue-400" />
                  </div>
                  <h1 className="text-2xl font-bold text-white mb-2">
                    {lang === 'da' ? 'Glemt adgangskode?' : 'Forgot password?'}
                  </h1>
                  <p className="text-slate-400 text-sm">
                    {lang === 'da'
                      ? 'Indtast din e-mail og vi sender dig et nulstillingslink.'
                      : "Enter your email and we'll send you a reset link."}
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-slate-300 text-sm font-medium mb-2">
                      {lang === 'da' ? 'E-mail' : 'Email'}
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={lang === 'da' ? 'navn@virksomhed.dk' : 'name@company.com'}
                      autoComplete="email"
                      required
                      disabled={loading}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition-colors text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                    {loading && <Loader2 size={16} className="animate-spin" />}
                    {lang === 'da' ? 'Send nulstillingslink' : 'Send reset link'}
                  </button>
                </form>

                <p className="text-center mt-6">
                  <Link
                    href="/login"
                    className="inline-flex items-center gap-1 text-slate-400 hover:text-white text-sm transition-colors"
                  >
                    <ArrowLeft size={14} />
                    {lang === 'da' ? 'Tilbage til log ind' : 'Back to log in'}
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
