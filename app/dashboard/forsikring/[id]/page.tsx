/**
 * Server entry — forces dynamic rendering. Forsikrings detail-side.
 */
import ForsikringDetailClient from './ForsikringDetailClient';

export const dynamic = 'force-dynamic';

export default async function ForsikringDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ForsikringDetailClient policyId={id} />;
}
