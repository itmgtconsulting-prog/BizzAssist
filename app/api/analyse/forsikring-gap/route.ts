/**
 * POST /api/analyse/forsikring-gap
 *
 * BIZZ-1223: Forsikrings-gap-analyse backend.
 * Modtager kundeId + policeliste, henter aktiver fra interne API'er,
 * matcher policer mod aktiver, og returnerer struktureret gap-rapport.
 *
 * Input: { kundeType, kundeId, policer[] }
 * Output: { aktiver[], gaps[], score, summary }
 *
 * @retention Ingen PII persisteres — ren beregning.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { assertAiAllowed } from '@/app/lib/aiGate';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { logger } from '@/app/lib/logger';
import type { ForsikringsType, ParsedPolice } from '@/app/lib/parsePoliceFile';

export const maxDuration = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input body — enten policer-array ELLER fritekst (BIZZ-1280) */
interface GapAnalyseBody {
  kundeType: 'person' | 'virksomhed';
  kundeId: string;
  policer?: ParsedPolice[];
  /** BIZZ-1280: Fritekst med forsikringsbeskrivelse — parser server-side */
  fritekst?: string;
}

/** Et fundet aktiv fra BizzAssist data */
export interface FundetAktiv {
  id: string;
  type: 'ejendom' | 'køretøj' | 'virksomhed' | 'bestyrelsespost';
  label: string;
  /** Vurdering/værdi i DKK */
  vaerdi: number | null;
  /** Adresse eller identifikation */
  adresse: string | null;
  /** BFE-nummer (ejendomme) */
  bfe: number | null;
  /** CVR-nummer (virksomheder) */
  cvr: string | null;
  /** Risikofaktorer */
  risikofaktorer: string[];
  /** Matchende police (null = uforsikret) */
  matchetPolice: ParsedPolice | null;
}

/** Et gap i forsikringsdækningen */
export interface ForsikringsGap {
  aktiv: FundetAktiv;
  gapType: 'uforsikret' | 'underforsikret' | 'manglende_ansvar' | 'risiko';
  risikoScore: 'lav' | 'middel' | 'hoej';
  besked: string;
  anbefaletDaekning: number | null;
}

/** Samlet resultat */
export interface GapAnalyseResult {
  aktiver: FundetAktiv[];
  gaps: ForsikringsGap[];
  summary: {
    totalAktiver: number;
    forsikrede: number;
    uforsikrede: number;
    underforsikrede: number;
    risikoAktiver: number;
    samletVaerdi: number;
    samletDaekning: number;
  };
}

// ─── BIZZ-1280: Fritekst-parsing ────────────────────────────────────────────

/** Keyword→type mapping for simpel fritekst-parsing */
const FRITEKST_TYPE_MAP: Array<{ keywords: string[]; type: ForsikringsType }> = [
  { keywords: ['hus', 'villa', 'parcelhus', 'bolig', 'ejerlejlighed'], type: 'husforsikring' },
  { keywords: ['bygning', 'erhvervsejendom', 'ejendom'], type: 'bygningsforsikring' },
  { keywords: ['indbo', 'løsøre', 'bohave'], type: 'indboforsikring' },
  { keywords: ['bil', 'køretøj', 'auto', 'kasko', 'motor'], type: 'bilforsikring' },
  { keywords: ['erhverv', 'driftstab', 'varelager'], type: 'erhvervsforsikring' },
  { keywords: ['ansvar', 'erstatning', 'liability'], type: 'ansvarsforsikring' },
  { keywords: ['bestyrelse', 'd&o', 'directors'], type: 'bestyrelsesansvar' },
  { keywords: ['arbejdsskade', 'arbejdsulykke'], type: 'arbejdsskadeforsikring' },
  { keywords: ['rejse', 'udland'], type: 'rejseforsikring' },
  { keywords: ['liv', 'pension', 'død'], type: 'livsforsikring' },
];

/**
 * Parser fritekst til policer via keyword-matching.
 * Splitter på linjer/sætninger og matcher mod kendte forsikringstyper.
 *
 * @param tekst - Fritekst med forsikringsbeskrivelse
 * @returns Array af parsed policer
 */
function parseFritekstTilPolicer(tekst: string): ParsedPolice[] {
  const policer: ParsedPolice[] = [];
  const linjer = tekst
    .split(/[\n;,]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let idx = 0; idx < linjer.length; idx++) {
    const linje = linjer[idx];
    const lower = linje.toLowerCase();
    let matchedType: ForsikringsType = 'andet';
    for (const { keywords, type } of FRITEKST_TYPE_MAP) {
      if (keywords.some((kw) => lower.includes(kw))) {
        matchedType = type;
        break;
      }
    }

    // Forsøg at finde beløb (dækningssum)
    const beloebMatch = linje.match(/(\d[\d.]*)\s*(?:kr|dkk|mio)/i);
    let daekningssum: number | null = null;
    if (beloebMatch) {
      const raw = beloebMatch[1].replace(/\./g, '');
      daekningssum = parseInt(raw, 10);
      if (lower.includes('mio')) daekningssum *= 1_000_000;
    }

    policer.push({
      type: matchedType,
      rawType: linje.slice(0, 100),
      daekningssum,
      selskab: null,
      objekt: null,
      policenummer: null,
      udloebsdato: null,
      linje: idx + 1,
    });
  }

  // Dedup: kun én police per type
  const seen = new Set<string>();
  return policer.filter((p) => {
    if (seen.has(p.type)) return false;
    seen.add(p.type);
    return true;
  });
}

// ─── Aktiv-hentning ─────────────────────────────────────────────────────────

/**
 * Henter alle aktiver for en kunde via interne API-routes.
 *
 * Person-flow:
 *   1. /api/ejerskab/person-bridge → navn + fødselsdato
 *   2. /api/ejerskab/person-properties → BFE-numre
 *   3. /api/bfe-addresses → adresser per BFE
 *   4. /api/cvr-public/person → virksomheder + bestyrelsesposter
 *
 * Virksomhed-flow:
 *   1. /api/ejendomme-by-owner → ejendomme ejet af CVR
 *   2. /api/tinglysning/bilbog → køretøjer
 *
 * @param kundeType - person eller virksomhed
 * @param kundeId - enhedsNummer eller CVR
 * @param host - Request host for intern fetch
 * @param cookie - Cookie header for auth
 * @returns Array af fundne aktiver
 */
async function hentAktiver(
  kundeType: string,
  kundeId: string,
  host: string,
  cookie: string
): Promise<FundetAktiv[]> {
  const base = host.startsWith('localhost') ? `http://${host}` : `https://${host}`;
  const headers = { cookie };
  const aktiver: FundetAktiv[] = [];

  if (kundeType === 'person') {
    // Step 1: Brug person-bridge til at få navn + fødselsdato fra enhedsNummer
    let personNavn = '';
    let foedselsdato = '';
    try {
      const bridgeRes = await fetch(`${base}/api/ejerskab/person-bridge?enhedsNummer=${kundeId}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (bridgeRes.ok) {
        const bridge = await bridgeRes.json();
        personNavn = bridge.navn ?? '';
        foedselsdato = bridge.foedselsdato ?? '';
      }
    } catch (err) {
      logger.warn('[forsikring-gap] person-bridge fejlede:', err);
    }

    // Step 2+3: Hent ejendomme (kræver navn + fdato) OG virksomheder parallelt
    const [ejdResult, virkResult] = await Promise.allSettled([
      // Ejendomme via person-properties → bfe-addresses
      (async () => {
        if (!personNavn || !foedselsdato) return;
        const ppRes = await fetch(
          `${base}/api/ejerskab/person-properties?navn=${encodeURIComponent(personNavn)}&fdato=${foedselsdato}`,
          { headers, signal: AbortSignal.timeout(10000) }
        );
        if (!ppRes.ok) return;
        const ppData = await ppRes.json();
        const bfes: number[] =
          ppData?.bfes ?? ppData?.properties?.map((p: { bfeNummer: number }) => p.bfeNummer) ?? [];
        if (bfes.length === 0) return;

        // Berig med adresser
        const addrRes = await fetch(`${base}/api/bfe-addresses`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ bfes: bfes.slice(0, 50) }),
          signal: AbortSignal.timeout(10000),
        });
        const addrMap: Record<number, string> = {};
        if (addrRes.ok) {
          const addrData = await addrRes.json();
          for (const a of addrData?.addresses ?? []) {
            addrMap[a.bfe] = a.adresse;
          }
        }

        for (const bfe of bfes) {
          aktiver.push({
            id: `ejendom-${bfe}`,
            type: 'ejendom',
            label: addrMap[bfe] ?? `BFE ${bfe}`,
            vaerdi: null,
            adresse: addrMap[bfe] ?? null,
            bfe,
            cvr: null,
            risikofaktorer: [],
            matchetPolice: null,
          });
        }
      })(),
      // Virksomheder via cvr-public/person
      (async () => {
        const virkRes = await fetch(`${base}/api/cvr-public/person?enhedsNummer=${kundeId}`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!virkRes.ok) return;
        const data = await virkRes.json();
        for (const v of data?.virksomheder ?? []) {
          // Virksomheder personen ejer → erhvervsforsikring-gap
          aktiver.push({
            id: `virksomhed-${v.cvr}`,
            type: 'virksomhed',
            label: `${v.navn} (CVR ${v.cvr})`,
            vaerdi: null,
            adresse: null,
            bfe: null,
            cvr: String(v.cvr),
            risikofaktorer: [],
            matchetPolice: null,
          });
          // Bestyrelsesposter → D&O ansvarsforsikring-gap
          const harBestyrelseRolle = v.roller?.some((r: { rolle: string }) =>
            /bestyrelse|direktion/i.test(r.rolle)
          );
          if (harBestyrelseRolle) {
            aktiver.push({
              id: `bestyrelsespost-${v.cvr}`,
              type: 'bestyrelsespost',
              label: `${v.navn} (${v.roller.map((r: { rolle: string }) => r.rolle).join(', ')})`,
              vaerdi: null,
              adresse: null,
              bfe: null,
              cvr: String(v.cvr),
              risikofaktorer: [],
              matchetPolice: null,
            });
          }
        }
      })(),
    ]);

    if (ejdResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Ejendom-hentning fejlede:', ejdResult.reason);
    }
    if (virkResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Virksomhed-hentning fejlede:', virkResult.reason);
    }
  } else {
    // Virksomhed: hent ejendomme ejet af CVR + køretøjer parallelt
    const [ejdResult, bilResult] = await Promise.allSettled([
      (async () => {
        const res = await fetch(`${base}/api/ejendomme-by-owner?cvr=${kundeId}`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return;
        const data = await res.json();
        for (const p of data?.ejendomme ?? []) {
          aktiver.push({
            id: `ejendom-${p.bfe}`,
            type: 'ejendom',
            label: p.adresse ?? `BFE ${p.bfe}`,
            vaerdi: p.vurdering ?? null,
            adresse: p.adresse ?? null,
            bfe: p.bfe,
            cvr: null,
            risikofaktorer: [],
            matchetPolice: null,
          });
        }
      })(),
      (async () => {
        const res = await fetch(`${base}/api/tinglysning/bilbog?cvr=${kundeId}`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return;
        const data = await res.json();
        for (const bil of data?.biler ?? []) {
          aktiver.push({
            id: `koeretoej-${bil.uuid}`,
            type: 'køretøj',
            label: [bil.fabrikat, bil.aargang, bil.registreringsnummer].filter(Boolean).join(' '),
            vaerdi: null,
            adresse: bil.registreringsnummer ?? bil.stelnummer ?? null,
            bfe: null,
            cvr: null,
            risikofaktorer: [],
            matchetPolice: null,
          });
        }
      })(),
    ]);

    if (ejdResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Ejendom-hentning fejlede:', ejdResult.reason);
    }
    if (bilResult.status === 'rejected') {
      logger.warn('[forsikring-gap] Bilbog-hentning fejlede:', bilResult.reason);
    }
  }

  return aktiver;
}

// ─── Gap-detektion ──────────────────────────────────────────────────────────

/** Mapper aktiv-type til relevante forsikringstyper */
const AKTIV_TIL_FORSIKRING: Record<string, ForsikringsType[]> = {
  ejendom: ['husforsikring', 'bygningsforsikring', 'indboforsikring'],
  køretøj: ['bilforsikring'],
  virksomhed: ['erhvervsforsikring', 'ansvarsforsikring'],
  bestyrelsespost: ['bestyrelsesansvar'],
};

/**
 * Matcher policer mod aktiver og identificerer gaps.
 *
 * @param aktiver - Fundne aktiver fra BizzAssist
 * @param policer - Kundens eksisterende policer
 * @returns Gaps med risiko-scoring
 */
function detectGaps(aktiver: FundetAktiv[], policer: ParsedPolice[]): ForsikringsGap[] {
  const gaps: ForsikringsGap[] = [];

  for (const aktiv of aktiver) {
    const relevantTypes = AKTIV_TIL_FORSIKRING[aktiv.type] ?? [];

    // Find matchende police — prioriter specifik objekt-match, ellers type-match.
    // En police UDEN objekt dækker alle aktiver af matchende type (fx "husforsikring"
    // dækker alle ejendomme). En police MED objekt dækker kun det specifikke aktiv.
    const match = policer.find((p) => {
      if (!relevantTypes.includes(p.type)) return false;
      // Specifik objekt-match: kun match hvis adresse/regnr matcher
      if (p.objekt && aktiv.adresse) {
        const pObj = p.objekt.toLowerCase();
        const aAddr = aktiv.adresse.toLowerCase();
        return pObj.includes(aAddr) || aAddr.includes(pObj);
      }
      // Generel type-match: policen dækker denne aktiv-type
      return true;
    });

    if (match) {
      aktiv.matchetPolice = match;
      // Tjek for underforsikring — kun relevant når vi har vurdering + dækningssum
      if (aktiv.vaerdi && match.daekningssum && match.daekningssum < aktiv.vaerdi * 0.8) {
        gaps.push({
          aktiv,
          gapType: 'underforsikret',
          risikoScore: match.daekningssum < aktiv.vaerdi * 0.5 ? 'hoej' : 'middel',
          besked: `Dækningssum ${match.daekningssum?.toLocaleString('da-DK')} DKK er under 80% af vurdering ${aktiv.vaerdi.toLocaleString('da-DK')} DKK`,
          anbefaletDaekning: aktiv.vaerdi,
        });
      }
    } else {
      // Uforsikret
      gaps.push({
        aktiv,
        gapType: aktiv.type === 'bestyrelsespost' ? 'manglende_ansvar' : 'uforsikret',
        risikoScore: aktiv.vaerdi && aktiv.vaerdi > 1_000_000 ? 'hoej' : 'middel',
        besked:
          aktiv.type === 'bestyrelsespost'
            ? `Bestyrelsespost i ${aktiv.label} uden D&O-forsikring`
            : `${aktiv.label} er ikke dækket af nogen forsikringspolice`,
        anbefaletDaekning: aktiv.vaerdi,
      });
    }

    // Risikofaktorer tilføjes til aktiv
    if (aktiv.risikofaktorer.length > 0) {
      gaps.push({
        aktiv,
        gapType: 'risiko',
        risikoScore: 'middel',
        besked: `Risikofaktorer: ${aktiv.risikofaktorer.join(', ')}`,
        anbefaletDaekning: null,
      });
    }
  }

  return gaps.sort((a, b) => {
    const score = { hoej: 3, middel: 2, lav: 1 };
    return score[b.risikoScore] - score[a.risikoScore];
  });
}

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * POST handler — forsikrings-gap-analyse.
 *
 * @param request - POST med kundeId + policer
 * @returns GapAnalyseResult
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await assertAiAllowed(auth.userId);
  if (blocked) return blocked as NextResponse;

  let body: GapAnalyseBody;
  try {
    body = (await request.json()) as GapAnalyseBody;
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  if (!body.kundeId || !body.kundeType) {
    return NextResponse.json({ error: 'Mangler kundeType eller kundeId' }, { status: 400 });
  }

  // BIZZ-1280: Enten policer-array eller fritekst er required
  if (!body.policer?.length && !body.fritekst?.trim()) {
    return NextResponse.json({ error: 'Mangler policer eller fritekst' }, { status: 400 });
  }

  try {
    const host = request.headers.get('host') ?? 'localhost:3000';
    const cookie = request.headers.get('cookie') ?? '';

    // BIZZ-1280: Parse fritekst til policer via simple pattern matching
    let policer = body.policer ?? [];
    if (policer.length === 0 && body.fritekst?.trim()) {
      policer = parseFritekstTilPolicer(body.fritekst.trim());
    }

    // Hent aktiver
    const aktiver = await hentAktiver(body.kundeType, body.kundeId, host, cookie);

    // Detect gaps
    const gaps = detectGaps(aktiver, policer);

    // Summary
    const forsikrede = aktiver.filter((a) => a.matchetPolice).length;
    const uforsikrede = gaps.filter(
      (g) => g.gapType === 'uforsikret' || g.gapType === 'manglende_ansvar'
    ).length;
    const underforsikrede = gaps.filter((g) => g.gapType === 'underforsikret').length;
    const risikoAktiver = gaps.filter((g) => g.gapType === 'risiko').length;
    const samletVaerdi = aktiver.reduce((s, a) => s + (a.vaerdi ?? 0), 0);
    const samletDaekning = (body.policer ?? []).reduce((s, p) => s + (p.daekningssum ?? 0), 0);

    const result: GapAnalyseResult = {
      aktiver,
      gaps,
      summary: {
        totalAktiver: aktiver.length,
        forsikrede,
        uforsikrede,
        underforsikrede,
        risikoAktiver,
        samletVaerdi,
        samletDaekning,
      },
    };

    return NextResponse.json(result);
  } catch (err) {
    logger.error('[forsikring-gap] Fejl:', err);
    return NextResponse.json({ error: 'Ekstern API fejl' }, { status: 500 });
  }
}
