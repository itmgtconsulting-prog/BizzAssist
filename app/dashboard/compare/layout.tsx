/**
 * Server-component layout for the compare section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sammenlign | BizzAssist',
  robots: { index: false, follow: false },
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
