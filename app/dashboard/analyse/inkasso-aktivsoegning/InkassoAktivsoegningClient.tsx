/**
 * inkasso-aktivsoegning analyse-modul klient-komponent.
 * BIZZ-1231: Wrapper rundt om shared AnalyseModulLayout.
 */

'use client';

import AnalyseModulLayout from '@/app/components/analyse/AnalyseModulLayout';
import { ANALYSE_MODULER } from '@/app/lib/analysePromptBuilder';

/** Find modul-definition */
const modul = ANALYSE_MODULER.find((m) => m.id === 'inkasso-aktivsoegning')!;

/**
 * InkassoAktivsoegningClient analyse-modul.
 *
 * @returns Analyse UI
 */
export default function InkassoAktivsoegningClient() {
  return <AnalyseModulLayout modul={modul} />;
}
