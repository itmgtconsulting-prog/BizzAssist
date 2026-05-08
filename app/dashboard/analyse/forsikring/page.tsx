/**
 * Server entry for forsikrings-gap-analyse.
 * BIZZ-1223: Dedikeret side under Analyse-menuen.
 */
import ForsikringGapClient from './ForsikringGapClient';

export const dynamic = 'force-dynamic';

export default function ForsikringGapPage() {
  return <ForsikringGapClient />;
}
