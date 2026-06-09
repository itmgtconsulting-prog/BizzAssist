import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
// BIZZ-1923: headers() fjernet — tvang alle pages til dynamic mode
import { Geist } from 'next/font/google';
import './globals.css';
import 'mapbox-gl/dist/mapbox-gl.css';
import { LanguageProvider } from '@/app/context/LanguageContext';
import ServiceWorkerRegistration from '@/app/components/ServiceWorkerRegistration';
import HideNextDevIndicator from '@/app/components/HideNextDevIndicator';
import CookieBanner from '@/app/components/CookieBanner';
import AnalyticsWithConsent from '@/app/components/AnalyticsWithConsent';
// BIZZ-1923: getConsentFromCookieHeader fjernet — erstattet af client-side check

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
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk'),
  title: 'BizzAssist — Danmarks forretningsintelligens platform',
  description:
    'Få øjeblikkelig adgang til data om virksomheder, ejendomme og personer i Danmark. Analysér med AI og tag bedre beslutninger.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'BizzAssist',
  },
  // Hreflang alternates — appen er fuldt tosproget (DA/EN) på SAMME URL-struktur.
  // Sproget styres via client-side toggle i Navbar.tsx (ikke URL-prefix), så
  // både `da` og `en` peger på samme canonical URL. Bemærk: der findes INGEN
  // /en route — at sætte `en: '${baseUrl}/en'` her vil generere et 404-link.
  alternates: {
    canonical: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
    languages: {
      da: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
      en: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
      'x-default': process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
    },
  },
  openGraph: {
    title: 'BizzAssist',
    description: 'Dansk erhvervs- og ejendomsintelligens',
    type: 'website',
    siteName: 'BizzAssist',
    locale: 'da_DK',
    images: [
      {
        url: '/images/dashboard-preview.png',
        width: 1902,
        height: 915,
        alt: 'BizzAssist dashboard',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'BizzAssist',
    description: 'Dansk erhvervs- og ejendomsintelligens',
    images: ['/images/dashboard-preview.png'],
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
};

/**
 * Root layout for the entire application.
 *
 * Reads the `bizzassist_consent` cookie during SSR to decide whether to
 * include Vercel Analytics. Analytics are only rendered when the user has
 * explicitly accepted cookies via the GDPR banner.
 */
// BIZZ-1923: Root layout må IKKE kalde headers()/cookies() — det tvinger
// alle pages (inkl. public SEO routes) til dynamic mode og ødelægger ISR.
// Analytics consent tjekkes nu client-side via AnalyticsWithConsent.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da" className={`${geistSans.variable} h-full`}>
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <Suspense>
          <LanguageProvider>
            {children}
            <CookieBanner />
            {/* BIZZ-808: SupportChatWidget er flyttet ind i DashboardLayout
                som et menupunkt, så floating-knappen ikke overlapper resten
                af appen. Offentlige sider har ikke længere in-app support —
                tilføj separat mount her hvis behov opstår. */}
            <HideNextDevIndicator />
            <ServiceWorkerRegistration />
            <AnalyticsWithConsent />
          </LanguageProvider>
        </Suspense>
      </body>
    </html>
  );
}
