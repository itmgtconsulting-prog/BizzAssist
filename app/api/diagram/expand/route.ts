/**
 * POST /api/diagram/expand — Cache-first expand for Diagram v2.
 *
 * Udvider en node i grafen: henter relaterede ejendomme, ejere og datterselskaber
 * fra lokale cache-tabeller. Deduplicerer mod eksisterende noder og finder
 * 2nd-degree edges (krydsrelationer) mellem nye og eksisterende noder.
 *
 * @param body.nodeType - 'company' | 'person'
 * @param body.nodeId   - Node-ID i grafen (fx "cvr-12345678")
 * @param body.cvr      - CVR-nummer (for company nodes)
 * @param body.enhedsNummer - enhedsNummer (for person nodes)
 * @param body.existingNodeIds - Array af node-IDs allerede i grafen
 * @param body.existingBfes    - Array af BFE-numre allerede i grafen
 * @returns Nye noder + edges (inkl. 2nd-degree crossOwnership edges)
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { DiagramNode, DiagramEdge } from '@/app/components/diagrams/DiagramData';

/** Max ejendomme per ejer-node ved expand */
const MAX_PROPS_PER_EXPAND = 5;

interface ExpandRequest {
  nodeType: 'company' | 'person';
  nodeId: string;
  cvr?: string;
  enhedsNummer?: string;
  existingNodeIds: string[];
  existingBfes: number[];
}

interface ExpandResponse {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  error?: string;
}

/**
 * Formater ejerandel som procent-streng.
 *
 * @param taeller - Tæller
 * @param naevner - Nævner
 * @returns Procent-streng eller undefined
 */
function formatEjerandel(taeller: number | null, naevner: number | null): string | undefined {
  if (taeller == null || naevner == null || naevner === 0) return undefined;
  const pct = Math.round((taeller / naevner) * 100);
  return `${pct}%`;
}

/**
 * Expand en virksomheds-node: hent ejendomme + find 2nd-degree edges.
 *
 * @param admin - Supabase admin client
 * @param nodeId - Node-ID i grafen
 * @param cvr - CVR-nummer
 * @param existingIds - Set af node-IDs allerede i grafen
 * @param existingBfes - Set af BFE-numre allerede i grafen
 * @returns Nye noder + edges
 */
async function expandCompany(
  admin: ReturnType<typeof createAdminClient>,
  nodeId: string,
  cvr: string,
  existingIds: Set<string>,
  existingBfes: Set<number>
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  const newNodes: DiagramNode[] = [];
  const newEdges: DiagramEdge[] = [];
  const addedIds = new Set<string>();

  // Hent ejendomme fra ejf_ejerskab
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: properties } = await (admin as any)
    .from('ejf_ejerskab')
    .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
    .eq('ejer_cvr', cvr)
    .eq('status', 'gældende')
    .limit(200);

  const props: Array<{
    bfe_nummer: number;
    ejerandel_taeller: number | null;
    ejerandel_naevner: number | null;
  }> = properties ?? [];

  // Filter: kun ejendomme der ikke allerede er i grafen
  const newProps = props.filter((p) => !existingBfes.has(p.bfe_nummer));
  const shownProps = newProps.slice(0, MAX_PROPS_PER_EXPAND);

  for (const prop of shownProps) {
    const propId = `bfe-${prop.bfe_nummer}`;
    if (!existingIds.has(propId) && !addedIds.has(propId)) {
      newNodes.push({
        id: propId,
        label: `BFE ${prop.bfe_nummer}`,
        type: 'property',
        bfeNummer: prop.bfe_nummer,
      });
      addedIds.add(propId);
    }
    newEdges.push({
      from: nodeId,
      to: propId,
      ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
    });
  }

  // Overflow
  if (newProps.length > MAX_PROPS_PER_EXPAND) {
    const overflowId = `props-overflow-${nodeId}`;
    newNodes.push({
      id: overflowId,
      label: `+${newProps.length - MAX_PROPS_PER_EXPAND} ejendomme`,
      type: 'status',
      overflowItems: newProps.slice(MAX_PROPS_PER_EXPAND).map((p) => ({
        label: `BFE ${p.bfe_nummer}`,
      })),
    });
    newEdges.push({ from: nodeId, to: overflowId });
  }

  // 2nd-degree edges: ejendomme der ALLEREDE er i grafen men som denne virksomhed også ejer
  const existingOwnedProps = props.filter((p) => existingBfes.has(p.bfe_nummer));
  for (const prop of existingOwnedProps) {
    newEdges.push({
      from: nodeId,
      to: `bfe-${prop.bfe_nummer}`,
      ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
      crossOwnership: true,
    });
  }

  // 2nd-degree edges: for nye ejendomme, find medejere der allerede er i grafen
  for (const prop of shownProps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: coOwners } = await (admin as any)
      .from('ejf_ejerskab')
      .select('ejer_cvr, ejer_navn, ejer_type, ejerandel_taeller, ejerandel_naevner')
      .eq('bfe_nummer', prop.bfe_nummer)
      .eq('status', 'gældende')
      .limit(20);

    for (const co of coOwners ?? []) {
      if (co.ejer_cvr === cvr) continue; // Skip den udvidede node selv
      const coId = co.ejer_cvr
        ? `cvr-${co.ejer_cvr}`
        : `person-${co.ejer_navn.replace(/\s+/g, '-').toLowerCase()}`;
      if (existingIds.has(coId)) {
        // Medejer allerede i grafen → 2nd-degree edge
        newEdges.push({
          from: coId,
          to: `bfe-${prop.bfe_nummer}`,
          ejerandel: formatEjerandel(co.ejerandel_taeller, co.ejerandel_naevner),
          crossOwnership: true,
        });
      }
    }
  }

  return { nodes: newNodes, edges: newEdges };
}

/**
 * Expand en person-node: hent virksomheder + ejendomme via intern API.
 *
 * @param admin - Supabase admin client
 * @param nodeId - Node-ID i grafen
 * @param enhedsNummer - Personens enhedsNummer
 * @param existingIds - Set af node-IDs allerede i grafen
 * @param existingBfes - Set af BFE-numre allerede i grafen
 * @param host - Request host for interne API-kald
 * @param cookie - Auth cookie
 * @returns Nye noder + edges
 */
async function expandPerson(
  admin: ReturnType<typeof createAdminClient>,
  nodeId: string,
  enhedsNummer: string,
  existingIds: Set<string>,
  existingBfes: Set<number>,
  host: string,
  cookie: string
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  const newNodes: DiagramNode[] = [];
  const newEdges: DiagramEdge[] = [];
  const addedIds = new Set<string>();

  // BIZZ-1120: Hent personens virksomheder fra lokal cache
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: personRels } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, type')
    .eq('deltager_enhedsnummer', Number(enhedsNummer))
    .is('gyldig_til', null)
    .limit(100);

  // Gruppér roller per virksomhed og filtrer
  const virksomhedRollerMap = new Map<string, string[]>();
  for (const r of (personRels ?? []) as Array<{ virksomhed_cvr: string; type: string }>) {
    const arr = virksomhedRollerMap.get(r.virksomhed_cvr) ?? [];
    arr.push(r.type);
    virksomhedRollerMap.set(r.virksomhed_cvr, arr);
  }
  // BIZZ-1120: Filtrer til virksomheder med ejendomme (ejf_ejerskab)
  if (virksomhedRollerMap.size > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: propOwners } = await (admin as any)
      .from('ejf_ejerskab')
      .select('ejer_cvr')
      .in('ejer_cvr', [...virksomhedRollerMap.keys()].slice(0, 50))
      .eq('status', 'gældende')
      .limit(200);
    const cvrsWithProps = new Set((propOwners ?? []).map((r: { ejer_cvr: string }) => r.ejer_cvr));
    for (const cvrKey of virksomhedRollerMap.keys()) {
      if (!cvrsWithProps.has(cvrKey)) virksomhedRollerMap.delete(cvrKey);
    }
  }

  for (const [cvrStr, roller] of virksomhedRollerMap) {
    const companyId = `cvr-${cvrStr}`;
    const rolleStr = roller.slice(0, 2).join(', ');

    if (existingIds.has(companyId)) {
      // Virksomhed allerede i grafen → 2nd-degree edge
      newEdges.push({
        from: nodeId,
        to: companyId,
        ejerandel: rolleStr || undefined,
        crossOwnership: true,
      });
      continue;
    }
    if (addedIds.has(companyId)) continue;

    // Hent virksomhedsinfo fra cache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: company } = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn, status, virksomhedsform, ophoert')
      .eq('cvr', cvrStr)
      .maybeSingle();

    // Tæl ejendomme for expandableChildren
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: propCount } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer', { count: 'exact', head: true })
      .eq('ejer_cvr', cvrStr)
      .eq('status', 'gældende');

    newNodes.push({
      id: companyId,
      label: company?.navn ?? `CVR ${cvrStr}`,
      sublabel: company?.virksomhedsform ?? undefined,
      type: 'company',
      cvr: Number(cvrStr),
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null,
      expandableChildren: (propCount ?? 0) > 0 ? (propCount ?? 0) : undefined,
    });
    addedIds.add(companyId);

    newEdges.push({
      from: nodeId,
      to: companyId,
      ejerandel: rolleStr || undefined,
    });
  }

  // Personligt ejede ejendomme via person-bridge + ejf_ejerskab
  const bridgeRes = await fetch(`${host}/api/ejerskab/person-bridge?enhedsNummer=${enhedsNummer}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  });
  const bridge = bridgeRes.ok ? await bridgeRes.json() : null;

  if (bridge?.navn && bridge?.foedselsdato) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: personalProps } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
      .ilike('ejer_navn', bridge.navn)
      .eq('ejer_foedselsdato', bridge.foedselsdato)
      .eq('ejer_type', 'person')
      .eq('status', 'gældende')
      .limit(50);

    const props: Array<{
      bfe_nummer: number;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }> = personalProps ?? [];
    const newProps = props.filter((p) => !existingBfes.has(p.bfe_nummer));

    if (newProps.length > 0) {
      // Container-node
      const containerId = 'personal-props-group';
      if (!existingIds.has(containerId) && !addedIds.has(containerId)) {
        newNodes.push({
          id: containerId,
          label: 'Personligt ejede ejendomme',
          type: 'status',
        });
        addedIds.add(containerId);
        newEdges.push({ from: nodeId, to: containerId, personallyOwned: true });
      }

      const shownProps = newProps.slice(0, MAX_PROPS_PER_EXPAND);
      for (const prop of shownProps) {
        const propId = `bfe-${prop.bfe_nummer}`;
        if (!existingIds.has(propId) && !addedIds.has(propId)) {
          newNodes.push({
            id: propId,
            label: `BFE ${prop.bfe_nummer}`,
            type: 'property',
            bfeNummer: prop.bfe_nummer,
          });
          addedIds.add(propId);
        }
        newEdges.push({
          from: containerId,
          to: propId,
          ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
          personallyOwned: true,
        });
      }
    }
  }

  return { nodes: newNodes, edges: newEdges };
}

export async function POST(request: NextRequest): Promise<NextResponse<ExpandResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ nodes: [], edges: [], error: 'Unauthorized' }, { status: 401 });
  }

  let body: ExpandRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ nodes: [], edges: [], error: 'Invalid JSON' }, { status: 400 });
  }

  const { nodeType, nodeId, cvr, enhedsNummer, existingNodeIds, existingBfes } = body;
  const existingIds = new Set(existingNodeIds ?? []);
  const existingBfeSet = new Set(existingBfes ?? []);

  const admin = createAdminClient();

  try {
    let result: { nodes: DiagramNode[]; edges: DiagramEdge[] };

    if (nodeType === 'company' && cvr) {
      result = await expandCompany(admin, nodeId, cvr, existingIds, existingBfeSet);
    } else if (nodeType === 'person' && enhedsNummer) {
      const proto = request.headers.get('x-forwarded-proto') ?? 'http';
      const host = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
      const cookie = request.headers.get('cookie') ?? '';
      result = await expandPerson(
        admin,
        nodeId,
        enhedsNummer,
        existingIds,
        existingBfeSet,
        host,
        cookie
      );
    } else {
      return NextResponse.json(
        { nodes: [], edges: [], error: 'Missing cvr or enhedsNummer' },
        { status: 400 }
      );
    }

    // Berig property-noder med adresser (best-effort)
    const propNodes = result.nodes.filter((n) => n.type === 'property' && n.bfeNummer != null);
    if (propNodes.length > 0) {
      try {
        const enrichProto = request.headers.get('x-forwarded-proto') ?? 'http';
        const enrichHost = `${enrichProto}://${request.headers.get('host') ?? 'localhost:3000'}`;
        const enrichCookie = request.headers.get('cookie') ?? '';
        const bfes = propNodes.map((n) => n.bfeNummer!).join(',');
        const addrRes = await fetch(`${enrichHost}/api/bfe-addresses?bfes=${bfes}`, {
          headers: { cookie: enrichCookie },
          signal: AbortSignal.timeout(10000),
        });
        if (addrRes.ok) {
          const addrData: Record<
            string,
            {
              adresse: string | null;
              postnr: string | null;
              by: string | null;
              dawaId: string | null;
              etage: string | null;
              doer: string | null;
            }
          > = await addrRes.json();
          for (const node of propNodes) {
            const info = addrData[String(node.bfeNummer)];
            if (!info?.adresse) continue;
            const etageStr = info.etage ? `, ${info.etage}.` : '';
            const doerStr = info.doer ? ` ${info.doer}` : '';
            // BIZZ-1103: Inkluder postnr+by i label (sublabel renderes ikke for property-noder)
            const postStr = info.postnr && info.by ? `, ${info.postnr} ${info.by}` : '';
            node.label = `${info.adresse}${etageStr}${doerStr}${postStr}`;
            if (info.postnr && info.by) node.sublabel = `${info.postnr} ${info.by}`;
            if (info.dawaId) node.link = `/dashboard/ejendomme/${info.dawaId}`;
          }
        }
      } catch {
        // Best-effort — fejl ignoreres
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    void (err instanceof Error ? err.message : '');
    return NextResponse.json({ nodes: [], edges: [], error: 'Ekstern API fejl' }, { status: 500 });
  }
}
