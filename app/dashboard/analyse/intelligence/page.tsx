/**
 * Data Intelligence — /dashboard/analyse/intelligence
 *
 * BIZZ-1701: Redirecter til AI Chat — DI-funktionalitet er nu integreret
 * i AI Chat via data_intelligence tool (BIZZ-1697).
 *
 * @module app/dashboard/analyse/intelligence
 */

import { redirect } from 'next/navigation';

/**
 * Server entry — redirect til AI Chat.
 */
export default function AnalyseIntelligencePage() {
  // AI Chat sidebar er tilgængelig fra alle dashboard-sider.
  // Redirect til hoved-dashboard hvor chatten kan bruges direkte.
  redirect('/dashboard');
}
