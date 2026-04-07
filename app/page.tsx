import Navbar from '@/app/components/Navbar';
import Hero from '@/app/components/Hero';
import Features from '@/app/components/Features';
import UseCases from '@/app/components/UseCases';
import CTABanner from '@/app/components/CTABanner';
import Footer from '@/app/components/Footer';

/** WebSite JSON-LD structured data — forbedrer søgemaskine-forståelse af sitenavnet */
const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'BizzAssist',
  url: process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk',
};

export default function HomePage() {
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
      <CTABanner />
      <Footer />
    </main>
  );
}
