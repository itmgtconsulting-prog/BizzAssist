'use client';

import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { type Language } from '@/app/lib/translations';

interface LanguageContextType {
  lang: Language;
  setLang: (l: Language) => void;
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'da',
  setLang: () => {},
});

/**
 * Language provider with hybrid Supabase + localStorage persistence.
 *
 * - Reads from localStorage for instant render (no flicker)
 * - When authenticated, syncs to /api/preferences on change
 * - On first authenticated load, pulls server preference and updates local
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const hasSynced = useRef(false);

  // Lazy initializer reads localStorage once on mount
  const [lang, setLangState] = useState<Language>(() => {
    if (typeof window === 'undefined') return 'da';
    const stored = localStorage.getItem('ba-lang') as Language | null;
    return stored === 'da' || stored === 'en' ? stored : 'da';
  });

  const setLang = (l: Language) => {
    setLangState(l);
    localStorage.setItem('ba-lang', l);

    // Sync to server in background (fire-and-forget)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: l }),
    }).catch(() => {
      /* silent — localStorage is the fallback */
    });
  };

  // On mount: pull language from server if authenticated
  useEffect(() => {
    if (hasSynced.current) return;
    hasSynced.current = true;

    fetch('/api/preferences')
      .then((res) => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data) => {
        if (data?.language && (data.language === 'da' || data.language === 'en')) {
          const serverLang = data.language as Language;
          if (serverLang !== lang) {
            setLangState(serverLang);
            localStorage.setItem('ba-lang', serverLang);
          }
        }
      })
      .catch(() => {
        /* not authenticated or server error — keep localStorage value */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <LanguageContext.Provider value={{ lang, setLang }}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);
