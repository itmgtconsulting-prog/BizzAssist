/**
 * /dashboard/forsikring/analyser/[id] — Analyse-detail side.
 *
 * BIZZ-1367: Viser analyse-resultat med aktiver, gaps og risk-score.
 *
 * @param params - Route params med analyse-ID
 */

import AnalyseDetailClient from './AnalyseDetailClient';

export default async function AnalyseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AnalyseDetailClient analyseId={id} />;
}
