'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import Navbar from '@/app/components/Navbar';
import Footer from '@/app/components/Footer';

/**
 * Cookie Policy page — /cookies
 */
export default function CookiesPage() {
  const { lang } = useLanguage();

  return (
    <main className="flex flex-col min-h-screen bg-[#0f172a]">
      <Navbar />
      <div className="flex-1 pt-32 pb-20">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm mb-8 transition-colors"
          >
            <ArrowLeft size={16} />
            {lang === 'da' ? 'Tilbage til forsiden' : 'Back to homepage'}
          </Link>

          <h1 className="text-4xl font-bold text-white mb-2">
            {lang === 'da' ? 'Cookiepolitik' : 'Cookie Policy'}
          </h1>
          <p className="text-slate-500 text-sm mb-10">
            {lang === 'da' ? 'Sidst opdateret: 29. marts 2026' : 'Last updated: March 29, 2026'}
          </p>

          <div className="prose prose-invert prose-slate max-w-none space-y-8 text-slate-300 leading-relaxed">
            {lang === 'da' ? <DanishCookies /> : <EnglishCookies />}
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}

function DanishCookies() {
  return (
    <>
      <section>
        <h2 className="text-xl font-semibold text-white mb-3">1. Hvad er cookies?</h2>
        <p>
          Cookies er små tekstfiler, der gemmes på din enhed (computer, tablet, telefon), når du
          besøger en hjemmeside. De bruges til at huske dine præferencer og forbedre din oplevelse.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">2. Hvilke cookies bruger vi?</h2>

        <h3 className="text-lg font-medium text-white mt-4 mb-2">
          Nødvendige cookies (kræver ikke samtykke)
        </h3>
        <p>Disse cookies er nødvendige for at platformen kan fungere korrekt:</p>
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-2 pr-4 text-white font-medium">Navn</th>
                <th className="text-left py-2 pr-4 text-white font-medium">Formål</th>
                <th className="text-left py-2 text-white font-medium">Udløb</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">sb-*-auth-token</td>
                <td className="py-2 pr-4">Autentificering (login-session)</td>
                <td className="py-2">Session / 1 uge</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">cookie_consent</td>
                <td className="py-2 pr-4">Gemmer dit cookie-samtykkevalg</td>
                <td className="py-2">1 år</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">lang</td>
                <td className="py-2 pr-4">Sprogpræference (DA/EN)</td>
                <td className="py-2">1 år</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="text-lg font-medium text-white mt-6 mb-2">
          Analytiske cookies (kræver samtykke)
        </h3>
        <p>
          Vi bruger i øjeblikket ingen analytiske cookies. Hvis vi fremover implementerer
          analyseværktøjer, vil de kun aktiveres efter dit udtrykkelige samtykke.
        </p>

        <h3 className="text-lg font-medium text-white mt-6 mb-2">
          Markedsføringscookies (kræver samtykke)
        </h3>
        <p>
          Vi bruger i øjeblikket ingen markedsføringscookies. Hvis vi fremover implementerer
          markedsføringsværktøjer, vil de kun aktiveres efter dit udtrykkelige samtykke.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">3. Lokal lagring (localStorage)</h2>
        <p>
          Ud over cookies bruger vi browserens lokale lagring til at gemme ikke-personlige
          præferencer som seneste søgninger og UI-indstillinger. Disse data forlader aldrig din
          enhed.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">4. Administrer dine cookies</h2>
        <p>
          Du kan til enhver tid ændre dit cookie-samtykke via cookie-banneret nederst på siden. Du
          kan også slette cookies via din browsers indstillinger:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Chrome: Indstillinger &rarr; Privatliv og sikkerhed &rarr; Cookies</li>
          <li>Firefox: Indstillinger &rarr; Privatliv &amp; Sikkerhed</li>
          <li>Safari: Præferencer &rarr; Privatliv</li>
          <li>Edge: Indstillinger &rarr; Cookies og webstedsdata</li>
        </ul>
        <p className="mt-2">
          Bemærk: Sletning af nødvendige cookies kan medføre, at du skal logge ind igen.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Kontakt</h2>
        <p>
          Har du spørgsmål om vores brug af cookies, kontakt os på{' '}
          <a href="mailto:support@pecuniait.com" className="text-blue-400 hover:underline">
            support@pecuniait.com
          </a>
          .
        </p>
      </section>
    </>
  );
}

function EnglishCookies() {
  return (
    <>
      <section>
        <h2 className="text-xl font-semibold text-white mb-3">1. What are cookies?</h2>
        <p>
          Cookies are small text files stored on your device (computer, tablet, phone) when you
          visit a website. They are used to remember your preferences and improve your experience.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">2. What cookies do we use?</h2>

        <h3 className="text-lg font-medium text-white mt-4 mb-2">
          Necessary cookies (no consent required)
        </h3>
        <p>These cookies are necessary for the platform to function correctly:</p>
        <div className="overflow-x-auto mt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left py-2 pr-4 text-white font-medium">Name</th>
                <th className="text-left py-2 pr-4 text-white font-medium">Purpose</th>
                <th className="text-left py-2 text-white font-medium">Expiry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">sb-*-auth-token</td>
                <td className="py-2 pr-4">Authentication (login session)</td>
                <td className="py-2">Session / 1 week</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">cookie_consent</td>
                <td className="py-2 pr-4">Stores your cookie consent choice</td>
                <td className="py-2">1 year</td>
              </tr>
              <tr>
                <td className="py-2 pr-4 font-mono text-xs">lang</td>
                <td className="py-2 pr-4">Language preference (DA/EN)</td>
                <td className="py-2">1 year</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="text-lg font-medium text-white mt-6 mb-2">
          Analytical cookies (consent required)
        </h3>
        <p>
          We currently do not use analytical cookies. If we implement analytics tools in the future,
          they will only be activated with your explicit consent.
        </p>

        <h3 className="text-lg font-medium text-white mt-6 mb-2">
          Marketing cookies (consent required)
        </h3>
        <p>
          We currently do not use marketing cookies. If we implement marketing tools in the future,
          they will only be activated with your explicit consent.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">3. Local storage (localStorage)</h2>
        <p>
          In addition to cookies, we use browser local storage to save non-personal preferences such
          as recent searches and UI settings. This data never leaves your device.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">4. Manage your cookies</h2>
        <p>
          You can change your cookie consent at any time via the cookie banner at the bottom of the
          page. You can also delete cookies via your browser settings:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Chrome: Settings &rarr; Privacy and Security &rarr; Cookies</li>
          <li>Firefox: Settings &rarr; Privacy &amp; Security</li>
          <li>Safari: Preferences &rarr; Privacy</li>
          <li>Edge: Settings &rarr; Cookies and site data</li>
        </ul>
        <p className="mt-2">Note: Deleting necessary cookies may require you to log in again.</p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Contact</h2>
        <p>
          If you have questions about our use of cookies, contact us at{' '}
          <a href="mailto:support@pecuniait.com" className="text-blue-400 hover:underline">
            support@pecuniait.com
          </a>
          .
        </p>
      </section>
    </>
  );
}
