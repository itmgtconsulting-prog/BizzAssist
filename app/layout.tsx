import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import 'mapbox-gl/dist/mapbox-gl.css';
import { LanguageProvider } from '@/app/context/LanguageContext';
import ServiceWorkerRegistration from '@/app/components/ServiceWorkerRegistration';
import SupportChatWidget from '@/app/components/SupportChatWidget';
import HideNextDevIndicator from '@/app/components/HideNextDevIndicator';
import CookieBanner from '@/app/components/CookieBanner';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

/** True kun på bizzassist.dk production — bruges til robots/noindex guard */
const isProduction =
  process.env.VERCEL_ENV === 'production' ||
  (!!process.env.NEXT_PUBLIC_APP_URL &&
    process.env.NEXT_PUBLIC_APP_URL.includes('bizzassist.dk') &&
    !process.env.NEXT_PUBLIC_APP_URL.includes('test.bizzassist.dk'));

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
  // Hreflang alternates — appen er fuldt tosproget (DA/EN) på samme URL-struktur
  alternates: {
    canonical: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
    languages: {
      da: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
      en: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk'}/en`,
      'x-default': process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
    },
  },
  openGraph: {
    title: 'BizzAssist',
    description: 'Dansk erhvervs- og ejendomsintelligens',
    type: 'website',
    siteName: 'BizzAssist',
    locale: 'da_DK',
    // TODO: Erstat /icons/og-image.png med en rigtig 1200×630 PNG før launch
    images: [{ url: '/icons/og-image.png', width: 1200, height: 630, alt: 'BizzAssist' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'BizzAssist',
    description: 'Dansk erhvervs- og ejendomsintelligens',
    // TODO: Erstat /icons/og-image.png med en rigtig 1200×630 PNG før launch
    images: ['/icons/og-image.png'],
  },
  // Bloker alle sider fra indeksering på test/preview-miljøer
  ...(!isProduction && {
    robots: { index: false, follow: false },
  }),
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
