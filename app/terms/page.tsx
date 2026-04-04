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
            {lang === 'da' ? 'Sidst opdateret: 4. april 2026' : 'Last updated: April 4, 2026'}
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
        <h2 className="text-xl font-semibold text-white mb-3">4. Abonnementer og betaling</h2>
        <p>
          BizzAssist tilbyder forskellige abonnementsplaner med varierende funktionalitet, AI-adgang
          og token-grænser. De tilgængelige planer og deres priser fremgår ved oprettelse samt i
          applikationens indstillinger. Priser kan ændres med 30 dages varsel.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            Visse planer kan tilbyde en gratis prøveperiode. Varigheden fremgår af den konkrete plan
            ved oprettelse.
          </li>
          <li>
            Abonnementer fornyes automatisk ved udløb af faktureringsperioden, medmindre de opsiges
            inden.
          </li>
          <li>Opsigelse kan ske til enhver tid med virkning fra næste faktureringsperiode.</li>
          <li>
            Ved op- eller nedgradering af abonnement træder den nye plan i kraft fra næste
            faktureringsperiode.
          </li>
          <li>
            Betaling sker via Stripe. Vi opbevarer ikke dine betalingskortoplysninger — disse
            håndteres udelukkende af Stripe i henhold til PCI DSS-standarden.
          </li>
          <li>
            Der ydes ikke refusion for allerede betalte perioder, medmindre lovgivningen kræver det.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Køb af AI-tokens</h2>
        <p>
          Ud over de tokens, der er inkluderet i dit abonnement, kan du tilkøbe ekstra
          AI-token-pakker som engangskøb. Token-pakkerne og deres priser fremgår i applikationen.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Tilkøbte tokens udløber ikke og kan bruges, så længe du har et aktivt abonnement.</li>
          <li>
            Tilkøbte tokens er ikke-refunderbare. Ved køb accepterer du, at der ikke ydes
            fortrydelsesret, jf. forbrugeraftalelovens § 18, stk. 2, nr. 13, da det digitale indhold
            leveres umiddelbart efter køb.
          </li>
          <li>Tokens kan ikke overføres mellem konti eller ombyttes til kontant betaling.</li>
          <li>
            Vi forbeholder os retten til at ændre priser og indhold af token-pakker. Ændringer
            påvirker ikke allerede købte tokens.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">
          6. Platform under udvikling — forbehold for fejl og nedetid
        </h2>
        <p>
          BizzAssist er en ny platform under aktiv udvikling. Selvom vi bestræber os på at levere en
          stabil og pålidelig tjeneste, tager vi udtrykkeligt forbehold for:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Fejl og mangler:</strong> Platformen kan indeholde fejl
            (bugs), unøjagtigheder i data eller funktioner, der endnu ikke er fuldt implementeret.
            Vi arbejder løbende på at identificere og rette fejl.
          </li>
          <li>
            <strong className="text-white">Planlagt og uplanlagt nedetid:</strong> Der kan forekomme
            driftsafbrydelser i forbindelse med opdateringer, vedligeholdelse eller uforudsete
            tekniske problemer. Vi tilstræber at minimere nedetid og varsle planlagt
            vedligeholdelse, men kan ikke garantere uafbrudt tilgængelighed.
          </li>
          <li>
            <strong className="text-white">Ændringer i funktionalitet:</strong> Vi kan tilføje,
            ændre eller fjerne funktioner uden forudgående varsel som led i den løbende udvikling af
            platformen.
          </li>
          <li>
            <strong className="text-white">AI-begrænsninger:</strong> AI-assistenten er et
            hjælpeværktøj og kan producere unøjagtige, ufuldstændige eller misvisende svar.
            AI-genereret indhold bør altid verificeres og må ikke bruges som eneste
            beslutningsgrundlag.
          </li>
          <li>
            <strong className="text-white">Eksterne datakilder:</strong> Vi er afhængige af
            tredjeparters API-tjenester og offentlige datakilder, som kan opleve nedetid eller
            levere forældede data uden for vores kontrol.
          </li>
        </ul>
        <p>
          Ved at bruge BizzAssist accepterer du, at platformen leveres &quot;som den er&quot; (as
          is), og at der kan forekomme fejl, nedetid og ændringer. Vi opfordrer til at rapportere
          fejl til{' '}
          <a href="mailto:support@pecuniait.com" className="text-blue-400 hover:underline">
            support@pecuniait.com
          </a>
          , så vi kan forbedre tjenesten.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">7. Datakilder og nøjagtighed</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">8. Tilladt brug</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">9. Immaterielle rettigheder</h2>
        <p>
          Alt indhold på BizzAssist, herunder design, kode, logoer og AI-modeller, tilhører Pecunia
          IT ApS eller vores licensgivere. Data hentet fra offentlige registre er underlagt de
          respektive dataeejeres vilkår.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">10. Ansvarsbegrænsning</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">11. Ændringer</h2>
        <p>
          Vi forbeholder os retten til at ændre disse vilkår. Væsentlige ændringer meddeles via
          e-mail eller i applikationen med mindst 30 dages varsel. Fortsat brug efter
          ændringstidspunktet betragtes som accept.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">12. Lovvalg og tvistløsning</h2>
        <p>
          Disse vilkår er underlagt dansk ret. Tvister, der ikke kan løses i mindelighed, afgøres
          ved Københavns Byret som første instans.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">13. Beta-status</h2>
        <p>
          BizzAssist er i øjeblikket i beta-version. Tjenesten leveres &quot;som den er&quot; uden
          garanti for fejlfri drift. Vi forbeholder os retten til at ændre, opdatere eller fjerne
          funktionalitet uden forudgående varsel. Data gemt i beta-perioden kan blive nulstillet ved
          overgang til fuld version.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">14. AI og tokens</h2>
        <p>
          BizzAssist anvender kunstig intelligens (AI) til mediesøgning, artikelanalyse og
          virksomhedsresearch. Brug af AI-funktioner forbruger tokens fra din konto.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Tokens købes via in-app køb og tilføjes automatisk til din konto</li>
          <li>Forbrugte tokens kan ikke refunderes eller tilbageføres</li>
          <li>Token-forbrug varierer afhængigt af søgningens kompleksitet</li>
          <li>
            AI-genererede resultater er ikke garanteret korrekte — verificér altid vigtig
            information
          </li>
          <li>Token-priser kan ændres med 30 dages varsel</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">15. In-app køb</h2>
        <p>BizzAssist tilbyder køb direkte i applikationen. Ved køb af abonnement eller tokens:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Betaling sker via Stripe</li>
          <li>Abonnementer fornyes automatisk medmindre de opsiges</li>
          <li>Refundering følger vores refunderingspolitik</li>
          <li>Priser er angivet inkl. moms for danske kunder</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">16. Kontakt</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">4. Subscriptions and payment</h2>
        <p>
          BizzAssist offers various subscription plans with different functionality, AI access and
          token limits. Available plans and their prices are displayed during sign-up and in the
          application settings. Prices may change with 30 days&apos; notice.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            Certain plans may offer a free trial period. The duration is specified for the
            particular plan at sign-up.
          </li>
          <li>
            Subscriptions renew automatically at the end of the billing period unless cancelled
            before expiry.
          </li>
          <li>Cancellation is possible at any time, effective from the next billing period.</li>
          <li>
            When upgrading or downgrading a subscription, the new plan takes effect from the next
            billing period.
          </li>
          <li>
            Payment is processed via Stripe. We do not store your payment card details — these are
            handled exclusively by Stripe in accordance with the PCI DSS standard.
          </li>
          <li>No refunds are provided for already paid periods, unless required by law.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Purchase of AI tokens</h2>
        <p>
          In addition to the tokens included in your subscription, you may purchase additional AI
          token packs as one-time purchases. Token packs and their prices are displayed in the
          application.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            Purchased tokens do not expire and can be used as long as you have an active
            subscription.
          </li>
          <li>
            Purchased tokens are non-refundable. By purchasing, you accept that the right of
            withdrawal does not apply, as the digital content is delivered immediately after
            purchase.
          </li>
          <li>Tokens cannot be transferred between accounts or exchanged for monetary payment.</li>
          <li>
            We reserve the right to change prices and content of token packs. Changes do not affect
            tokens already purchased.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">
          6. Platform under development — disclaimer for errors and downtime
        </h2>
        <p>
          BizzAssist is a new platform under active development. While we strive to deliver a stable
          and reliable service, we expressly reserve the right regarding:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Errors and defects:</strong> The platform may contain
            bugs, inaccuracies in data, or features that are not yet fully implemented. We
            continuously work to identify and fix issues.
          </li>
          <li>
            <strong className="text-white">Planned and unplanned downtime:</strong> Service
            interruptions may occur due to updates, maintenance, or unforeseen technical issues. We
            aim to minimize downtime and provide notice of planned maintenance, but cannot guarantee
            uninterrupted availability.
          </li>
          <li>
            <strong className="text-white">Changes to functionality:</strong> We may add, modify or
            remove features without prior notice as part of the ongoing development of the platform.
          </li>
          <li>
            <strong className="text-white">AI limitations:</strong> The AI assistant is a support
            tool and may produce inaccurate, incomplete, or misleading answers. AI-generated content
            should always be verified and must not be used as the sole basis for decisions.
          </li>
          <li>
            <strong className="text-white">External data sources:</strong> We depend on third-party
            API services and public data sources that may experience downtime or deliver outdated
            data beyond our control.
          </li>
        </ul>
        <p>
          By using BizzAssist, you accept that the platform is provided &quot;as is&quot; and that
          errors, downtime and changes may occur. We encourage you to report issues to{' '}
          <a href="mailto:support@pecuniait.com" className="text-blue-400 hover:underline">
            support@pecuniait.com
          </a>{' '}
          so we can improve the service.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">7. Data sources and accuracy</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">8. Permitted use</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">9. Intellectual property</h2>
        <p>
          All content on BizzAssist, including design, code, logos and AI models, belongs to Pecunia
          IT ApS or our licensors. Data sourced from public registries is subject to the respective
          data owners&apos; terms.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">10. Limitation of liability</h2>
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
        <h2 className="text-xl font-semibold text-white mb-3">11. Changes</h2>
        <p>
          We reserve the right to modify these terms. Material changes will be communicated via
          email or in the application with at least 30 days&apos; notice. Continued use after the
          effective date constitutes acceptance.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">12. Governing law and disputes</h2>
        <p>
          These terms are governed by Danish law. Disputes that cannot be resolved amicably shall be
          decided by the Copenhagen City Court as the court of first instance.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">13. Beta status</h2>
        <p>
          BizzAssist is currently in beta version. The service is provided &quot;as is&quot; without
          guarantee of error-free operation. We reserve the right to change, update or remove
          functionality without prior notice. Data stored during the beta period may be reset upon
          transition to the full version.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">14. AI and tokens</h2>
        <p>
          BizzAssist uses artificial intelligence (AI) for media search, article analysis and
          business research. Use of AI features consumes tokens from your account.
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Tokens are purchased via in-app purchases and added automatically to your account</li>
          <li>Consumed tokens cannot be refunded or reversed</li>
          <li>Token consumption varies depending on the complexity of the search</li>
          <li>
            AI-generated results are not guaranteed to be correct — always verify important
            information
          </li>
          <li>Token prices may change with 30 days&apos; notice</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">15. In-app purchases</h2>
        <p>
          BizzAssist offers purchases directly within the application. When purchasing a
          subscription or tokens:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Payment is processed via Stripe</li>
          <li>Subscriptions renew automatically unless cancelled</li>
          <li>Refunds are subject to our refund policy</li>
          <li>Prices are stated inclusive of VAT for Danish customers</li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">16. Contact</h2>
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
