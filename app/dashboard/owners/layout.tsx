/**
 * Server-component layout for the owners section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Ejere | BizzAssist',
  robots: { index: false, follow: false },
};

export default function OwnersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
