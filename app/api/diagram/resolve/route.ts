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
 * Root = virksomheden. Ejere opad via ownership-typer, datterselskaber via cache.
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

    // Person-ejerandel er nice-to-have — skippes i cache-first (kræver live CVR ES)
    const personEjerandele = new Map<number, string>();

    // BIZZ-1125: Batch-beregn expandableChildren for person-noder.
    // Tæl virksomheder med interessenter/indehaver-rolle eller ejerandel_pct > 0,
    // plus personlige ejendomme — alt der IKKE allerede er i grafen.
    const personExpandCounts = new Map<number, number>();
    {
      // Virksomheder med ejerskabs-roller ELLER ejerandel > 0.
      // Matcher expand-routens filter: interessenter/indehaver altid,
      // + alle typer med ejerandel_pct > 0 (inkl. stifter med ejerandel).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: expandRels } = await (admin as any)
        .from('cvr_deltagerrelation')
        .select('deltager_enhedsnummer, virksomhed_cvr, type, ejerandel_pct')
        .in('deltager_enhedsnummer', enhedsNumre.slice(0, 20))
        .is('gyldig_til', null)
        .limit(500);
      for (const r of (expandRels ?? []) as Array<{
        deltager_enhedsnummer: number;
        virksomhed_cvr: string;
        type: string;
        ejerandel_pct: number | null;
      }>) {
        // Skip virksomheder allerede i grafen (inkl. main)
        if (r.virksomhed_cvr === cvr) continue;
        // Interessenter/indehaver tæller altid
        const isPersonlig = r.type === 'interessenter' || r.type === 'indehaver';
        // Alle typer med ejerandel > 0 tæller (inkl. stifter med ejerandel)
        const hasEjerandel = r.ejerandel_pct != null && r.ejerandel_pct > 0;
        if (!isPersonlig && !hasEjerandel) continue;
        personExpandCounts.set(
          r.deltager_enhedsnummer,
          (personExpandCounts.get(r.deltager_enhedsnummer) ?? 0) + 1
        );
      }
      // Personlige ejendomme via navne-match i ejf_ejerskab
      for (const [en] of Array.from(personRollerMap)) {
        const navn = navnMap.get(en);
        if (!navn) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { count: propCount } = await (admin as any)
          .from('ejf_ejerskab')
          .select('bfe_nummer', { count: 'exact', head: true })
          .eq('ejer_navn', navn)
          .eq('ejer_type', 'person')
          .eq('status', 'gældende');
        if (propCount && propCount > 0) {
          personExpandCounts.set(en, (personExpandCounts.get(en) ?? 0) + propCount);
        }
      }
    }

    for (const [en] of Array.from(personRollerMap)) {
      const ownerId = `en-${en}`;
      if (nodeIds.has(ownerId)) continue;
      const ownerNavn = navnMap.get(en) ?? `Person ${en}`;
      const expandable = personExpandCounts.get(en) ?? 0;
      nodes.push({
        id: ownerId,
        label: ownerNavn,
        type: 'person',
        enhedsNummer: en,
        link: `/dashboard/owners/${en}`,
        expandableChildren: expandable > 0 ? expandable : 0,
      });
      nodeIds.add(ownerId);
      edges.push({
        from: ownerId,
        to: mainId,
        ejerandel: personEjerandele.get(en) ?? undefined,
      });
    }
  }

  // 2b. BIZZ-1122: Ejerens personlige virksomheder (enkeltmand, I/S etc.)
  // Disse vises direkte under ejer-noden — ikke bag "Udvid".
  if (ownershipRows.length > 0) {
    const ownerEnheder = Array.from(new Set(ownershipRows.map((r) => r.deltager_enhedsnummer)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: personalCompRows } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('virksomhed_cvr, deltager_enhedsnummer, type')
      .in('deltager_enhedsnummer', ownerEnheder.slice(0, 5))
      .in('type', ['interessenter', 'indehaver'])
      .is('gyldig_til', null)
      .limit(20);

    if (personalCompRows?.length) {
      const personalCvrs = Array.from(
        new Set(
          (personalCompRows as Array<{ virksomhed_cvr: string; deltager_enhedsnummer: number }>)
            .map((r) => r.virksomhed_cvr)
            .filter((c) => c !== cvr && !nodeIds.has(`cvr-${c}`))
        )
      );

      if (personalCvrs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: personalComps } = await (admin as any)
          .from('cvr_virksomhed')
          .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
          .in('cvr', personalCvrs.slice(0, 10));

        // Hent ejendomsantal for at sætte expandableChildren korrekt
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: pcPropCounts } = await (admin as any)
          .from('ejf_ejerskab')
          .select('ejer_cvr')
          .in('ejer_cvr', personalCvrs.slice(0, 10))
          .eq('status', 'gældende');
        const pcPropMap = new Map<string, number>();
        for (const r of (pcPropCounts ?? []) as Array<{ ejer_cvr: string }>) {
          pcPropMap.set(r.ejer_cvr, (pcPropMap.get(r.ejer_cvr) ?? 0) + 1);
        }

        for (const pc of (personalComps ?? []) as Array<{
          cvr: string;
          navn: string;
          virksomhedsform: string | null;
          branche_tekst: string | null;
          ophoert: string | null;
        }>) {
          if (pc.ophoert != null) continue;
          const pcId = `cvr-${pc.cvr}`;
          if (nodeIds.has(pcId)) continue;
          const pcSubParts = [pc.virksomhedsform, pc.branche_tekst].filter(Boolean);
          // Find ejer-noden denne virksomhed tilhører
          // Personlige virksomheder vises som siblings af main (ikke under person)

          const pcPropCount = pcPropMap.get(pc.cvr) ?? 0;
          nodes.push({
            id: pcId,
            label: pc.navn,
            sublabel: pcSubParts.length > 0 ? pcSubParts.join(' · ') : undefined,
            branche: pc.branche_tekst ?? undefined,
            type: 'company',
            cvr: Number(pc.cvr),
            link: `/dashboard/companies/${pc.cvr}`,
            isCeased: false,
            // expandableChildren: 0 = ingen Udvid-knap, >0 = vis knap
            expandableChildren: pcPropCount > 0 ? pcPropCount : 0,
          });
          nodeIds.add(pcId);
          // Edge fra person-ejer — IT Management consulting kobles til Jakob,
          // ikke til JaJR Holding. DiagramForce placerer den på samme depth
          // som main via downward BFS fra person-noden (depth -1 + 1 = 0).
          const ownerRow = (
            personalCompRows as Array<{
              virksomhed_cvr: string;
              deltager_enhedsnummer: number;
            }>
          ).find((r) => r.virksomhed_cvr === pc.cvr);
          const personId = ownerRow ? `en-${ownerRow.deltager_enhedsnummer}` : mainId;
          edges.push({ from: personId, to: pcId });
        }
      }
    }
  }

  // 2c. Datterselskaber via cache (cvr_virksomhed_ejerskab)
  const MAX_TOTAL_NODES = 50;
  {
    // Nedad: hvad ejer denne virksomhed?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cachedSubs } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejet_cvr, ejerandel_min, ejerandel_max')
      .eq('ejer_cvr', cvr)
      .is('gyldig_til', null)
      .limit(30);

    const subCvrs = ((cachedSubs ?? []) as Array<{ ejet_cvr: string }>).map((r) => r.ejet_cvr);

    if (subCvrs.length > 0) {
      // Batch-hent virksomhedsinfo
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: subCompanies } = await (admin as any)
        .from('cvr_virksomhed')
        .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
        .in('cvr', subCvrs.slice(0, MAX_TOTAL_NODES));

      const subMap = new Map(
        (
          (subCompanies ?? []) as Array<{
            cvr: string;
            navn: string;
            virksomhedsform: string | null;
            branche_tekst: string | null;
            ophoert: string | null;
          }>
        ).map((c) => [c.cvr, c])
      );
      const ejerandelMap = new Map(
        (
          (cachedSubs ?? []) as Array<{
            ejet_cvr: string;
            ejerandel_min: number | null;
            ejerandel_max: number | null;
          }>
        ).map((r) => [
          r.ejet_cvr,
          r.ejerandel_min != null ? `${r.ejerandel_min}-${r.ejerandel_max}%` : undefined,
        ])
      );

      for (const subCvr of subCvrs) {
        if (nodes.length >= MAX_TOTAL_NODES) break;
        const subId = `cvr-${subCvr}`;
        if (nodeIds.has(subId)) continue;

        const cached = subMap.get(subCvr);
        if (cached?.ophoert != null) continue;

        const sublabelParts = [cached?.virksomhedsform, cached?.branche_tekst].filter(Boolean);
        nodes.push({
          id: subId,
          label: cached?.navn ?? `CVR ${subCvr}`,
          sublabel: sublabelParts.length > 0 ? sublabelParts.join(' · ') : undefined,
          branche: cached?.branche_tekst ?? undefined,
          type: 'company',
          cvr: Number(subCvr),
          link: `/dashboard/companies/${subCvr}`,
          isCeased: false,
        });
        nodeIds.add(subId);
        edges.push({
          from: mainId,
          to: subId,
          ejerandel: ejerandelMap.get(subCvr),
        });
      }

      // 2. niveau: hvad ejer datterselskaberne?
      if (subCvrs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: level2Subs } = await (admin as any)
          .from('cvr_virksomhed_ejerskab')
          .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
          .in('ejer_cvr', subCvrs.slice(0, 20))
          .is('gyldig_til', null)
          .limit(50);

        for (const l2 of (level2Subs ?? []) as Array<{
          ejer_cvr: string;
          ejet_cvr: string;
          ejerandel_min: number | null;
          ejerandel_max: number | null;
        }>) {
          if (nodes.length >= MAX_TOTAL_NODES) break;
          const l2Id = `cvr-${l2.ejet_cvr}`;
          const parentId = `cvr-${l2.ejer_cvr}`;
          if (nodeIds.has(l2Id)) continue;
          if (!nodeIds.has(parentId)) continue;

          // Hent virksomhedsinfo — forsøg batch-map først, ellers enkelt-query
          let l2Info = subMap.get(l2.ejet_cvr) as
            | {
                navn: string;
                virksomhedsform: string | null;
                branche_tekst: string | null;
                ophoert: string | null;
              }
            | undefined;
          if (!l2Info) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data } = await (admin as any)
              .from('cvr_virksomhed')
              .select('navn, virksomhedsform, branche_tekst, ophoert')
              .eq('cvr', l2.ejet_cvr)
              .maybeSingle();
            l2Info = data ?? undefined;
          }
          if (l2Info?.ophoert != null) continue;

          const l2SubParts = [l2Info?.virksomhedsform, l2Info?.branche_tekst].filter(Boolean);
          nodes.push({
            id: l2Id,
            label: l2Info?.navn ?? `CVR ${l2.ejet_cvr}`,
            sublabel: l2SubParts.length > 0 ? l2SubParts.join(' · ') : undefined,
            branche: l2Info?.branche_tekst ?? undefined,
            type: 'company',
            cvr: Number(l2.ejet_cvr),
            link: `/dashboard/companies/${l2.ejet_cvr}`,
            isCeased: false,
          });
          nodeIds.add(l2Id);
          edges.push({
            from: parentId,
            to: l2Id,
            ejerandel:
              l2.ejerandel_min != null ? `${l2.ejerandel_min}-${l2.ejerandel_max}%` : undefined,
          });
        }
      }
    }
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

  // Beregn expandableChildren for ALLE virksomheder i grafen.
  // Checker cvr_virksomhed_ejerskab for ejere/datterselskaber der IKKE allerede
  // er i grafen. Noder med 0 ekspanderbare = ingen Udvid-knap.
  const allCompanyNodes = nodes.filter((n) => (n.type === 'company' || n.type === 'main') && n.cvr);
  if (allCompanyNodes.length > 0) {
    const allCvrList = allCompanyNodes.map((n) => String(n.cvr));
    // Ejere opad: hvem ejer disse virksomheder men er IKKE i grafen?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ownerCounts } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejet_cvr, ejer_cvr')
      .in('ejet_cvr', allCvrList)
      .is('gyldig_til', null);
    // Datterselskaber nedad: hvad ejer disse men er IKKE i grafen?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: subCounts } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejer_cvr, ejet_cvr')
      .in('ejer_cvr', allCvrList)
      .is('gyldig_til', null);

    // Tæl noder IKKE allerede i grafen per CVR
    const expandMap = new Map<string, number>();
    for (const r of (ownerCounts ?? []) as Array<{ ejet_cvr: string; ejer_cvr: string }>) {
      if (nodeIds.has(`cvr-${r.ejer_cvr}`)) continue;
      expandMap.set(r.ejet_cvr, (expandMap.get(r.ejet_cvr) ?? 0) + 1);
    }
    for (const r of (subCounts ?? []) as Array<{ ejer_cvr: string; ejet_cvr: string }>) {
      if (nodeIds.has(`cvr-${r.ejet_cvr}`)) continue;
      expandMap.set(r.ejer_cvr, (expandMap.get(r.ejer_cvr) ?? 0) + 1);
    }

    // Sæt expandableChildren på alle virksomheds-noder
    for (const node of allCompanyNodes) {
      if (node.type === 'main') continue; // main har aldrig Udvid
      const cvrStr = String(node.cvr);
      const count = expandMap.get(cvrStr) ?? 0;
      // Behold eksisterende expandableChildren (fx ejendomme) men tilføj ejerskab
      const existing = node.expandableChildren ?? 0;
      node.expandableChildren = existing + count > 0 ? existing + count : 0;
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
      // Forsøg at resolve enhedsNummer fra cvr_deltager for at muliggøre expand
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: deltagerMatch } = await (admin as any)
        .from('cvr_deltager')
        .select('enhedsnummer')
        .eq('navn', owner.ejer_navn)
        .limit(1)
        .maybeSingle();
      const personEn: number | undefined = deltagerMatch?.enhedsnummer ?? undefined;
      const ownerId = personEn
        ? `en-${personEn}`
        : `person-${owner.ejer_navn.replace(/\s+/g, '-').toLowerCase()}`;
      if (!nodeIds.has(ownerId)) {
        nodes.push({
          id: ownerId,
          label: owner.ejer_navn,
          type: 'person',
          enhedsNummer: personEn,
          link: personEn ? `/dashboard/owners/${personEn}` : undefined,
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
 * Root = personen. Henter virksomheder fra cvr_deltagerrelation cache.
 * Ejendomme hentes fra ejf_ejerskab cache.
 *
 * @param admin - Supabase admin client
 * @param enhedsNummer - Personens enhedsNummer
 * @returns DiagramGraph
 */
async function resolvePersonGraph(
  admin: ReturnType<typeof createAdminClient>,
  enhedsNummer: string
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

  // Cache-first: personens virksomheder via cvr_deltagerrelation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: personRelRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, type')
    .eq('deltager_enhedsnummer', Number(enhedsNummer))
    .is('gyldig_til', null)
    .limit(50);

  // Dedup CVR'er og gruppér roller per virksomhed
  const personVirkRollerMap = new Map<string, string[]>();
  for (const r of (personRelRows ?? []) as Array<{ virksomhed_cvr: string; type: string }>) {
    const arr = personVirkRollerMap.get(r.virksomhed_cvr) ?? [];
    arr.push(r.type);
    personVirkRollerMap.set(r.virksomhed_cvr, arr);
  }
  const allCvrs = Array.from(personVirkRollerMap.keys());
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

  // BIZZ-1135: Find ejerskab MELLEM personens virksomheder for hierarkisk layout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: interOwnershipRows } = await (admin as any)
    .from('cvr_virksomhed_ejerskab')
    .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
    .in('ejer_cvr', allCvrs.slice(0, 50))
    .in('ejet_cvr', allCvrs.slice(0, 50))
    .is('gyldig_til', null);

  // Byg parent-map: child CVR → parent CVR (kun inden for personens virksomheder)
  const parentOfCvr = new Map<string, string>();
  const childrenOfCvr = new Map<string, Array<{ cvr: string; ejerandel?: string }>>();
  for (const row of (interOwnershipRows ?? []) as Array<{
    ejer_cvr: string;
    ejet_cvr: string;
    ejerandel_min: number | null;
    ejerandel_max: number | null;
  }>) {
    if (parentOfCvr.has(row.ejet_cvr)) continue; // første parent vinder
    parentOfCvr.set(row.ejet_cvr, row.ejer_cvr);
    const children = childrenOfCvr.get(row.ejer_cvr) ?? [];
    children.push({
      cvr: row.ejet_cvr,
      ejerandel:
        row.ejerandel_min != null ? `${row.ejerandel_min}-${row.ejerandel_max}%` : undefined,
    });
    childrenOfCvr.set(row.ejer_cvr, children);
  }

  // Opret noder for ALLE virksomheder, men kun top-level edges til personen
  const topLevelCvrs: string[] = [];

  for (const cvrStr of allCvrs) {
    const companyId = `cvr-${cvrStr}`;
    if (nodeIds.has(companyId)) continue;

    const company = companyMap.get(cvrStr) ?? null;
    const propCount = propCountMap.get(cvrStr) ?? 0;

    const roller = personVirkRollerMap.get(cvrStr) ?? [];
    const rolleStr = roller.slice(0, 2).join(', ');

    const keyPersons = noeglePersonerMap.get(cvrStr)?.slice(0, 5);
    const subParts = [company?.virksomhedsform, company?.branche_tekst].filter(Boolean);

    nodes.push({
      id: companyId,
      label: company?.navn ?? `CVR ${cvrStr}`,
      sublabel: subParts.length > 0 ? subParts.join(' · ') : undefined,
      branche: company?.branche_tekst ?? undefined,
      type: 'company',
      cvr: Number(cvrStr),
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null,
      expandableChildren: propCount > 0 ? propCount : undefined,
      personRolle: rolleStr || undefined,
      noeglePersoner: keyPersons && keyPersons.length > 0 ? keyPersons : undefined,
    });
    nodeIds.add(companyId);

    // BIZZ-1135: Kun top-level virksomheder (uden parent i grafen) forbindes
    // direkte til personen. Child-virksomheder forbindes via parent nedenfor.
    if (!parentOfCvr.has(cvrStr)) {
      topLevelCvrs.push(cvrStr);
      // BIZZ-1135: Person→virksomhed edge viser IKKE rolletekst (den vises
      // på noden via personRolle). Kun ejerskabs-edges viser ejerandel%.
      edges.push({ from: mainId, to: companyId });
    }
  }

  // Tilføj parent→child ejerskabs-edges
  for (const [parentCvr, children] of childrenOfCvr) {
    const parentId = `cvr-${parentCvr}`;
    if (!nodeIds.has(parentId)) continue;
    for (const child of children) {
      const childId = `cvr-${child.cvr}`;
      if (!nodeIds.has(childId)) continue;
      edges.push({
        from: parentId,
        to: childId,
        ejerandel: child.ejerandel,
      });
    }
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
      ...Array.from(
        new Set((subRelRows as Array<{ virksomhed_cvr: string }>).map((r) => r.virksomhed_cvr))
      ),
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
        graph = await resolveCompanyGraph(admin, id);
        break;
      case 'property':
        graph = await resolvePropertyGraph(admin, Number(id), label);
        break;
      case 'person':
        graph = await resolvePersonGraph(admin, id);
        break;
      default:
        return NextResponse.json({ graph: null, error: `Unknown type: ${type}` }, { status: 400 });
    }

    // Berig virksomheds-noder uden navn med live CVR API (best-effort fallback)
    const namelessCompanies = graph.nodes.filter(
      (n) => (n.type === 'company' || n.type === 'main') && n.cvr && n.label.startsWith('CVR ')
    );
    if (namelessCompanies.length > 0) {
      await Promise.all(
        namelessCompanies.map(async (node) => {
          try {
            const cvrRes = await fetch(`${reqHost}/api/cvr/${node.cvr}`, {
              headers: { cookie: reqCookie },
              signal: AbortSignal.timeout(5000),
            });
            if (cvrRes.ok) {
              const cvrData = await cvrRes.json();
              if (cvrData?.navn) {
                node.label = cvrData.navn;
                const subParts = [cvrData.selskabsform, cvrData.branche].filter(Boolean);
                if (subParts.length > 0) node.sublabel = subParts.join(' · ');
                if (cvrData.branche) node.branche = cvrData.branche;
                if (cvrData.slutdato) node.isCeased = true;

                // Option B: On-demand writeback — gem i cvr_virksomhed cache
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                void (admin as any)
                  .from('cvr_virksomhed')
                  .upsert(
                    {
                      cvr: String(node.cvr),
                      navn: cvrData.navn,
                      virksomhedsform: cvrData.selskabsform ?? null,
                      branche_tekst: cvrData.branche ?? null,
                      ophoert: cvrData.slutdato ?? null,
                      sidst_hentet_fra_cvr: new Date().toISOString(),
                    },
                    { onConflict: 'cvr' }
                  )
                  .then(() => {});
              }
            }
          } catch {
            // Best-effort — beholder "CVR XXXXXXXX" label ved fejl
          }
        })
      );
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
