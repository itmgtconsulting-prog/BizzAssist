/**
 * GET /api/diagram/resolve — Cache-first initial graf-builder for Diagram v2.
 *
 * Bygger en DiagramGraph fra lokale cache-tabeller (ejf_ejerskab + cvr_virksomhed)
 * for hurtig initial load uden live API-kald.
 *
 * @param type - 'company' | 'person' | 'property'
 * @param id   - CVR-nummer, enhedsNummer eller BFE-nummer
 * @returns DiagramGraph med expandableChildren sat korrekt
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { DiagramNode, DiagramEdge, DiagramGraph } from '@/app/components/diagrams/DiagramData';

/** Max ejendomme per ejer-node i initial graf */
const MAX_PROPS_PER_OWNER = 5;

interface ResolveResponse {
  graph: DiagramGraph | null;
  error?: string;
}

/**
 * Hent virksomhedsinfo fra cvr_virksomhed cache-tabel.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer
 * @returns Virksomhedsdata eller null
 */
async function fetchCachedCompany(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string
): Promise<{
  navn: string;
  status: string | null;
  virksomhedsform: string | null;
  ophoert: string | null;
} | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('cvr_virksomhed')
    .select('navn, status, virksomhedsform, ophoert')
    .eq('cvr', cvr)
    .maybeSingle();
  return data ?? null;
}

/**
 * Hent ejendomme ejet af et CVR-nummer fra ejf_ejerskab.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer
 * @returns Array af ejerskabsrækker
 */
async function fetchPropertiesByCvr(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string
): Promise<
  Array<{ bfe_nummer: number; ejerandel_taeller: number | null; ejerandel_naevner: number | null }>
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('ejf_ejerskab')
    .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
    .eq('ejer_cvr', cvr)
    .eq('status', 'gældende')
    .limit(200);
  return data ?? [];
}

/**
 * Hent alle ejere af en ejendom fra ejf_ejerskab.
 *
 * @param admin - Supabase admin client
 * @param bfe - BFE-nummer
 * @returns Array af ejere
 */
async function fetchOwnersByBfe(
  admin: ReturnType<typeof createAdminClient>,
  bfe: number
): Promise<
  Array<{
    ejer_navn: string;
    ejer_cvr: string | null;
    ejer_type: string;
    ejerandel_taeller: number | null;
    ejerandel_naevner: number | null;
  }>
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('ejf_ejerskab')
    .select('ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner')
    .eq('bfe_nummer', bfe)
    .eq('status', 'gældende')
    .limit(50);
  return data ?? [];
}

/**
 * Tæl ejendomme for et CVR der IKKE allerede er i grafen.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer
 * @param existingBfes - Set af BFE-numre allerede i grafen
 * @returns Antal ekstra ejendomme
 */
async function countExpandableProperties(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string,
  existingBfes: Set<number>
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (admin as any)
    .from('ejf_ejerskab')
    .select('bfe_nummer', { count: 'exact', head: true })
    .eq('ejer_cvr', cvr)
    .eq('status', 'gældende');
  const total = count ?? 0;
  // Træk eksisterende fra
  return Math.max(0, total - existingBfes.size);
}

/**
 * Formater ejerandel som procent-streng.
 *
 * @param taeller - Tæller
 * @param naevner - Nævner
 * @returns Procent-streng (fx "50%") eller undefined
 */
function formatEjerandel(taeller: number | null, naevner: number | null): string | undefined {
  if (taeller == null || naevner == null || naevner === 0) return undefined;
  const pct = Math.round((taeller / naevner) * 100);
  return `${pct}%`;
}

/**
 * Byg graf for virksomhed (CVR).
 * Root = virksomheden. Noder = ejendomme den ejer + medejere af disse ejendomme.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer
 * @returns DiagramGraph
 */
async function resolveCompanyGraph(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string
): Promise<DiagramGraph> {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const nodeIds = new Set<string>();
  const bfesInGraph = new Set<number>();

  // 1. Root-node: virksomheden selv
  const company = await fetchCachedCompany(admin, cvr);
  const mainId = `cvr-${cvr}`;
  nodes.push({
    id: mainId,
    label: company?.navn ?? `CVR ${cvr}`,
    sublabel: [company?.virksomhedsform, `CVR ${cvr}`].filter(Boolean).join(' · '),
    type: 'main',
    cvr: Number(cvr),
    link: `/dashboard/companies/${cvr}`,
    isCeased: company?.ophoert != null,
  });
  nodeIds.add(mainId);

  // 2. Ejendomme virksomheden ejer
  const properties = await fetchPropertiesByCvr(admin, cvr);
  const shownProps = properties.slice(0, MAX_PROPS_PER_OWNER);
  const overflowCount = properties.length - shownProps.length;

  for (const prop of shownProps) {
    const propId = `bfe-${prop.bfe_nummer}`;
    if (!nodeIds.has(propId)) {
      nodes.push({
        id: propId,
        label: `BFE ${prop.bfe_nummer}`,
        type: 'property',
        bfeNummer: prop.bfe_nummer,
      });
      nodeIds.add(propId);
    }
    bfesInGraph.add(prop.bfe_nummer);
    edges.push({
      from: mainId,
      to: propId,
      ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
    });
  }

  // Overflow-node for ejendomme
  if (overflowCount > 0) {
    const overflowId = `props-overflow-${mainId}`;
    nodes.push({
      id: overflowId,
      label: `+${overflowCount} ejendomme`,
      type: 'status',
      overflowItems: properties.slice(MAX_PROPS_PER_OWNER).map((p) => ({
        label: `BFE ${p.bfe_nummer}`,
      })),
    });
    nodeIds.add(overflowId);
    edges.push({ from: mainId, to: overflowId });
  }

  // 3. Medejere: for alle viste ejendomme, find andre ejere
  const coOwnerCvrs = new Set<string>();
  for (const prop of shownProps) {
    const owners = await fetchOwnersByBfe(admin, prop.bfe_nummer);
    for (const owner of owners) {
      if (owner.ejer_cvr === cvr) continue; // Skip root
      if (owner.ejer_type === 'virksomhed' && owner.ejer_cvr) {
        const ownerId = `cvr-${owner.ejer_cvr}`;
        if (!nodeIds.has(ownerId)) {
          const ownerCompany = await fetchCachedCompany(admin, owner.ejer_cvr);
          nodes.push({
            id: ownerId,
            label: ownerCompany?.navn ?? owner.ejer_navn,
            sublabel: ownerCompany?.virksomhedsform ?? undefined,
            type: 'company',
            cvr: Number(owner.ejer_cvr),
            link: `/dashboard/companies/${owner.ejer_cvr}`,
            isCeased: ownerCompany?.ophoert != null,
          });
          nodeIds.add(ownerId);
          coOwnerCvrs.add(owner.ejer_cvr);
        }
        edges.push({
          from: ownerId,
          to: `bfe-${prop.bfe_nummer}`,
          ejerandel: formatEjerandel(owner.ejerandel_taeller, owner.ejerandel_naevner),
          crossOwnership: true,
        });
      } else if (owner.ejer_type === 'person') {
        const ownerId = `person-${owner.ejer_navn.replace(/\s+/g, '-').toLowerCase()}`;
        if (!nodeIds.has(ownerId)) {
          nodes.push({
            id: ownerId,
            label: owner.ejer_navn,
            type: 'person',
          });
          nodeIds.add(ownerId);
        }
        edges.push({
          from: ownerId,
          to: `bfe-${prop.bfe_nummer}`,
          ejerandel: formatEjerandel(owner.ejerandel_taeller, owner.ejerandel_naevner),
        });
      }
    }
  }

  // 4. Beregn expandableChildren for medejer-virksomheder
  for (const node of nodes) {
    if (node.type === 'company' && node.cvr && node.id !== mainId) {
      const extra = await countExpandableProperties(admin, String(node.cvr), bfesInGraph);
      if (extra > 0) node.expandableChildren = extra;
    }
  }

  return { nodes, edges, mainId };
}

/**
 * Byg graf for ejendom (BFE).
 * Root = ejendommen. Noder = ejere (virksomheder + personer).
 *
 * @param admin - Supabase admin client
 * @param bfe - BFE-nummer
 * @returns DiagramGraph
 */
async function resolvePropertyGraph(
  admin: ReturnType<typeof createAdminClient>,
  bfe: number
): Promise<DiagramGraph> {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const nodeIds = new Set<string>();

  // Root-node: ejendommen
  const mainId = `bfe-${bfe}`;
  nodes.push({
    id: mainId,
    label: `BFE ${bfe}`,
    type: 'property',
    bfeNummer: bfe,
  });
  nodeIds.add(mainId);

  // Ejere
  const owners = await fetchOwnersByBfe(admin, bfe);
  for (const owner of owners) {
    if (owner.ejer_type === 'virksomhed' && owner.ejer_cvr) {
      const ownerId = `cvr-${owner.ejer_cvr}`;
      if (!nodeIds.has(ownerId)) {
        const company = await fetchCachedCompany(admin, owner.ejer_cvr);
        // Tæl andre ejendomme denne virksomhed ejer (udover nuværende)
        const otherProps = await fetchPropertiesByCvr(admin, owner.ejer_cvr);
        const expandable = otherProps.filter((p) => p.bfe_nummer !== bfe).length;

        nodes.push({
          id: ownerId,
          label: company?.navn ?? owner.ejer_navn,
          sublabel: company?.virksomhedsform ?? undefined,
          type: 'company',
          cvr: Number(owner.ejer_cvr),
          link: `/dashboard/companies/${owner.ejer_cvr}`,
          isCeased: company?.ophoert != null,
          expandableChildren: expandable > 0 ? expandable : undefined,
        });
        nodeIds.add(ownerId);
      }
      edges.push({
        from: ownerId,
        to: mainId,
        ejerandel: formatEjerandel(owner.ejerandel_taeller, owner.ejerandel_naevner),
      });
    } else if (owner.ejer_type === 'person') {
      const ownerId = `person-${owner.ejer_navn.replace(/\s+/g, '-').toLowerCase()}`;
      if (!nodeIds.has(ownerId)) {
        nodes.push({
          id: ownerId,
          label: owner.ejer_navn,
          type: 'person',
        });
        nodeIds.add(ownerId);
      }
      edges.push({
        from: ownerId,
        to: mainId,
        ejerandel: formatEjerandel(owner.ejerandel_taeller, owner.ejerandel_naevner),
      });
    }
  }

  return { nodes, edges, mainId };
}

/**
 * Byg graf for person (enhedsNummer).
 * Root = personen. Henter virksomheder fra live CVR ES (ingen lokal cache for deltagerRelation).
 * Ejendomme hentes fra ejf_ejerskab cache.
 *
 * @param admin - Supabase admin client
 * @param enhedsNummer - Personens enhedsNummer
 * @param host - Request host for interne API-kald
 * @param cookie - Auth cookie for interne API-kald
 * @returns DiagramGraph
 */
async function resolvePersonGraph(
  admin: ReturnType<typeof createAdminClient>,
  enhedsNummer: string,
  host: string,
  cookie: string
): Promise<DiagramGraph> {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const nodeIds = new Set<string>();
  const bfesInGraph = new Set<number>();

  // Root-node: personen
  const mainId = `en-${enhedsNummer}`;

  // Hent personens virksomheder via intern API (kræver live CVR ES)
  const personRes = await fetch(`${host}/api/cvr-public/person?enhedsNummer=${enhedsNummer}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  });
  const personData = personRes.ok ? await personRes.json() : null;
  const personName = personData?.navn ?? `Person ${enhedsNummer}`;

  nodes.push({
    id: mainId,
    label: personName,
    type: 'person',
    enhedsNummer: Number(enhedsNummer),
    link: `/dashboard/owners/${enhedsNummer}`,
  });
  nodeIds.add(mainId);

  // Tilføj virksomheder personen ejer
  const virksomheder: Array<{ cvr: number; navn: string; roller: string }> =
    personData?.virksomheder ?? [];
  for (const v of virksomheder) {
    const cvrStr = String(v.cvr);
    const companyId = `cvr-${cvrStr}`;
    if (nodeIds.has(companyId)) continue;

    const company = await fetchCachedCompany(admin, cvrStr);
    const properties = await fetchPropertiesByCvr(admin, cvrStr);

    nodes.push({
      id: companyId,
      label: company?.navn ?? v.navn,
      sublabel: company?.virksomhedsform ?? undefined,
      type: 'company',
      cvr: v.cvr,
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null,
      expandableChildren: properties.length > 0 ? properties.length : undefined,
    });
    nodeIds.add(companyId);

    edges.push({
      from: mainId,
      to: companyId,
      ejerandel: v.roller,
    });

    // Vis op til MAX_PROPS_PER_OWNER ejendomme per virksomhed
    const shownProps = properties.slice(0, MAX_PROPS_PER_OWNER);
    for (const prop of shownProps) {
      const propId = `bfe-${prop.bfe_nummer}`;
      if (!nodeIds.has(propId)) {
        nodes.push({
          id: propId,
          label: `BFE ${prop.bfe_nummer}`,
          type: 'property',
          bfeNummer: prop.bfe_nummer,
        });
        nodeIds.add(propId);
      }
      bfesInGraph.add(prop.bfe_nummer);
      edges.push({
        from: companyId,
        to: propId,
        ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
      });
    }
  }

  return { nodes, edges, mainId };
}

/**
 * Berig property-noder med adresser fra /api/bfe-addresses.
 * Opdaterer label, sublabel og link på alle property-noder i grafen.
 *
 * @param graph - DiagramGraph med property-noder der har BFE-numre
 * @param host - Request host for internt API-kald
 * @param cookie - Auth cookie
 */
async function enrichPropertyNodes(
  graph: DiagramGraph,
  host: string,
  cookie: string
): Promise<void> {
  const propNodes = graph.nodes.filter((n) => n.type === 'property' && n.bfeNummer != null);
  if (propNodes.length === 0) return;

  const bfes = propNodes.map((n) => n.bfeNummer!).join(',');
  try {
    const res = await fetch(`${host}/api/bfe-addresses?bfes=${bfes}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data: Record<
      string,
      {
        adresse: string | null;
        postnr: string | null;
        by: string | null;
        dawaId: string | null;
        etage: string | null;
        doer: string | null;
      }
    > = await res.json();

    for (const node of propNodes) {
      const info = data[String(node.bfeNummer)];
      if (!info?.adresse) continue;
      // Opdater label med adresse i stedet for "BFE 12345"
      const etageStr = info.etage ? `, ${info.etage}.` : '';
      const doerStr = info.doer ? ` ${info.doer}` : '';
      node.label = `${info.adresse}${etageStr}${doerStr}`;
      if (info.postnr && info.by) {
        node.sublabel = `${info.postnr} ${info.by}`;
      }
      if (info.dawaId) {
        node.link = `/dashboard/ejendomme/${info.dawaId}`;
      }
    }
  } catch {
    // Adresse-berigelse er best-effort — fejl ignoreres
  }
}

export async function GET(request: NextRequest): Promise<NextResponse<ResolveResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ graph: null, error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type');
  const id = searchParams.get('id');

  if (!type || !id) {
    return NextResponse.json({ graph: null, error: 'Missing type or id' }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    let graph: DiagramGraph;

    switch (type) {
      case 'company':
        graph = await resolveCompanyGraph(admin, id);
        break;
      case 'property':
        graph = await resolvePropertyGraph(admin, Number(id));
        break;
      case 'person': {
        const proto = request.headers.get('x-forwarded-proto') ?? 'http';
        const host = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
        const cookie = request.headers.get('cookie') ?? '';
        graph = await resolvePersonGraph(admin, id, host, cookie);
        break;
      }
      default:
        return NextResponse.json({ graph: null, error: `Unknown type: ${type}` }, { status: 400 });
    }

    // Berig property-noder med adresser (best-effort)
    const proto = request.headers.get('x-forwarded-proto') ?? 'http';
    const enrichHost = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
    const enrichCookie = request.headers.get('cookie') ?? '';
    await enrichPropertyNodes(graph, enrichHost, enrichCookie);

    return NextResponse.json({ graph });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    void message;
    return NextResponse.json({ graph: null, error: 'Ekstern API fejl' }, { status: 500 });
  }
}
