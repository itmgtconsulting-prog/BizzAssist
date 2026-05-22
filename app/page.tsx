// redirect moved to middleware.ts (BIZZ-1783)
import JsonLd from '@/app/components/JsonLd';
import Navbar from '@/app/components/Navbar';
import Hero from '@/app/components/Hero';
import Features from '@/app/components/Features';
import UseCases from '@/app/components/UseCases';
import PopularEntities from '@/app/components/PopularEntities';
import PricingSection from '@/app/components/PricingSection';
import CTABanner from '@/app/components/CTABanner';
import Footer from '@/app/components/Footer';

/** WebSite JSON-LD structured data — forbedrer søgemaskine-forståelse af sitenavnet */
const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'BizzAssist',
  url: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
};

/**
 * Marketing homepage.
 *
 * Also handles the Supabase auth fallback: when `uri_allow_list` does not
 * include the callback URL, Supabase redirects the PKCE code to `site_url`
 * (i.e. the homepage) as `/?code=XXX`. We catch that here and forward it to
 * the real auth callback route so email verification still completes.
 *
 * @param searchParams - Next.js page search params (code, type, token_hash, error)
 */
export default function HomePage() {
  // BIZZ-1783: PKCE callback detection moved to middleware.ts
  // so this page can be statically cached for SEO.
  return (
    <main className="flex flex-col min-h-screen">
      {/* BIZZ-219: JSON-LD structured data via safe helper component */}
      <JsonLd data={websiteJsonLd} />
      <Navbar />
      <Hero />
      <Features />
      <UseCases />
      <PopularEntities />
      <PricingSection />
      <CTABanner />
      <Footer />
    </main>
  );
}
