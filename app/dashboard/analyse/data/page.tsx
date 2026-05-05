/**
 * Data Analyse — /dashboard/analyse/data
 *
 * BIZZ-1038: AI Query Builder — skriv dansk forespørgsel → AI genererer
 * SQL → resultat vises som graf + tabel.
 */

import AnalyseDataClient from './AnalyseDataClient';

/**
 * Server entry point for Data Analyse.
 * Renderer AnalyseDataClient som klient-komponent.
 */
export default function AnalyseDataPage() {
  return <AnalyseDataClient />;
}
