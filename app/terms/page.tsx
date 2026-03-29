'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import Navbar from '@/app/components/Navbar';
import Footer from '@/app/components/Footer';

/**
 * Terms & Conditions page — /terms
 */
export default function TermsPage() {
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
            {lang === 'da' ? 'Vilkår og betingelser' : 'Terms & Conditions'}
          </h1>
          <p className="text-slate-500 text-sm mb-10">
            {lang === 'da' ? 'Sidst opdateret: 29. marts 2026' : 'Last updated: March 29, 2026'}
          </p>

          <div className="prose prose-invert prose-slate max-w-none space-y-8 text-slate-300 leading-relaxed">
            {lang === 'da' ? <DanishTerms /> : <EnglishTerms />}
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}

function DanishTerms() {
  return (
    <>
      <section>
        <h2 className="text-xl font-semibold text-white mb-3">1. Generelt</h2>
        <p>
          Disse vilkår og betingelser gælder for din brug af BizzAssist-platformen, som drives af
          Pecunia IT ApS (CVR: 44718502), Søbyvej 11, 2650 Hvidovre (&quot;vi&quot;, &quot;os&quot;,
          &quot;vores&quot;).
        </p>
        <p>
          Ved at oprette en konto eller bruge BizzAssist accepterer du disse vilkår. Hvis du ikke er
          enig, bedes du undlade at bruge tjenesten.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">2. Tjenestens indhold</h2>
        <p>
          BizzAssist er en forretningsintelligens-platform, der aggregerer offentligt tilgængelige
          data om virksomheder, ejendomme og ejere i Danmark. Platformen tilbyder:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Søgning og visning af virksomheds-, ejendoms- og ejerdata</li>
          <li>AI-baseret analyse af forretningsdata</li>
          <li>Generering af rapporter</li>
          <li>Overvågning af ændringer (med abonnement)</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">3. Konto og adgang</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Du skal være mindst 18 år for at oprette en konto.</li>
          <li>
            Du er ansvarlig for at holde dine loginoplysninger fortrolige og for al aktivitet under
            din konto.
          </li>
          <li>
            Vi forbeholder os retten til at suspendere eller lukke konti, der misbruger tjenesten.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">4. Prøveperiode og betaling</h2>
        <p>
          BizzAssist tilbyder en gratis prøveperiode på 7 dage. Efter prøveperioden kræves et betalt
          abonnement for fortsat adgang. Priser fremgår af vores hjemmeside og kan ændres med 30
          dages varsel.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Abonnementer fornyes automatisk, medmindre de opsiges inden udløb.</li>
          <li>Opsigelse kan ske til enhver tid med virkning fra næste faktureringsperiode.</li>
          <li>
            Der ydes ikke refusion for allerede betalte perioder, medmindre lovgivningen kræver det.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Datakilder og nøjagtighed</h2>
        <p>
          BizzAssist aggregerer data fra offentligt tilgængelige kilder, herunder Datafordeler.dk,
          CVR-registret, Tinglysning.dk, BBR og andre. Vi bestræber os på at levere nøjagtige og
          opdaterede data, men:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Vi garanterer ikke for datas fuldstændighed, nøjagtighed eller aktualitet.</li>
          <li>
            Data leveres &quot;som de er&quot; og bør ikke anvendes som eneste grundlag for
            forretningsbeslutninger.
          </li>
          <li>AI-genererede analyser er vejledende og kan indeholde fejl.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">6. Tilladt brug</h2>
        <p>Du må bruge BizzAssist til lovlige forretningsformål. Du må ikke:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Systematisk scrape, kopiere eller videredistribuere data fra platformen.</li>
          <li>Bruge data i strid med GDPR eller anden gældende lovgivning.</li>
          <li>
            Forsøge at opnå uautoriseret adgang til platformens systemer eller andre brugeres data.
          </li>
          <li>Bruge platformen til chikane, overvågning eller andre ulovlige formål.</li>
          <li>Videresælge adgang til platformen uden skriftlig aftale.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">7. Immaterielle rettigheder</h2>
        <p>
          Alt indhold på BizzAssist, herunder design, kode, logoer og AI-modeller, tilhører Pecunia
          IT ApS eller vores licensgivere. Data hentet fra offentlige registre er underlagt de
          respektive dataeejeres vilkår.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">8. Ansvarsbegrænsning</h2>
        <p>I det omfang det er tilladt ved lov, er Pecunia IT ApS ikke ansvarlig for:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Tab opstået som følge af unøjagtige data eller AI-analyser.</li>
          <li>Indirekte tab, herunder tabt fortjeneste, driftstab eller datatab.</li>
          <li>Nedbrud, forstyrrelser eller sikkerhedsbrud uden for vores rimelige kontrol.</li>
        </ul>
        <p>
          Vores samlede ansvar er begrænset til det beløb, du har betalt for tjenesten i de seneste
          12 måneder.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">9. Ændringer</h2>
        <p>
          Vi forbeholder os retten til at ændre disse vilkår. Væsentlige ændringer meddeles via
          e-mail eller i applikationen med mindst 30 dages varsel. Fortsat brug efter
          ændringstidspunktet betragtes som accept.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">10. Lovvalg og tvistløsning</h2>
        <p>
          Disse vilkår er underlagt dansk ret. Tvister, der ikke kan løses i mindelighed, afgøres
          ved Københavns Byret som første instans.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">11. Kontakt</h2>
        <p>
          Ved spørgsmål om disse vilkår, kontakt os på{' '}
          <a href="mailto:support@pecuniait.com" className="text-blue-400 hover:underline">
            support@pecuniait.com
          </a>
          .
        </p>
      </section>
    </>
  );
}

function EnglishTerms() {
  return (
    <>
      <section>
        <h2 className="text-xl font-semibold text-white mb-3">1. General</h2>
        <p>
          These terms and conditions apply to your use of the BizzAssist platform, operated by
          Pecunia IT ApS (CVR: 44718502), Soebyvej 11, 2650 Hvidovre, Denmark (&quot;we&quot;,
          &quot;us&quot;, &quot;our&quot;).
        </p>
        <p>
          By creating an account or using BizzAssist, you accept these terms. If you do not agree,
          please refrain from using the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">2. Service description</h2>
        <p>
          BizzAssist is a business intelligence platform that aggregates publicly available data on
          companies, properties and owners in Denmark. The platform offers:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Search and display of company, property and owner data</li>
          <li>AI-based analysis of business data</li>
          <li>Report generation</li>
          <li>Change monitoring (with subscription)</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">3. Account and access</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>You must be at least 18 years old to create an account.</li>
          <li>
            You are responsible for keeping your login credentials confidential and for all activity
            under your account.
          </li>
          <li>We reserve the right to suspend or close accounts that misuse the service.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">4. Trial period and payment</h2>
        <p>
          BizzAssist offers a free 7-day trial period. After the trial, a paid subscription is
          required for continued access. Prices are listed on our website and may change with 30
          days&apos; notice.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Subscriptions renew automatically unless cancelled before expiry.</li>
          <li>Cancellation is possible at any time, effective from the next billing period.</li>
          <li>No refunds are provided for already paid periods, unless required by law.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Data sources and accuracy</h2>
        <p>
          BizzAssist aggregates data from publicly available sources, including Datafordeler.dk, the
          CVR register, Tinglysning.dk, BBR and others. We strive to deliver accurate and up-to-date
          data, however:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>We do not guarantee the completeness, accuracy or timeliness of data.</li>
          <li>
            Data is provided &quot;as is&quot; and should not be used as the sole basis for business
            decisions.
          </li>
          <li>AI-generated analyses are indicative and may contain errors.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">6. Permitted use</h2>
        <p>You may use BizzAssist for lawful business purposes. You may not:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Systematically scrape, copy or redistribute data from the platform.</li>
          <li>Use data in violation of GDPR or other applicable legislation.</li>
          <li>
            Attempt to gain unauthorized access to platform systems or other users&apos; data.
          </li>
          <li>Use the platform for harassment, surveillance or other unlawful purposes.</li>
          <li>Resell access to the platform without written agreement.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">7. Intellectual property</h2>
        <p>
          All content on BizzAssist, including design, code, logos and AI models, belongs to Pecunia
          IT ApS or our licensors. Data sourced from public registries is subject to the respective
          data owners&apos; terms.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">8. Limitation of liability</h2>
        <p>To the extent permitted by law, Pecunia IT ApS is not liable for:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Losses arising from inaccurate data or AI analyses.</li>
          <li>Indirect losses, including lost profits, business interruption or data loss.</li>
          <li>Outages, disruptions or security breaches beyond our reasonable control.</li>
        </ul>
        <p>
          Our total liability is limited to the amount you have paid for the service in the
          preceding 12 months.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">9. Changes</h2>
        <p>
          We reserve the right to modify these terms. Material changes will be communicated via
          email or in the application with at least 30 days&apos; notice. Continued use after the
          effective date constitutes acceptance.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">10. Governing law and disputes</h2>
        <p>
          These terms are governed by Danish law. Disputes that cannot be resolved amicably shall be
          decided by the Copenhagen City Court as the court of first instance.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">11. Contact</h2>
        <p>
          For questions about these terms, contact us at{' '}
          <a href="mailto:support@pecuniait.com" className="text-blue-400 hover:underline">
            support@pecuniait.com
          </a>
          .
        </p>
      </section>
    </>
  );
}
