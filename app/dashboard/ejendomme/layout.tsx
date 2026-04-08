/**
 * Server-component layout for the ejendomme section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 * The actual page content is rendered by child pages (client components).
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Ejendomme | BizzAssist',
  robots: { index: false, follow: false },
};

export default function EjendommeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
