/**
 * Server-component layout for the kort (map) section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Kort | BizzAssist',
  robots: { index: false, follow: false },
};

export default function KortLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
