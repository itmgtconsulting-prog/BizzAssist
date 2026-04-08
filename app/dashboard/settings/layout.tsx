/**
 * Server-component layout for the settings section.
 * Exports section-level metadata so the browser tab shows a meaningful title.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Indstillinger | BizzAssist',
  robots: { index: false, follow: false },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
