'use client';

/**
 * AIPageContext — deler side-specifik data med AI-assistenten.
 *
 * Pages sætter kontekst via `useSetAIPageContext` når deres data loader.
 * AIChatPanel læser den via `useAIPageContext` og inkluderer den i API-kaldet.
 *
 * Eksempel:
 *   // I ejendomsdetaljesiden:
 *   useSetAIPageContext({ bfeNummer, kommunekode, adresseId, adresse });
 *
 *   // I AIChatPanel (læser automatisk):
 *   const { pageData } = useAIPageContext();
 */

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Struktureret side-kontekst som AI-assistenten kan bruge direkte.
 * Alle felter er valgfrie — sæt kun dem der er tilgængelige på siden.
 */
export interface AIPageData {
  /** Adresse som vist på siden, f.eks. "Søbyvej 11, 2650 Hvidovre" */
  adresse?: string;
  /** DAWA / DAR adgangsadresse UUID */
  adresseId?: string;
  /** BFE-nummer (Bestemt Fast Ejendom) */
  bfeNummer?: string;
  /** 4-cifret kommunekode, f.eks. "0167" */
  kommunekode?: string;
  /** Matrikelnummer, f.eks. "21cn" */
  matrikelnr?: string;
  /** Numerisk ejerlavkode */
  ejerlavKode?: string;
  /** 8-cifret CVR-nummer (virksomhed) */
  cvrNummer?: string;
  /** CVR enhedsnummer for en person (deltager) */
  enhedsNummer?: string;
  /** Personens fulde navn */
  personNavn?: string;
  /** Virksomhedens navn */
  virksomhedNavn?: string;
  /**
   * Allerede loadede virksomhedstilknytninger for personen på siden.
   * Inkluderer aktive CVR-numre, roller og ejerandele.
   * Når dette felt er sat, behøver AI'en ikke kalde hent_person_virksomheder.
   */
  personVirksomheder?: Array<{
    cvr: number;
    navn: string;
    branche: string | null;
    aktiv: boolean;
    ejerandel: string | null; // Interval-streng, f.eks. "90-100%"
    roller: string[]; // Aktive rolle-navne
  }>;
  /**
   * BIZZ-874: Aktiv tab på detalje-siden (fx "oversigt" / "ejendomme" /
   * "regnskab" / "diagram"). Sendes til AI så den ved hvad brugeren mener
   * når de refererer til "det her tab" eller "oversigt-tabbet".
   */
  activeTab?: string;
  /**
   * BIZZ-874: Type af detaljeside — 'virksomhed' | 'person' | 'ejendom'.
   * Bruges sammen med activeTab for korrekt tool-dispatch.
   */
  pageType?: 'virksomhed' | 'person' | 'ejendom' | 'domain';
  /**
   * BIZZ-902 (parent BIZZ-896): Aktuel domain-sag og valgte dokumenter
   * fra sager-workspace. Når brugeren åbner AI Chat fra /domain/[id]?sag=X
   * og har checked dokumenter, sendes dette så AI kan bruge dokumenterne
   * som primær kontekst uden at skulle lede efter dem selv.
   */
  currentCaseId?: string;
  currentCaseName?: string;
  /**
   * BIZZ-902: Let-weight summary af de valgte dokumenter (id + navn).
   * Full extractedText hentes via hent_dokument_indhold tool-call efter
   * AI beslutter sig for at læse et specifikt doc. Undgår at sende hele
   * tekst-payload i hver chat-request.
   */
  selectedDocuments?: Array<{ id: string; name: string }>;
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface AIPageContextValue {
  pageData: AIPageData | null;
  setPageData: (data: AIPageData | null) => void;
}

const AIPageContext = createContext<AIPageContextValue>({
  pageData: null,
  setPageData: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Wrap dashboard layout med denne provider så alle child-sider og
 * AIChatPanel har adgang til den delte side-kontekst.
 * Rydder automatisk data når pathname ændres (navigation til ny side).
 */
export function AIPageProvider({ children }: { children: ReactNode }) {
  const [pageData, setPageDataRaw] = useState<AIPageData | null>(null);
  const pathname = usePathname();

  // Ryd side-data ved navigation — ny side loader sit eget
  useEffect(() => {
    setPageDataRaw(null);
  }, [pathname]);

  const setPageData = useCallback((data: AIPageData | null) => {
    setPageDataRaw(data);
  }, []);

  return (
    <AIPageContext.Provider value={{ pageData, setPageData }}>{children}</AIPageContext.Provider>
  );
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Læs den aktuelle side-kontekst (bruges af AIChatPanel).
 *
 * @returns { pageData } — struktureret data fra den aktuelle side
 */
export function useAIPageContext() {
  return useContext(AIPageContext);
}

/**
 * Sæt side-kontekst fra en page-komponent. Kald i en useEffect når data loader.
 * Data ryddes automatisk ved navigation.
 *
 * @example
 * const setAICtx = useSetAIPageContext();
 * useEffect(() => {
 *   if (bfeNummer) setAICtx({ bfeNummer, kommunekode, adresse });
 * }, [bfeNummer]);
 */
export function useSetAIPageContext() {
  const { setPageData } = useContext(AIPageContext);
  return setPageData;
}
