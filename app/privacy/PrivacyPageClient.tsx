'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { companyInfo } from '@/app/lib/companyInfo';
import Navbar from '@/app/components/Navbar';
import Footer from '@/app/components/Footer';

/**
 * Privacy Policy page — /privacy
 * GDPR-compliant privacy policy for BizzAssist.
 */
export default function PrivacyPageClient() {
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
            {lang === 'da' ? 'Privatlivspolitik' : 'Privacy Policy'}
          </h1>
          <p className="text-slate-500 text-sm mb-10">
            {lang === 'da' ? 'Sidst opdateret: 21. april 2026' : 'Last updated: April 21, 2026'}
          </p>

          <div className="prose prose-invert prose-slate max-w-none space-y-8 text-slate-300 leading-relaxed">
            {lang === 'da' ? <DanishPrivacy /> : <EnglishPrivacy />}
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}

function DanishPrivacy() {
  return (
    <>
      <section>
        <h2 className="text-xl font-semibold text-white mb-3">1. Dataansvarlig</h2>
        <p>
          {companyInfo.name} (CVR: {companyInfo.cvr}), {companyInfo.fullAddress} er dataansvarlig
          for behandling af personoplysninger i forbindelse med BizzAssist.
        </p>
        <p>Kontakt: {companyInfo.supportEmail}</p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">
          2. Hvilke personoplysninger indsamler vi?
        </h2>
        <p>Vi indsamler følgende kategorier af personoplysninger:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Kontooplysninger:</strong> Navn, e-mailadresse og
            adgangskode (krypteret) når du opretter en konto.
          </li>
          <li>
            <strong className="text-white">Brugsdata:</strong> IP-adresse, browsertype, enhedstype,
            sidevisninger og handlinger i applikationen.
          </li>
          <li>
            <strong className="text-white">Cookies:</strong> Tekniske cookies til funktionalitet og
            analytiske cookies (kun med samtykke). Se vores{' '}
            <Link href="/cookies" className="text-blue-400 hover:underline">
              cookiepolitik
            </Link>
            .
          </li>
          <li>
            <strong className="text-white">Kommunikation:</strong> Indhold af henvendelser til vores
            support.
          </li>
          <li>
            <strong className="text-white">Cached offentlige registerdata:</strong> Vi cacher data
            fra danske offentlige registre (BBR, CVR, DAR, VUR, EJF) for at levere hurtigere opslag.
            Disse data kan indeholde virksomhedsnavne, ejernavne og adresser. Behandlingsgrundlag:
            berettiget interesse (GDPR art. 6(1)(f)) — legitim forretningsinteresse i at levere en
            responsiv tjeneste. Cache-data slettes automatisk efter fastsatte perioder (CVR: 30
            dage, BBR/VUR: 90 dage, DAR: 180 dage).
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">3. Formål og retsgrundlag</h2>
        <p>Vi behandler dine personoplysninger til følgende formål:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Levering af tjenesten</strong> (GDPR art. 6, stk. 1,
            litra b — kontraktopfyldelse): Oprettelse og administration af din konto, adgang til
            platformens funktioner.
          </li>
          <li>
            <strong className="text-white">Forbedring af tjenesten</strong> (GDPR art. 6, stk. 1,
            litra f — legitim interesse): Analyse af brugsdata for at forbedre brugeroplevelsen.
          </li>
          <li>
            <strong className="text-white">Markedsføring</strong> (GDPR art. 6, stk. 1, litra a —
            samtykke): Kun med dit udtrykkelige samtykke.
          </li>
          <li>
            <strong className="text-white">Lovmæssige forpligtelser</strong> (GDPR art. 6, stk. 1,
            litra c): Bogføring og skattemæssige forpligtelser.
          </li>
          <li>
            <strong className="text-white">Intern notifikation ved tilmelding</strong> (GDPR art. 6,
            stk. 1, litra f — legitim interesse): Ved oprettelse af en ny konto sendes en intern
            notifikation til vores supportteam med maskeret e-mailadresse og valgt abonnementsplan
            med henblik på onboarding og kundeservice. Denne e-mail opbevares ikke separat og
            indeholder ikke dit fulde navn eller adgangskode.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">4. Databehandlere</h2>
        <p>Vi bruger følgende tredjeparts databehandlere:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Supabase Inc.</strong> — Database og autentificering
            (EU-region, ingen overførsel til tredjelande).
          </li>
          <li>
            <strong className="text-white">Anthropic, Inc.</strong> (USA) — AI-sprogmodel til
            chat-assistance. Behandler: brugerforespørgsler sendt til AI-assistenten.
            Overførselsgrundlag: EU-US Data Privacy Framework / standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Vercel, Inc.</strong> (USA) — Hosting og
            deploymentplatform. Behandler: al applikationstrafik og serverside-logfiler.
            Overførselsgrundlag: EU-US Data Privacy Framework / standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Sentry Inc.</strong> (USA) — Fejlovervågning og
            performancemåling. Overførsel sker på grundlag af standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Resend Inc.</strong> (USA) — E-maillevering
            (transaktionelle e-mails). Overførsel sker på grundlag af standardkontraktbestemmelser
            (SCC).
          </li>
          <li>
            <strong className="text-white">Twilio Inc.</strong> (USA) — SMS-beskeder. Overførsel
            sker på grundlag af standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Mapbox Inc.</strong> (USA) — Kortvisning og
            geodata-tjenester. Behandler: ejendomskoordinater, kortvisningsområde og IP-adresse.
            Overførsel sker på grundlag af standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Stripe, Inc.</strong> (USA / Irland) — Betalings-
            behandling af abonnementer og token-køb. Behandler: navn, e-mail, betalingskort-
            detaljer (tokeniseret) og faktureringsadresse. Kortdata opbevares aldrig på vores
            servere — håndteres udelukkende af Stripe i henhold til PCI DSS. Overførsel sker på
            grundlag af EU-US Data Privacy Framework / standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Brave Software, Inc.</strong> (USA) — Websøgning brugt
            som kontekst for AI-assistenten. Behandler: søgetermer. Overførsel sker på grundlag af
            standardkontraktbestemmelser (SCC).
          </li>
          <li>
            <strong className="text-white">Mediastack / apilayer GmbH</strong> (Østrig, EU) —
            Nyhedsartikler til AI-medieanalyse. Behandler: søgeforespørgsler om virksomheder og
            personer. Ingen tredjelands-overførsel.
          </li>
          <li>
            <strong className="text-white">Upstash Inc.</strong> (USA, GCP eu-west) — Rate-limit
            state og kortvarig cache. Behandler: IP-adresse og bruger-ID til request-throttling.
            Data opbevares i EU-region; overførselsgrundlag SCC for US-entiteten.
          </li>
        </ul>
        <p>
          Der er indgået databehandleraftaler med alle tredjeparts databehandlere i overensstemmelse
          med GDPR art. 28.
        </p>
        <p className="text-slate-400 text-sm">
          <strong className="text-white">Offentlige datakilder (ikke databehandlere):</strong>{' '}
          BizzAssist henter data fra offentlige danske registre — Datafordeler.dk, Erhvervs-
          styrelsens CVR, Tinglysning.dk, BBR og DAWA. Disse kilder leverer offentligt tilgængelige
          data og betragtes ikke som databehandlere for personlige data om dig som bruger.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Overførsel til tredjelande</h2>
        <p>
          Visse databehandlere er baseret i USA. Overførsel sker på baggrund af EU-Kommissionens
          tilstrækkelighedsafgørelse (EU-US Data Privacy Framework) eller
          standardkontraktbestemmelser (SCC).
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">6. Opbevaringsperiode</h2>
        <p>
          Vi opbevarer dine personoplysninger så længe du har en aktiv konto. Ved sletning af konto
          slettes dine data inden for 30 dage, medmindre lovgivning kræver længere opbevaring
          (f.eks. bogføringslovens krav om 5 år).
        </p>
        <p className="text-slate-400 text-sm">
          <strong className="text-white">AI-chat-historik:</strong> Dine samtaler med AI-
          assistenten (spørgsmål og svar) gemmes i din BizzAssist-konto så du kan genbesøge dem på
          tværs af enheder. Aktive samtaler opbevares i op til 12 måneder fra sidste aktivitet —
          derefter slettes de automatisk. Arkiverede samtaler er ikke inkluderet i denne
          auto-sletning. Du kan til enhver tid slette en enkelt samtale manuelt, eller eksportere
          hele din chat-historik som en del af din data-eksport. Ved sletning af konto fjernes al
          chat-historik ved cascade-delete (GDPR art. 17).
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">7. Dine rettigheder</h2>
        <p>Du har følgende rettigheder i henhold til GDPR:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Ret til indsigt i dine personoplysninger</li>
          <li>Ret til berigtigelse af urigtige oplysninger</li>
          <li>
            Ret til sletning (&quot;retten til at blive glemt&quot;) — du kan slette din konto under{' '}
            <Link href="/dashboard/settings" className="text-blue-400 hover:underline">
              Indstillinger → Min profil → Farlig zone
            </Link>
          </li>
          <li>Ret til begrænsning af behandling</li>
          <li>
            Ret til dataportabilitet — du kan eksportere dine data under{' '}
            <Link href="/dashboard/settings" className="text-blue-400 hover:underline">
              Indstillinger → Min profil → Download dine data
            </Link>
          </li>
          <li>Ret til indsigelse mod behandling</li>
          <li>Ret til at tilbagekalde samtykke</li>
        </ul>
        <p className="mt-3">
          Henvendelser om dine rettigheder rettes til{' '}
          <a href={`mailto:${companyInfo.supportEmail}`} className="text-blue-400 hover:underline">
            {companyInfo.supportEmail}
          </a>
          . Vi svarer inden for 30 dage.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">8. Klageadgang</h2>
        <p>
          Du kan klage til Datatilsynet, hvis du mener, at vi behandler dine personoplysninger i
          strid med gældende lovgivning:
        </p>
        <p className="mt-2">
          Datatilsynet
          <br />
          Carl Jacobsens Vej 35
          <br />
          2500 Valby
          <br />
          <a href="https://www.datatilsynet.dk" className="text-blue-400 hover:underline">
            www.datatilsynet.dk
          </a>
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">9. Sikkerhed</h2>
        <p>
          Vi anvender passende tekniske og organisatoriske sikkerhedsforanstaltninger for at
          beskytte dine personoplysninger, herunder kryptering af data i transit (TLS) og i hvile,
          adgangskontrol og regelmæssig sikkerhedsgennemgang.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">10. Ændringer til denne politik</h2>
        <p>
          Vi forbeholder os ret til at opdatere denne privatlivspolitik. Ved væsentlige ændringer
          informerer vi dig via e-mail eller en meddelelse i applikationen.
        </p>
      </section>
    </>
  );
}

function EnglishPrivacy() {
  return (
    <>
      <section>
        <h2 className="text-xl font-semibold text-white mb-3">1. Data Controller</h2>
        <p>
          {companyInfo.name} (CVR: {companyInfo.cvr}), {companyInfo.fullAddress},{' '}
          {companyInfo.country} is the data controller for the processing of personal data in
          connection with BizzAssist.
        </p>
        <p>Contact: {companyInfo.supportEmail}</p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">
          2. What personal data do we collect?
        </h2>
        <p>We collect the following categories of personal data:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Account information:</strong> Name, email address and
            password (encrypted) when you create an account.
          </li>
          <li>
            <strong className="text-white">Usage data:</strong> IP address, browser type, device
            type, page views and actions within the application.
          </li>
          <li>
            <strong className="text-white">Cookies:</strong> Technical cookies for functionality and
            analytical cookies (with consent only). See our{' '}
            <Link href="/cookies" className="text-blue-400 hover:underline">
              cookie policy
            </Link>
            .
          </li>
          <li>
            <strong className="text-white">Communication:</strong> Content of inquiries to our
            support.
          </li>
          <li>
            <strong className="text-white">Cached public register data:</strong> We cache data from
            Danish public registers (BBR, CVR, DAR, VUR, EJF) to deliver faster lookups. This data
            may include company names, owner names and addresses. Legal basis: legitimate interest
            (GDPR Art. 6(1)(f)) — legitimate business interest in providing a responsive service.
            Cache data is automatically deleted after fixed periods (CVR: 30 days, BBR/VUR: 90 days,
            DAR: 180 days).
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">3. Purpose and legal basis</h2>
        <p>We process your personal data for the following purposes:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Service delivery</strong> (GDPR Art. 6(1)(b) — contract
            performance): Creating and managing your account, access to platform features.
          </li>
          <li>
            <strong className="text-white">Service improvement</strong> (GDPR Art. 6(1)(f) —
            legitimate interest): Analysis of usage data to improve user experience.
          </li>
          <li>
            <strong className="text-white">Marketing</strong> (GDPR Art. 6(1)(a) — consent): Only
            with your explicit consent.
          </li>
          <li>
            <strong className="text-white">Legal obligations</strong> (GDPR Art. 6(1)(c)):
            Accounting and tax obligations.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">4. Data processors</h2>
        <p>We use the following third-party data processors:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong className="text-white">Supabase Inc.</strong> — Database and authentication (EU
            region, no third-country transfer).
          </li>
          <li>
            <strong className="text-white">Anthropic, Inc.</strong> (USA) — AI language model for
            chat assistance. Processes: user queries sent to the AI assistant. Transfer basis: EU-US
            Data Privacy Framework / Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Vercel, Inc.</strong> (USA) — Hosting and deployment
            platform. Processes: all application traffic and server-side logs. Transfer basis: EU-US
            Data Privacy Framework / Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Sentry Inc.</strong> (USA) — Error monitoring and
            performance measurement. Transfer is based on Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Resend Inc.</strong> (USA) — Email delivery
            (transactional emails). Transfer is based on Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Twilio Inc.</strong> (USA) — SMS messaging. Transfer is
            based on Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Mapbox Inc.</strong> (USA) — Map display and geodata
            services. Processes: property coordinates, map viewport and IP address. Transfer is
            based on Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Stripe, Inc.</strong> (USA / Ireland) — Payment
            processing for subscriptions and token purchases. Processes: name, email, tokenised card
            details and billing address. Card data is never stored on our servers — handled
            exclusively by Stripe under PCI DSS. Transfer basis: EU-US Data Privacy Framework /
            Standard Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Brave Software, Inc.</strong> (USA) — Web search used as
            context for the AI assistant. Processes: search terms. Transfer is based on Standard
            Contractual Clauses (SCC).
          </li>
          <li>
            <strong className="text-white">Mediastack / apilayer GmbH</strong> (Austria, EU) — News
            articles for AI media analysis. Processes: search queries for companies and persons. No
            third-country transfer.
          </li>
          <li>
            <strong className="text-white">Upstash Inc.</strong> (USA, GCP eu-west) — Rate-limit
            state and short-lived cache. Processes: IP address and user ID for request throttling.
            Data stored in EU region; transfer basis SCC for the US entity.
          </li>
        </ul>
        <p>
          Data processing agreements have been entered into with all third-party processors in
          accordance with GDPR Art. 28.
        </p>
        <p className="text-slate-400 text-sm">
          <strong className="text-white">Public data sources (not processors):</strong> BizzAssist
          retrieves data from public Danish registries — Datafordeler.dk, the Business
          Authority&apos;s CVR register, Tinglysning.dk, BBR and DAWA. These sources provide
          publicly available data and are not considered processors of personal data about you as a
          user.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">5. Transfer to third countries</h2>
        <p>
          Certain data processors are based in the USA. Transfers are based on the European
          Commission&apos;s adequacy decision (EU-US Data Privacy Framework) or Standard Contractual
          Clauses (SCC).
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">6. Retention period</h2>
        <p>
          We retain your personal data as long as you have an active account. Upon account deletion,
          your data will be deleted within 30 days, unless legislation requires longer retention
          (e.g., accounting law requires 5 years).
        </p>
        <p className="text-slate-400 text-sm">
          <strong className="text-white">AI chat history:</strong> Your conversations with the AI
          assistant (questions and responses) are stored in your BizzAssist account so you can
          revisit them across devices. Active conversations are retained for up to 12 months from
          the last activity, after which they are deleted automatically. Archived conversations are
          excluded from this auto-purge. You can delete individual conversations manually at any
          time, or export your full chat history as part of your data export. Upon account deletion,
          all chat history is removed via cascade-delete (GDPR Art. 17).
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">7. Your rights</h2>
        <p>You have the following rights under GDPR:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Right of access to your personal data</li>
          <li>Right to rectification of inaccurate data</li>
          <li>
            Right to erasure (&quot;right to be forgotten&quot;) — you can delete your account under{' '}
            <Link href="/dashboard/settings" className="text-blue-400 hover:underline">
              Settings → My profile → Danger zone
            </Link>
          </li>
          <li>Right to restriction of processing</li>
          <li>
            Right to data portability — you can export your data under{' '}
            <Link href="/dashboard/settings" className="text-blue-400 hover:underline">
              Settings → My profile → Download your data
            </Link>
          </li>
          <li>Right to object to processing</li>
          <li>Right to withdraw consent</li>
        </ul>
        <p className="mt-3">
          Requests regarding your rights should be directed to{' '}
          <a href={`mailto:${companyInfo.supportEmail}`} className="text-blue-400 hover:underline">
            {companyInfo.supportEmail}
          </a>
          . We will respond within 30 days.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">8. Complaints</h2>
        <p>
          You can lodge a complaint with the Danish Data Protection Agency (Datatilsynet) if you
          believe that we process your personal data in violation of applicable law:
        </p>
        <p className="mt-2">
          Datatilsynet
          <br />
          Carl Jacobsens Vej 35
          <br />
          2500 Valby, Denmark
          <br />
          <a href="https://www.datatilsynet.dk" className="text-blue-400 hover:underline">
            www.datatilsynet.dk
          </a>
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">9. Security</h2>
        <p>
          We implement appropriate technical and organizational security measures to protect your
          personal data, including encryption of data in transit (TLS) and at rest, access controls
          and regular security reviews.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold text-white mb-3">10. Changes to this policy</h2>
        <p>
          We reserve the right to update this privacy policy. In case of material changes, we will
          inform you via email or a notification in the application.
        </p>
      </section>
    </>
  );
}
