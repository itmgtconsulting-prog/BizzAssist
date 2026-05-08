/**
 * Server entry for aml-kyc analyse-modul.
 * BIZZ-1231: Bruger shared AnalyseModulLayout framework.
 */
import AmlKycClient from './AmlKycClient';

export const dynamic = 'force-dynamic';

export default function AmlKycPage() {
  return <AmlKycClient />;
}
