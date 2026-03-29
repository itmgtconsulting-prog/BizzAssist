import Navbar from '@/app/components/Navbar';
import Hero from '@/app/components/Hero';
import Features from '@/app/components/Features';
import UseCases from '@/app/components/UseCases';
import CTABanner from '@/app/components/CTABanner';
import Footer from '@/app/components/Footer';
export default function HomePage() {
  return (
    <main className="flex flex-col min-h-screen">
      <Navbar />
      <Hero />
      <Features />
      <UseCases />
      <CTABanner />
      <Footer />
    </main>
  );
}
