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

interface ChainNode {
  id: string;
  label: string;
  type: 'property' | 'company' | 'person' | 'status';
  cvr?: number;
  enhedsNummer?: number;
  ejerandel?: string;
  link?: string;
}

/** Status-tekster fra Tinglysning der ikke er faktiske ejere */
const STATUS_TEKSTER = [
  'opdelt i ejerlejlighed', // matcher både "ejerlejligheder" og "ejerlejlighed 1-4, 8-56"
  'opdelt i ideelle anparter',
  'opdelt i ideel anpart',
  'del af samlet ejendom',
];

interface ChainEdge {
  from: string;
  to: string;
  ejerandel?: string;
}

export interface ChainEjerDetalje {
  navn: string;
  cvr: string | null;
  enhedsNummer: number | null;
  type: 'person' | 'selskab' | 'status';
  andel: string | null;
  adresse: string | null;
  overtagelsesdato: string | null;
  adkomstType: string | null;
  koebesum: number | null;
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

/** Henter ejere af en virksomhed fra CVR ES */
async function fetchCompanyOwners(cvr: number): Promise<{
  companyName: string;
  owners: { navn: string; enhedsNummer: number; erVirksomhed: boolean; ejerandel: string | null }[];
}> {
  if (!CVR_ES_USER || !CVR_ES_PASS) return { companyName: `CVR ${cvr}`, owners: [] };

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
  const query = {
    query: { term: { 'Vrvirksomhed.cvrNummer': cvr } },
    _source: ['Vrvirksomhed.navne', 'Vrvirksomhed.deltagerRelation'],
    size: 1,
  };

  try {
    const res = await fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { companyName: `CVR ${cvr}`, owners: [] };

    const data = await res.json();
    const hit = data?.hits?.hits?.[0]?._source?.Vrvirksomhed;
    if (!hit) return { companyName: `CVR ${cvr}`, owners: [] };

    // Virksomhedsnavn
    const navne = Array.isArray(hit.navne) ? (hit.navne as (Periodic & { navn?: string })[]) : [];
    const companyName = gyldigNu(navne)?.navn ?? `CVR ${cvr}`;

    // Ejere fra deltagerRelation
    const owners: {
      navn: string;
      enhedsNummer: number;
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
        const erEjerOrg = orgNavne.some(
          (n) =>
            n.navn &&
            (n.navn.toUpperCase().includes('EJER') ||
              n.navn.toUpperCase().includes('LEGALE') ||
              n.navn.toUpperCase().includes('REEL')) &&
            n.periode?.gyldigTil == null
        );
        if (!erEjerOrg) continue;
        erEjer = true;

        // Find ejerandel
        const medlemsData = Array.isArray(org.medlemsData)
          ? (org.medlemsData as Record<string, unknown>[])
          : [];
        for (const md of medlemsData) {
          const attrs = Array.isArray(md.attributter)
            ? (md.attributter as Record<string, unknown>[])
            : [];
          for (const attr of attrs) {
            if (attr.type === 'EJERANDEL_PROCENT') {
              const vaerdier = Array.isArray(attr.vaerdier)
                ? (attr.vaerdier as (Periodic & { vaerdi?: number })[])
                : [];
              const gyldig = gyldigNu(vaerdier);
              if (gyldig?.vaerdi != null) {
                ejerandel = mapEjerandel(
                  typeof gyldig.vaerdi === 'number'
                    ? gyldig.vaerdi
                    : parseFloat(String(gyldig.vaerdi))
                );
              }
            }
          }
        }
      }

      if (erEjer) {
        owners.push({ navn, enhedsNummer, erVirksomhed, ejerandel });
      }
    }

    return { companyName, owners };
  } catch {
    return { companyName: `CVR ${cvr}`, owners: [] };
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

  if (!bfe) {
    return NextResponse.json({ nodes: [], edges: [], mainId: '', fejl: 'bfe er påkrævet' });
  }

  const nodes: ChainNode[] = [];
  const edges: ChainEdge[] = [];
  const seenIds = new Set<string>();
  const mainId = `bfe-${bfe}`;

  // Ejendomsnode (grøn)
  nodes.push({ id: mainId, label: adresse, type: 'property' });
  seenIds.add(mainId);

  // Hent ejere fra Tinglysning adkomst (primær kilde) og beriget via CVR API
  const companyOwnersToResolve: { nodeId: string; cvr: number; depth: number }[] = [];
  const ejerDetaljer: ChainEjerDetalje[] = [];

  // Forward the caller's session cookie so internal API routes can authenticate.
  const cookieHeader = req.headers.get('cookie') ?? '';

  // Trin 1: Prøv Tinglysning API — har navne, adkomsttype, evt. CVR
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
                companyOwnersToResolve.push({ nodeId: id, cvr: parseInt(ejer.cvr, 10), depth: 0 });
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
              const erStatus = STATUS_TEKSTER.some((s) =>
                (ejer.navn ?? '').toLowerCase().includes(s)
              );

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
                // Søg efter personens enhedsNummer i CVR ES via navn
                let personLink: string | undefined;
                let personEnhedsNummer: number | undefined;
                if (ejer.navn && CVR_ES_USER && CVR_ES_PASS) {
                  try {
                    const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
                    const pQuery = {
                      query: { match: { 'Vrdeltagerperson.navne.navn': ejer.navn } },
                      _source: ['Vrdeltagerperson.enhedsNummer'],
                      size: 1,
                    };
                    const pRes = await fetch(`${CVR_ES_BASE}/deltager/_search`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Basic ${auth}`,
                      },
                      body: JSON.stringify(pQuery),
                      signal: AbortSignal.timeout(5000),
                    });
                    if (pRes.ok) {
                      const pData = await pRes.json();
                      const enr = pData?.hits?.hits?.[0]?._source?.Vrdeltagerperson?.enhedsNummer;
                      if (typeof enr === 'number') {
                        personEnhedsNummer = enr;
                        personLink = `/dashboard/owners/${enr}`;
                      }
                    }
                  } catch {
                    /* ignore */
                  }
                }
                nodes.push({
                  id,
                  label: ejer.navn || 'Person',
                  type: 'person',
                  enhedsNummer: personEnhedsNummer,
                  link: personLink,
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
                  enhedsNummer: personEnhedsNummer ?? null,
                });
              }
            }
          }
        }
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

  if (!harFaktiskeEjere) {
    try {
      const ejfRes = await fetch(`${req.nextUrl.origin}/api/ejerskab?bfeNummer=${bfe}`, {
        headers: { cookie: cookieHeader },
        signal: AbortSignal.timeout(15000),
      });
      if (ejfRes.ok) {
        const ejfData = await ejfRes.json();
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
              nodes.push({
                id,
                label: ejer.personNavn || `CVR ${ejer.cvr}`,
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
              navn: ejer.personNavn || `CVR ${ejer.cvr}`,
              cvr: ejer.cvr,
              enhedsNummer: null,
              type: 'selskab',
              andel: andel ?? null,
              adresse: null,
              overtagelsesdato: ejer.virkningFra ?? null,
              adkomstType: null,
              koebesum: null,
            });
          } else if (ejer.personNavn) {
            const id = `person-ejf-${nodes.length}`;

            // Søg efter personens enhedsNummer i CVR ES via navn
            let personLink: string | undefined;
            let personEnhedsNummer: number | undefined;
            if (CVR_ES_USER && CVR_ES_PASS) {
              try {
                const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
                const pRes = await fetch(`${CVR_ES_BASE}/deltager/_search`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Basic ${auth}`,
                  },
                  body: JSON.stringify({
                    query: { match: { 'Vrdeltagerperson.navne.navn': ejer.personNavn } },
                    _source: ['Vrdeltagerperson.enhedsNummer'],
                    size: 1,
                  }),
                  signal: AbortSignal.timeout(5000),
                });
                if (pRes.ok) {
                  const pData = await pRes.json();
                  const enr = pData?.hits?.hits?.[0]?._source?.Vrdeltagerperson?.enhedsNummer;
                  if (typeof enr === 'number') {
                    personEnhedsNummer = enr;
                    personLink = `/dashboard/owners/${enr}`;
                  }
                }
              } catch {
                /* ignore */
              }
            }

            if (!seenIds.has(id)) {
              seenIds.add(id);
              nodes.push({
                id,
                label: ejer.personNavn,
                type: 'person',
                enhedsNummer: personEnhedsNummer,
                link: personLink,
              });
            }
            edges.push({ from: id, to: mainId, ejerandel: andel });
            ejerDetaljer.push({
              navn: ejer.personNavn,
              cvr: null,
              enhedsNummer: personEnhedsNummer ?? null,
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
    } catch {
      /* EJF fallback valgfri */
    }
  }

  // Resolver virksomhedsejere rekursivt (BFS)
  while (companyOwnersToResolve.length > 0) {
    const { nodeId, cvr, depth } = companyOwnersToResolve.shift()!;
    if (depth >= MAX_DEPTH) continue;

    const { companyName, owners } = await fetchCompanyOwners(cvr);

    // Opdater virksomhedsnode med navn
    const companyNode = nodes.find((n) => n.id === nodeId);
    if (companyNode && companyNode.label.startsWith('CVR ')) {
      companyNode.label = companyName;
    }

    for (const owner of owners) {
      const ownerId = owner.erVirksomhed ? `cvr-${owner.enhedsNummer}` : `en-${owner.enhedsNummer}`;

      if (!seenIds.has(ownerId)) {
        seenIds.add(ownerId);
        if (owner.erVirksomhed) {
          nodes.push({
            id: ownerId,
            label: owner.navn,
            type: 'company',
            cvr: owner.enhedsNummer,
            link: `/dashboard/companies/${owner.enhedsNummer}`,
          });
          companyOwnersToResolve.push({
            nodeId: ownerId,
            cvr: owner.enhedsNummer,
            depth: depth + 1,
          });
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
