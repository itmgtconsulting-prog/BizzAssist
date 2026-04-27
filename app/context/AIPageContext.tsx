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

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

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
  /** BIZZ-930: Valgte skabeloner for den aktuelle sag. */
  selectedTemplates?: Array<{ id: string; name: string }>;
  /** BIZZ-937: Linket klient på sagen (person eller virksomhed). */
  caseClient?: {
    kind: 'company' | 'person';
    name: string;
    cvr?: string;
    enhedsNummer?: string;
  };
  /** BIZZ-937: Sags-status og metadata. */
  caseStatus?: string;
  caseTags?: string[];
  caseClientRef?: string;
  /**
   * BIZZ-941: Pre-loaded ejendomme fra aktiv record. Kompakt summary
   * så AI ikke behøver re-fetche via tools.
   */
  preloadedEjendomme?: Array<{
    bfe: number;
    adresse: string | null;
    type: string | null;
    ejerandel?: string | null;
    personligtEjet?: boolean;
  }>;
  /** BIZZ-941: Antal ejendomme total (kan være flere end preloaded pga. cap). */
  ejendommeTotal?: number;
  /** BIZZ-941: Pre-loaded datterselskaber fra virksomheds-record. */
  preloadedDatterselskaber?: Array<{
    cvr: number;
    navn: string;
    aktiv: boolean;
    branche?: string | null;
  }>;
  /**
   * BIZZ-1000: Base64-encoded PNG af ejerskabsdiagrammet. Sættes automatisk
   * af DiagramForce når diagrammet er renderet. Bruges af generate_document
   * til at indlejre billede i Word/PPTX-eksport.
   */
  diagramBase64?: string;
  /**
   * BIZZ-1002: Virksomheds kontaktinfo — telefon, email, adresse.
   * Inkluderes i AI-kontekst så eksport-dokumenter kan indeholde kontaktdata.
   */
  virksomhedKontakt?: {
    telefon?: string | null;
    email?: string | null;
    adresse?: string | null;
    postnr?: string | null;
    by?: string | null;
  };
  /**
   * BIZZ-1002: Nøglepersoner — ejere, bestyrelse, direktion med roller.
   * Kompakt summary til AI-kontekst (max 20 personer).
   */
  virksomhedNoeglePersoner?: Array<{
    navn: string;
    roller: string[];
    ejerandel?: string | null;
    aktiv: boolean;
  }>;
  /**
   * BIZZ-1002: Seneste regnskabstal fra XBRL (nøgletal).
   * Inkluderes når regnskabs-tab er loaded.
   */
  virksomhedRegnskab?: {
    aar: number;
    omsaetning?: number | null;
    bruttofortjeneste?: number | null;
    resultat?: number | null;
    egenkapital?: number | null;
    balancesum?: number | null;
    ansatte?: number | null;
  };
  /**
   * BIZZ-1023: Preloaded ejendomsdata (vurdering, BBR-summary, ejerskab).
   * Reducerer tool-calls for standard ejendomsspørgsmål.
   */
  ejendomVurdering?: {
    ejendomsvaerdi?: number | null;
    grundvaerdi?: number | null;
    vurderingsaar?: number | null;
  };
  ejendomBBR?: {
    antalBygninger?: number;
    samletAreal?: number | null;
    opfoerelsesaar?: number | null;
    anvendelse?: string | null;
  };
  ejendomEjerskab?: Array<{
    navn: string;
    type: string;
    ejerandel?: string | null;
  }>;
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface AIPageContextValue {
  pageData: AIPageData | null;
  setPageData: (data: AIPageData | null) => void;
  /** BIZZ-985: Eksplicit rydning af al kontekst */
  clearPageData: () => void;
}

const AIPageContext = createContext<AIPageContextValue>({
  pageData: null,
  setPageData: () => {},
  clearPageData: () => {},
});

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Wrap dashboard layout med denne provider så alle child-sider og
 * AIChatPanel har adgang til den delte side-kontekst.
 *
 * BIZZ-985: Sticky kontekst — data ryddes IKKE automatisk ved navigation.
 * I stedet merger nye siders data ind i den eksisterende kontekst, så
 * AI Chat bevarer relevante detaljer fra den senest besøgte side.
 * Brug `clearPageData()` for eksplicit rydning.
 */
export function AIPageProvider({ children }: { children: ReactNode }) {
  const [pageData, setPageDataRaw] = useState<AIPageData | null>(null);

  // BIZZ-985: Merge-baseret setter — nye felter overskriver, men tomme
  // felter rydder ikke eksisterende værdier. null rydder alt.
  const setPageData = useCallback((data: AIPageData | null) => {
    if (data === null) {
      setPageDataRaw(null);
      return;
    }
    setPageDataRaw((prev) => {
      if (!prev) return data;
      // Merge: nye non-undefined felter overskriver, resten bevares
      const merged = { ...prev };
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (merged as any)[key] = value;
        }
      }
      return merged;
    });
  }, []);

  /** BIZZ-985: Eksplicit rydning af al kontekst */
  const clearPageData = useCallback(() => setPageDataRaw(null), []);

  return (
    <AIPageContext.Provider value={{ pageData, setPageData, clearPageData }}>
      {children}
    </AIPageContext.Provider>
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
 *
 * BIZZ-985: Data er nu sticky — nye felter merger ind i eksisterende kontekst.
 * Kald med `null` for at rydde alt.
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

/**
 * BIZZ-985: Eksplicit rydning af al AI-kontekst.
 * Bruges f.eks. af en "ryd kontekst"-knap i AIChatPanel.
 */
export function useClearAIPageContext() {
  const { clearPageData } = useContext(AIPageContext);
  return clearPageData;
}
