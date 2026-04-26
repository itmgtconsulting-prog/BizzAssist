'use client';

/**
 * useFiltersFromURL (BIZZ-792 / BIZZ-788a) — synkroniserer filter-state
 * to-vejs med URL query params så filtre bliver bookmarkable/delelige.
 *
 * Arkitektur-valg per ARCHITECT sign-off (2026-04-23):
 *   - 300ms debounce på URL-write (reducerer history-spam ved drag på range)
 *   - URL-read er synkron via useSearchParams (næste Next.js ReadonlyURLSearchParams)
 *   - Default-værdier skrives ikke til URL (delte links er renere)
 *   - `q` søgetekst håndteres separat af caller — hook'en rører ikke `q`
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  parseFiltersFromSearchParams,
  serializeFiltersToSearchParams,
  type FilterSchema,
  type FilterState,
} from '@/app/lib/search/filterSchema';

interface UseFiltersFromURLOptions {
  /** Debounce ms før URL'en opdateres (default 300ms pr. ARCHITECT krav). */
  debounceMs?: number;
}

/**
 * Returnerer {filters, setFilters, resetFilters} hvor filters altid reflekterer
 * URL'en (via useSearchParams) og setFilters skriver til URL'en efter debounce.
 *
 * @param schemas - Array af FilterSchema der definerer hvilke params der læses
 * @param options - {debounceMs}
 */
export function useFiltersFromURL(
  schemas: FilterSchema[],
  options: UseFiltersFromURLOptions = {}
): {
  filters: FilterState;
  setFilters: (next: FilterState) => void;
  setFilter: (key: string, value: FilterState[string]) => void;
} {
  const { debounceMs = 300 } = options;
  const router = useRouter();
  const searchParams = useSearchParams();

  // Hydration-sikker initial state. useSearchParams kan være null i edge-cases.
  const initial = useMemo(
    () => parseFiltersFromSearchParams(schemas, searchParams ?? new URLSearchParams()),
    // Schemas er konstant per page-instance (defineret out-of-render), så det
    // er sikkert at bruge schemas som dep — bytes kun ved side-navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schemas]
  );
  const [filters, setFiltersState] = useState<FilterState>(initial);

  // Når URL'en ændres eksternt (back/forward, eller anden komponent), sync
  // state'en. Bruger ref til at undgå loop med vores egen router.replace.
  const selfWriteRef = useRef(false);
  useEffect(() => {
    if (selfWriteRef.current) {
      selfWriteRef.current = false;
      return;
    }
    const next = parseFiltersFromSearchParams(schemas, searchParams ?? new URLSearchParams());
    setFiltersState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Debounced URL write. Cleanup timer ved hver ny setFilters-kald.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleURLWrite = useCallback(
    (nextState: FilterState) => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        const base = new URLSearchParams(window.location.search);
        const merged = serializeFiltersToSearchParams(schemas, nextState, base);
        selfWriteRef.current = true;
        const qs = merged.toString();
        router.replace(qs.length > 0 ? `?${qs}` : window.location.pathname, { scroll: false });
      }, debounceMs);
    },
    [schemas, debounceMs, router]
  );

  // Cleanup timer ved unmount så vi ikke skriver efter at komponenten er gone.
  useEffect(() => {
    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, []);

  const setFilters = useCallback(
    (next: FilterState) => {
      setFiltersState(next);
      scheduleURLWrite(next);
    },
    [scheduleURLWrite]
  );

  const setFilter = useCallback(
    (key: string, value: FilterState[string]) => {
      setFiltersState((prev) => {
        const next = { ...prev, [key]: value };
        scheduleURLWrite(next);
        return next;
      });
    },
    [scheduleURLWrite]
  );

  return { filters, setFilters, setFilter };
}
