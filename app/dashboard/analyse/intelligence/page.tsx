/**
 * Data Intelligence — /dashboard/analyse/intelligence (BIZZ-1428)
 *
 * Smart SQL endpoint — dansk-prompt → AI genererer SQL → AST-validator →
 * read-only execution → resultat med chart-recommendation.
 *
 * @module app/dashboard/analyse/intelligence
 */

import IntelligenceClient from './IntelligenceClient';

/**
 * Server entry — renderer IntelligenceClient (klient-komponent for state).
 */
export default function AnalyseIntelligencePage() {
  return <IntelligenceClient />;
}
