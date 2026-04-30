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
  branche_tekst: string | null;
  ophoert: string | null;
} | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('cvr_virksomhed')
    .select('navn, status, virksomhedsform, branche_tekst, ophoert')
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
async function _countExpandableProperties(
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

/** CVR-deltagerrelation typer der indikerer EJERSKAB (ikke ledelse/bestyrelse) */
const OWNERSHIP_TYPES = new Set([
  'register', // Registreret ejer (Det Offentlige Ejerregister)
  'reel_ejer', // Reel ejer (beneficial owner)
  'interessenter', // Interessent (partner i I/S)
  'stifter', // Stifter
  'hovedselskab', // Moderselskab
]);

/**
 * Byg graf for virksomhed (CVR).
 * Root = virksomheden. Ejere opad via ownership-typer, datterselskaber via CVR ES related.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer
 * @param host - Request host for interne API-kald
 * @param cookie - Auth cookie for interne API-kald
 * @returns DiagramGraph
 */
async function resolveCompanyGraph(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string,
  host: string,
  cookie: string
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

  // 2. BIZZ-1108/1122: Hent EJERE (opad) — kun ownership-typer, ikke bestyrelse/direktion
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: ownerRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('deltager_enhedsnummer, type')
    .eq('virksomhed_cvr', cvr)
    .is('gyldig_til', null)
    .limit(30);

  // Filtrer til ownership-typer
  const ownershipRows = (ownerRows ?? []).filter((r: { type: string }) =>
    OWNERSHIP_TYPES.has(r.type)
  ) as Array<{ deltager_enhedsnummer: number; type: string }>;

  if (ownershipRows.length > 0) {
    const enhedsNumre = Array.from(new Set(ownershipRows.map((r) => r.deltager_enhedsnummer)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: deltagere } = await (admin as any)
      .from('cvr_deltager')
      .select('enhedsnummer, navn')
      .in('enhedsnummer', enhedsNumre);
    const navnMap = new Map<number, string>(
      (deltagere ?? []).map((d: { enhedsnummer: number; navn: string }) => [d.enhedsnummer, d.navn])
    );

    // Gruppér roller per deltager
    const personRollerMap = new Map<number, string[]>();
    for (const r of ownershipRows) {
      const arr = personRollerMap.get(r.deltager_enhedsnummer) ?? [];
      arr.push(r.type);
      personRollerMap.set(r.deltager_enhedsnummer, arr);
    }

    for (const [en, roller] of Array.from(personRollerMap)) {
      const ownerId = `en-${en}`;
      if (nodeIds.has(ownerId)) continue;
      const ownerNavn = navnMap.get(en) ?? `Person ${en}`;
      // BIZZ-1122: Person-noder bevarer enhedsNummer for Udvid-knap, men
      // expand-route filtrerer til ejerskabs-virksomheder + personlige
      // ejendomme når context=company (ikke bestyrelse/direktion).
      nodes.push({
        id: ownerId,
        label: ownerNavn,
        type: 'person',
        enhedsNummer: en,
        link: `/dashboard/owners/${en}`,
      });
      nodeIds.add(ownerId);
      edges.push({
        from: ownerId,
        to: mainId,
        ejerandel: roller.slice(0, 2).join(', '),
      });
    }
  }

  // 2b. BIZZ-1122: Datterselskaber via CVR ES /api/cvr-public/related.
  // Bruger ejetAfCvr til at bygge korrekt hierarki (ikke fladt).
  // Filtrerer ophørte virksomheder fra.
  const MAX_TOTAL_NODES = 50;

  interface RelatedCompany {
    cvr: number;
    navn: string;
    form: string | null;
    branche: string | null;
    aktiv: boolean;
    ejerandel: string | null;
    ejetAfCvr: number | null;
  }

  try {
    const relRes = await fetch(`${host}/api/cvr-public/related?cvr=${cvr}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (relRes.ok) {
      const relData = await relRes.json();
      const allRelated: RelatedCompany[] = relData?.virksomheder ?? [];

      // BIZZ-1122: Filtrer ophørte virksomheder fra
      const relatedCompanies = allRelated.filter((r) => r.aktiv);

      // Batch-hent virksomhedsinfo fra cache (for branche_tekst mv.)
      const relCvrs = relatedCompanies.map((r) => String(r.cvr));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: relCachedCompanies } = await (admin as any)
        .from('cvr_virksomhed')
        .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
        .in('cvr', relCvrs.slice(0, MAX_TOTAL_NODES));
      type CachedCompany = {
        cvr: string;
        navn: string;
        virksomhedsform: string | null;
        branche_tekst: string | null;
        ophoert: string | null;
      };
      const cachedMap = new Map<string, CachedCompany>(
        (relCachedCompanies ?? []).map((c: CachedCompany) => [c.cvr, c])
      );

      // BIZZ-1122: Byg hierarkisk graf — brug ejetAfCvr til parent→child relationer.
      // Sortér: DIREKTE virksomheder (ejetAfCvr = null) først, dernæst children.
      // Sikrer at parent-noder eksisterer før children refererer til dem.
      const sorted = [
        ...relatedCompanies.filter((r) => r.ejetAfCvr == null),
        ...relatedCompanies.filter((r) => r.ejetAfCvr != null),
      ];

      for (const rel of sorted) {
        if (nodes.length >= MAX_TOTAL_NODES) break;
        const subCvr = String(rel.cvr);
        const subId = `cvr-${subCvr}`;
        if (nodeIds.has(subId)) continue;

        const cached = cachedMap.get(subCvr);
        const sublabelParts = [
          cached?.virksomhedsform ?? rel.form,
          cached?.branche_tekst ?? rel.branche,
        ].filter(Boolean);

        nodes.push({
          id: subId,
          label: cached?.navn ?? rel.navn,
          sublabel: sublabelParts.length > 0 ? sublabelParts.join(' · ') : undefined,
          branche: cached?.branche_tekst ?? rel.branche ?? undefined,
          type: 'company',
          cvr: rel.cvr,
          link: `/dashboard/companies/${subCvr}`,
          isCeased: false,
        });
        nodeIds.add(subId);

        // BIZZ-1122: Hierarkisk edge — ejetAfCvr bestemmer parent
        const parentId = rel.ejetAfCvr != null ? `cvr-${rel.ejetAfCvr}` : mainId;
        // Hvis parent-node ikke eksisterer (fx filtreret som ophørt), brug root
        const effectiveParent = nodeIds.has(parentId) ? parentId : mainId;
        edges.push({
          from: effectiveParent,
          to: subId,
          ejerandel: rel.ejerandel ?? undefined,
        });
      }
    }
  } catch {
    // Related-virksomheder er best-effort — fejl ignoreres
  }

  // 3. BIZZ-1117: Ejendomme for ALLE virksomheder — batch-query (undgå N+1)
  const companyCvrs = nodes
    .filter((n) => (n.type === 'company' || n.type === 'main') && n.cvr)
    .map((n) => String(n.cvr));

  if (companyCvrs.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allProps } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr, ejerandel_taeller, ejerandel_naevner')
      .in('ejer_cvr', companyCvrs.slice(0, 10))
      .eq('status', 'gældende')
      .limit(100);

    // Gruppér ejendomme per CVR
    const propsByCvr = new Map<
      string,
      Array<{
        bfe_nummer: number;
        ejerandel_taeller: number | null;
        ejerandel_naevner: number | null;
      }>
    >();
    for (const p of (allProps ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }>) {
      const arr = propsByCvr.get(p.ejer_cvr) ?? [];
      arr.push(p);
      propsByCvr.set(p.ejer_cvr, arr);
    }

    for (const compNode of nodes.filter(
      (n) => (n.type === 'company' || n.type === 'main') && n.cvr
    )) {
      const props = propsByCvr.get(String(compNode.cvr)) ?? [];
      const shownProps = props.slice(0, MAX_PROPS_PER_OWNER);
      const overflowCount = props.length - shownProps.length;

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
          from: compNode.id,
          to: propId,
          ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
        });
      }

      if (overflowCount > 0) {
        const overflowId = `props-overflow-${compNode.id}`;
        nodes.push({
          id: overflowId,
          label: `+${overflowCount} ejendomme`,
          type: 'status',
          overflowItems: props
            .slice(MAX_PROPS_PER_OWNER)
            .map((p) => ({ label: `BFE ${p.bfe_nummer}` })),
        });
        nodeIds.add(overflowId);
        edges.push({ from: compNode.id, to: overflowId });
      }
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
  bfe: number,
  rootLabel?: string | null
): Promise<DiagramGraph> {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const nodeIds = new Set<string>();

  // Root-node: ejendommen — BIZZ-1114: brug client-supplied label hvis tilgængelig
  const mainId = `bfe-${bfe}`;
  nodes.push({
    id: mainId,
    label: rootLabel || `BFE ${bfe}`,
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

        // BIZZ-1113: Cache-first label: cvr_virksomhed → ejf_ejerskab.ejer_navn
        // Ingen live API kald — det gør resolve for langsom.
        const companyLabel = company?.navn ?? owner.ejer_navn ?? `CVR ${owner.ejer_cvr}`;

        // BIZZ-1123: Inkluder branche_tekst i sublabel
        const propOwnerSubParts = [company?.virksomhedsform, company?.branche_tekst].filter(
          Boolean
        );
        nodes.push({
          id: ownerId,
          label: companyLabel,
          sublabel:
            propOwnerSubParts.length > 0 ? propOwnerSubParts.join(' · ') : `CVR ${owner.ejer_cvr}`,
          branche: company?.branche_tekst ?? undefined,
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

  // Root-node: personen
  const mainId = `en-${enhedsNummer}`;

  // Hent personnavn fra cvr_deltager (lokal cache)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: deltagerRow } = await (admin as any)
    .from('cvr_deltager')
    .select('navn')
    .eq('enhedsnummer', Number(enhedsNummer))
    .maybeSingle();
  const personName = deltagerRow?.navn ?? `Person ${enhedsNummer}`;

  nodes.push({
    id: mainId,
    label: personName,
    type: 'person',
    enhedsNummer: Number(enhedsNummer),
    link: `/dashboard/owners/${enhedsNummer}`,
  });
  nodeIds.add(mainId);

  // BIZZ-1120: Hent personens ejerskabs-virksomheder via live CVR ES.
  // Lokal cvr_deltagerrelation kan IKKE skelne ejerskab fra ledelsesposter
  // (ingen kontorsteder.type === 'EJERREGISTER' data). V1 bruger live API
  // og det er den eneste pålidelige metode.
  const personRes = await fetch(`${host}/api/cvr-public/person?enhedsNummer=${enhedsNummer}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  const personData = personRes && personRes.ok ? await personRes.json() : null;

  // Opdater personnavn fra API-response hvis tilgængeligt
  if (personData?.navn) {
    nodes[0].label = personData.navn;
  }

  // Filtrér virksomheder: v1 inkluderer dem med ejerskabs-roller
  interface PersonVirksomhed {
    cvr: number;
    navn: string;
    aktiv: boolean;
    roller: Array<{ rolle?: string; ejerandel?: string | null }>;
  }
  const virksomheder: PersonVirksomhed[] = personData?.virksomheder ?? [];

  // Batch-hent virksomhedsnavne fra lokal cache
  const allCvrs = virksomheder.map((v) => String(v.cvr));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: companyBatch } = await (admin as any)
    .from('cvr_virksomhed')
    .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
    .in('cvr', allCvrs.slice(0, 50));
  const companyMap = new Map<
    string,
    {
      navn: string;
      virksomhedsform: string | null;
      branche_tekst: string | null;
      ophoert: string | null;
    }
  >(
    (companyBatch ?? []).map(
      (c: {
        cvr: string;
        navn: string;
        virksomhedsform: string | null;
        branche_tekst: string | null;
        ophoert: string | null;
      }) => [c.cvr, c]
    )
  );

  // Batch-hent ejendomsantal per CVR
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: propCounts } = await (admin as any)
    .from('ejf_ejerskab')
    .select('ejer_cvr')
    .in('ejer_cvr', allCvrs.slice(0, 50))
    .eq('status', 'gældende');
  const propCountMap = new Map<string, number>();
  for (const r of (propCounts ?? []) as Array<{ ejer_cvr: string }>) {
    propCountMap.set(r.ejer_cvr, (propCountMap.get(r.ejer_cvr) ?? 0) + 1);
  }

  // BIZZ-1124: Batch-hent nøglepersoner (bestyrelse/direktion) for alle virksomheder
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: keyPersonRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, deltager_enhedsnummer, type')
    .in('virksomhed_cvr', allCvrs.slice(0, 50))
    .in('type', ['bestyrelsesmedlem', 'bestyrelse', 'formand', 'direktør', 'direktion'])
    .is('gyldig_til', null)
    .limit(500);

  // Hent navne for alle nøglepersoner
  const keyPersonEnheder = Array.from(
    new Set(
      ((keyPersonRows ?? []) as Array<{ deltager_enhedsnummer: number }>).map(
        (r) => r.deltager_enhedsnummer
      )
    )
  );
  let keyPersonNames: Array<{ enhedsnummer: number; navn: string }> | null = [];
  if (keyPersonEnheder.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from('cvr_deltager')
      .select('enhedsnummer, navn')
      .in('enhedsnummer', keyPersonEnheder.slice(0, 200));
    keyPersonNames = data;
  }
  const keyPersonNavnMap = new Map<number, string>(
    ((keyPersonNames ?? []) as Array<{ enhedsnummer: number; navn: string }>).map((d) => [
      d.enhedsnummer,
      d.navn,
    ])
  );

  // Byg nøglepersoner-map per CVR
  type NoeglePersonEntry = { enhedsNummer: number; navn: string; rolle: string };
  const noeglePersonerMap = new Map<string, NoeglePersonEntry[]>();
  const bestyrelsesTyper = new Set(['bestyrelsesmedlem', 'bestyrelse', 'formand']);
  for (const r of (keyPersonRows ?? []) as Array<{
    virksomhed_cvr: string;
    deltager_enhedsnummer: number;
    type: string;
  }>) {
    // Ekskludér den valgte person selv
    if (r.deltager_enhedsnummer === Number(enhedsNummer)) continue;
    const arr = noeglePersonerMap.get(r.virksomhed_cvr) ?? [];
    // Undgå duplikater
    if (arr.some((p) => p.enhedsNummer === r.deltager_enhedsnummer)) continue;
    arr.push({
      enhedsNummer: r.deltager_enhedsnummer,
      navn: keyPersonNavnMap.get(r.deltager_enhedsnummer) ?? `Person ${r.deltager_enhedsnummer}`,
      rolle: bestyrelsesTyper.has(r.type) ? 'Bestyrelse' : 'Direktion',
    });
    noeglePersonerMap.set(r.virksomhed_cvr, arr);
  }

  // Samle alle CVR'er vi skal hente related for (hierarki)
  const topLevelCvrs: string[] = [];

  for (const v of virksomheder) {
    const cvrStr = String(v.cvr);
    const companyId = `cvr-${cvrStr}`;
    if (nodeIds.has(companyId)) continue;

    const company = companyMap.get(cvrStr) ?? null;
    const propCount = propCountMap.get(cvrStr) ?? 0;

    // Formater roller fra API-response
    const rolleStr =
      v.roller
        ?.map((r) => [r.rolle, r.ejerandel].filter(Boolean).join(' '))
        .filter(Boolean)
        .slice(0, 2)
        .join(', ') ?? '';

    // BIZZ-1124: Nøglepersoner for denne virksomhed
    const keyPersons = noeglePersonerMap.get(cvrStr)?.slice(0, 5);

    // BIZZ-1118: Vis branche i sublabel
    const subParts = [company?.virksomhedsform, company?.branche_tekst].filter(Boolean);
    nodes.push({
      id: companyId,
      label: company?.navn ?? v.navn,
      sublabel: subParts.length > 0 ? subParts.join(' · ') : undefined,
      branche: company?.branche_tekst ?? undefined,
      type: 'company',
      cvr: v.cvr,
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null || !v.aktiv,
      expandableChildren: propCount > 0 ? propCount : undefined,
      personRolle: rolleStr || undefined,
      noeglePersoner: keyPersons && keyPersons.length > 0 ? keyPersons : undefined,
    });
    nodeIds.add(companyId);
    topLevelCvrs.push(cvrStr);

    edges.push({
      from: mainId,
      to: companyId,
      ejerandel: rolleStr || undefined,
    });
  }

  // BIZZ-1104/1108: Hent datterselskaber fra lokal cvr_deltagerrelation via ejer_cvr
  for (const parentCvr of topLevelCvrs.slice(0, 10)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: subRelRows } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('virksomhed_cvr')
      .eq('ejer_cvr', parentCvr)
      .is('gyldig_til', null)
      .limit(15);

    if (!subRelRows?.length) continue;
    const subCvrs = [
      ...new Set((subRelRows as Array<{ virksomhed_cvr: string }>).map((r) => r.virksomhed_cvr)),
    ];

    for (const subCvr of subCvrs.slice(0, 10)) {
      const subId = `cvr-${subCvr}`;
      const parentId = `cvr-${parentCvr}`;
      if (nodeIds.has(subId)) {
        if (!edges.some((e) => e.from === parentId && e.to === subId)) {
          edges.push({ from: parentId, to: subId, crossOwnership: true });
        }
        continue;
      }
      const subCompany = await fetchCachedCompany(admin, subCvr);
      const subProps = await fetchPropertiesByCvr(admin, subCvr);
      // BIZZ-1123: Inkluder branche_tekst i sublabel
      const subSublabelParts = [subCompany?.virksomhedsform, subCompany?.branche_tekst].filter(
        Boolean
      );
      nodes.push({
        id: subId,
        label: subCompany?.navn ?? `CVR ${subCvr}`,
        sublabel: subSublabelParts.length > 0 ? subSublabelParts.join(' · ') : undefined,
        branche: subCompany?.branche_tekst ?? undefined,
        type: 'company',
        cvr: Number(subCvr),
        link: `/dashboard/companies/${subCvr}`,
        isCeased: subCompany?.ophoert != null,
        expandableChildren: subProps.length > 0 ? subProps.length : undefined,
      });
      nodeIds.add(subId);
      edges.push({ from: parentId, to: subId });
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
      // BIZZ-1114: Skip noder der allerede har et client-supplied label (rootLabel)
      // — undgå at overskrive korrekt adresse med forkert BFE→DAWA mapping
      if (node.label && !node.label.startsWith('BFE ')) continue;

      const info = data[String(node.bfeNummer)];
      if (!info?.adresse) continue;
      // BIZZ-1103: Inkluder postnr+by i label (sublabel renderes ikke for property-noder)
      const etageStr = info.etage ? `, ${info.etage}.` : '';
      const doerStr = info.doer ? ` ${info.doer}` : '';
      const postStr = info.postnr && info.by ? `, ${info.postnr} ${info.by}` : '';
      node.label = `${info.adresse}${etageStr}${doerStr}${postStr}`;
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
  const label = searchParams.get('label'); // BIZZ-1114: client-supplied label for root node

  if (!type || !id) {
    return NextResponse.json({ graph: null, error: 'Missing type or id' }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    let graph: DiagramGraph;

    const proto = request.headers.get('x-forwarded-proto') ?? 'http';
    const reqHost = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
    const reqCookie = request.headers.get('cookie') ?? '';

    switch (type) {
      case 'company':
        graph = await resolveCompanyGraph(admin, id, reqHost, reqCookie);
        break;
      case 'property':
        graph = await resolvePropertyGraph(admin, Number(id), label);
        break;
      case 'person':
        graph = await resolvePersonGraph(admin, id, reqHost, reqCookie);
        break;
      default:
        return NextResponse.json({ graph: null, error: `Unknown type: ${type}` }, { status: 400 });
    }

    // Berig property-noder med adresser (best-effort)
    await enrichPropertyNodes(graph, reqHost, reqCookie);

    return NextResponse.json({ graph });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    void message;
    return NextResponse.json({ graph: null, error: 'Ekstern API fejl' }, { status: 500 });
  }
}
