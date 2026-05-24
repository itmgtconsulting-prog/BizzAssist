/**
 * GET /api/ejerskab/chain?bfe=100165718&adresse=Thorvald+Bindesbølls+Plads+18
 *
 * Resolver ejerskabskæden for en ejendom:
 *   1. Henter adkomst-ejere fra Tinglysning (summarisk XML) — primær kilde med navn, adkomsttype, CVR m.m.
 *   2. For virksomhedsejere med CVR → henter ejere fra CVR ES (rekursivt op til 3 niveauer)
 *   3. Returnerer en flad graf (nodes + edges) klar til DiagramForce
 *
 * EJF (Datafordeler Ejerfortegnelse) bruges som fallback når Tinglysning
 * ikke returnerer faktiske ejere (typisk for ejerlejligheder hvor
 * Tinglysning kun viser "Opdelt i ejerlejligheder" som status).
 *
 * Node-typer: property (grøn), company (blå), person (lilla)
 *
 * @param bfe - BFE-nummer
 * @param adresse - Ejendomsadresse (til visning)
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { buildChainCacheKey, getCached, setCached } from '@/app/lib/ejerskab/cache';
import { fetchEjfEjereDirekt } from '@/app/lib/ejerskab/fetchEjfEjereDirekt';
import { fetchTlEjereDirekt } from '@/app/lib/tinglysning/fetchTlEjere';
import { logger } from '@/app/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Resolve the label for the root property node in the ejerskab diagram.
 *
 * The client-side code that composes the `adresse` query param for this
 * route sometimes produces strings that are only commas and whitespace
 * (e.g. `" , , "`) when the DAR/DAWA lookup returned an address with
 * missing fields. Rendering such a string in the diagram produces a blank
 * node box. Falling back to `BFE <nr>` makes the node always carry
 * meaningful text.
 *
 * Exported so it can be unit-tested in isolation.
 *
 * @param adresse - Address string supplied by the caller (may be empty)
 * @param bfe     - BFE number for the property (used as fallback identifier)
 */
export function resolvePropertyLabel(adresse: string, bfe: string | number): string {
  const trimmed = (adresse ?? '').replace(/[\s,]+/g, ' ').trim();
  if (trimmed.length > 0) return adresse;
  return `BFE ${bfe}`;
}

interface ChainNode {
  id: string;
  label: string;
  type: 'property' | 'company' | 'person' | 'status';
  cvr?: number;
  enhedsNummer?: number;
  ejerandel?: string;
  link?: string;
  /** True when the company has a slutdato / sammensatStatus "Ophørt" — shown greyed out in diagrams */
  isCeased?: boolean;
  /**
   * BFE number on property nodes — lets the diagram render a `BFE 12345` line
   * even when the address is missing or empty, so the root property node is
   * never a blank box (bug seen on Ejerskab tab 2026-04-18).
   */
  bfeNummer?: number;
}

/**
 * Status-tekster fra Tinglysning der ikke er faktiske ejere.
 *
 * BIZZ-726: Udvidet til regex så alle varianter rammes — "Opdelt i anpart 1-2"
 * (uden "ideelle") slap tidligere igennem filteret og blev fejlagtigt vist som
 * privatperson-ejer på ejendommens ejerskabs-tab. Dækker nu:
 *   - opdelt i ejerlejlighed / ejerlejligheder (med eller uden nr.-range)
 *   - opdelt i (ideel|ideelle)? anpart / anparter (med eller uden nr.-range)
 *   - del af samlet ejendom
 */
export const STATUS_TEKST_RE =
  /^\s*(opdelt i (ejerlejlighed(er)?|(ideel(le)? )?anpart(er)?)|del af samlet ejendom)\b/i;

interface ChainEdge {
  from: string;
  to: string;
  ejerandel?: string;
}

export interface ChainEjerDetalje {
  navn: string;
  cvr: string | null;
  enhedsNummer: number | null;
  type: 'person' | 'selskab' | 'status' | 'pvoplys';
  andel: string | null;
  adresse: string | null;
  overtagelsesdato: string | null;
  adkomstType: string | null;
  koebesum: number | null;
  /** True when the owning company is ceased/dissolved — shown as warning in UI */
  isCeased?: boolean;
  /**
   * BIZZ-482: PV-oplys-felter for dødsboer, udenlandske ejere, fonde m.m.
   * Kun sat når typen er 'pvoplys'. fiktivtPVnummer bruges til link til
   * dedikeret detaljeside (se BIZZ-483).
   */
  fiktivtPVnummer?: string | null;
  landekode?: string | null;
  udlandsadresse?: string | null;
  administrator?: string | null;
}

export interface OwnershipChainResponse {
  nodes: ChainNode[];
  edges: ChainEdge[];
  mainId: string;
  ejerDetaljer: ChainEjerDetalje[];
  fejl: string | null;
  /** BIZZ-1582: True when there are company owners that could be expanded
   *  to deeper levels (current depth < MAX_DEPTH). UI shows "Udvid" button. */
  hasMore?: boolean;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';
/** BIZZ-1582: Default depth 2 (saves 400-800ms per ekstra niveau).
 *  Klienten kan bede om depth=3 via "Udvid ejerkæde"-knap. */
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

type Periodic = { periode?: { gyldigFra?: string | null; gyldigTil?: string | null } };

function gyldigNu<T extends Periodic>(arr: T[]): T | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.find((x) => x.periode?.gyldigTil == null) ?? arr[arr.length - 1];
}

/** Mapper ejerandel decimal til interval-streng */
function mapEjerandel(val: number): string {
  if (val >= 1) return '100%';
  if (val >= 0.9) return '90-100%';
  if (val >= 0.6667) return '66.67-90%';
  if (val >= 0.5) return '50-66.67%';
  if (val >= 0.3334) return '33.34-50%';
  if (val >= 0.1) return '10-33.33%';
  if (val >= 0.05) return '5-10%';
  return '<5%';
}

/**
 * Henter ejere og ophørsstatus af en virksomhed fra CVR ES.
 *
 * @param cvr - CVR-nummer at slå op
 * @returns Virksomhedsnavn, ejere og om virksomheden er ophørt
 */
async function fetchCompanyOwners(cvr: number): Promise<{
  companyName: string;
  isCeased: boolean;
  owners: {
    navn: string;
    enhedsNummer: number;
    /**
     * BIZZ-564 v3: CVR-nummer (kun for virksomheder). For deltager-virksomheder
     * er enhedsNummer en intern 10-cifret CVR-ES-id som IKKE kan bruges til
     * cvrNummer-opslag. Den rigtige CVR ligger i deltager.forretningsnoegle
     * — uden denne kunne recursion ikke forfølge ejerkæden videre op.
     */
    cvrNummer: number | null;
    erVirksomhed: boolean;
    ejerandel: string | null;
  }[];
}> {
  if (!CVR_ES_USER || !CVR_ES_PASS)
    return { companyName: `CVR ${cvr}`, isCeased: false, owners: [] };

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
  const query = {
    query: { term: { 'Vrvirksomhed.cvrNummer': cvr } },
    _source: [
      'Vrvirksomhed.navne',
      'Vrvirksomhed.deltagerRelation',
      // BIZZ-357: Fetch status fields to detect ceased companies
      'Vrvirksomhed.livsforloeb',
      'Vrvirksomhed.virksomhedMetadata',
    ],
    size: 1,
  };

  try {
    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { companyName: `CVR ${cvr}`, isCeased: false, owners: [] };

    const data = await res.json();
    const hit = data?.hits?.hits?.[0]?._source?.Vrvirksomhed;
    if (!hit) return { companyName: `CVR ${cvr}`, isCeased: false, owners: [] };

    // Virksomhedsnavn
    const navne = Array.isArray(hit.navne) ? (hit.navne as (Periodic & { navn?: string })[]) : [];
    const companyName = gyldigNu(navne)?.navn ?? `CVR ${cvr}`;

    // BIZZ-357: Detect ceased companies via livsforloeb slutdato or sammensatStatus "Ophørt"
    // Mirrors the logic in /api/cvr-public/related/route.ts mapHitToVirksomhed
    const livsforloeb = Array.isArray(hit.livsforloeb) ? (hit.livsforloeb as Periodic[]) : [];
    const harSlutdato = livsforloeb.some((l) => l.periode?.gyldigTil != null);
    const meta = hit.virksomhedMetadata as Record<string, unknown> | undefined;
    const sammensatStatus = typeof meta?.sammensatStatus === 'string' ? meta.sammensatStatus : '';
    const isCeased = harSlutdato || sammensatStatus === 'Ophørt';

    // Ejere fra deltagerRelation
    const owners: {
      navn: string;
      enhedsNummer: number;
      cvrNummer: number | null;
      erVirksomhed: boolean;
      ejerandel: string | null;
    }[] = [];
    const relationer = Array.isArray(hit.deltagerRelation) ? hit.deltagerRelation : [];

    for (const rel of relationer) {
      const deltager = rel.deltager as Record<string, unknown> | undefined;
      if (!deltager) continue;

      const enhedsNummer = typeof deltager.enhedsNummer === 'number' ? deltager.enhedsNummer : null;
      if (!enhedsNummer) continue;

      const erVirksomhed =
        typeof deltager.enhedstype === 'string' && deltager.enhedstype !== 'PERSON';
      const dNavne = Array.isArray(deltager.navne)
        ? (deltager.navne as (Periodic & { navn?: string })[])
        : [];
      const navn = gyldigNu(dNavne)?.navn;
      if (!navn) continue;

      // BIZZ-564 v3: For virksomheds-deltagere er forretningsnoegle CVR-nr
      // (8-cifret). enhedsNummer er CVR-ES intern 10-cifret id og kan IKKE
      // bruges til at slå virksomheden op via cvrNummer-term-query. Uden
      // denne mapping stopper recursion fordi det "fake CVR" returnerer 0
      // hits når næste fetchCompanyOwners-iteration kører.
      const forretningsnoegle =
        typeof deltager.forretningsnoegle === 'number'
          ? deltager.forretningsnoegle
          : typeof deltager.forretningsnoegle === 'string'
            ? parseInt(deltager.forretningsnoegle, 10)
            : null;
      const cvrNummer = erVirksomhed && forretningsnoegle ? forretningsnoegle : null;

      // Check for ejer-roller
      const orgs = Array.isArray(rel.organisationer)
        ? (rel.organisationer as Record<string, unknown>[])
        : [];
      let erEjer = false;
      let ejerandel: string | null = null;

      for (const org of orgs) {
        const orgNavne = Array.isArray(org.organisationsNavn)
          ? (org.organisationsNavn as (Periodic & { navn?: string })[])
          : [];
        // BIZZ-564 v2: Reel ejer (RBE) er KAP-anmeldelse og IKKE legalt ejerskab.
        // Bemærk: orgNavne.periode.gyldigTil er ALTID null (CVR ES bruger kun
        // perioden på orgNavn til at tracke navne-ændringer, ikke ejer-status).
        // Den reelle ejer-status check sker via medlemsData attributter (vaerdier)
        // hvor vi tjekker om ejerandel-vaerdi har en aktiv (gyldigTil=null) entry.
        const erRolleType = orgNavne.some((n) => {
          const upper = n.navn?.toUpperCase() ?? '';
          if (!upper) return false;
          if (upper.includes('REEL')) return false; // RBE — ikke legalt ejerskab
          return upper.includes('EJER') || upper.includes('LEGALE');
        });
        if (!erRolleType) continue;

        // Find ejerandel + AKTIV-check via medlemsData attributter.
        // BIZZ-564 v2: Hvis EJERANDEL_PROCENT har vaerdier hvor ALLE er udløbet
        // (alle gyldigTil != null), er ejerskabet historisk og skal IKKE med.
        // Hvis mindst én vaerdi har gyldigTil = null → aktiv ejer.
        const medlemsData = Array.isArray(org.medlemsData)
          ? (org.medlemsData as Record<string, unknown>[])
          : [];
        let aktivEjerandel: string | null = null;
        let harEjerandelAttribut = false;
        for (const md of medlemsData) {
          const attrs = Array.isArray(md.attributter)
            ? (md.attributter as Record<string, unknown>[])
            : [];
          for (const attr of attrs) {
            if (attr.type === 'EJERANDEL_PROCENT') {
              harEjerandelAttribut = true;
              const vaerdier = Array.isArray(attr.vaerdier)
                ? (attr.vaerdier as (Periodic & { vaerdi?: number })[])
                : [];
              // Find AKTIV vaerdi (gyldigTil == null) — IKKE bare seneste
              const aktiv = vaerdier.find((v) => v.periode?.gyldigTil == null);
              if (aktiv?.vaerdi != null) {
                aktivEjerandel = mapEjerandel(
                  typeof aktiv.vaerdi === 'number' ? aktiv.vaerdi : parseFloat(String(aktiv.vaerdi))
                );
              }
            }
          }
        }
        // Aktiv ejer-criteria:
        //   1. Ingen EJERANDEL_PROCENT-attributter → fallback: behandl som aktiv
        //      (sjælden case, men nogle ejer-typer fx INTERESSENTER har ikke
        //      eksplicit ejerandel-kvantificering)
        //   2. Har EJERANDEL_PROCENT MEN ingen aktiv vaerdi → historisk → skip
        //   3. Har aktiv vaerdi → inkluder med den ejerandel
        if (harEjerandelAttribut && aktivEjerandel == null) {
          // Historisk ejer — skip helt
          continue;
        }
        erEjer = true;
        ejerandel = aktivEjerandel;
      }

      if (erEjer) {
        owners.push({ navn, enhedsNummer, cvrNummer, erVirksomhed, ejerandel });
      }
    }

    return { companyName, isCeased, owners };
  } catch {
    return { companyName: `CVR ${cvr}`, isCeased: false, owners: [] };
  }
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bfe = req.nextUrl.searchParams.get('bfe');
  const adresse = req.nextUrl.searchParams.get('adresse') ?? 'Ejendom';
  /**
   * BIZZ-470: Klienten sender type=ejerlejlighed når ejendommen er en
   * ejerlejlighed. I så fald springer vi Tinglysning-kaldene over — for
   * ejerlejligheder returnerer Tinglysning-adkomst typisk kun "Opdelt i
   * ejerlejligheder" som status, og de faktiske ejere ligger alligevel i
   * EJF. At undvære de to sekventielle Tinglysning-runde-trips (search +
   * summarisk XML) sparer ~2-4 sek på koldstart.
   */
  const ejendomstypeHint = (req.nextUrl.searchParams.get('type') ?? '').toLowerCase();
  const skipTinglysning = ejendomstypeHint.includes('ejerlejlighed');
  /** BIZZ-1582: Klient-styret depth (default 2, max 3). Reducer latency
   *  ved at begrænse CVR ES recursion-niveauer for standardvisning. */
  const requestedDepth = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get('depth') ?? '', 10) || DEFAULT_DEPTH, 1),
    MAX_DEPTH
  );

  if (!bfe) {
    return NextResponse.json({ nodes: [], edges: [], mainId: '', fejl: 'bfe er påkrævet' });
  }

  // BIZZ-1582: Server-side cache. Hit returnerer payload uden eksterne
  // API-kald (Tinglysning + CVR ES + EJF tager 1.5-5s; cache-hit <100ms).
  // Klient-cache (HTTP s-maxage) blev kun delt per browser; denne deles
  // på tværs af brugere via Supabase.
  const cacheKey = buildChainCacheKey(bfe, ejendomstypeHint) + `:d${requestedDepth}`;
  const cached = await getCached<OwnershipChainResponse>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=600',
        'X-Cache': 'HIT',
      },
    });
  }

  const nodes: ChainNode[] = [];
  const edges: ChainEdge[] = [];
  const seenIds = new Set<string>();
  const mainId = `bfe-${bfe}`;

  // Ejendomsnode (grøn). Fallback-label håndteres af resolvePropertyLabel:
  // hvis klientens adresse-streng er tom eller kun kommaer/mellemrum, brug
  // `BFE <nr>` så noden aldrig renderes som en blank kasse.
  nodes.push({
    id: mainId,
    label: resolvePropertyLabel(adresse, bfe),
    type: 'property',
    bfeNummer: Number(bfe) || undefined,
  });
  seenIds.add(mainId);

  // ── CACHE-FIRST: Byg chain fra ejf_ejerskab + cvr_deltager (< 200ms) ──
  // Springer Tinglysning S2S + EJF GraphQL over. Kun fallback til live
  // API hvis cache er tom (ny ejendom uden backfill).
  const companyOwnersToResolve: { nodeId: string; cvr: number; depth: number }[] = [];
  const ejerDetaljer: ChainEjerDetalje[] = [];
  const tlPersonsToResolve: { navn: string | undefined; nodeIdx: number; detaljeIdx: number }[] =
    [];
  const ejfPersonsToResolve: { navn: string; nodeIdx: number; detaljeIdx: number }[] = [];

  let usedCachePath = false;
  try {
    const admin = (await import('@/lib/supabase/admin')).createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cachedEjere } = await (admin as any)
      .from('ejf_ejerskab')
      .select(
        'ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, virkning_fra, ejer_enheds_nummer'
      )
      .eq('bfe_nummer', Number(bfe))
      .eq('status', 'gældende')
      .limit(20);

    if (cachedEjere && cachedEjere.length > 0) {
      usedCachePath = true;

      // Hent købesum fra ejf_ejerskifte + handelsoplysninger (parallel)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: ejerskifter } = await (admin as any)
        .from('ejf_ejerskifte')
        .select('overtagelsesdato, overdragelsesmaade, handelsoplysninger_lokal_id')
        .eq('bfe_nummer', Number(bfe))
        .eq('status', 'gældende')
        .order('overtagelsesdato', { ascending: false })
        .limit(5);

      let koebesum: number | null = null;
      let overtagelsesdato: string | null = null;
      let adkomstType: string | null = null;
      if (ejerskifter?.length > 0) {
        const es = ejerskifter[0] as Record<string, unknown>;
        overtagelsesdato = (es.overtagelsesdato as string) ?? null;
        adkomstType = (es.overdragelsesmaade as string) ?? null;
        const hId = es.handelsoplysninger_lokal_id as string | null;
        if (hId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: handel } = await (admin as any)
            .from('ejf_handelsoplysninger')
            .select('kontant_koebesum')
            .eq('id_lokal_id', hId)
            .maybeSingle();
          koebesum = (handel?.kontant_koebesum as number) ?? null;
        }
      }

      for (const row of cachedEjere as Array<Record<string, unknown>>) {
        const cvr = row.ejer_cvr as string | null;
        const navn = (row.ejer_navn as string) ?? 'Ukendt';
        const type = (row.ejer_type as string) ?? 'ukendt';
        const t = row.ejerandel_taeller as number | null;
        const n = row.ejerandel_naevner as number | null;
        const andel = t != null && n != null && n > 0 ? `${Math.round((t / n) * 100)}%` : null;
        const enhNr = row.ejer_enheds_nummer as number | null;

        if (cvr) {
          const id = `cvr-${cvr}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            nodes.push({
              id,
              label: navn,
              type: 'company',
              cvr: parseInt(cvr, 10),
              link: `/dashboard/companies/${cvr}`,
            });
            companyOwnersToResolve.push({ nodeId: id, cvr: parseInt(cvr, 10), depth: 0 });
          }
          edges.push({ from: id, to: mainId, ejerandel: andel ?? undefined });
          ejerDetaljer.push({
            navn,
            cvr,
            enhedsNummer: null,
            type: 'selskab',
            andel,
            adresse: null,
            overtagelsesdato,
            adkomstType,
            koebesum,
          });
        } else {
          const id = enhNr ? `en-${enhNr}` : `person-${nodes.length}`;
          if (!seenIds.has(id)) {
            seenIds.add(id);
            /* BIZZ-1826: Person-ejere uden enhedsNummer (fra ejf_ejerskab cache)
               får et søge-link fallback så diagrammet også linker til personen. */
            const personLink = enhNr
              ? `/dashboard/owners/${enhNr}`
              : `/dashboard?q=${encodeURIComponent(navn)}`;
            nodes.push({
              id,
              label: navn,
              type: type === 'person' ? 'person' : 'status',
              enhedsNummer: enhNr ?? undefined,
              link: type === 'person' ? personLink : undefined,
            });
          }
          edges.push({ from: id, to: mainId, ejerandel: andel ?? undefined });
          ejerDetaljer.push({
            navn,
            cvr: null,
            enhedsNummer: enhNr,
            type: type === 'person' ? 'person' : 'status',
            andel,
            adresse: null,
            overtagelsesdato,
            adkomstType,
            koebesum,
          });
        }
      }
      logger.log(
        `[chain] CACHE-PATH: ${cachedEjere.length} ejere for BFE ${bfe} (skip TL+EJF live)`
      );
    }
  } catch (err) {
    logger.warn(
      '[chain] Cache-path fejl, falder til live:',
      err instanceof Error ? err.message : err
    );
  }

  // Kun kald live API hvis cache-path ikke fandt data
  const ejfPromise = usedCachePath
    ? Promise.resolve(null)
    : fetchEjfEjereDirekt(Number(bfe)).catch(() => null);

  // Trin 1: Prøv Tinglysning API — SKIP hvis cache-path allerede fandt ejere.
  // BIZZ-470: For ejerlejligheder springer vi også over.
  if (!usedCachePath && !skipTinglysning)
    try {
      const tlResult = await fetchTlEjereDirekt(bfe);
      if (tlResult.ejere.length > 0) {
        const ejere = tlResult.ejere;
        for (const ejer of ejere) {
          if (ejer.cvr) {
            const id = `cvr-${ejer.cvr}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              nodes.push({
                id,
                label: ejer.navn || `CVR ${ejer.cvr}`,
                type: 'company',
                cvr: parseInt(ejer.cvr, 10),
                link: `/dashboard/companies/${ejer.cvr}`,
              });
              companyOwnersToResolve.push({
                nodeId: id,
                cvr: parseInt(ejer.cvr, 10),
                depth: 0,
              });
            }
            edges.push({ from: id, to: mainId, ejerandel: ejer.andel ?? undefined });
            ejerDetaljer.push({
              navn: ejer.navn,
              cvr: ejer.cvr,
              enhedsNummer: null,
              type: 'selskab',
              andel: ejer.andel,
              adresse: ejer.adresse ?? null,
              overtagelsesdato: ejer.overtagelsesdato ?? null,
              adkomstType: ejer.adkomstType ?? null,
              koebesum: ejer.koebesum ?? null,
            });
          } else {
            // Tjek om "ejeren" egentlig er en status-tekst (fx "Opdelt i ejerlejligheder")
            const erStatus = STATUS_TEKST_RE.test(ejer.navn ?? '');

            if (erStatus) {
              const id = `status-${nodes.length}`;
              nodes.push({ id, label: ejer.navn, type: 'status' });
              edges.push({ from: id, to: mainId });
              ejerDetaljer.push({
                navn: ejer.navn,
                cvr: null,
                enhedsNummer: null,
                type: 'status',
                andel: null,
                adresse: null,
                overtagelsesdato: null,
                adkomstType: null,
                koebesum: null,
              });
            } else {
              const id = `person-${nodes.length}`;
              // BIZZ-386: Push node immediately (without enhedsNummer) so id is stable,
              // then batch-resolve enhedsNummer for all persons after the loop.
              nodes.push({
                id,
                label: ejer.navn || 'Person',
                type: 'person',
              });
              edges.push({ from: id, to: mainId, ejerandel: ejer.andel ?? undefined });
              ejerDetaljer.push({
                navn: ejer.navn,
                cvr: null,
                type: 'person',
                andel: ejer.andel,
                adresse: ejer.adresse ?? null,
                overtagelsesdato: ejer.overtagelsesdato ?? null,
                adkomstType: ejer.adkomstType ?? null,
                koebesum: ejer.koebesum ?? null,
                enhedsNummer: null,
              });
              // Track node/detaljer indices so we can patch them after batch lookup
              tlPersonsToResolve.push({
                navn: ejer.navn,
                nodeIdx: nodes.length - 1,
                detaljeIdx: ejerDetaljer.length - 1,
              });
            }
          }
        }
      }

      // BIZZ-386: Batch-resolve enhedsNummer for all Tinglysning person owners in parallel
      if (tlPersonsToResolve.length > 0 && CVR_ES_USER && CVR_ES_PASS) {
        const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
        const results = await Promise.allSettled(
          tlPersonsToResolve.map(({ navn }) =>
            navn
              ? fetch(`${CVR_ES_BASE}/deltager/_search`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
                  body: JSON.stringify({
                    query: { match: { 'Vrdeltagerperson.navne.navn': navn } },
                    _source: ['Vrdeltagerperson.enhedsNummer'],
                    size: 1,
                  }),
                  signal: AbortSignal.timeout(5000),
                })
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null)
              : Promise.resolve(null)
          )
        );
        for (let i = 0; i < tlPersonsToResolve.length; i++) {
          const result = results[i];
          if (result.status !== 'fulfilled' || !result.value) continue;
          const enr = result.value?.hits?.hits?.[0]?._source?.Vrdeltagerperson?.enhedsNummer;
          if (typeof enr !== 'number') continue;
          const { nodeIdx, detaljeIdx } = tlPersonsToResolve[i];
          nodes[nodeIdx].enhedsNummer = enr;
          nodes[nodeIdx].link = `/dashboard/owners/${enr}`;
          ejerDetaljer[detaljeIdx].enhedsNummer = enr;
        }
      }
    } catch {
      /* Tinglysning valgfri */
    }

  // ── EJF fallback — bruges når Tinglysning ikke returnerer faktiske ejere ──
  // For ejerlejligheder returnerer Tinglysning typisk kun "Opdelt i ejerlejlighed"
  // som status-tekst, ikke de individuelle ejere. EJF (Ejerfortegnelsen) har de
  // korrekte ejere for den specifikke BFE.
  const harFaktiskeEjere = nodes.some((n) => n.type === 'company' || n.type === 'person');

  // BIZZ-329: Cross-reference with EJF to remove historical owners that Tinglysning
  // still reports. EJF uses virkningstid=nu so only has current owners.
  // BIZZ-1582: ejfPromise now returns EjfEjereResult directly (no HTTP overhead).
  // BIZZ-1745: Skip cross-ref when EJF cache er stale (ældre end TL-adkomst).
  // Tinglysning er autoritativ for nyere ejerskifter der ikke er synket til EJF endnu.
  if (harFaktiskeEjere) {
    try {
      const ejfResult = await ejfPromise;
      const ejfEjere = ejfResult?.ejere ?? [];

      // BIZZ-1745: Freshness check — find nyeste TL-overtagelsesdato og nyeste EJF-virkningFra.
      // Hvis TL har nyere ejere end EJF, skip cross-ref (EJF er stale).
      const tlDatoer = ejerDetaljer
        .filter((d) => d.overtagelsesdato)
        .map((d) => new Date(d.overtagelsesdato!).getTime());
      const nyesteTl = tlDatoer.length > 0 ? Math.max(...tlDatoer) : 0;
      const ejfDatoer = ejfEjere
        .filter((e) => e.virkningFra)
        .map((e) => new Date(e.virkningFra!).getTime());
      const nyesteEjf = ejfDatoer.length > 0 ? Math.max(...ejfDatoer) : 0;
      // Hvis TL er > 30 dage nyere end EJF, skip cross-ref
      const ejfErStale = nyesteTl > 0 && nyesteEjf > 0 && nyesteTl - nyesteEjf > 30 * 86400000;

      if (ejfEjere.length > 0 && !ejfErStale) {
        const ejfCvrs = new Set(ejfEjere.filter((e) => e.cvr).map((e) => e.cvr!));
        const ejfNames = new Set(
          ejfEjere.filter((e) => e.personNavn).map((e) => e.personNavn!.toLowerCase())
        );

        // Remove nodes that are NOT in EJF's current owner list
        const toRemove = new Set<string>();
        for (const node of nodes) {
          if (
            node.type === 'company' &&
            node.cvr &&
            !ejfCvrs.has(String(node.cvr).padStart(8, '0')) &&
            !ejfCvrs.has(String(node.cvr))
          ) {
            toRemove.add(node.id);
          } else if (node.type === 'person' && !node.cvr) {
            const nameMatch = ejfNames.has(node.label.toLowerCase());
            if (!nameMatch && ejfNames.size > 0) {
              toRemove.add(node.id);
            }
          }
        }

        if (toRemove.size > 0) {
          // BIZZ-1625: Collect removed person names BEFORE filtering nodes array,
          // otherwise nodes.filter(toRemove) returns empty (nodes already filtered).
          const removedPersonNames = new Set<string>();
          for (const node of nodes) {
            if (toRemove.has(node.id) && node.type === 'person') {
              removedPersonNames.add(node.label.toLowerCase());
            }
          }

          // Remove stale nodes and their edges
          const filtered = nodes.filter((n) => !toRemove.has(n.id));
          nodes.length = 0;
          nodes.push(...filtered);
          const filteredEdges = edges.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to));
          edges.length = 0;
          edges.push(...filteredEdges);
          // Also clean ejerDetaljer — both CVR-based AND person-name-based.
          const cleanedDetaljer = ejerDetaljer.filter((d) => {
            if (d.cvr && !ejfCvrs.has(d.cvr) && !ejfCvrs.has(d.cvr.replace(/^0+/, '')))
              return false;
            // BIZZ-1625: Person-ejere (cvr=null) der blev fjernet fra diagram
            // skal også fjernes fra ejerDetaljer så ejerkort og diagram matcher.
            if (!d.cvr && d.type === 'person' && removedPersonNames.has(d.navn.toLowerCase()))
              return false;
            return true;
          });
          ejerDetaljer.length = 0;
          ejerDetaljer.push(...cleanedDetaljer);
        }
      }
    } catch {
      /* EJF cross-reference non-fatal */
    }
  }

  if (
    !harFaktiskeEjere ||
    nodes.filter((n) => n.type === 'company' || n.type === 'person').length === 0
  ) {
    try {
      // BIZZ-1582: Direct lib call (no HTTP overhead) — pre-fetched in parallel with TL.
      const ejfResult = await ejfPromise;
      if (ejfResult) {
        const ejere = ejfResult.ejere ?? [];

        for (const ejer of ejere) {
          const andel =
            ejer.ejerandel_taeller != null && ejer.ejerandel_naevner != null
              ? `${Math.round((ejer.ejerandel_taeller / ejer.ejerandel_naevner) * 100)}%`
              : undefined;

          if (ejer.cvr) {
            const id = `cvr-${ejer.cvr}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              // BIZZ-692: Brug virksomhedsnavn (fra CVR-enrichment) for selskabsejere,
              // personNavn for personejere, CVR-nummer som sidste fallback.
              const ejerLabel = ejer.virksomhedsnavn || ejer.personNavn || `CVR ${ejer.cvr}`;
              nodes.push({
                id,
                label: ejerLabel,
                type: 'company',
                cvr: parseInt(ejer.cvr, 10),
                link: `/dashboard/companies/${ejer.cvr}`,
              });
              companyOwnersToResolve.push({
                nodeId: id,
                cvr: parseInt(ejer.cvr, 10),
                depth: 0,
              });
            }
            edges.push({ from: id, to: mainId, ejerandel: andel });
            ejerDetaljer.push({
              navn: ejer.virksomhedsnavn || ejer.personNavn || `CVR ${ejer.cvr}`,
              cvr: ejer.cvr,
              enhedsNummer: null,
              type: 'selskab',
              andel: andel ?? null,
              adresse: null,
              overtagelsesdato: ejer.virkningFra ?? null,
              adkomstType: null,
              koebesum: null,
            });
          } else if (ejer.ejertype === 'pvoplys' && ejer.personNavn) {
            // BIZZ-482: Parter uden CVR/CPR (dødsboer, udenlandske selskaber,
            // fonde, administratorer). Disse renderes som diagrammets 'person'-
            // node (samme visuelle udtryk) men ejerDetaljer beholder
            // type='pvoplys' og de udvidede felter så UI'en kan vise flag,
            // udlandsadresse og administrator. Springer enhedsNummer-lookup
            // over — PV-parter findes ikke i CVR ES.
            const id = `pvoplys-${ejer.fiktivtPVnummer ?? nodes.length}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              nodes.push({
                id,
                label: ejer.personNavn,
                type: 'person',
              });
            }
            edges.push({ from: id, to: mainId, ejerandel: andel });
            ejerDetaljer.push({
              navn: ejer.personNavn,
              cvr: null,
              enhedsNummer: null,
              type: 'pvoplys',
              andel: andel ?? null,
              adresse: ejer.udlandsadresse ?? null,
              overtagelsesdato: ejer.virkningFra ?? null,
              adkomstType: null,
              koebesum: null,
              fiktivtPVnummer: ejer.fiktivtPVnummer ?? null,
              landekode: ejer.landekode ?? null,
              udlandsadresse: ejer.udlandsadresse ?? null,
              administrator: ejer.administrator ?? null,
            });
          } else if (ejer.personNavn) {
            const id = `person-ejf-${nodes.length}`;

            // BIZZ-386: Push node immediately (without enhedsNummer) so id is stable,
            // then batch-resolve enhedsNummer for all EJF persons after the loop.
            if (!seenIds.has(id)) {
              seenIds.add(id);
              nodes.push({
                id,
                label: ejer.personNavn,
                type: 'person',
              });
              // Only track for lookup when the node is newly added (deduplication guard)
              ejfPersonsToResolve.push({
                navn: ejer.personNavn,
                nodeIdx: nodes.length - 1,
                detaljeIdx: ejerDetaljer.length, // points to the entry we're about to push
              });
            }
            edges.push({ from: id, to: mainId, ejerandel: andel });
            ejerDetaljer.push({
              navn: ejer.personNavn,
              cvr: null,
              enhedsNummer: null,
              type: 'person',
              andel: andel ?? null,
              adresse: null,
              overtagelsesdato: ejer.virkningFra ?? null,
              adkomstType: null,
              koebesum: null,
            });
          }
        }
      }

      // BIZZ-386: Batch-resolve enhedsNummer for all EJF person owners in parallel
      if (ejfPersonsToResolve.length > 0 && CVR_ES_USER && CVR_ES_PASS) {
        const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
        const results = await Promise.allSettled(
          ejfPersonsToResolve.map(({ navn }) =>
            fetch(`${CVR_ES_BASE}/deltager/_search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
              body: JSON.stringify({
                query: { match: { 'Vrdeltagerperson.navne.navn': navn } },
                _source: ['Vrdeltagerperson.enhedsNummer'],
                size: 1,
              }),
              signal: AbortSignal.timeout(5000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        );
        for (let i = 0; i < ejfPersonsToResolve.length; i++) {
          const result = results[i];
          if (result.status !== 'fulfilled' || !result.value) continue;
          const enr = result.value?.hits?.hits?.[0]?._source?.Vrdeltagerperson?.enhedsNummer;
          if (typeof enr !== 'number') continue;
          const { nodeIdx, detaljeIdx } = ejfPersonsToResolve[i];
          nodes[nodeIdx].enhedsNummer = enr;
          nodes[nodeIdx].link = `/dashboard/owners/${enr}`;
          ejerDetaljer[detaljeIdx].enhedsNummer = enr;
        }
      }
    } catch {
      /* EJF fallback valgfri */
    }
  }

  // BIZZ-1655: Fjern "Opdelt i ejerlejligheder" status-noder når EJF
  // har fundet faktiske ejere. Status-teksten er misvisende når vi har
  // reelle ejere at vise — undgår at brugeren ser "Opdelt" som klikbar.
  const harRealEjereNu = nodes.some((n) => n.type === 'company' || n.type === 'person');
  if (harRealEjereNu) {
    const statusNodeIds = new Set(nodes.filter((n) => n.type === 'status').map((n) => n.id));
    if (statusNodeIds.size > 0) {
      const cleanedNodes = nodes.filter((n) => !statusNodeIds.has(n.id));
      nodes.length = 0;
      nodes.push(...cleanedNodes);
      const cleanedEdges = edges.filter(
        (e) => !statusNodeIds.has(e.from) && !statusNodeIds.has(e.to)
      );
      edges.length = 0;
      edges.push(...cleanedEdges);
      const cleanedDetaljer = ejerDetaljer.filter((d) => d.type !== 'status');
      ejerDetaljer.length = 0;
      ejerDetaljer.push(...cleanedDetaljer);
    }
  }

  // Resolver virksomhedsejere rekursivt (BFS, niveau-for-niveau parallelt — BIZZ-356)
  // Items at the same depth are fetched in parallel via Promise.allSettled to avoid
  // serialising independent network calls (common for ejerlejligheder with many owners).
  let currentLevel = companyOwnersToResolve.splice(0);
  while (currentLevel.length > 0) {
    // Filter out items that have already hit requested depth before firing requests
    const eligible = currentLevel.filter(({ depth }) => depth < requestedDepth);
    if (eligible.length === 0) break;

    // Fire all fetchCompanyOwners calls at this depth level in parallel
    const results = await Promise.allSettled(eligible.map(({ cvr }) => fetchCompanyOwners(cvr)));

    // Items to resolve at the next depth level, collected during this pass
    const nextLevel: { nodeId: string; cvr: number; depth: number }[] = [];

    for (let i = 0; i < eligible.length; i++) {
      const { nodeId, depth } = eligible[i];
      const result = results[i];

      // fetchCompanyOwners already handles its own errors and returns a safe default,
      // but guard against unexpected rejections just in case.
      if (result.status === 'rejected') continue;

      const { companyName, isCeased, owners } = result.value;

      // Opdater virksomhedsnode med navn og ophørsstatus (BIZZ-357)
      const companyNode = nodes.find((n) => n.id === nodeId);
      if (companyNode) {
        if (companyNode.label.startsWith('CVR ')) {
          companyNode.label = companyName;
        }
        // Mark as ceased so diagrams can render it visually distinct
        if (isCeased) companyNode.isCeased = true;
      }

      for (const owner of owners) {
        // BIZZ-564 v3: For virksomheder skal vi ID'e via det rigtige CVR-nummer
        // (forretningsnoegle), ikke det interne CVR-ES enhedsNummer. Hvis vi
        // brugte enhedsNummer som "cvr" stoppede recursion fordi næste
        // fetchCompanyOwners-iteration ikke kunne finde virksomheden via
        // term-query på cvrNummer.
        const effectiveCvr =
          owner.erVirksomhed && owner.cvrNummer ? owner.cvrNummer : owner.enhedsNummer;
        const ownerId = owner.erVirksomhed ? `cvr-${effectiveCvr}` : `en-${owner.enhedsNummer}`;

        if (!seenIds.has(ownerId)) {
          seenIds.add(ownerId);
          if (owner.erVirksomhed) {
            nodes.push({
              id: ownerId,
              label: owner.navn,
              type: 'company',
              cvr: effectiveCvr,
              link: `/dashboard/companies/${effectiveCvr}`,
            });
            // Kun push til next-level hvis vi har en gyldig CVR — ellers kan
            // vi alligevel ikke recurse (f.eks. udenlandske ejere uden DK-CVR).
            if (owner.cvrNummer) {
              nextLevel.push({
                nodeId: ownerId,
                cvr: owner.cvrNummer,
                depth: depth + 1,
              });
            }
          } else {
            nodes.push({
              id: ownerId,
              label: owner.navn,
              type: 'person',
              enhedsNummer: owner.enhedsNummer,
              link: `/dashboard/owners/${owner.enhedsNummer}`,
            });
          }
        }
        edges.push({ from: ownerId, to: nodeId, ejerandel: owner.ejerandel ?? undefined });
      }
    }

    currentLevel = nextLevel;
  }

  // BIZZ-1582: If there are still unresolved companies at depth limit, deeper
  // levels exist. The client can re-fetch with depth=3 to expand.
  const hasMore = requestedDepth < MAX_DEPTH && currentLevel.length > 0;

  // Propagate isCeased from resolved company nodes til ejerDetaljer entries.
  // Skal ske FØR filtreringen nedenfor, så detaljerne bevarer advarslen
  // om at en direkte ejer er ophørt selvom noden fjernes fra diagrammet.
  for (const d of ejerDetaljer) {
    if (d.cvr && d.type === 'selskab') {
      const cvrNum = parseInt(d.cvr, 10);
      const node = nodes.find((n) => n.type === 'company' && n.cvr === cvrNum);
      if (node?.isCeased) d.isCeased = true;
    }
  }

  // BIZZ-471 + BIZZ-477: Fjern ophørte virksomheder fra ejerstrukturen OG
  // fra adkomst-listen. Ophørte selskaber kan ikke længere eje noget i dag;
  // at vise dem som 100%-ejer (selv med "Ophørt" badge) giver forkert
  // indtryk af det aktuelle ejerskab. Tinglysning-registreringen kan være
  // forældet når selskabet er afregistreret uden formel re-tinglysning af
  // adkomsten. Match chain-graph og ejer-liste: samme filter, samme ejere.
  const ceasedCompanyIds = new Set(
    nodes.filter((n) => n.type === 'company' && n.isCeased).map((n) => n.id)
  );
  const ceasedCvrs = new Set(
    nodes
      .filter((n) => n.type === 'company' && n.isCeased && n.cvr != null)
      .map((n) => String(n.cvr))
  );
  if (ceasedCompanyIds.size > 0) {
    const filteredNodes = nodes.filter((n) => !ceasedCompanyIds.has(n.id));
    nodes.length = 0;
    nodes.push(...filteredNodes);
    const filteredEdges = edges.filter(
      (e) => !ceasedCompanyIds.has(e.from) && !ceasedCompanyIds.has(e.to)
    );
    edges.length = 0;
    edges.push(...filteredEdges);
  }
  if (ceasedCvrs.size > 0) {
    // BIZZ-477: Drop ophørte selskaber fra ejerDetaljer så UI-listen matcher
    // diagrammet (begge viser kun aktive ejere).
    const filteredEjerDetaljer = ejerDetaljer.filter((d) => {
      if (d.type !== 'selskab' || !d.cvr) return true;
      return !ceasedCvrs.has(d.cvr);
    });
    ejerDetaljer.length = 0;
    ejerDetaljer.push(...filteredEjerDetaljer);
  }

  const fejl: string | null = null;

  const payload: OwnershipChainResponse = {
    nodes,
    edges,
    mainId,
    ejerDetaljer,
    fejl,
    hasMore,
  };

  // BIZZ-1582: Fire-and-forget cache-write. Vi venter ikke på Supabase-
  // skrivning før vi svarer brugeren.
  void setCached(cacheKey, payload, {
    bfeNummer: Number(bfe) || undefined,
    ttlMinutes: 360,
  });

  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=600',
      'X-Cache': 'MISS',
    },
  });
}
