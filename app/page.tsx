import { redirect } from 'next/navigation';
import Navbar from '@/app/components/Navbar';
import Hero from '@/app/components/Hero';
import Features from '@/app/components/Features';
import UseCases from '@/app/components/UseCases';
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
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; type?: string; token_hash?: string; error?: string }>;
}) {
  const params = await searchParams;

  // Supabase PKCE code landed here instead of /auth/callback — forward it.
  // When uri_allow_list doesn't include the callback URL, Supabase falls back
  // to site_url and appends only `?code=` (no `type`). OAuth providers always
  // redirect to /auth/callback directly, so a code here is always email signup.
  if (params.code) {
    const qs = new URLSearchParams({ code: params.code });
    // Preserve type if present; default to 'signup' since OAuth codes never land here
    qs.set('type', params.type ?? 'signup');
    redirect(`/auth/callback?${qs.toString()}`);
  }

  // Supabase token_hash (OTP) landed here — forward it
  if (params.token_hash && params.type) {
    const qs = new URLSearchParams({ token_hash: params.token_hash, type: params.type });
    redirect(`/auth/callback?${qs.toString()}`);
  }

  return (
    <main className="flex flex-col min-h-screen">
      {/* JSON-LD struktureret data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      <Navbar />
      <Hero />
      <Features />
      <UseCases />
      <PricingSection />
      <CTABanner />
      <Footer />
    </main>
  );
}
