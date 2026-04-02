import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { LanguageProvider } from '@/app/context/LanguageContext';
import ServiceWorkerRegistration from '@/app/components/ServiceWorkerRegistration';
import SupportChatWidget from '@/app/components/SupportChatWidget';
import HideNextDevIndicator from '@/app/components/HideNextDevIndicator';
import CookieBanner from '@/app/components/CookieBanner';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'BizzAssist — Danmarks forretningsintelligens platform',
  description:
    'Få øjeblikkelig adgang til data om virksomheder, ejendomme og personer i Danmark. Analysér med AI og tag bedre beslutninger.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'BizzAssist',
  },
  openGraph: {
    title: 'BizzAssist',
    description: "Denmark's most comprehensive business intelligence platform",
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da" className={`${geistSans.variable} h-full`}>
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <LanguageProvider>
          {children}
          <CookieBanner />
          <SupportChatWidget />
          <HideNextDevIndicator />
          <ServiceWorkerRegistration />
        </LanguageProvider>
      </body>
    </html>
  );
}
