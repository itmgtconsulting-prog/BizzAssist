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

export default function HomePage() {
  return (
    <main className="flex flex-col min-h-screen">
      {/* JSON-LD struktureret data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      {/* Beta-banner — kun synlig på forsiden */}
      <div className="w-full bg-amber-400 text-amber-900 text-center text-sm py-1.5 font-medium">
        Vores løsning er ikke live endnu - forventet beta release medio april 2026
      </div>
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
