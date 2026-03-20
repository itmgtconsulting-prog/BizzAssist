'use client';

import { createContext, useContext, useState, ReactNode } from 'react';
import { type Language } from '@/app/lib/translations';

interface LanguageContextType {
  lang: Language;
  setLang: (l: Language) => void;
}

const LanguageContext = createContext<LanguageContextType>({
  lang: 'da',
  setLang: () => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Lazy initializer reads localStorage once on mount — avoids setState-in-effect lint warning
  const [lang, setLangState] = useState<Language>(() => {
    if (typeof window === 'undefined') return 'da';
    const stored = localStorage.getItem('ba-lang') as Language | null;
    return stored === 'da' || stored === 'en' ? stored : 'da';
  });

  const setLang = (l: Language) => {
    setLangState(l);
    localStorage.setItem('ba-lang', l);
  };

  return <LanguageContext.Provider value={{ lang, setLang }}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);
