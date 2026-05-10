/**
 * Pivot Analyse — /dashboard/analyse/pivot
 *
 * BIZZ-1260: Manuel data explorer med FINOS Perspective pivot-tabel.
 * Bruger vælger tabel, kolonner og filtre — data vises i interaktiv
 * pivot-viewer med drag-and-drop gruppering og visualiseringer.
 *
 * @module app/dashboard/analyse/pivot
 */

import PivotExplorerClient from './PivotExplorerClient';

/**
 * Server entry point for Pivot Analyse.
 *
 * @returns Pivot explorer page
 */
export default function PivotPage() {
  return <PivotExplorerClient />;
}
