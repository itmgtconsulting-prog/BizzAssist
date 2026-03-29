'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/app/context/LanguageContext';

/**
 * GDPR cookie consent banner.
 * Shows on first visit, stores consent in localStorage.
 */
export default function CookieBanner() {
  const { lang } = useLanguage();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const consent = localStorage.getItem('cookie_consent');
    if (!consent) setVisible(true);
  }, []);

  const accept = () => {
    localStorage.setItem('cookie_consent', 'accepted');
    setVisible(false);
  };

  const decline = () => {
    localStorage.setItem('cookie_consent', 'declined');
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4">
      <div className="max-w-4xl mx-auto bg-[#1e293b] border border-white/10 rounded-2xl p-5 shadow-2xl flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <p className="text-slate-300 text-sm flex-1 leading-relaxed">
          {lang === 'da' ? (
            <>
              Vi bruger cookies til at sikre, at platformen fungerer korrekt. Læs mere i vores{' '}
              <Link href="/cookies" className="text-blue-400 hover:underline">
                cookiepolitik
              </Link>
              .
            </>
          ) : (
            <>
              We use cookies to ensure the platform works correctly. Read more in our{' '}
              <Link href="/cookies" className="text-blue-400 hover:underline">
                cookie policy
              </Link>
              .
            </>
          )}
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={decline}
            className="text-sm text-slate-400 hover:text-white border border-white/10 hover:border-white/20 px-4 py-2 rounded-lg transition-colors"
          >
            {lang === 'da' ? 'Kun nødvendige' : 'Necessary only'}
          </button>
          <button
            onClick={accept}
            className="text-sm text-white bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            {lang === 'da' ? 'Acceptér alle' : 'Accept all'}
          </button>
        </div>
      </div>
    </div>
  );
}
