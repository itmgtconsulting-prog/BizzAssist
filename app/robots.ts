/**
 * Dynamisk robots.txt via Next.js App Router.
 *
 * Styrer søgemaskine-indeksering baseret på miljø:
 *  - Production (bizzassist.dk): Tillader offentlige sider, blokerer dashboard/API
 *  - Test / preview (test.bizzassist.dk, Vercel previews): Blokerer ALT
 *
 * Miljø-detektering:
 *  - VERCEL_ENV === 'production'  → production
 *  - NEXT_PUBLIC_APP_URL indeholder 'bizzassist.dk' (ikke 'test.') → production
 *  - Alt andet → test/preview → fuld blokering
 */

import type { MetadataRoute } from 'next';

/**
 * Returnerer robots.txt indhold tilpasset det aktuelle miljø.
 *
 * @returns MetadataRoute.Robots objekt som Next.js serialiserer til robots.txt
 */
export default function robots(): MetadataRoute.Robots {
  const isProduction =
    process.env.VERCEL_ENV === 'production' ||
    (!!process.env.NEXT_PUBLIC_APP_URL &&
      process.env.NEXT_PUBLIC_APP_URL.includes('bizzassist.dk') &&
      !process.env.NEXT_PUBLIC_APP_URL.includes('test.bizzassist.dk'));

  if (!isProduction) {
    // Test / preview: Bloker ALT fra indeksering
    return {
      rules: { userAgent: '*', disallow: '/' },
    };
  }

  // Vi er her kun i produktion (isProduction===true), så env var er sikker at bruge.
  // BIZZ-645: trim() fjerner trailing newlines/whitespace fra Vercel-env-var så
  // Sitemap: header ikke breakes op. Uden trim blev "Sitemap: https://bizzassist.dk\n/sitemap/0.xml"
  // eftersom NEXT_PUBLIC_APP_URL-værdien på Vercel indeholdt en trailing \n.
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk')
    .trim()
    .replace(/\/$/, '');

  // Production: Tillad offentlige SEO-sider, bloker alt andet.
  // BIZZ-645: Pege på /sitemap.xml (sitemap-index) i stedet for første fil
  // direkte — Google foretrækker index-konventionen så paginerede filer
  // auto-discover'es.
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/ejendom/', '/virksomhed/'],
        disallow: ['/dashboard/', '/api/', '/login/', '/auth/', '/admin/'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
