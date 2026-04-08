/**
 * Server-component layout for the tokens section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Token-administration | BizzAssist',
  robots: { index: false, follow: false },
};

export default function TokensLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
