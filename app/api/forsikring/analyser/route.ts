/**
 * POST /api/forsikring/analyser — Kør gap-analyse for en kunde.
 * GET  /api/forsikring/analyser — List alle analyser for tenant.
 *
 * BIZZ-1366: Walk koncern → match aktiver mod policer → kør gap-engine
 * → persistér i forsikring_analyser + forsikring_aktiver + forsikring_gaps.
 *
 * @module api/forsikring/analyser
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { filterAllowedStandardDocIds } from '@/app/lib/forsikring/standardDocVisibility';
import { getTenantSchemaName } from '@/lib/db/tenant';
import { getInsuranceApi } from '@/lib/db/insurance';
import { walkKoncern } from '@/app/lib/forsikring/koncernWalk';
import * as Sentry from '@sentry/nextjs';
import { matchAssetsToPolicies, addressesMatch } from '@/app/lib/forsikring/assetMatcher';
import { berigMedSfeStruktur } from '@/app/lib/forsikring/sfeStruktur';
import {
  runGapEngine,
  computeRiskScore,
  runPortfolioChecks,
  runDaekningsgradChecks,
  runVaerdiChecks,
} from '@/app/lib/forsikring/gapEngine';
import type { RegnskabsTalLite } from '@/app/lib/forsikring/gapEngine';
import { fetchDmrByRegnr } from '@/app/lib/forsikring/dmr';
import type { ForsikringCoverage } from '@/app/lib/forsikring/types';
import {
  runBbrCrossCheck,
  runTinglysningCrossCheck,
  runVurCrossCheck,
} from '@/app/lib/forsikring/crossChecks';
import { logActivity } from '@/app/lib/activityLog';
import { logger } from '@/app/lib/logger';

/** Øget til 300s (Vercel Pro max) — store porteføljer (40+ aktiver, 9 docs, SFE-opslag) kræver mere tid */
export const maxDuration = 300;

/**
 * Normaliserer et forsikringsselskabs-navn til selskabs-sammenligning.
 *
 * BIZZ-2069: Standard-betingelsers selskab kan bruge tankestreg ("Topdanmark
 * – en del af If Skadeforsikring", U+2013) mens policens insurer_name bruger
 * almindelig bindestreg — så ren substring-match fejler, og Topdanmark-vilkår
 * blev fejlagtigt markeret som "ikke anvendt". Normaliserer dash-varianter,
 * case og whitespace før sammenligning.
 *
 * @param navn - Rå selskabsnavn fra police eller standard-betingelse
 * @returns Lowercase navn med ens bindestreger og kollapset whitespace
 */
/**
 * Returnerer Supabase server-client med cookie-baseret session (anon key).
 *
 * BIZZ-2106: Bruges til at slå standard_doc_ids fra request body op under
 * brugerens egen RLS-kontekst (samme visibility-regler som BIZZ-1907), så
 * fremmede tenants private betingelser ikke kan smugles ind i en analyse
 * via service-role-clienten.
 *
 * @returns Supabase client med bruger-auth der respekterer RLS
 */
async function getSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          /* read-only i route handlers */
        },
      },
    }
  );
}

function normSelskab(navn: string): string {
  return navn
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * BIZZ-2140: Progress-step-identifikatorer for analyse-flowet. Bruges til at
 * rapportere fremdrift til klienten via SSE, så store analyser (40+ aktiver)
 * viser hvilket trin der kører i stedet for en tavs spinner.
 */
type StepId = 'aktiver' | 'match' | 'daekning' | 'gap' | 'gem';

/** Brugervendt rækkefølge + labels (DA) for de fem analyse-trin. */
const ANALYSE_STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: 'aktiver', label: 'Henter aktiver fra koncern…' },
  { id: 'match', label: 'Matcher policer mod ejendomme…' },
  { id: 'daekning', label: 'Henter dækninger & branchedata…' },
  { id: 'gap', label: 'Kører gap-engine…' },
  { id: 'gem', label: 'Gemmer resultater…' },
];

/**
 * BIZZ-2140: Per-trin "langsom"-grænse. Overskrider et trin denne tid uden at
 * blive afsluttet, sendes et `slow`-event så UI'et kan markere trinnet som
 * langsomt (i stedet for kun en global timeout uden feedback). Den globale
 * maxDuration=300 er fortsat hård backstop.
 */
const STEP_SLOW_MS = 30_000;

/** Et progress-event sendt over SSE. */
interface StepEvent {
  type: 'step';
  id: StepId;
  status: 'running' | 'done' | 'slow';
  label?: string;
}

/** Emit-funktion: no-op for JSON-klienter, SSE-enqueue for streaming-klienter. */
type EmitFn = (event: StepEvent | Record<string, unknown>) => void;

/**
 * BIZZ-2140: Trin-tracker der udsender running/done/slow-events og rearmerer en
 * watchdog-timer pr. trin. `begin(id)` afslutter automatisk forrige trin og
 * starter det nye. `done()` afslutter det aktive trin. `dispose()` rydder
 * watchdog-timeren uden at sende done (bruges i fejl-stien).
 *
 * @param emit - Emit-funktion (SSE eller no-op)
 * @returns Tracker med begin/done/current/dispose
 */
function createStepTracker(emit: EmitFn): {
  begin: (id: StepId) => void;
  done: () => void;
  current: () => StepId | null;
  dispose: () => void;
} {
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let active: StepId | null = null;
  const clear = (): void => {
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };
  return {
    begin: (id: StepId): void => {
      clear();
      if (active) emit({ type: 'step', id: active, status: 'done' });
      const meta = ANALYSE_STEPS.find((s) => s.id === id);
      active = id;
      emit({ type: 'step', id, status: 'running', label: meta?.label });
      // Watchdog: marker trinnet som langsomt hvis det ikke er færdigt i tide.
      watchdog = setTimeout(() => {
        emit({ type: 'step', id, status: 'slow', label: meta?.label });
      }, STEP_SLOW_MS);
    },
    done: (): void => {
      clear();
      if (active) emit({ type: 'step', id: active, status: 'done' });
      active = null;
    },
    current: (): StepId | null => active,
    dispose: clear,
  };
}

/**
 * POST /api/forsikring/analyser
 *
 * Body: { kunde_type: 'virksomhed'|'person', kunde_id: string }
 *
 * @param request - Next.js request
 * @returns { analyse_id: string }
 */
export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    kunde_type: string;
    kunde_id: string;
    kunde_navn?: string;
    as_of_date?: string;
    /** BIZZ-1404: Dokument-IDs der skal genbruges fra tidligere analyser */
    document_ids?: string[];
    /** BIZZ-1404: Nyligt uploadede dokument-IDs for denne analyse */
    new_document_ids?: string[];
    /** BIZZ-1404: Link til kundesag */
    sag_id?: string;
    /** BIZZ-1833: Standard forsikringsbetingelser valgt til analysen */
    standard_doc_ids?: string[];
    /**
     * BIZZ-1973: Hvis true, kører kun adresse-tjek (walk + policer) og returnerer
     * { mismatches } UDEN at køre gap-engine eller persistere noget. Bruges som
     * preflight inden analysen, så brugeren kan advares om policer der dækker en
     * ejendom uden for kundens portefølje.
     */
    preflight?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const {
    kunde_type,
    kunde_id,
    kunde_navn,
    as_of_date,
    document_ids,
    new_document_ids,
    sag_id,
    standard_doc_ids,
  } = body;
  if (!kunde_type || !kunde_id || !['virksomhed', 'person'].includes(kunde_type)) {
    return NextResponse.json({ error: 'Missing or invalid kunde_type/kunde_id' }, { status: 400 });
  }

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  // BIZZ-2106: Validér standard_doc_ids mod brugerens RLS-synlighed FØR brug.
  // Opslagene nedenfor sker med service-role (bypasser RLS), så uden dette
  // filter kunne en bruger angive en fremmed tenants private doc-id og få
  // indholdet anvendt i sin analyse. Ikke-synlige ids droppes med en advarsel
  // i loggen (ingen 403 — analysen fortsætter med de tilladte betingelser).
  let allowedStandardDocIds: string[] = [];
  if (standard_doc_ids && standard_doc_ids.length > 0) {
    const sessionClient = await getSessionClient();
    const { data: visibleDocs, error: visErr } = await sessionClient
      .from('forsikring_standard_doc')
      .select('id')
      .in('id', standard_doc_ids);
    if (visErr) {
      logger.warn(
        '[forsikring/analyser] Visibility-opslag for standard docs fejlede:',
        visErr.message
      );
    }
    const { allowed, dropped } = filterAllowedStandardDocIds(
      standard_doc_ids,
      ((visibleDocs ?? []) as Array<{ id: string }>).map((d) => d.id)
    );
    allowedStandardDocIds = allowed;
    if (dropped.length > 0) {
      logger.warn(
        `[forsikring/analyser] BIZZ-2106: Droppede ${dropped.length} standard_doc_ids uden for brugerens synlighed: ${dropped.join(', ')}`
      );
    }
  }

  // BIZZ-2140: SSE-streaming hvis klienten beder om det (Accept-header). Ellers
  // bevares den bagudkompatible JSON-respons uændret. `emit` er no-op i JSON-
  // tilstand og enqueuer SSE-events i streaming-tilstand.
  const wantsSse = (request.headers.get('accept') ?? '').includes('text/event-stream');
  const encoder = new TextEncoder();
  let emit: EmitFn = () => {};
  const tracker = createStepTracker((event) => emit(event));

  /**
   * Kører hele analysen og returnerer et HTTP-outcome ({ status, body }).
   * Identisk logik for JSON- og SSE-stien; kun fremdrifts-emits adskiller dem.
   */
  const executeAnalyse = async (): Promise<{ status: number; body: unknown }> => {
    try {
      // BIZZ-1355: Parse snapshot-dato for historisk analyse
      const snapshotDate = as_of_date ? new Date(as_of_date) : null;
      if (snapshotDate && Number.isNaN(snapshotDate.getTime())) {
        return { status: 400, body: { error: 'Invalid as_of_date format (use YYYY-MM-DD)' } };
      }

      // 1. Walk koncern → opdag aktiver (med valgfri snapshot-dato)
      tracker.begin('aktiver');
      logger.log(
        `[forsikring/analyser] Walking koncern for ${kunde_type} ${kunde_id}${snapshotDate ? ` as of ${as_of_date}` : ''}`
      );
      const aktiver = await walkKoncern(
        kunde_type as 'virksomhed' | 'person',
        kunde_id,
        snapshotDate
      );
      logger.log(`[forsikring/analyser] Fandt ${aktiver.length} aktiver`);

      // Request context for internal API calls (used by address enrichment + cross-checks)
      const proto = request.headers.get('x-forwarded-proto') ?? 'https';
      const host = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
      const cookie = request.headers.get('cookie') ?? '';

      // 1b. Berig ejendom-aktiver med adresser (for matching mod policer)
      const ejendomBfes = aktiver.filter((a) => a.type === 'ejendom' && a.bfe).map((a) => a.bfe!);
      if (ejendomBfes.length > 0) {
        try {
          const addrRes = await fetch(`${host}/api/bfe-addresses?bfes=${ejendomBfes.join(',')}`, {
            headers: { cookie },
            signal: AbortSignal.timeout(10_000),
          });
          if (addrRes.ok) {
            const addrData: Record<
              string,
              {
                adresse: string | null;
                postnr: string | null;
                by: string | null;
                etage: string | null;
                doer: string | null;
              }
            > = await addrRes.json();
            for (const aktiv of aktiver) {
              if (aktiv.type === 'ejendom' && aktiv.bfe) {
                const info = addrData[String(aktiv.bfe)];
                if (info?.adresse) {
                  // BIZZ-1441: Inkluder etage/dør i adresse for ejerlejligheder
                  const etageDoer = [info.etage, info.doer].filter(Boolean).join(' ');
                  const fullAddr = etageDoer ? `${info.adresse}, ${etageDoer}` : info.adresse;
                  const postBy = [info.postnr, info.by].filter(Boolean).join(' ');
                  aktiv.adresse = postBy ? `${fullAddr}, ${postBy}` : fullAddr;
                  aktiv.label = aktiv.adresse;
                }
              }
            }
            logger.log(
              `[forsikring/analyser] Beriget ${Object.keys(addrData).length} ejendomme med adresser`
            );
          }
        } catch (err) {
          // BIZZ-1488/1492/1552: Log fejlen så vi kan diagnosticere når adresse-
          // berigelse fejler (tidligere stille fallback) — aktiver beholder så kun
          // BFE-nummeret som label hvilket fejler alle matches.
          logger.error('[forsikring/analyser] Adresse-berigelse fejlede:', err);
        }
      }

      // 2. Hent policer — BIZZ-1404: scope til valgte dokumenter hvis angivet
      tracker.begin('match');
      const insurance = await getInsuranceApi(auth.tenantId);
      const scopeDocIds = [...(document_ids ?? []), ...(new_document_ids ?? [])];
      // BIZZ-2065: UI'et sender nu altid document_ids (også som tom liste).
      // En EKSPLICIT tom liste betyder "brugeren har fravalgt alle dokumenter"
      // og må aldrig udløse fallback til alle policer fra tidligere analyser.
      const docScopeExplicit = document_ids !== undefined || new_document_ids !== undefined;
      const allPolicies = await insurance.policies.list();
      let policer: typeof allPolicies;
      if (scopeDocIds.length > 0) {
        // Kun policer parsed fra de valgte dokumenter
        policer = allPolicies.filter((p) => p.document_id && scopeDocIds.includes(p.document_id));

        // BIZZ-1592 REVERTED: Fallback til alle policer fjernet — det gav
        // forkerte resultater fordi policer fra TIDLIGERE uploads (andre
        // dokumenter) blev inkluderet i analysen. Bedre med 0 forsikrede
        // end forkerte matches fra irrelevante policer.
        if (policer.length === 0 && allPolicies.length > 0) {
          logger.warn(
            `[forsikring/analyser] scopeDocIds filtrerede ALLE ${allPolicies.length} policer væk — 0 policer brugt (ingen fallback)`
          );
        } else {
          logger.log(
            `[forsikring/analyser] Scoped til ${policer.length} policer fra ${scopeDocIds.length} dokumenter (af ${allPolicies.length} total)`
          );
        }
      } else if (docScopeExplicit) {
        // BIZZ-2065: Eksplicit tomt dokument-scope — brugeren har fravalgt
        // alle dokumenter. Analysér med 0 policer (alt uforsikret) i stedet
        // for at falde tilbage til policer fra tidligere analyser.
        logger.log(
          `[forsikring/analyser] Eksplicit tomt dokument-scope — 0 policer brugt (${allPolicies.length} tidligere policer ignoreret)`
        );
        policer = [];
      } else if (allPolicies.length > 0) {
        // BIZZ-1776: document_ids-feltet helt udeladt (legacy kald) OG der er
        // policer fra tidligere analyser — brug dem som fallback (backward
        // compat). Men log en warning — ideelt bør kalderen sende document_ids.
        // BIZZ-2120: Fallbacken må KUN bruge policer der hører til den
        // analyserede kunde/koncern — tenant'en kan have policer fra ANDRE
        // kunders dokumenter (fx DBRAMANTEs ansvarspolice der "dækkede"
        // SKIINVEST). Tilhørsforhold = forsikringstager-CVR i koncern-kæden,
        // forsikringstager-navn matcher en koncern-virksomhed, eller policens
        // forsikringssted matcher en af kundens ejendomme.
        const koncernCvrSet = new Set(
          aktiver.filter((a) => a.type === 'virksomhed' && a.cvr).map((a) => a.cvr as string)
        );
        if (kunde_type === 'virksomhed') koncernCvrSet.add(kunde_id);
        const koncernNavne = aktiver
          .filter((a) => a.type === 'virksomhed')
          .map((a) => a.label.toLowerCase().trim())
          .filter((n) => n.length > 0);
        if (kunde_navn) koncernNavne.push(kunde_navn.toLowerCase().trim());
        const aktivAdresser = aktiver
          .filter((a) => a.type === 'ejendom' && a.adresse)
          .map((a) => a.adresse as string);
        const hoererTilKoncern = (p: (typeof allPolicies)[number]): boolean => {
          if (p.policyholder_cvr && koncernCvrSet.has(p.policyholder_cvr)) return true;
          const pn = (p.policyholder_name ?? '').toLowerCase().trim();
          if (pn && koncernNavne.some((n) => pn === n || pn.includes(n) || n.includes(pn))) {
            return true;
          }
          return (
            !!p.property_address && aktivAdresser.some((a) => addressesMatch(p.property_address, a))
          );
        };
        policer = allPolicies.filter(hoererTilKoncern);
        logger.warn(
          `[forsikring/analyser] Ingen scopeDocIds — fallback til ${policer.length} koncern-policer (${allPolicies.length - policer.length} fra andre kunder filtreret fra, BIZZ-2120)`
        );
      } else {
        policer = [];
      }

      // BIZZ-1973: Detektér policer der dækker en adresse uden for kundens
      // portefølje (hverken ejet eller administreret). Bruges som advarsel — en
      // police uden property_address (fx ren ansvarsforsikring) springes over.
      const portefoeljeAdresser = aktiver
        .filter((a) => a.type === 'ejendom' && a.adresse)
        .map((a) => a.adresse as string);

      // BIZZ-2077: Kundens egen CVR-registrerede adresse (hovedkontor) er pr.
      // definition IKKE et forsikringssted — policer stiles ofte dertil som ren
      // korrespondanceadresse. Bruges både til advarsels-filteret (BIZZ-2079)
      // og til sikrede-info-banneret nedenfor.
      let kundeEgenAdresse: string | null = null;
      if (kunde_type === 'virksomhed') {
        try {
          const { data: cvrRow } = await admin
            .from('cvr_virksomhed')
            .select('adresse_json')
            .eq('cvr', kunde_id)
            .maybeSingle();
          // Admin-klienten er utypet for public-tabeller — cast adresse_json manuelt.
          const adr = (cvrRow as { adresse_json?: unknown } | null)?.adresse_json as {
            vejnavn?: string | null;
            husnummerFra?: number | null;
            bogstavFra?: string | null;
            postnummer?: number | null;
            postdistrikt?: string | null;
          } | null;
          if (adr?.vejnavn) {
            kundeEgenAdresse =
              `${adr.vejnavn} ${adr.husnummerFra ?? ''}${adr.bogstavFra ?? ''}, ${adr.postnummer ?? ''} ${adr.postdistrikt ?? ''}`.trim();
          }
        } catch {
          // Rent informativt filter — analysen fortsætter uden hvis CVR-opslag fejler.
        }
      }

      // BIZZ-2079: Adresse-kontekst — en police-adresse er kun et bygnings-
      // forsikringssted hvis policen faktisk er en bygnings-/ejendomspolice.
      // Erhvervs-/ansvars-/løsørepolicer nævner adresser som driftssted eller
      // korrespondanceadresse — de må ikke sammenlignes med ejendomsporteføljen.
      // Oversigt-policer gemmer insurance_type i business_activity (parse-route);
      // individuelt parsede policer kan have typen i raw_metadata. Mangler
      // type-information helt, antages bygningspolice (advarslen bevares).
      const erBygningsPolice = (p: (typeof policer)[number]): boolean => {
        const typeTekst = [
          p.raw_metadata?.source_type === 'oversigt' ? p.business_activity : null,
          p.raw_metadata?.insurance_type as string | undefined,
          p.raw_metadata?.type as string | undefined,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!typeTekst) return true;
        return /bygning|ejendom|grundejer|hus(?!leje)/.test(typeTekst);
      };

      const addressMismatches = policer
        .filter((p) => p.property_address && p.property_address.trim().length > 0)
        .filter(
          (p) => !portefoeljeAdresser.some((addr) => addressesMatch(p.property_address, addr))
        )
        // BIZZ-2079: kun bygnings-/ejendomspolicer har et forsikringssted der
        // meningsfuldt kan sammenlignes med ejendomsporteføljen.
        .filter((p) => erBygningsPolice(p))
        // BIZZ-2079: forsikringstagers egen adresse (police-adressat/HQ) er en
        // korrespondanceadresse — ikke et forsikringssted uden for porteføljen.
        .filter(
          (p) =>
            !(
              p.policyholder_address && addressesMatch(p.property_address, p.policyholder_address)
            ) && !(kundeEgenAdresse && addressesMatch(p.property_address, kundeEgenAdresse))
        )
        .map((p) => ({
          policy_id: p.id,
          document_id: p.document_id ?? null,
          policy_number: p.policy_number,
          insurer_name: p.insurer_name,
          property_address: p.property_address,
          // true når adressen er forsikringstagers egen adresse (typisk HQ) — så
          // advarslen kan forklare at det er hovedkontoret, ikke en ejet ejendom.
          is_policyholder_address:
            !!p.policyholder_address && addressesMatch(p.property_address, p.policyholder_address),
        }));

      // BIZZ-2067: Sikrede-/korrespondance-adresser uden for porteføljen.
      // En police er ofte stilet til virksomhedens hovedkontor (typisk lejet,
      // ikke ejet) — det er IKKE en fejl, men brugeren skal kunne se det i
      // rapporten, så adressen ikke forveksles med et forsikringssted. Vises
      // som info — blokerer ikke preflight og udløser ingen advarsel.
      // Follow-up: inkluder kildedokumentets filnavn pr. adresse, så brugeren
      // kan se HVILKEN police der indeholder adressen uden for porteføljen.
      const dokumentNavne = new Map<string, string>();
      try {
        for (const d of await insurance.documents.list()) {
          dokumentNavne.set(d.id, d.original_name);
        }
      } catch {
        // Filnavne er rent informative — analysen fortsætter uden dem.
      }
      const sikredeAdresseSet = new Set<string>();
      const sikredeAdresserUdenForPortefoelje: Array<{
        adresse: string;
        dokument_navn: string | null;
        policy_number: string | null;
      }> = [];
      for (const p of policer) {
        // BIZZ-2067: police-adressater (policyholder_address). BIZZ-2079:
        // driftssteder fra ikke-bygningspolicer (fx erhvervsforsikring) vises
        // også som info i stedet for som "uden for porteføljen"-advarsel.
        const kandidater: Array<string | null | undefined> = [p.policyholder_address];
        if (p.property_address && !erBygningsPolice(p)) kandidater.push(p.property_address);
        for (const rawAdresse of kandidater) {
          const adresse = rawAdresse?.trim();
          if (!adresse) continue;
          if (portefoeljeAdresser.some((addr) => addressesMatch(adresse, addr))) continue;
          // BIZZ-2077: Spring kundens egen virksomhedsadresse over — den er nævnt
          // som adressat på policen, ikke som dækket forsikringssted.
          if (kundeEgenAdresse && addressesMatch(adresse, kundeEgenAdresse)) continue;
          const dokumentNavn = p.document_id ? (dokumentNavne.get(p.document_id) ?? null) : null;
          const key = `${adresse.toLowerCase()}|${dokumentNavn ?? ''}`;
          if (sikredeAdresseSet.has(key)) continue;
          sikredeAdresseSet.add(key);
          sikredeAdresserUdenForPortefoelje.push({
            adresse,
            dokument_navn: dokumentNavn,
            policy_number: p.policy_number ?? null,
          });
        }
      }

      // BIZZ-1973: Preflight — returnér kun mismatches, kør ikke gap-engine/persist.
      if (body.preflight) {
        // Undertryk mismatches for policer hvis adresse resolver til en SFE som
        // porteføljens aktiver tilhører — en police der dækker porteføljen via
        // (direkte) SFE-arv er ikke "uden for porteføljen".
        let preflightMismatches = addressMismatches;
        if (preflightMismatches.length > 0) {
          try {
            const pseudoMatches = aktiver.map((a) => ({
              aktiv: a,
              bestMatch: null,
              candidates: [],
            }));
            const { portefoeljePolicyIds } = await berigMedSfeStruktur(pseudoMatches, policer);
            preflightMismatches = preflightMismatches.filter(
              (m) => !portefoeljePolicyIds.has(m.policy_id)
            );
          } catch {
            // Best-effort: DAWA-opslag må ikke vælte preflight.
          }
        }
        logger.log(
          `[forsikring/analyser] Preflight: ${preflightMismatches.length} adresse-mismatch(es) af ${policer.length} policer`
        );
        return { status: 200, body: { preflight: true, mismatches: preflightMismatches } };
      }

      // 3. Match aktiver mod policer
      // BIZZ-1492: Debug-log policy adresser for at diagnosticere 0% match
      for (const p of policer.slice(0, 5)) {
        logger.log(
          `[forsikring/analyser] Policy ${p.policy_number}: property_address="${p.property_address ?? 'NULL'}" policyholder_address="${p.policyholder_address ?? 'NULL'}" property_bfe="${p.property_bfe ?? 'NULL'}"`
        );
      }
      for (const a of aktiver.filter((x) => x.type === 'ejendom').slice(0, 5)) {
        logger.log(
          `[forsikring/analyser] Aktiv ejendom: label="${a.label}" adresse="${a.adresse ?? 'NULL'}" bfe=${a.bfe ?? 'NULL'}`
        );
      }

      const matches = matchAssetsToPolicies(aktiver, policer);

      // BIZZ-2096: SFE-struktur-arv — en police på en SFE-adresse dækker som
      // udgangspunkt alle underliggende ejendomme i strukturen. Umatchede
      // aktiver i en dækket SFE får nedarvet match (score 75) + markering
      // `daekket_via_sfe` i raw_data. BIZZ-2128: kun direkte arv inden for SAMME
      // SFE-BFE — søster-SFE-kæden er fjernet (gav falsk dækning i by-ejerlav).
      // Best-effort: DAWA-opslag må ikke vælte analysen.
      let sfePortefoeljePolicyIds = new Set<string>();
      try {
        const sfeResultat = await berigMedSfeStruktur(matches, policer);
        sfePortefoeljePolicyIds = sfeResultat.portefoeljePolicyIds;
        if (sfeResultat.inherited > 0) {
          logger.log(
            `[forsikring/analyser] SFE-arv: ${sfeResultat.inherited} aktiver dækket via SFE-struktur`
          );
        }
      } catch (err) {
        logger.warn('[forsikring/analyser] SFE-struktur-berigelse fejlede (best-effort):', err);
      }

      // BIZZ-2118: En police der anvendes til SFE-arv (eller hvis SFE er
      // forankret i porteføljen) kan ikke samtidig være "uden for porteføljen".
      const filtreredeMismatches = addressMismatches.filter(
        (m) => !sfePortefoeljePolicyIds.has(m.policy_id)
      );

      const insuredCount = matches.filter((m) => m.bestMatch !== null).length;

      // BIZZ-1492: Log match-resultater for debugging
      logger.log(
        `[forsikring/analyser] Matches: ${insuredCount}/${matches.length} forsikrede, ${matches.length - insuredCount} uforsikrede`
      );
      for (const m of matches.filter((x) => x.bestMatch === null).slice(0, 3)) {
        logger.log(
          `[forsikring/analyser] Uforsikret: "${m.aktiv.label}" (type=${m.aktiv.type}, bfe=${m.aktiv.bfe ?? '?'})`
        );
      }

      // BIZZ-1592: Sentry-breadcrumb når 0% match-rate detekteres på trods af
      // policer (alert til oss — typisk symptom på scopeDocIds-bug, manglende
      // adresse-parsing eller manglende ejer_cvr på aktiver).
      if (matches.length > 0 && insuredCount === 0 && policer.length > 0) {
        Sentry.captureMessage('[forsikring/analyser] 0% match-rate trods policer', {
          level: 'warning',
          tags: {
            tenant_id: auth.tenantId,
            kunde_type,
            aktiver_count: String(matches.length),
            policer_count: String(policer.length),
          },
          extra: {
            // Sample af aktiver der ikke matchede (op til 5)
            aktiver_sample: matches.slice(0, 5).map((m) => ({
              type: m.aktiv.type,
              label: m.aktiv.label,
              bfe: m.aktiv.bfe ?? null,
              har_adresse: !!m.aktiv.adresse,
              har_ejer_cvr: !!(m.aktiv.rawData as { ejer_cvr?: string } | undefined)?.ejer_cvr,
            })),
            policer_sample: policer.slice(0, 5).map((p) => ({
              id: p.id,
              har_property_address: !!p.property_address,
              har_property_bfe: !!p.property_bfe,
              har_policyholder_cvr: !!p.policyholder_cvr,
            })),
          },
        });
      }

      // 4. Kør gap-engine for matchede aktiver
      const allGaps: Array<{
        policyId: string;
        checkId: string;
        category: string;
        severity: string;
        title: string;
        description: string;
        recommendation: string | null;
        estimatedImpactDkk: number | null;
        sourceData: Record<string, unknown>;
        riskScore: number;
      }> = [];

      // BIZZ-1446: Hent branche-data + virksomhedsform for virksomheds-aktiver
      tracker.begin('daekning');
      const virksomhedAktiver = aktiver.filter((a) => a.type === 'virksomhed' && a.cvr);
      let brancheData:
        | {
            hovedbranche: string | null;
            hovedbranche_tekst: string | null;
            bibrancher: Array<{ kode: string; tekst: string | null }>;
          }
        | undefined;
      let virksomhedsform: string | null = null;
      if (virksomhedAktiver.length > 0) {
        try {
          // Hent core CVR-data først (branche + virksomhedsform er kerne-felter
          // der findes i alle miljøer). Bibrancher hentes separat fordi de er
          // tilføjet af migration 104 og ikke nødvendigvis applied overalt.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: coreData } = await (admin as any)
            .from('cvr_virksomhed')
            .select('branche_kode, branche_tekst, virksomhedsform')
            .eq('cvr', virksomhedAktiver[0].cvr)
            .maybeSingle();

          if (coreData) {
            const core = coreData as Record<string, string | null>;
            virksomhedsform = core.virksomhedsform ?? null;

            // Forsøg at hente bibrancher (kan fejle hvis migration 104 ikke applied)
            const bibrancher: Array<{ kode: string; tekst: string | null }> = [];
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: biData } = await (admin as any)
                .from('cvr_virksomhed')
                .select(
                  'bibranche1_kode, bibranche1_tekst, bibranche2_kode, bibranche2_tekst, bibranche3_kode, bibranche3_tekst'
                )
                .eq('cvr', virksomhedAktiver[0].cvr)
                .maybeSingle();
              if (biData) {
                const v = biData as Record<string, string | null>;
                for (let i = 1; i <= 3; i++) {
                  const kode = v[`bibranche${i}_kode`];
                  if (kode) bibrancher.push({ kode, tekst: v[`bibranche${i}_tekst`] ?? null });
                }
              }
            } catch {
              /* bibrancher-kolonner findes ikke i dette miljø — fortsæt uden */
            }

            brancheData = {
              hovedbranche: core.branche_kode ?? null,
              hovedbranche_tekst: core.branche_tekst ?? null,
              bibrancher,
            };
          }
        } catch (err) {
          logger.warn('[forsikring/analyser] Branche-fetch fejlede:', err);
        }
      }

      // BIZZ-1488/1492/1552: Batch-fetch coverages per policy så gap-engine
      // får faktiske dækningsdata (tidligere hardkodet til []) — uden disse
      // rapporterede checkMissingGlas/Sanitet/etc. altid "mangler".
      // BIZZ-2066: Hent for ALLE policer i scope — ikke kun bestMatches.
      // Ansvar-policer uden property_address (fx en forsikringsoversigts
      // "dækker hele virksomheden"-række) matcher aldrig et aktiv, og når to
      // rækker deler policenummer/adresse vinder kun én bestMatch — i begge
      // tilfælde var dækningerne (fx erhvervsansvar) usynlige for portefølje-
      // checks (GAP-067 m.fl.), så et ekstra dokument kunne paradoksalt give
      // FLERE manglende branchekrav.
      const policyIds = policer.map((p) => p.id);
      const coveragesByPolicy = new Map<string, ForsikringCoverage[]>();
      if (policyIds.length > 0) {
        const coveragePromises = policyIds.map((id) =>
          insurance.coverages.listForPolicy(id).then((rows) => ({ id, rows }))
        );
        const results = await Promise.all(coveragePromises);
        for (const r of results) coveragesByPolicy.set(r.id, r.rows);
      }

      // BIZZ-2120: Præmieopkrævninger uden dækningsdetaljer — dokumenttypen
      // "praemie" parses som police (BIZZ-2083), men en ren opkrævning har
      // hverken coverages eller forsikringsform. Uden advarsel ser brugeren
      // bare "0 dækninger" og tror policen er analyseret. Vises som banner.
      const praemieAdvarsler = policer
        .filter((p) => (p.raw_metadata?.document_type as string | undefined) === 'praemie')
        .filter((p) => (coveragesByPolicy.get(p.id) ?? []).length === 0 && !p.insurance_form)
        .map(
          (p) =>
            `Policedokument mangler — kun præmieopkrævning uploadet for ${p.insurer_name} ${p.policy_number}. Opkrævningen indeholder ikke dækningsdetaljer, så policen kan ikke indgå i dækningsanalysen. Upload den fulde police.`
        );

      // BIZZ-1902: Hent standard betingelsers dækningskrav for gap-engine baseline
      const standardBetingelserBaseline: Array<{
        titel: string;
        selskab: string;
        krav: Array<{ omraade: string; beskrivelse: string; paakraevet: boolean }>;
      }> = [];
      if (allowedStandardDocIds.length > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: stdDocs } = await (admin as any)
            .from('forsikring_standard_doc')
            .select('id, selskab, titel, raw_content, ai_metadata')
            .in('id', allowedStandardDocIds);

          for (const doc of (stdDocs ?? []) as Array<{
            id: string;
            selskab: string;
            titel: string;
            raw_content: string | null;
            ai_metadata: Record<string, unknown> | null;
          }>) {
            // Brug AI-metadata hvis allerede ekstraheret, ellers fallback til
            // simpel coverage-code matching baseret på titel/kategori
            const krav: Array<{ omraade: string; beskrivelse: string; paakraevet: boolean }> = [];

            // Heuristisk: match standard betingelsers titel mod kendte coverage-koder
            const titelLower = doc.titel.toLowerCase();
            if (titelLower.includes('ejendom') || titelLower.includes('bygning')) {
              krav.push(
                {
                  omraade: 'brand_el',
                  beskrivelse: 'Brand- og el-skadeforsikring',
                  paakraevet: true,
                },
                { omraade: 'bygningskasko', beskrivelse: 'Bygningskasko', paakraevet: true },
                { omraade: 'udvidet_roerskade', beskrivelse: 'Udvidet rørskade', paakraevet: true },
                { omraade: 'stikledning', beskrivelse: 'Stikledningsforsikring', paakraevet: true },
                { omraade: 'jordskade', beskrivelse: 'Jordskadedækning', paakraevet: true },
                { omraade: 'huslejetab', beskrivelse: 'Huslejetabsforsikring', paakraevet: true }
              );
            }
            if (titelLower.includes('ansvar') || titelLower.includes('erhverv')) {
              krav.push(
                {
                  omraade: 'erhvervsansvar',
                  beskrivelse: 'Erhvervsansvarsforsikring',
                  paakraevet: true,
                },
                { omraade: 'forurening', beskrivelse: 'Forureningsdækning', paakraevet: true },
                {
                  omraade: 'hus_grundejer_ansvar',
                  beskrivelse: 'Hus- og grundejeransvar',
                  paakraevet: true,
                }
              );
            }

            if (krav.length > 0) {
              standardBetingelserBaseline.push({
                titel: doc.titel,
                selskab: doc.selskab,
                krav,
              });
            }
          }
          logger.log(
            `[forsikring/analyser] Standard betingelser baseline: ${standardBetingelserBaseline.length} docs med ${standardBetingelserBaseline.reduce((s, d) => s + d.krav.length, 0)} krav`
          );
        } catch (err) {
          logger.warn('[forsikring/analyser] Standard betingelser baseline fejlede:', err);
        }
      }

      // BIZZ-2071: Et policenummer kan optræde i flere dokumenter (fuld police +
      // forsikringsoversigt). Kun én af rækkerne vinder bestMatch pr. aktiv, så
      // uden merge ignoreres dækninger der kun står i det andet dokument (fx
      // hus_grundejer_ansvar fra en oversigt) — et ekstra dokument ændrede
      // dermed intet i analysen. Normalisér policenummeret (fjern whitespace)
      // og saml dækninger fra alle policer i scope med samme nummer.
      const normPolicyNo = (n: string | null | undefined): string => (n ?? '').replace(/\s+/g, '');

      tracker.begin('gap');
      for (const match of matches) {
        if (!match.bestMatch) continue;
        const bestPolicyNo = normPolicyNo(match.bestMatch.policy.policy_number);
        const policyCoverages = policer
          .filter(
            (p) =>
              p.id === match.bestMatch!.policy.id ||
              (bestPolicyNo.length > 0 && normPolicyNo(p.policy_number) === bestPolicyNo)
          )
          .flatMap((p) => coveragesByPolicy.get(p.id) ?? []);

        // BIZZ-2047: Filtrer standard-betingelser til kun at matche policens selskab.
        // Topdanmark-vilkår skal ikke bruges som baseline for Alm. Brand policer osv.
        // BIZZ-2069: Sammenlign på normaliserede navne (dash/case/whitespace).
        const policyInsurer = normSelskab(match.bestMatch.policy.insurer_name ?? '');
        const matchedStdBetingelser =
          standardBetingelserBaseline.length > 0 && policyInsurer
            ? standardBetingelserBaseline.filter(
                (sb) =>
                  policyInsurer.includes(normSelskab(sb.selskab)) ||
                  normSelskab(sb.selskab).includes(policyInsurer)
              )
            : [];

        // BIZZ-2144: For bil-aktiver berig med DMR-data (tjekbil.dk) så
        // gap-motoren kan opdage afmeldt/uforsikret/selskabsskift/forældet syn.
        // Fail-soft: opslag-fejl giver dmr=null og springer DMR-checks over.
        const dmr =
          match.aktiv.type === 'bil' && match.aktiv.regnr
            ? await fetchDmrByRegnr(match.aktiv.regnr)
            : undefined;

        const gaps = runGapEngine({
          policy: match.bestMatch.policy,
          coverages: policyCoverages,
          bbr: null,
          asOfDate: new Date(),
          standardBetingelser: matchedStdBetingelser.length > 0 ? matchedStdBetingelser : undefined,
          branche: brancheData,
          dmr,
          asset: {
            type: match.aktiv.type,
            vaerdiDkk: match.aktiv.vaerdiDkk,
            haeftelserDkk: match.aktiv.haeftelserDkk,
            byggeaar: match.aktiv.byggeaar,
            matchScore: match.bestMatch.score,
          },
        });
        for (const gap of gaps) {
          allGaps.push({
            policyId: match.bestMatch.policy.id,
            checkId: gap.check_id,
            category: gap.category,
            severity: gap.severity,
            title: gap.title,
            description: gap.description,
            recommendation: gap.recommendation,
            estimatedImpactDkk: gap.estimated_impact_dkk,
            sourceData: gap.source_data,
            riskScore: computeRiskScore(gap, {
              type: match.aktiv.type,
              vaerdiDkk: match.aktiv.vaerdiDkk,
              haeftelserDkk: match.aktiv.haeftelserDkk,
              byggeaar: match.aktiv.byggeaar,
            }),
          });
        }
      }

      // 4a. Portefølje-niveau checks (D&O, huslejetab, driftstab, cyber, retshjælp, kollektiv)
      const portfolioGaps = runPortfolioChecks({
        aktiver,
        matches,
        policer,
        coveragesByPolicy,
        branche: brancheData,
        virksomhedsform,
      });

      // Find virksomhedens matched police — portefølje-gaps hører til virksomheds-
      // niveauet, ikke til en tilfældig ejendomspolice. Fallback-rækkefølge:
      //   1. Police matched til hovedvirksomhed (CVR-aktiv)
      //   2. Første police i scope
      //   3. Streng 'portfolio' hvis ingen policer findes
      const hovedCvr = kunde_type === 'virksomhed' ? kunde_id : null;
      const virksomhedMatch = matches.find(
        (m) => m.aktiv.type === 'virksomhed' && m.aktiv.cvr === hovedCvr && m.bestMatch
      );
      const portfolioPolicyId =
        virksomhedMatch?.bestMatch?.policy.id ?? policer[0]?.id ?? 'portfolio';

      for (const gap of portfolioGaps) {
        allGaps.push({
          policyId: portfolioPolicyId,
          checkId: gap.check_id,
          category: gap.category,
          severity: gap.severity,
          title: gap.title,
          description: gap.description,
          recommendation: gap.recommendation,
          estimatedImpactDkk: gap.estimated_impact_dkk,
          sourceData: gap.source_data,
          riskScore: computeRiskScore(gap),
        });
      }
      logger.log(
        `[forsikring/analyser] Portefølje-checks: ${portfolioGaps.length} gaps (${portfolioGaps.filter((g) => g.severity === 'critical').length} kritiske)`
      );

      // 4a3. BIZZ-2100: Dækningsgradsanalyse — valider dækningsSUMMER mod
      // seneste regnskabstal (regnskab_cache i public-skemaet, samme kilde som
      // /api/regnskab/xbrl). Mangler cachen springes checkene over — analysen
      // må ikke fejle på et manglende regnskab.
      const daekningsgradCvr = hovedCvr ?? virksomhedAktiver.find((a) => a.cvr)?.cvr ?? null;
      if (daekningsgradCvr) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: regnskabCache } = await (admin as any)
            .from('regnskab_cache')
            .select('years')
            .eq('cvr', daekningsgradCvr)
            .maybeSingle();
          const seneste = (
            regnskabCache as {
              years?: Array<{
                aar: string;
                resultat: { omsaetning: number | null; bruttofortjeneste: number | null };
                balance: {
                  varelager: number | null;
                  likvideBeholdninger: number | null;
                  aktiverIAlt: number | null;
                };
              }>;
            } | null
          )?.years?.[0];
          const regnskab: RegnskabsTalLite | null = seneste
            ? {
                aar: seneste.aar,
                omsaetningTkr: seneste.resultat.omsaetning,
                bruttofortjenesteTkr: seneste.resultat.bruttofortjeneste,
                varelagerTkr: seneste.balance.varelager,
                likvideBeholdningerTkr: seneste.balance.likvideBeholdninger,
                aktiverIAltTkr: seneste.balance.aktiverIAlt,
              }
            : null;
          const daekningsgradGaps = runDaekningsgradChecks({
            policer,
            coveragesByPolicy,
            regnskab,
          });
          for (const gap of daekningsgradGaps) {
            allGaps.push({
              policyId: portfolioPolicyId,
              checkId: gap.check_id,
              category: gap.category,
              severity: gap.severity,
              title: gap.title,
              description: gap.description,
              recommendation: gap.recommendation,
              estimatedImpactDkk: gap.estimated_impact_dkk,
              sourceData: gap.source_data,
              riskScore: computeRiskScore(gap),
            });
          }
          logger.log(
            `[forsikring/analyser] Dækningsgrads-checks: ${daekningsgradGaps.length} gaps (regnskab ${regnskab ? regnskab.aar : 'mangler'})`
          );
        } catch (err) {
          logger.warn('[forsikring/analyser] Dækningsgrads-checks fejlede:', err);
        }
      }

      // 4a2. BIZZ-1890: Standard betingelser — hent metadata og tilføj INFO-gaps til analysen.
      // Hvert linked standard-betingelses-dokument genererer ét INFO-gap der vejleder
      // analytikeren om at sammenligne policens dækning med selskabets egne vilkår.
      if (allowedStandardDocIds.length > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: stdDocs } = await (admin as any)
            .from('forsikring_standard_doc')
            .select('id, selskab, titel, source_url, kategori')
            .in('id', allowedStandardDocIds);
          // BIZZ-2072: Kobl hvert vilkårs INFO-gap til en police fra SAMME
          // selskab (normaliseret navnematch, jf. BIZZ-2047/2069) — ellers
          // endte fx Topdanmark-vilkår under en Alm. Brand-police, fordi de
          // ukritisk blev hæftet på portfolioPolicyId. Foretræk en police der
          // er bestMatch for et aktiv (så gappet renderes under det rigtige
          // aktiv i UI'et). Matcher intet selskab udelades INFO-gappet —
          // std_betingelser_advarsel forklarer i forvejen at vilkårene ikke
          // blev anvendt.
          const bestMatchPolicyIds = new Set(
            matches.filter((m) => m.bestMatch).map((m) => m.bestMatch!.policy.id)
          );
          for (const doc of (stdDocs ?? []) as Array<{
            id: string;
            selskab: string;
            titel: string;
            source_url: string;
            kategori: string;
          }>) {
            const docSelskab = normSelskab(doc.selskab);
            const selskabsPolicer = policer.filter((p) => {
              const pi = normSelskab(p.insurer_name ?? '');
              return pi.length > 0 && docSelskab.length > 0
                ? pi.includes(docSelskab) || docSelskab.includes(pi)
                : false;
            });
            const stdPolicy =
              selskabsPolicer.find((p) => bestMatchPolicyIds.has(p.id)) ?? selskabsPolicer[0];
            if (!stdPolicy) continue;
            allGaps.push({
              policyId: stdPolicy.id,
              checkId: `GAP-STD-${doc.id.slice(0, 8).toUpperCase()}`,
              category: 'standard_betingelser',
              severity: 'info',
              title: `Standard betingelse tilknyttet: ${doc.titel}`,
              description:
                `${doc.selskab}-vilkår (${doc.kategori}) er tilknyttet denne analyse. ` +
                `Sammenlign policens aktuelle dækning med ${doc.selskab}s standard-betingelser ` +
                `for at identificere eventuelle afvigelser og mangler.`,
              recommendation: `Gennemgå ${doc.titel} og verificér at alle vilkår er opfyldt i policen.`,
              estimatedImpactDkk: null,
              sourceData: {
                standard_doc_id: doc.id,
                source_url: doc.source_url,
                selskab: doc.selskab,
              },
              riskScore: 5,
            });
          }
          logger.log(
            `[forsikring/analyser] Standard-betingelser: ${(stdDocs ?? []).length} tilknyttet`
          );
        } catch (err) {
          logger.warn(
            '[forsikring/analyser] Standard betingelser lookup fejlede (best-effort):',
            err
          );
        }
      }

      // 4b. BIZZ-1356: Auto-trigger eksterne cross-checks (best-effort, parallel)
      try {
        const [bbrResult, tlResult, vurResult] = await Promise.allSettled([
          runBbrCrossCheck(matches, host, cookie),
          runTinglysningCrossCheck(matches, host, cookie),
          runVurCrossCheck(matches, host, cookie),
        ]);

        // Merge cross-check gaps into allGaps
        if (bbrResult.status === 'fulfilled') {
          for (const g of bbrResult.value.gaps) {
            allGaps.push({
              policyId: g.policyId,
              checkId: g.check_id,
              category: g.category,
              severity: g.severity,
              title: g.title,
              description: g.description,
              recommendation: g.recommendation,
              estimatedImpactDkk: g.estimated_impact_dkk,
              sourceData: g.source_data,
              riskScore: g.riskScore,
            });
          }
          logger.log(`[forsikring/analyser] BBR cross-check: ${bbrResult.value.gaps.length} gaps`);
        }
        if (tlResult.status === 'fulfilled') {
          for (const g of tlResult.value.gaps) {
            allGaps.push({
              policyId: g.policyId,
              checkId: g.check_id,
              category: g.category,
              severity: g.severity,
              title: g.title,
              description: g.description,
              recommendation: g.recommendation,
              estimatedImpactDkk: g.estimated_impact_dkk,
              sourceData: g.source_data,
              riskScore: g.riskScore,
            });
          }
          logger.log(
            `[forsikring/analyser] Tinglysning cross-check: ${tlResult.value.gaps.length} gaps`
          );
        }
        if (vurResult.status === 'fulfilled') {
          for (const g of vurResult.value.gaps) {
            allGaps.push({
              policyId: g.policyId,
              checkId: g.check_id,
              category: g.category,
              severity: g.severity,
              title: g.title,
              description: g.description,
              recommendation: g.recommendation,
              estimatedImpactDkk: g.estimated_impact_dkk,
              sourceData: g.source_data,
              riskScore: g.riskScore,
            });
          }
          logger.log(`[forsikring/analyser] VUR cross-check: ${vurResult.value.gaps.length} gaps`);
        }

        // BIZZ-2170: Værdi-baserede checks — sammenlign forsikret sum mod
        // seneste købspris (TL) og offentlig vurdering (VUR). Bruger data
        // hentet af cross-checks ovenfor (ingen ekstra I/O). Aldrig critical.
        const koebsprisByBfe =
          tlResult.status === 'fulfilled' ? tlResult.value.koebsprisByBfe : new Map();
        const vurderingByBfe =
          vurResult.status === 'fulfilled' ? vurResult.value.vurderingByBfe : new Map();
        const vurderingsAarByBfe =
          vurResult.status === 'fulfilled' ? vurResult.value.vurderingsAarByBfe : new Map();
        const asOfDate = new Date();

        // BIZZ-2175: Bygningens forsikringssum ligger ofte på dæknings-niveau
        // (fx "Bygningsbrand mv." = 113.860.000) på ejendomspolicen — IKKE på
        // policens sum_insured_dkk, og ikke nødvendigvis på bestMatch (en
        // ansvarspolice på samme adresse kan vinde matchet). Læser vi kun
        // bestMatch.sum_insured_dkk, rapporteres "Ingen forsikringssum" selv om
        // bygningen er fuldt forsikret. Vi aggregerer derfor den HØJESTE
        // bygnings-dækningssum på tværs af ALLE matchede policer (score ≥ 50)
        // for samme BFE. En dækning regnes som bygningsværdi hvis koden er
        // 'bygningskasko' eller 'brand_el' med "bygning" i labelen (så fx
        // ansvarspolicens "Varetægt" (brand_el) ikke tæller med).
        const isBuildingCoverage = (c: ForsikringCoverage): boolean =>
          c.is_covered &&
          (c.sum_dkk ?? 0) > 0 &&
          (c.coverage_code === 'bygningskasko' ||
            (c.coverage_code === 'brand_el' && /bygning/i.test(c.coverage_label ?? '')));
        const buildingSumForMatch = (m: (typeof matches)[number]): number | null => {
          let best: number | null = null;
          for (const cand of m.candidates) {
            if (cand.score < 50) continue;
            for (const c of coveragesByPolicy.get(cand.policy.id) ?? []) {
              if (isBuildingCoverage(c) && (best === null || c.sum_dkk! > best)) {
                best = c.sum_dkk!;
              }
            }
          }
          return best;
        };

        let vaerdiGapCount = 0;
        for (const match of matches) {
          if (match.aktiv.type !== 'ejendom' || !match.aktiv.bfe || !match.bestMatch) continue;
          const bfe = match.aktiv.bfe;
          const koebs = koebsprisByBfe.get(bfe) as
            | { pris: number | null; dato: string | null }
            | undefined;
          // Effektiv forsikringssum: højeste af bestMatch-policens sum_insured
          // og den aggregerede bygnings-dækningssum på tværs af policer.
          const buildingSum = buildingSumForMatch(match);
          const effectiveSum =
            Math.max(buildingSum ?? 0, match.bestMatch.policy.sum_insured_dkk ?? 0) || null;
          const vaerdiGaps = runVaerdiChecks({
            bfe,
            policyId: match.bestMatch.policy.id,
            adresse: match.aktiv.adresse ?? null,
            sumInsuredDkk: effectiveSum,
            vurderingDkk: vurderingByBfe.get(bfe) ?? null,
            vurderingsAar: vurderingsAarByBfe.get(bfe) ?? null,
            koebsprisDkk: koebs?.pris ?? null,
            koebsDato: koebs?.dato ?? null,
            asOfDate,
          });
          for (const gap of vaerdiGaps) {
            vaerdiGapCount++;
            allGaps.push({
              policyId: match.bestMatch.policy.id,
              checkId: gap.check_id,
              category: gap.category,
              severity: gap.severity,
              title: gap.title,
              description: gap.description,
              recommendation: gap.recommendation,
              estimatedImpactDkk: gap.estimated_impact_dkk,
              sourceData: gap.source_data,
              riskScore: computeRiskScore(gap, {
                type: 'ejendom',
                vaerdiDkk: vurderingByBfe.get(bfe) ?? undefined,
              }),
            });
          }
        }
        logger.log(`[forsikring/analyser] Værdi-checks: ${vaerdiGapCount} gaps`);
      } catch (err) {
        logger.warn('[forsikring/analyser] Cross-checks fejlede (best-effort):', err);
      }

      // 5. Beregn samlet risk-score
      const totalRiskScore =
        allGaps.length > 0
          ? Math.round(allGaps.reduce((sum, g) => sum + g.riskScore, 0) / allGaps.length)
          : 0;

      // 6. Persistér analyse
      tracker.begin('gem');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (admin as any).schema(schemaName);
      const { data: analyse, error: analyseErr } = await db
        .from('forsikring_analyser')
        .insert({
          tenant_id: auth.tenantId,
          kunde_type,
          kunde_id,
          kunde_navn: kunde_navn ?? null,
          total_aktiver: aktiver.length,
          insured_count: insuredCount,
          uninsured_count: aktiver.length - insuredCount,
          total_risk_score: totalRiskScore,
          sag_id: sag_id ?? null,
          summary: {
            gaps_count: allGaps.length,
            gaps_critical: allGaps.filter((g) => g.severity === 'critical').length,
            gaps_warning: allGaps.filter((g) => g.severity === 'warning').length,
            policer_count: policer.length,
            as_of_date: as_of_date ?? null,
            // BIZZ-1973: Policer der dækker en adresse uden for porteføljen —
            // surfaces i rapport-banner + DOCX selv hvis brugeren valgte "fortsæt".
            address_mismatches: filtreredeMismatches,
            // BIZZ-2067: Sikrede-adresser uden for porteføljen (info, ikke advarsel)
            sikrede_adresser_uden_for_portefoelje: sikredeAdresserUdenForPortefoelje,
            // BIZZ-2120: Præmieopkrævninger uden dækningsdetaljer (advarsel)
            praemie_advarsler: praemieAdvarsler,
          },
          created_by: auth.userId,
        })
        .select('id')
        .single();

      if (analyseErr || !analyse) {
        logger.error('[forsikring/analyser] Insert analyse fejl:', analyseErr);
        return NextResponse.json({ error: 'Kunne ikke gemme analyse' }, { status: 500 });
      }

      // 7. Persistér aktiver
      if (aktiver.length > 0) {
        const aktivRows = matches.map((m) => ({
          tenant_id: auth.tenantId,
          analyse_id: analyse.id,
          type: m.aktiv.type,
          label: m.aktiv.label,
          bfe: m.aktiv.bfe ?? null,
          cvr: m.aktiv.cvr ?? null,
          regnr: m.aktiv.regnr ?? null,
          vaerdi_dkk: m.aktiv.vaerdiDkk ?? null,
          haeftelser_dkk: m.aktiv.haeftelserDkk ?? null,
          byggeaar: m.aktiv.byggeaar ?? null,
          ansatte: m.aktiv.ansatte ?? null,
          adresse: m.aktiv.adresse ?? null,
          matched_policy_id: m.bestMatch?.policy.id ?? null,
          match_score: m.bestMatch?.score ?? null,
          raw_data: m.aktiv.rawData ?? null,
        }));

        const { error: aktivErr } = await db.from('forsikring_aktiver').insert(aktivRows);

        if (aktivErr) {
          logger.error('[forsikring/analyser] Insert aktiver fejl:', aktivErr);
        }
      }

      // 8. Persistér gaps (med analyse_id for per-analyse scoping)
      if (allGaps.length > 0) {
        const gapRows = allGaps.map((g) => ({
          tenant_id: auth.tenantId,
          policy_id: g.policyId,
          check_id: g.checkId,
          category: g.category,
          severity: g.severity,
          title: g.title,
          description: g.description,
          recommendation: g.recommendation,
          estimated_impact_dkk: g.estimatedImpactDkk,
          source_data: g.sourceData,
          analyse_id: analyse.id,
        }));

        const { error: gapErr } = await db.from('forsikring_gaps').insert(gapRows);

        if (gapErr) {
          logger.error('[forsikring/analyser] Insert gaps fejl:', gapErr);
        }
      }

      // BIZZ-1404: Link dokumenter til analysen via junction-tabel.
      // Dedup via Set så samme document_id ikke insertes to gange — frontend
      // duplikat-detektion auto-vælger eksisterende doc_id når en fil med
      // samme navn uploades, hvilket kan give overlap mellem document_ids
      // og new_document_ids.
      const allDocIds = Array.from(
        new Set<string>([...(document_ids ?? []), ...(new_document_ids ?? [])])
      );
      if (allDocIds.length > 0) {
        const docLinks = allDocIds.map((docId) => ({
          tenant_id: auth.tenantId,
          analyse_id: analyse.id,
          document_id: docId,
          source: (document_ids ?? []).includes(docId) ? 'reused' : 'uploaded',
        }));
        const { error: linkErr } = await db.from('forsikring_analyse_documents').insert(docLinks);
        if (linkErr) {
          logger.warn('[forsikring/analyser] Link docs fejl:', linkErr.message);
        }
      }

      // BIZZ-1833: Link standard betingelser til analysen (delt tabel, public schema)
      if (allowedStandardDocIds.length > 0) {
        const stdLinks = allowedStandardDocIds.map((stdId) => ({
          analyse_id: analyse.id,
          standard_doc_id: stdId,
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: stdLinkErr } = await (admin as any)
          .from('forsikring_analyse_standard_docs')
          .insert(stdLinks);
        if (stdLinkErr) {
          logger.warn('[forsikring/analyser] Link standard docs fejl:', stdLinkErr.message);
        } else {
          logger.log(
            `[forsikring/analyser] Linked ${stdLinks.length} standard docs til analyse ${analyse.id}`
          );
        }
      }

      logActivity(admin, auth.tenantId, auth.userId, 'page_view', {
        analyse_id: analyse.id,
        kunde_type,
        aktiver: aktiver.length,
        gaps: allGaps.length,
      });

      // Tjek om valgte standard-betingelser matchede policernes selskab
      let stdBetingelserAdvarsel: string | null = null;
      if (standardBetingelserBaseline.length > 0) {
        const betSelskaber = [...new Set(standardBetingelserBaseline.map((b) => b.selskab))];
        const polSelskaber = [
          ...new Set(policer.map((p) => p.insurer_name).filter((n): n is string => !!n)),
        ];
        // BIZZ-2069: Sammenlign på normaliserede navne (dash/case/whitespace).
        const noMatch = betSelskaber.filter(
          (bs) =>
            !polSelskaber.some(
              (ps) =>
                normSelskab(ps).includes(normSelskab(bs)) ||
                normSelskab(bs).includes(normSelskab(ps))
            )
        );
        if (noMatch.length > 0) {
          stdBetingelserAdvarsel = `Standard betingelser fra ${noMatch.join(', ')} blev ikke anvendt — policerne er fra ${polSelskaber.join(', ') || 'ukendt selskab'}. Tilføj betingelser fra det korrekte selskab for at få en mere præcis gap-analyse.`;
        }
      }

      tracker.done();
      return {
        status: 200,
        body: {
          analyse_id: analyse.id,
          total_aktiver: aktiver.length,
          insured_count: insuredCount,
          gaps_count: allGaps.length,
          total_risk_score: totalRiskScore,
          address_mismatches: filtreredeMismatches,
          // BIZZ-2067: Sikrede-adresser uden for porteføljen (info, ikke advarsel)
          sikrede_adresser_uden_for_portefoelje: sikredeAdresserUdenForPortefoelje,
          std_betingelser_advarsel: stdBetingelserAdvarsel,
          // BIZZ-2120: Præmieopkrævninger uden dækningsdetaljer (advarsel)
          praemie_advarsler: praemieAdvarsler,
        },
      };
    } catch (err) {
      logger.error('[forsikring/analyser] Fejl:', err);
      tracker.dispose();
      return { status: 500, body: { error: 'Ekstern API fejl' } };
    }
  };

  // BIZZ-2140: Bagudkompatibel JSON-respons for klienter der ikke beder om SSE.
  if (!wantsSse) {
    const outcome = await executeAnalyse();
    return NextResponse.json(outcome.body, { status: outcome.status });
  }

  // BIZZ-2140: SSE-streaming — send progress-steps undervejs og det endelige
  // resultat som et `done`-event. Fejl sendes som et `error`-event (inkl.
  // hvilket trin der kørte), så UI'et kan vise præcis hvad der gik galt.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      emit = (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* stream lukket — ignorér */
        }
      };
      try {
        const outcome = await executeAnalyse();
        emit({ type: 'done', status: outcome.status, result: outcome.body });
      } catch (err) {
        logger.error('[forsikring/analyser] SSE-fejl:', err);
        emit({ type: 'error', message: 'Ekstern API fejl', step: tracker.current() });
      } finally {
        tracker.dispose();
        try {
          controller.close();
        } catch {
          /* allerede lukket */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * GET /api/forsikring/analyser — List alle analyser for tenant.
 *
 * @returns { analyser: ForsikringAnalyseRow[] }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // BIZZ-1404: Optional filter by customer
  const kundeId = request.nextUrl.searchParams.get('kunde_id');

  const admin = createAdminClient();
  const schemaName = await getTenantSchemaName(auth.tenantId);
  if (!schemaName) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (admin as any)
      .schema(schemaName)
      .from('forsikring_analyser')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (kundeId) {
      query = query.eq('kunde_id', kundeId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[forsikring/analyser] List fejl:', error);
      return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
    }

    return NextResponse.json({ analyser: data ?? [] });
  } catch (err) {
    logger.error('[forsikring/analyser] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
