/**
 * Server entry for ejendomsinvestor analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import EjendomsinvestorClient from './EjendomsinvestorClient';

export const dynamic = 'force-dynamic';

export default function EjendomsinvestorPage() {
  return <EjendomsinvestorClient />;
}
