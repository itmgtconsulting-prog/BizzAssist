/**
 * DI Result Store — shared state mellem AI Chat og DI-hovedområdet.
 *
 * BIZZ-1708: Når AI Chat kalder data_intelligence tool, pushes resultatet
 * til denne store. IntelligenceClient subscribes og renderer i fuld bredde.
 *
 * Bruger simpel event-emitter pattern (ingen zustand dependency).
 *
 * @module app/lib/diResultStore
 */

/** Et DI-resultat fra data_intelligence tool */
export interface DiResult {
  /** Kolonne-navne */
  columns: string[];
  /** Data-rækker */
  rows: unknown[][];
  /** Totalt antal rækker */
  rowCount: number;
  /** Visualiseringstype */
  chartType: 'table' | 'bar' | 'line' | 'pie' | 'number';
  /** Brugerens spørgsmål */
  query: string;
  /** Tidsstempel */
  timestamp: number;
  /** Om data er afkortet */
  afkortet: boolean;
}

type Listener = (result: DiResult) => void;

const listeners = new Set<Listener>();
let latestResult: DiResult | null = null;

/**
 * Push et nyt DI-resultat til store.
 * Alle subscribers notificeres.
 */
export function pushDiResult(result: DiResult): void {
  latestResult = result;
  for (const fn of listeners) {
    try {
      fn(result);
    } catch {
      /* listener error non-fatal */
    }
  }
}

/**
 * Subscribe til DI-resultater.
 * Returnerer unsubscribe-funktion.
 */
export function subscribeDiResult(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Hent seneste DI-resultat (null hvis intet).
 */
export function getLatestDiResult(): DiResult | null {
  return latestResult;
}
