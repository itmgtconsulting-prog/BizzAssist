/**
 * Server-component layout for the companies section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Virksomheder | BizzAssist',
  robots: { index: false, follow: false },
};

export default function CompaniesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
