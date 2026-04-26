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
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';
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
      signal: AbortSignal.timeout(8000),
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

  if (!bfe) {
    return NextResponse.json({ nodes: [], edges: [], mainId: '', fejl: 'bfe er påkrævet' });
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

  // Hent ejere fra Tinglysning adkomst (primær kilde) og beriget via CVR API
  const companyOwnersToResolve: { nodeId: string; cvr: number; depth: number }[] = [];
  const ejerDetaljer: ChainEjerDetalje[] = [];

  // BIZZ-386: Accumulators for batched parallel enhedsNummer lookups (Tinglysning + EJF paths)
  const tlPersonsToResolve: { navn: string | undefined; nodeIdx: number; detaljeIdx: number }[] =
    [];
  const ejfPersonsToResolve: { navn: string; nodeIdx: number; detaljeIdx: number }[] = [];

  // Forward the caller's session cookie so internal API routes can authenticate.
  const cookieHeader = req.headers.get('cookie') ?? '';

  // BIZZ-328: Start EJF lookup in parallel with Tinglysning — used as fallback
  // if Tinglysning doesn't return real owners (common for ejerlejligheder).
  // Starting early saves ~200ms by overlapping with the Tinglysning round-trip.
  const ejfPromise = fetch(`${req.nextUrl.origin}/api/ejerskab?bfeNummer=${bfe}`, {
    headers: { cookie: cookieHeader },
    signal: AbortSignal.timeout(15000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  // Trin 1: Prøv Tinglysning API — har navne, adkomsttype, evt. CVR.
  // BIZZ-470: For ejerlejligheder (identificeret via ?type=ejerlejlighed)
  // springer vi helt over — Tinglysning returnerer ikke de reelle ejere
  // alligevel, og EJF-fallbacken henter dem hurtigt via ejfPromise.
  if (!skipTinglysning)
    try {
      const tlRes = await fetch(`${req.nextUrl.origin}/api/tinglysning?bfe=${bfe}`, {
        headers: { cookie: cookieHeader },
        signal: AbortSignal.timeout(30000),
      });
      if (tlRes.ok) {
        const tlData = await tlRes.json();
        if (tlData.uuid && !tlData.error) {
          // Hent KUN ejere-sektion fra summarisk (undgår at parse 90KB+ XML for servitutter)
          const tlSumRes = await fetch(
            `${req.nextUrl.origin}/api/tinglysning/summarisk?uuid=${tlData.uuid}&section=ejere`,
            {
              headers: { cookie: cookieHeader },
              signal: AbortSignal.timeout(30000),
            }
          );
          if (tlSumRes.ok) {
            const sumData = await tlSumRes.json();
            const ejere = sumData.ejere ?? [];
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
                    type: 'status' as 'person',
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
  if (harFaktiskeEjere) {
    try {
      const ejfData = await ejfPromise;
      if (ejfData?.ejere?.length > 0) {
        const ejfCvrs = new Set(
          ejfData.ejere
            .filter((e: { cvr: string | null }) => e.cvr)
            .map((e: { cvr: string }) => e.cvr)
        );
        const ejfNames = new Set(
          ejfData.ejere
            .filter((e: { personNavn: string | null }) => e.personNavn)
            .map((e: { personNavn: string }) => e.personNavn.toLowerCase())
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
          // Remove stale nodes and their edges
          const filtered = nodes.filter((n) => !toRemove.has(n.id));
          nodes.length = 0;
          nodes.push(...filtered);
          const filteredEdges = edges.filter((e) => !toRemove.has(e.from) && !toRemove.has(e.to));
          edges.length = 0;
          edges.push(...filteredEdges);
          // Also clean ejerDetaljer
          const cleanedDetaljer = ejerDetaljer.filter((d) => {
            if (d.cvr && !ejfCvrs.has(d.cvr) && !ejfCvrs.has(d.cvr.replace(/^0+/, '')))
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
      // BIZZ-328: Use pre-fetched EJF promise (started in parallel with Tinglysning)
      const ejfData = await ejfPromise;
      if (ejfData) {
        const ejere = ejfData.ejere ?? [];

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

  // Resolver virksomhedsejere rekursivt (BFS, niveau-for-niveau parallelt — BIZZ-356)
  // Items at the same depth are fetched in parallel via Promise.allSettled to avoid
  // serialising independent network calls (common for ejerlejligheder with many owners).
  let currentLevel = companyOwnersToResolve.splice(0);
  while (currentLevel.length > 0) {
    // Filter out items that have already hit MAX_DEPTH before firing requests
    const eligible = currentLevel.filter(({ depth }) => depth < MAX_DEPTH);
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

  return NextResponse.json(
    {
      nodes,
      edges,
      mainId,
      ejerDetaljer,
      fejl,
    } as OwnershipChainResponse,
    {
      headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=600' },
    }
  );
}
