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
import { logger } from '@/app/lib/logger';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import type { DiagramNode, DiagramEdge, DiagramGraph } from '@/app/components/diagrams/DiagramData';

/** Max ejendomme per ejer-node i initial graf */
const MAX_PROPS_PER_OWNER = 15;

/**
 * Formatér ejerandel fra min/max til læsbar streng.
 * "100%" når min===max, "25-50%" ved range, undefined når ukendt.
 */
function formatEjerandelRange(
  min: number | null | undefined,
  max: number | null | undefined
): string | undefined {
  if (min == null) return undefined;
  if (max == null || min === max) return `${min}%`;
  return `${min}-${max}%`;
}

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
async function _fetchPropertiesByCvr(
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
 * BIZZ-1743: Hent ejendomme administreret af et CVR fra ejf_administrator.
 *
 * @param admin - Supabase admin client
 * @param cvr - CVR-nummer for administrator-virksomhed
 * @returns Array af administrerede BFE-numre
 */
async function _fetchAdministeredByCvr(
  admin: ReturnType<typeof createAdminClient>,
  cvr: string
): Promise<Array<{ bfe_nummer: number }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('ejf_administrator')
    .select('bfe_nummer')
    .eq('virksomhed_cvr', cvr)
    .eq('status', 'gældende')
    .limit(50);
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
    ejer_enheds_nummer: number | null;
  }>
> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from('ejf_ejerskab')
    .select(
      'ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner, ejer_enheds_nummer'
    )
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

  // 1b. BIZZ-1202: Virksomheds-ejere opad (fra cvr_virksomhed_ejerskab).
  // Viser moderselskaber der ejer main-virksomheden — supplerer person-ejere.
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: parentOwners } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejer_cvr, ejerandel_min, ejerandel_max')
      .eq('ejet_cvr', cvr)
      .is('gyldig_til', null)
      .limit(10);

    if (parentOwners?.length) {
      const parentCvrs = (parentOwners as Array<{ ejer_cvr: string }>)
        .map((r) => r.ejer_cvr)
        .filter((c) => !nodeIds.has(`cvr-${c}`));

      if (parentCvrs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: parentComps } = await (admin as any)
          .from('cvr_virksomhed')
          .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
          .in('cvr', parentCvrs.slice(0, 10));

        const parentMap = new Map(
          (
            (parentComps ?? []) as Array<{
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
            (parentOwners ?? []) as Array<{
              ejer_cvr: string;
              ejerandel_min: number | null;
              ejerandel_max: number | null;
            }>
          ).map((r) => [r.ejer_cvr, formatEjerandelRange(r.ejerandel_min, r.ejerandel_max)])
        );

        for (const pCvr of parentCvrs) {
          const pId = `cvr-${pCvr}`;
          if (nodeIds.has(pId)) continue;
          const pc = parentMap.get(pCvr);
          const sublabelParts = [pc?.virksomhedsform, `CVR ${pCvr}`].filter(Boolean);
          nodes.push({
            id: pId,
            label: pc?.navn ?? `CVR ${pCvr}`,
            sublabel: sublabelParts.join(' · '),
            branche: pc?.branche_tekst ?? undefined,
            type: 'company',
            cvr: Number(pCvr),
            link: `/dashboard/companies/${pCvr}`,
            isCeased: pc?.ophoert != null,
          });
          nodeIds.add(pId);
          edges.push({
            from: pId,
            to: mainId,
            ejerandel: ejerandelMap.get(pCvr),
          });
        }
      }
    }
  }

  // 2. BIZZ-1108/1122: Hent EJERE (opad) — kun ownership-typer, ikke bestyrelse/direktion
  // BIZZ-1680: Kun hent person-ejere for main + parent-virksomheder (opad).
  // IKKE for datterselskaber — ellers vises irrelevante ejere fra andre koncerner.
  const companyCvrsInGraph = [
    cvr,
    ...nodes.filter((n) => n.cvr && n.id !== mainId).map((n) => String(n.cvr)),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: ownerRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('deltager_enhedsnummer, type, virksomhed_cvr, ejerandel_pct')
    .in('virksomhed_cvr', companyCvrsInGraph.slice(0, 10))
    .is('gyldig_til', null)
    .limit(100);

  // Filtrer til ownership-typer
  const ownershipRows = (ownerRows ?? []).filter((r: { type: string }) =>
    OWNERSHIP_TYPES.has(r.type)
  ) as Array<{
    deltager_enhedsnummer: number;
    type: string;
    virksomhed_cvr: string;
    ejerandel_pct: number | null;
  }>;

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

    // Gruppér roller per deltager + track hvilke virksomheder de ejer
    const personRollerMap = new Map<number, string[]>();
    // BIZZ-1317: Track person→virksomhed relationer (kan have flere targets)
    const personTargets = new Map<number, Set<string>>();
    for (const r of ownershipRows) {
      const arr = personRollerMap.get(r.deltager_enhedsnummer) ?? [];
      arr.push(r.type);
      personRollerMap.set(r.deltager_enhedsnummer, arr);
      const targets = personTargets.get(r.deltager_enhedsnummer) ?? new Set();
      targets.add(r.virksomhed_cvr);
      personTargets.set(r.deltager_enhedsnummer, targets);
    }

    // BIZZ-1680: Populér person-ejerandel fra cvr_deltagerrelation
    const personEjerandele = new Map<number, string>();
    for (const r of ownershipRows) {
      if (r.ejerandel_pct != null && r.ejerandel_pct > 0) {
        personEjerandele.set(r.deltager_enhedsnummer, `${r.ejerandel_pct}%`);
      }
    }

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
      const ownerNavn = navnMap.get(en);
      // BIZZ-1202: Skip person-noder uden navn der kun har register-type.
      // Disse er typisk holdingselskaber registreret via enhedsnummer i
      // Ejerregisteret — de vises allerede som virksomheds-ejere via
      // cvr_virksomhed_ejerskab (step 1b). Viser "Person 4010065318" er
      // forvirrende og forkert.
      if (!ownerNavn) {
        const roller = personRollerMap.get(en) ?? [];
        const onlyRegister = roller.every((r) => r === 'register' || r === 'reel_ejer');
        if (onlyRegister) continue;
      }
      const expandable = personExpandCounts.get(en) ?? 0;
      nodes.push({
        id: ownerId,
        label: ownerNavn ?? `Person ${en}`,
        type: 'person',
        enhedsNummer: en,
        link: `/dashboard/owners/${en}`,
        expandableChildren: expandable > 0 ? expandable : 0,
      });
      nodeIds.add(ownerId);
      // BIZZ-1317: Opret edges til ALLE virksomheder personen ejer (inkl. parents)
      const targets = personTargets.get(en) ?? new Set([cvr]);
      for (const targetCvr of targets) {
        const targetId = `cvr-${targetCvr}`;
        if (nodeIds.has(targetId)) {
          edges.push({
            from: ownerId,
            to: targetId,
            ejerandel: personEjerandele.get(en) ?? undefined,
          });
        }
      }
    }
  }

  // BIZZ-1680: Enkeltmandsvirksomheder vises IKKE i initial diagram.
  // De er ikke direkte relateret til hovedvirksomhedens ejerskabsstruktur.
  // Vises kun via "Udvid"-knap på person-noder (expandableChildren).

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

    // BIZZ-1680: Filtrer datterselskaber hvor main har NULL-ejerandel men en
    // ANDEN virksomhed har reel ejerandel → main's entry er sandsynligvis historisk.
    const rawSubs = (cachedSubs ?? []) as Array<{
      ejet_cvr: string;
      ejerandel_min: number | null;
      ejerandel_max: number | null;
    }>;
    const subsWithAndel = rawSubs.filter((r) => r.ejerandel_min != null);
    const subsWithoutAndel = rawSubs.filter((r) => r.ejerandel_min == null);

    // For subs uden ejerandel: tjek om en ANDEN virksomhed har reel ejerandel
    const validSubsWithoutAndel: typeof subsWithoutAndel = [];
    if (subsWithoutAndel.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: otherOwners } = await (admin as any)
        .from('cvr_virksomhed_ejerskab')
        .select('ejet_cvr, ejer_cvr, ejerandel_min')
        .in(
          'ejet_cvr',
          subsWithoutAndel.map((r) => r.ejet_cvr)
        )
        .not('ejerandel_min', 'is', null)
        .is('gyldig_til', null)
        .limit(100);

      const hasRealOwner = new Set(
        ((otherOwners ?? []) as Array<{ ejet_cvr: string }>).map((r) => r.ejet_cvr)
      );
      for (const sub of subsWithoutAndel) {
        if (!hasRealOwner.has(sub.ejet_cvr)) {
          // Ingen anden ejer med reel ejerandel → behold (ægte datterselskab)
          validSubsWithoutAndel.push(sub);
        }
        // Ellers: en anden virksomhed ejer den med reel andel → main's entry er historisk
      }
    }

    const filteredSubs = [...subsWithAndel, ...validSubsWithoutAndel];
    const subCvrs = filteredSubs.map((r) => r.ejet_cvr);

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
          filteredSubs as Array<{
            ejet_cvr: string;
            ejerandel_min: number | null;
            ejerandel_max: number | null;
          }>
        ).map((r) => [r.ejet_cvr, formatEjerandelRange(r.ejerandel_min, r.ejerandel_max)])
      );

      // BIZZ-1680: Vis direkte datterselskaber (niveau 1) — med eller uden ejerandel.
      for (const subCvr of subCvrs) {
        if (nodes.length >= MAX_TOTAL_NODES) break;
        const subId = `cvr-${subCvr}`;
        if (nodeIds.has(subId)) continue;

        const cached = subMap.get(subCvr);
        if (cached?.ophoert != null) continue;
        const andel = ejerandelMap.get(subCvr);

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
          ejerandel: andel,
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

        // BIZZ-1680: Kun level 2 med faktisk ejerandel
        for (const l2 of (level2Subs ?? []) as Array<{
          ejer_cvr: string;
          ejet_cvr: string;
          ejerandel_min: number | null;
          ejerandel_max: number | null;
        }>) {
          if (nodes.length >= MAX_TOTAL_NODES) break;
          if (l2.ejerandel_min == null) continue; // Kun med registreret ejerandel
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
            ejerandel: formatEjerandelRange(l2.ejerandel_min, l2.ejerandel_max),
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
          // BIZZ-1647: Inkluder bfeNummer så enrichPropertyNodes kan resolve adresser
          overflowItems: props
            .slice(MAX_PROPS_PER_OWNER)
            .map((p) => ({ label: `BFE ${p.bfe_nummer}`, bfeNummer: p.bfe_nummer })),
        });
        nodeIds.add(overflowId);
        edges.push({ from: compNode.id, to: overflowId });
      }
    }
  }

  // 3b. BIZZ-1645: Ejerforening (FFO) — vis ejerlejligheder under SFE
  // Når virksomheden er en ejerforening, tilføj ejerlejligheder som children
  // af SFE-ejendommen for at vise ejendomsstrukturen.
  if (
    company?.virksomhedsform?.toUpperCase().includes('FFO') ||
    company?.virksomhedsform?.toLowerCase().includes('forening')
  ) {
    const sfeNodes = nodes.filter((n) => n.type === 'property' && n.bfeNummer);
    for (const sfeNode of sfeNodes.slice(0, 3)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: lejRows } = await (admin as any)
          .from('ejf_ejerskab')
          .select('bfe_nummer, ejer_navn, ejer_type, ejerandel_taeller, ejerandel_naevner')
          .eq('status', 'gældende')
          .neq('ejer_cvr', cvr)
          .limit(20);

        // Filtrer til kun lejligheder under denne SFE (approximate: same BFE-range)
        // Bedre approach: brug ejendom-struktur API, men det kræver DAWA lookup
        // For nu: vis lejligheder fra ejf_ejerskab der er person-ejede
        const personEjere = (lejRows ?? [])
          .filter((r: Record<string, unknown>) => r.ejer_type === 'person')
          .slice(0, 10);

        if (personEjere.length > 0) {
          // Tilføj "X ejerlejligheder" status-node under SFE
          const lejId = `lejligheder-${sfeNode.id}`;
          if (!nodeIds.has(lejId)) {
            nodes.push({
              id: lejId,
              label: `${personEjere.length} ejerlejligheder`,
              type: 'status',
            });
            nodeIds.add(lejId);
            edges.push({ from: sfeNode.id, to: lejId });
          }
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  // BIZZ-1672: Administrator-data vises KUN som kort over ejertabellen
  // på ejendomssiden — IKKE som noder i virksomhedsdiagrammet.

  // 4. BIZZ-1082: Personlige ejendomme for ALLE top-level ejere.
  // Henter properties fra ejf_ejerskab per person-navn. Dedup: hvis BFE
  // allerede er i grafen (fx ejet via virksomhed), tilføj kun edge — ikke node.
  // Farve-koder edges per person for visuel distinktion af fælles ejerskab.
  // BIZZ-1285: Reduceret opacity fra 0.75 til 0.65 så personlige ejendomme
  // matcher normale ejendomslinjer i stedet for at skille sig visuelt ud.
  const OWNER_COLORS = [
    'rgba(52,211,153,0.65)', // emerald — person 1
    'rgba(167,139,250,0.65)', // violet  — person 2
    'rgba(251,191,36,0.65)', // amber   — person 3
    'rgba(248,113,113,0.65)', // red     — person 4
    'rgba(34,211,238,0.65)', // cyan    — person 5
  ];
  const personNodes = nodes.filter((n) => n.type === 'person' && n.enhedsNummer);
  if (personNodes.length > 0) {
    // Batch-fetch personlige ejendomme for alle person-ejere
    const personNavne = new Map<string, string>();
    for (const pn of personNodes) {
      personNavne.set(pn.id, pn.label);
    }

    for (let pi = 0; pi < personNodes.length; pi++) {
      const pNode = personNodes[pi];
      const ownerColor = OWNER_COLORS[pi % OWNER_COLORS.length];
      const navn = personNavne.get(pNode.id);
      if (!navn) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: personProps } = await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
        .eq('ejer_navn', navn)
        .eq('ejer_type', 'person')
        .eq('status', 'gældende')
        .limit(MAX_PROPS_PER_OWNER + 1);

      for (const pp of (personProps ?? []) as Array<{
        bfe_nummer: number;
        ejerandel_taeller: number | null;
        ejerandel_naevner: number | null;
      }>) {
        const propId = `bfe-${pp.bfe_nummer}`;
        // Dedup: tilføj kun node hvis den ikke allerede er i grafen
        if (!nodeIds.has(propId)) {
          nodes.push({
            id: propId,
            label: `BFE ${pp.bfe_nummer}`,
            type: 'property',
            bfeNummer: pp.bfe_nummer,
          });
          nodeIds.add(propId);
        }
        bfesInGraph.add(pp.bfe_nummer);
        edges.push({
          from: pNode.id,
          to: propId,
          ejerandel: formatEjerandel(pp.ejerandel_taeller, pp.ejerandel_naevner),
          personallyOwned: true,
          ownerPersonId: pNode.id,
          ownerColor,
        });
      }
    }
  }

  // Kryds-ejerskab: tegn edges mellem virksomheder der BEGGE allerede er i grafen
  // men som mangler en edge (fx PEI Holding → Pharma IT ManCo).
  // BIZZ-1680: Beregn expandableChildren for datterselskaber.
  // Kryds-ejerskab og person-ejere for datterselskaber FJERNET —
  // de tilføjede irrelevante noder fra andre koncerner.
  // Kun nedadgående hierarki fra main vises. "Udvid" viser resten.
  const allCompanyNodes = nodes.filter((n) => (n.type === 'company' || n.type === 'main') && n.cvr);
  if (allCompanyNodes.length > 0) {
    const allCvrList = allCompanyNodes.map((n) => String(n.cvr));

    // BIZZ-1680: Person-ejere og kryds-ejerskab for datterselskaber FJERNET.
    // Viste irrelevante ejere fra andre koncerner (SqWI, PEI, Billeschou etc.).
    // Kun ejere af main (step 2) og parents (step 1b) vises i initial diagram.

    // Beregn expandableChildren for ALLE virksomheder i grafen.
    // Checker cvr_virksomhed_ejerskab for ejere/datterselskaber der IKKE allerede
    // er i grafen. Noder med 0 ekspanderbare = ingen Udvid-knap.

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

    // Sæt expandableChildren på alle virksomheds-noder (inkl. main)
    for (const node of allCompanyNodes) {
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

  // Ejere — cache-first via ejf_ejerskab, live EJF fallback ved tom liste
  let owners = await fetchOwnersByBfe(admin, bfe);

  // BIZZ-1136: Fallback til live EJF GraphQL når ejf_ejerskab er tom
  // (typisk for "opdelt i anpart/ejerlejligheder" ejendomme hvor
  // ingest-ejf-bulk filtrerer status-tekst entries fra).
  if (owners.length === 0) {
    try {
      const ejfToken = await getSharedOAuthToken();
      if (ejfToken) {
        const virkningstid = new Date().toISOString();
        const ejfQuery = `{
          EJFCustom_EjerskabBegraenset(
            first: 500
            virkningstid: "${virkningstid}"
            where: { bestemtFastEjendomBFENr: { eq: ${bfe} } }
          ) {
            nodes {
              bestemtFastEjendomBFENr
              ejendeVirksomhedCVRNr
              ejendePersonBegraenset { navn { navn } }
              ejerforholdskode
              faktiskEjerandel_taeller
              faktiskEjerandel_naevner
              status
              virkningFra
            }
          }
        }`;
        const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';
        const ejfRes = await fetch(proxyUrl(EJF_GQL_URL), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ejfToken}`,
            ...proxyHeaders(),
          },
          body: JSON.stringify({ query: ejfQuery }),
          signal: AbortSignal.timeout(proxyTimeout()),
        });
        if (ejfRes.ok) {
          const ejfJson = (await ejfRes.json()) as {
            data?: {
              EJFCustom_EjerskabBegraenset?: {
                nodes?: Array<{
                  ejendeVirksomhedCVRNr: number | null;
                  ejendePersonBegraenset: { navn: { navn: string } } | null;
                  ejerforholdskode: string | null;
                  faktiskEjerandel_taeller: number | null;
                  faktiskEjerandel_naevner: number | null;
                  status: string | null;
                }>;
              };
            };
          };
          const ejfNodes = ejfJson.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
          // Mapper til samme format som fetchOwnersByBfe
          // Inkl. pvoplys-ejere (dødsboer, udenlandske, fonde) som har
          // hverken CVR eller personNavn — de får ejer_type='person'
          // og bruger ejerforholdskode som fallback-label.
          owners = ejfNodes
            .filter((n) => n.status === 'Gældende' || n.status === 'gældende')
            .map((n) => {
              const personNavn = n.ejendePersonBegraenset?.navn?.navn ?? null;
              const cvr = n.ejendeVirksomhedCVRNr;
              // Ejerforholdskode-tekst til fallback-label for pvoplys
              // Detect status-tekst entries (opdelt i anpart/ejerlejligheder)
              // Disse har hverken CVR eller personNavn
              const isStatus = !cvr && !personNavn;
              return {
                ejer_navn:
                  personNavn ?? (cvr ? `CVR ${cvr}` : isStatus ? 'Opdelt ejerskab' : 'Ukendt ejer'),
                ejer_cvr: cvr ? String(cvr) : null,
                ejer_type: cvr ? 'virksomhed' : isStatus ? 'status' : 'person',
                ejerandel_taeller: n.faktiskEjerandel_taeller,
                ejerandel_naevner: n.faktiskEjerandel_naevner,
                ejer_enheds_nummer: null,
              };
            });
          if (owners.length > 0) {
            logger.log(
              `[diagram/resolve] EJF live fallback fandt ${owners.length} ejere for BFE ${bfe}`
            );
          }
        }
      }
    } catch (err) {
      logger.warn('[diagram/resolve] EJF live fallback fejl:', err);
    }
  }

  // BIZZ-1210: Batch-hent virksomheder og person-navne i stedet for N+1 queries
  const companyCvrs = owners
    .filter((o) => o.ejer_type === 'virksomhed' && o.ejer_cvr)
    .map((o) => o.ejer_cvr!);
  // BIZZ-1350: Brug ejer_enheds_nummer direkte når tilgængeligt; fallback til navne-match
  const personOwners = owners.filter((o) => o.ejer_type === 'person');
  const personNavne = personOwners.filter((o) => !o.ejer_enheds_nummer).map((o) => o.ejer_navn);
  const directEnNumre = personOwners
    .filter((o) => o.ejer_enheds_nummer != null)
    .map((o) => o.ejer_enheds_nummer!);

  // Batch: virksomhedsinfo + ejendomsantal + deltager-navne
  const [companyBatchResult, propCountResult, deltagerBatchResult, directDeltagerResult] =
    await Promise.all([
      companyCvrs.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any)
            .from('cvr_virksomhed')
            .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
            .in('cvr', companyCvrs.slice(0, 20))
        : Promise.resolve({ data: [] }),
      companyCvrs.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any)
            .from('ejf_ejerskab')
            .select('ejer_cvr')
            .in('ejer_cvr', companyCvrs.slice(0, 20))
            .eq('status', 'gældende')
        : Promise.resolve({ data: [] }),
      personNavne.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any)
            .from('cvr_deltager')
            .select('enhedsnummer, navn')
            .in('navn', personNavne.slice(0, 20))
        : Promise.resolve({ data: [] }),
      // BIZZ-1350: Hent faktiske navne for person-ejere med direkte enhedsNummer-link
      directEnNumre.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (admin as any)
            .from('cvr_deltager')
            .select('enhedsnummer, navn')
            .in('enhedsnummer', directEnNumre.slice(0, 30))
        : Promise.resolve({ data: [] }),
    ]);

  // Byg lookup-maps
  const companyMap = new Map(
    (
      (companyBatchResult.data ?? []) as Array<{
        cvr: string;
        navn: string;
        virksomhedsform: string | null;
        branche_tekst: string | null;
        ophoert: string | null;
      }>
    ).map((c) => [c.cvr, c])
  );
  const propCountMap = new Map<string, number>();
  for (const r of (propCountResult.data ?? []) as Array<{ ejer_cvr: string }>) {
    propCountMap.set(r.ejer_cvr, (propCountMap.get(r.ejer_cvr) ?? 0) + 1);
  }
  // Navne-baseret fallback-map
  const deltagerMap = new Map(
    ((deltagerBatchResult.data ?? []) as Array<{ enhedsnummer: number; navn: string }>).map((d) => [
      d.navn,
      d.enhedsnummer,
    ])
  );
  // BIZZ-1350: enhedsNummer → faktisk navn map (for "Ukendt ejer" → rigtigt navn)
  const enToNameMap = new Map(
    ((directDeltagerResult.data ?? []) as Array<{ enhedsnummer: number; navn: string }>).map(
      (d) => [d.enhedsnummer, d.navn]
    )
  );

  for (const owner of owners) {
    if (owner.ejer_type === 'virksomhed' && owner.ejer_cvr) {
      const ownerId = `cvr-${owner.ejer_cvr}`;
      if (!nodeIds.has(ownerId)) {
        const company = companyMap.get(owner.ejer_cvr) ?? null;
        const totalProps = propCountMap.get(owner.ejer_cvr) ?? 0;
        const expandable = Math.max(0, totalProps - 1); // minus nuværende BFE

        const companyLabel = company?.navn ?? owner.ejer_navn ?? `CVR ${owner.ejer_cvr}`;
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
      // BIZZ-1350: Brug ejer_enheds_nummer direkte; fallback til navne-match
      const personEn: number | undefined =
        owner.ejer_enheds_nummer ?? deltagerMap.get(owner.ejer_navn) ?? undefined;
      const ownerId = personEn
        ? `en-${personEn}`
        : `person-${owner.ejer_navn.replace(/\s+/g, '-').toLowerCase()}`;
      if (!nodeIds.has(ownerId)) {
        // Brug faktisk navn fra cvr_deltager når ejer_navn er generisk
        const resolvedName =
          personEn && enToNameMap.has(personEn) ? enToNameMap.get(personEn)! : owner.ejer_navn;
        nodes.push({
          id: ownerId,
          label: resolvedName,
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
    } else if (owner.ejer_type === 'status') {
      // Status-tekst: "Opdelt i anpart", "Opdelt i ejerlejligheder" etc.
      // Vises som status-node (grå) i stedet for person-node
      const ownerId = `status-${nodes.length}`;
      if (!nodeIds.has(ownerId)) {
        nodes.push({
          id: ownerId,
          label: owner.ejer_navn,
          type: 'status',
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

  // ── BIZZ-1139: CVR ES fallback for person-ejere uden enhedsNummer ───────
  // cvr_deltager dækker kun cached deltagere. CVR ES deltager/_search har
  // alle registrerede deltagere og giver højere hit-rate.
  //
  // BIZZ-1540: Udvidet til også at re-resolve nodes der HAR enhedsNummer men
  // mangler navn (label er placeholder som "Person N" eller "Ukendt ejer").
  // Disse rammer typisk dødsboer, udenlandske ejere og personer der ikke er
  // i cvr_deltager-cachen endnu.
  const isPlaceholderName = (label: string): boolean =>
    /^Person\s+\d+$/.test(label) ||
    label === 'Ukendt ejer' ||
    /^Ukendt ejer\s*\(en\s*\d+\)$/.test(label);

  {
    const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
    const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
    const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';
    const personsWithoutEn = nodes.filter(
      (n) => n.type === 'person' && !n.enhedsNummer && n.id.startsWith('person-')
    );
    if (personsWithoutEn.length > 0 && CVR_ES_USER && CVR_ES_PASS) {
      try {
        const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
        // BIZZ-1540: Parse "(en NNNN)" fra labels som "Ukendt ejer (en 4001768042)"
        // → brug enhedsnummer direkte i CVR ES-opslaget. Når label er pseudo-navn
        // som "Ukendt ejer", giver navne-match ingen hits.
        const results = await Promise.allSettled(
          personsWithoutEn.map((node) => {
            const enMatch = node.label.match(/\(en\s*(\d+)\)/);
            const enFromLabel = enMatch ? Number(enMatch[1]) : null;
            const body =
              enFromLabel != null
                ? {
                    query: {
                      match: { 'Vrdeltagerperson.enhedsNummer': String(enFromLabel) },
                    },
                    _source: ['Vrdeltagerperson.enhedsNummer', 'Vrdeltagerperson.navne.navn'],
                    size: 1,
                  }
                : {
                    // BIZZ-1625: match_phrase i stedet for match — ES match tokenizer
                    // splitter på mellemrum og matcher hvert token uafhængigt, så
                    // "Mette Borchardt Jørgensen" kunne matche "Peter Borchardt" via
                    // fælles token "Borchardt". match_phrase kræver alle tokens i rækkefølge.
                    query: { match_phrase: { 'Vrdeltagerperson.navne.navn': node.label } },
                    _source: ['Vrdeltagerperson.enhedsNummer', 'Vrdeltagerperson.navne.navn'],
                    size: 1,
                  };
            return fetch(`${CVR_ES_BASE}/deltager/_search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(5000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null);
          })
        );
        for (let i = 0; i < personsWithoutEn.length; i++) {
          const result = results[i];
          if (result.status !== 'fulfilled' || !result.value) continue;
          const src = result.value?.hits?.hits?.[0]?._source?.Vrdeltagerperson;
          const enr = src?.enhedsNummer;
          if (typeof enr !== 'number' && typeof enr !== 'string') continue;
          const enrNum = Number(enr);
          if (!Number.isFinite(enrNum)) continue;
          const node = personsWithoutEn[i];
          // Hvis en-${enrNum} allerede findes (samme person via andet spor),
          // merge edges og fjern denne duplikat-node
          const newId = `en-${enrNum}`;
          const oldId = node.id;
          if (nodeIds.has(newId)) {
            // Dedup: redirect edges fra oldId til existing newId, fjern oldId-noden
            for (const edge of edges) {
              if (edge.from === oldId) edge.from = newId;
              if (edge.to === oldId) edge.to = newId;
            }
            const idx = nodes.indexOf(node);
            if (idx >= 0) nodes.splice(idx, 1);
            nodeIds.delete(oldId);
            continue;
          }
          // Resolve det rigtige navn fra CVR ES hvis tilgængeligt
          const navne = src?.navne;
          let realName: string | undefined;
          if (Array.isArray(navne) && navne.length > 0) {
            realName = navne[navne.length - 1]?.navn;
          } else if (typeof navne === 'string') {
            realName = navne;
          }
          if (realName) node.label = realName;
          node.enhedsNummer = enrNum;
          node.link = `/dashboard/owners/${enrNum}`;
          node.id = newId;
          nodeIds.delete(oldId);
          nodeIds.add(newId);
          for (const edge of edges) {
            if (edge.from === oldId) edge.from = newId;
            if (edge.to === oldId) edge.to = newId;
          }
          // Writeback til cvr_deltager for fremtidige opslag
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any)
              .from('cvr_deltager')
              .upsert({ enhedsnummer: enrNum, navn: node.label }, { onConflict: 'enhedsnummer' });
          } catch {
            /* writeback non-fatal */
          }
        }
        const resolved = personsWithoutEn.filter((n) => n.enhedsNummer != null).length;
        if (resolved > 0) {
          logger.log(
            `[diagram/resolve] CVR ES fallback resolved ${resolved}/${personsWithoutEn.length} person-ejere`
          );
        }
      } catch (err) {
        logger.warn('[diagram/resolve] CVR ES person-fallback fejl:', err);
      }
    }

    // BIZZ-1540: Re-resolve nodes WITH enhedsNummer but placeholder labels.
    // Bruger CVR ES Vrdeltagerperson opslag på enhedsNummer (ikke navne-match)
    // for at finde det rigtige navn, og writeback til cvr_deltager.
    const personsWithEnButPlaceholder = nodes.filter(
      (n) => n.type === 'person' && typeof n.enhedsNummer === 'number' && isPlaceholderName(n.label)
    );
    if (personsWithEnButPlaceholder.length > 0 && CVR_ES_USER && CVR_ES_PASS) {
      try {
        const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
        const results = await Promise.allSettled(
          personsWithEnButPlaceholder.map((node) =>
            fetch(`${CVR_ES_BASE}/deltager/_search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
              body: JSON.stringify({
                query: {
                  match: { 'Vrdeltagerperson.enhedsNummer': String(node.enhedsNummer) },
                },
                _source: ['Vrdeltagerperson.navne.navn'],
                size: 1,
              }),
              signal: AbortSignal.timeout(5000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        );
        for (let i = 0; i < personsWithEnButPlaceholder.length; i++) {
          const result = results[i];
          if (result.status !== 'fulfilled' || !result.value) continue;
          const navne = result.value?.hits?.hits?.[0]?._source?.Vrdeltagerperson?.navne;
          // navne er typisk array af { navn, periode: { gyldigFra, gyldigTil } }
          let navn: string | undefined;
          if (Array.isArray(navne) && navne.length > 0) {
            navn = navne[navne.length - 1]?.navn; // nyeste navn
          } else if (typeof navne === 'string') {
            navn = navne;
          }
          if (!navn) continue;
          const node = personsWithEnButPlaceholder[i];
          node.label = navn;
          // Writeback til cvr_deltager
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (admin as any)
              .from('cvr_deltager')
              .upsert({ enhedsnummer: node.enhedsNummer, navn }, { onConflict: 'enhedsnummer' });
          } catch {
            /* writeback non-fatal */
          }
        }
        const resolved = personsWithEnButPlaceholder.filter(
          (n) => !isPlaceholderName(n.label)
        ).length;
        if (resolved > 0) {
          logger.log(
            `[diagram/resolve] CVR ES en-fallback resolved ${resolved}/${personsWithEnButPlaceholder.length} placeholder-personer`
          );
        }
      } catch (err) {
        logger.warn('[diagram/resolve] CVR ES en-fallback fejl:', err);
      }
    }

    // BIZZ-1587: Nogle "person"-enhedsnumre er faktisk virksomheder (fx
    // holdingselskaber registreret som ejere). Hvis Vrdeltagerperson ikke
    // matched, prøv Vrvirksomhed.enhedsNummer — hvis hit, konvertér noden
    // til company-type med korrekt CVR + navn + link.
    const stillPlaceholder = nodes.filter(
      (n) => n.type === 'person' && typeof n.enhedsNummer === 'number' && isPlaceholderName(n.label)
    );
    if (stillPlaceholder.length > 0 && CVR_ES_USER && CVR_ES_PASS) {
      try {
        const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
        const results = await Promise.allSettled(
          stillPlaceholder.map((node) =>
            fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
              body: JSON.stringify({
                query: {
                  term: { 'Vrvirksomhed.enhedsNummer': String(node.enhedsNummer) },
                },
                _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.navne.navn'],
                size: 1,
              }),
              signal: AbortSignal.timeout(5000),
            })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        );
        let converted = 0;
        for (let i = 0; i < stillPlaceholder.length; i++) {
          const result = results[i];
          if (result.status !== 'fulfilled' || !result.value) continue;
          const src = result.value?.hits?.hits?.[0]?._source?.Vrvirksomhed;
          if (!src) continue;
          const cvrNr = src.cvrNummer;
          const navne = src.navne;
          let navn: string | undefined;
          if (Array.isArray(navne) && navne.length > 0) {
            navn = navne[navne.length - 1]?.navn;
          }
          if (!cvrNr || !navn) continue;
          const node = stillPlaceholder[i];
          node.label = navn;
          node.type = 'company';
          node.cvr = Number(cvrNr);
          node.link = `/dashboard/companies/${cvrNr}`;
          converted++;
        }
        if (converted > 0) {
          logger.log(
            `[diagram/resolve] CVR ES virksomhed-fallback konverterede ${converted}/${stillPlaceholder.length} fejlcachede person-noder til company`
          );
        }
      } catch (err) {
        logger.warn('[diagram/resolve] CVR ES virksomhed-fallback fejl:', err);
      }
    }

    // BIZZ-1587: Noder der stadig har placeholder-label efter både person- og
    // virksomheds-lookup er sandsynligvis navnebeskyttede (CPR). Relabel dem
    // til "Navnebeskyttet ejer" så brugeren ikke ser kryptiske enhedsnumre.
    const finalPlaceholder = nodes.filter(
      (n) => n.type === 'person' && typeof n.enhedsNummer === 'number' && isPlaceholderName(n.label)
    );
    for (const node of finalPlaceholder) {
      node.label = 'Navnebeskyttet ejer';
    }
  }

  // ── HIERARKI OPAD: hvem ejer ejer-virksomhederne? ──────────────────────
  // Trace ejerskab opad via cvr_virksomhed_ejerskab i 2 niveauer,
  // og find person-ejere på toppen via cvr_deltagerrelation.
  const companyOwnerCvrs = nodes
    .filter((n) => n.type === 'company' && n.cvr)
    .map((n) => String(n.cvr));

  if (companyOwnerCvrs.length > 0) {
    // Level 1: hvem ejer ejer-virksomhederne?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: l1Owners } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
      .in('ejet_cvr', companyOwnerCvrs)
      .is('gyldig_til', null)
      .limit(30);

    const l1CvrList: string[] = [];
    for (const row of (l1Owners ?? []) as Array<{
      ejer_cvr: string;
      ejet_cvr: string;
      ejerandel_min: number | null;
      ejerandel_max: number | null;
    }>) {
      const ownerId = `cvr-${row.ejer_cvr}`;
      const childId = `cvr-${row.ejet_cvr}`;
      if (!nodeIds.has(childId)) continue;

      if (!nodeIds.has(ownerId)) {
        const comp = await fetchCachedCompany(admin, row.ejer_cvr);
        if (comp?.ophoert != null) continue;
        const sub = [comp?.virksomhedsform, comp?.branche_tekst].filter(Boolean);
        nodes.push({
          id: ownerId,
          label: comp?.navn ?? `CVR ${row.ejer_cvr}`,
          sublabel: sub.length > 0 ? sub.join(' · ') : undefined,
          branche: comp?.branche_tekst ?? undefined,
          type: 'company',
          cvr: Number(row.ejer_cvr),
          link: `/dashboard/companies/${row.ejer_cvr}`,
          isCeased: false,
        });
        nodeIds.add(ownerId);
        l1CvrList.push(row.ejer_cvr);
      }
      if (!edges.some((e) => e.from === ownerId && e.to === childId)) {
        edges.push({
          from: ownerId,
          to: childId,
          ejerandel: formatEjerandelRange(row.ejerandel_min, row.ejerandel_max),
        });
      }
    }

    // Level 2: hvem ejer level-1 ejerne?
    if (l1CvrList.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: l2Owners } = await (admin as any)
        .from('cvr_virksomhed_ejerskab')
        .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
        .in('ejet_cvr', l1CvrList)
        .is('gyldig_til', null)
        .limit(30);

      for (const row of (l2Owners ?? []) as Array<{
        ejer_cvr: string;
        ejet_cvr: string;
        ejerandel_min: number | null;
        ejerandel_max: number | null;
      }>) {
        const ownerId = `cvr-${row.ejer_cvr}`;
        const childId = `cvr-${row.ejet_cvr}`;
        if (!nodeIds.has(childId)) continue;

        if (!nodeIds.has(ownerId)) {
          const comp = await fetchCachedCompany(admin, row.ejer_cvr);
          if (comp?.ophoert != null) continue;
          const sub = [comp?.virksomhedsform, comp?.branche_tekst].filter(Boolean);
          nodes.push({
            id: ownerId,
            label: comp?.navn ?? `CVR ${row.ejer_cvr}`,
            sublabel: sub.length > 0 ? sub.join(' · ') : undefined,
            branche: comp?.branche_tekst ?? undefined,
            type: 'company',
            cvr: Number(row.ejer_cvr),
            link: `/dashboard/companies/${row.ejer_cvr}`,
            isCeased: false,
          });
          nodeIds.add(ownerId);
        }
        if (!edges.some((e) => e.from === ownerId && e.to === childId)) {
          edges.push({
            from: ownerId,
            to: childId,
            ejerandel: formatEjerandelRange(row.ejerandel_min, row.ejerandel_max),
          });
        }
      }
    }

    // Person-ejere: find registrerede ejere af ALLE virksomheder i hierarkiet
    // — viser hvem der reelt ejer ejendommen gennem holdingselskaber
    const allCompCvrs = [
      ...new Set(nodes.filter((n) => n.type === 'company' && n.cvr).map((n) => String(n.cvr))),
    ];
    logger.log(`[diagram/resolve] person-ejer lookup for ${allCompCvrs.length} virksomheder`);
    if (allCompCvrs.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: personOwnerRows } = await (admin as any)
        .from('cvr_deltagerrelation')
        .select('virksomhed_cvr, deltager_enhedsnummer, type, ejerandel_pct')
        .in('virksomhed_cvr', allCompCvrs)
        .eq('type', 'register')
        .is('gyldig_til', null)
        .limit(200);

      // Dedup person per virksomhed
      const personEnheder = new Set<number>();
      for (const r of (personOwnerRows ?? []) as Array<{
        deltager_enhedsnummer: number;
      }>) {
        personEnheder.add(r.deltager_enhedsnummer);
      }

      logger.log(
        `[diagram/resolve] fandt ${personEnheder.size} person-enheder fra deltagerrelation`
      );
      if (personEnheder.size > 0) {
        // Batch-hent navne
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: personNames } = await (admin as any)
          .from('cvr_deltager')
          .select('enhedsnummer, navn')
          .in('enhedsnummer', Array.from(personEnheder).slice(0, 20));
        const nameMap = new Map<number, string>(
          ((personNames ?? []) as Array<{ enhedsnummer: number; navn: string }>).map((d) => [
            d.enhedsnummer,
            d.navn,
          ])
        );

        for (const r of (personOwnerRows ?? []) as Array<{
          virksomhed_cvr: string;
          deltager_enhedsnummer: number;
          ejerandel_pct: number | null;
        }>) {
          const personId = `en-${r.deltager_enhedsnummer}`;
          const compId = `cvr-${r.virksomhed_cvr}`;
          if (!nodeIds.has(compId)) continue;

          if (!nodeIds.has(personId)) {
            const pNavn = nameMap.get(r.deltager_enhedsnummer);
            if (!pNavn) {
              logger.log(
                `[diagram/resolve] skip person en=${r.deltager_enhedsnummer} — ikke i cvr_deltager`
              );
              continue;
            }
            nodes.push({
              id: personId,
              label: pNavn,
              type: 'person',
              enhedsNummer: r.deltager_enhedsnummer,
              link: `/dashboard/owners/${r.deltager_enhedsnummer}`,
            });
            nodeIds.add(personId);
          }
          const ejerandel =
            r.ejerandel_pct != null ? `${Math.round(Number(r.ejerandel_pct))}%` : undefined;
          if (!edges.some((e) => e.from === personId && e.to === compId)) {
            edges.push({ from: personId, to: compId, ejerandel });
          }
        }
      }
    }
  }

  // BIZZ-1612: Dedup noder — sektion 1b og L1 kan tilføje same virksomhed.
  // Beholder første forekomst (har korrekte edges).
  const seenNodeIds = new Set<string>();
  const dedupedNodes: DiagramNode[] = [];
  for (const n of nodes) {
    if (seenNodeIds.has(n.id)) continue;
    seenNodeIds.add(n.id);
    dedupedNodes.push(n);
  }

  // BIZZ-1672: Administrator-data vises KUN som kort over ejertabellen
  // på ejendomssiden (via /api/ejendomsadmin) — IKKE i diagrammet.

  return { nodes: dedupedNodes, edges, mainId };
}

/**
 * Byg graf for person (enhedsNummer).
 * Root = personen. Ejerskabs-virksomheder vises hierarkisk med inter-ownership.
 * Rolle-virksomheder (bestyrelse/direktion) vises i separat sektion nederst.
 * Ingen Udvid-knapper eller nøglepersoner — klik navigerer til detaljesiden.
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
  // Hent ALLE aktive relationer inkl. ejerandel_pct (fra register-backfill)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: personRelRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, type, ejerandel_pct')
    .eq('deltager_enhedsnummer', Number(enhedsNummer))
    .is('gyldig_til', null)
    .limit(200);

  // Dedup CVR'er og gruppér roller per virksomhed
  const personVirkRollerMap = new Map<string, string[]>();
  // Ejerandel fra register-type (Det Offentlige Ejerregister)
  const registerEjerandelMap = new Map<string, number | null>();
  for (const r of (personRelRows ?? []) as Array<{
    virksomhed_cvr: string;
    type: string;
    ejerandel_pct: number | null;
  }>) {
    const arr = personVirkRollerMap.get(r.virksomhed_cvr) ?? [];
    arr.push(r.type);
    personVirkRollerMap.set(r.virksomhed_cvr, arr);
    // Gem ejerandel fra register-type
    if (r.type === 'register') {
      registerEjerandelMap.set(r.virksomhed_cvr, r.ejerandel_pct);
    }
  }

  // Klassificér virksomheder: ejerskab = register, interessenter, eller indehaver
  // Virksomheder UDEN ejerskabsrolle → Øvrige roller (direktør, bestyrelse)
  // BIZZ-1669: 'stifter' fjernet — stifteren er ikke nødvendigvis ejer.
  // Mange virksomheder hvor personen kun er stifter (ikke ejer) forurenede
  // ejerskabsstrukturen. Stiftere vises nu i rolle-sektionen i stedet.
  const OWNERSHIP_ROLES = ['register', 'interessenter', 'indehaver'];
  const ownershipCvrs: string[] = [];
  const roleCvrs: string[] = [];
  for (const [cvr, roller] of personVirkRollerMap) {
    if (roller.some((r) => OWNERSHIP_ROLES.includes(r))) {
      ownershipCvrs.push(cvr);
    } else {
      roleCvrs.push(cvr);
    }
  }
  // Gem ejerandel fra interessenter/indehaver som fallback for virksomheder
  // der ikke har register-type men har ejerandel via anden ejerskabsrolle
  for (const r of (personRelRows ?? []) as Array<{
    virksomhed_cvr: string;
    type: string;
    ejerandel_pct: number | null;
  }>) {
    if (
      OWNERSHIP_ROLES.includes(r.type) &&
      r.ejerandel_pct != null &&
      !registerEjerandelMap.has(r.virksomhed_cvr)
    ) {
      registerEjerandelMap.set(r.virksomhed_cvr, r.ejerandel_pct);
    }
  }
  const allCvrs = [...ownershipCvrs, ...roleCvrs];

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

  // ── EJERSKABS-VIRKSOMHEDER ──────────────────────────────────────────────

  // Find ejerskab MELLEM personens virksomheder for hierarkisk layout
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: interOwnershipRows } = await (admin as any)
    .from('cvr_virksomhed_ejerskab')
    .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
    .in('ejer_cvr', ownershipCvrs.slice(0, 50))
    .in('ejet_cvr', ownershipCvrs.slice(0, 50))
    .is('gyldig_til', null);

  // Byg parent-map: child CVR → parent CVR (kun inden for ejerskabs-virksomheder)
  const parentOfCvr = new Map<string, string>();
  const childrenOfCvr = new Map<string, Array<{ cvr: string; ejerandel?: string }>>();
  for (const row of (interOwnershipRows ?? []) as Array<{
    ejer_cvr: string;
    ejet_cvr: string;
    ejerandel_min: number | null;
    ejerandel_max: number | null;
  }>) {
    if (parentOfCvr.has(row.ejet_cvr)) continue; // første parent vinder
    // BIZZ-1622: Skip ejerskab hvis den ejede virksomhed er ophørt — dette
    // fanger stale relationer hvor gyldig_til ikke er opdateret i backfill.
    const ownedCompany = companyMap.get(row.ejet_cvr);
    if (ownedCompany?.ophoert != null) continue;
    parentOfCvr.set(row.ejet_cvr, row.ejer_cvr);
    const children = childrenOfCvr.get(row.ejer_cvr) ?? [];
    children.push({
      cvr: row.ejet_cvr,
      ejerandel: formatEjerandelRange(row.ejerandel_min, row.ejerandel_max),
    });
    childrenOfCvr.set(row.ejer_cvr, children);
  }

  // Opret noder for ejerskabs-virksomheder
  const topLevelCvrs: string[] = [];

  for (const cvrStr of ownershipCvrs) {
    const companyId = `cvr-${cvrStr}`;
    if (nodeIds.has(companyId)) continue;

    const company = companyMap.get(cvrStr) ?? null;
    const roller = personVirkRollerMap.get(cvrStr) ?? [];
    const rolleStr = roller.slice(0, 2).join(', ');
    const subParts = [company?.virksomhedsform, company?.branche_tekst].filter(Boolean);

    // BIZZ-1757: layoutSection for hierarkisk person-diagram
    // Top-level = direkte ejet af person. Datterselskaber (har parent) = deeper.
    const isChild = parentOfCvr.has(cvrStr);
    nodes.push({
      id: companyId,
      label: company?.navn ?? `CVR ${cvrStr}`,
      sublabel: subParts.length > 0 ? subParts.join(' · ') : undefined,
      branche: company?.branche_tekst ?? undefined,
      type: 'company',
      cvr: Number(cvrStr),
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null,
      personRolle: rolleStr || undefined,
      layoutSection: isChild ? 'subsidiary' : 'ownership',
    });
    nodeIds.add(companyId);

    // BIZZ-1621: Personens direkte ejerskab → ALTID top-level. Tidligere
    // blev virksomheder skjult som datterselskaber når en anden af personens
    // virksomheder også ejede dem via cvr_virksomhed_ejerskab. Nu forbindes
    // alle personens virksomheder til personen + evt. parent→child edge vises også.
    topLevelCvrs.push(cvrStr);
    // Ejerandel fra register/interessenter/indehaver
    const regPct = registerEjerandelMap.get(cvrStr);
    // BIZZ-1207: ENK-virksomheder er per definition 100% ejet af deltageren.
    // I/S med interessenter-type uden ejerandel_pct vises som "Ejer".
    {
      const companyForEnk = companyMap.get(cvrStr);
      const isEnk = (companyForEnk?.virksomhedsform ?? '').toLowerCase().includes('enkeltmand');
      const ejerandel = regPct != null ? `${Math.round(regPct)}%` : isEnk ? '100%' : 'Ejer';
      edges.push({ from: mainId, to: companyId, ejerandel });
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

  // Udfold hierarki nedad fra ALLE ejerskabs-virksomheder via cvr_virksomhed_ejerskab.
  // Viser datterselskaber i 2 niveauer (ligesom virksomhedsdiagrammet).
  const MAX_PERSON_NODES = 50;
  {
    const allOwnerCvrs = ownershipCvrs.filter((c) => nodeIds.has(`cvr-${c}`));
    if (allOwnerCvrs.length > 0) {
      // Level 1: hvad ejer personens ejerskabs-virksomheder?
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: l1Subs } = await (admin as any)
        .from('cvr_virksomhed_ejerskab')
        .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
        .in('ejer_cvr', allOwnerCvrs)
        .is('gyldig_til', null)
        .limit(50);

      const l1SubCvrs: string[] = [];
      // Batch-hent virksomhedsinfo
      const l1CvrList = ((l1Subs ?? []) as Array<{ ejet_cvr: string }>).map((r) => r.ejet_cvr);
      let l1CompMap = new Map<
        string,
        {
          navn: string;
          virksomhedsform: string | null;
          branche_tekst: string | null;
          ophoert: string | null;
        }
      >();
      if (l1CvrList.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: l1Comps } = await (admin as any)
          .from('cvr_virksomhed')
          .select('cvr, navn, virksomhedsform, branche_tekst, ophoert')
          .in('cvr', l1CvrList.slice(0, MAX_PERSON_NODES));
        l1CompMap = new Map(
          (
            (l1Comps ?? []) as Array<{
              cvr: string;
              navn: string;
              virksomhedsform: string | null;
              branche_tekst: string | null;
              ophoert: string | null;
            }>
          ).map((c) => [c.cvr, c])
        );
      }

      for (const row of (l1Subs ?? []) as Array<{
        ejer_cvr: string;
        ejet_cvr: string;
        ejerandel_min: number | null;
        ejerandel_max: number | null;
      }>) {
        if (nodes.length >= MAX_PERSON_NODES) break;
        const subId = `cvr-${row.ejet_cvr}`;
        const parentId = `cvr-${row.ejer_cvr}`;
        if (!nodeIds.has(parentId)) continue;

        if (nodeIds.has(subId)) {
          // BIZZ-1622: Skip edge til ophørte virksomheder (stale ejerskab i backfill)
          const existingNode = nodes.find((n) => n.id === subId);
          if (existingNode?.isCeased) continue;
          // Allerede i grafen → tilføj edge hvis mangler
          if (!edges.some((e) => e.from === parentId && e.to === subId)) {
            edges.push({
              from: parentId,
              to: subId,
              ejerandel:
                row.ejerandel_min != null
                  ? `${row.ejerandel_min}-${row.ejerandel_max}%`
                  : undefined,
            });
          }
          continue;
        }

        const cached = l1CompMap.get(row.ejet_cvr);
        if (cached?.ophoert != null) continue;
        const sublParts = [cached?.virksomhedsform, cached?.branche_tekst].filter(Boolean);
        nodes.push({
          id: subId,
          label: cached?.navn ?? `CVR ${row.ejet_cvr}`,
          sublabel: sublParts.length > 0 ? sublParts.join(' · ') : undefined,
          branche: cached?.branche_tekst ?? undefined,
          type: 'company',
          cvr: Number(row.ejet_cvr),
          link: `/dashboard/companies/${row.ejet_cvr}`,
          isCeased: false,
        });
        nodeIds.add(subId);
        l1SubCvrs.push(row.ejet_cvr);
        edges.push({
          from: parentId,
          to: subId,
          ejerandel: formatEjerandelRange(row.ejerandel_min, row.ejerandel_max),
        });
      }

      // Level 2: hvad ejer level-1 datterselskaberne?
      if (l1SubCvrs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: l2Subs } = await (admin as any)
          .from('cvr_virksomhed_ejerskab')
          .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
          .in('ejer_cvr', l1SubCvrs.slice(0, 30))
          .is('gyldig_til', null)
          .limit(50);

        for (const row of (l2Subs ?? []) as Array<{
          ejer_cvr: string;
          ejet_cvr: string;
          ejerandel_min: number | null;
          ejerandel_max: number | null;
        }>) {
          if (nodes.length >= MAX_PERSON_NODES) break;
          const subId = `cvr-${row.ejet_cvr}`;
          const parentId = `cvr-${row.ejer_cvr}`;
          if (!nodeIds.has(parentId)) continue;

          if (nodeIds.has(subId)) {
            if (!edges.some((e) => e.from === parentId && e.to === subId)) {
              edges.push({
                from: parentId,
                to: subId,
                ejerandel:
                  row.ejerandel_min != null
                    ? `${row.ejerandel_min}-${row.ejerandel_max}%`
                    : undefined,
              });
            }
            continue;
          }

          let l2Info = l1CompMap.get(row.ejet_cvr) as
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
              .eq('cvr', row.ejet_cvr)
              .maybeSingle();
            l2Info = data ?? undefined;
          }
          if (l2Info?.ophoert != null) continue;

          const l2SubParts = [l2Info?.virksomhedsform, l2Info?.branche_tekst].filter(Boolean);
          nodes.push({
            id: subId,
            label: l2Info?.navn ?? `CVR ${row.ejet_cvr}`,
            sublabel: l2SubParts.length > 0 ? l2SubParts.join(' · ') : undefined,
            branche: l2Info?.branche_tekst ?? undefined,
            type: 'company',
            cvr: Number(row.ejet_cvr),
            link: `/dashboard/companies/${row.ejet_cvr}`,
            isCeased: false,
          });
          nodeIds.add(subId);
          edges.push({
            from: parentId,
            to: subId,
            ejerandel: formatEjerandelRange(row.ejerandel_min, row.ejerandel_max),
          });
        }
      }
    }
  }

  // ── POST-PROCESS: flyt register-virksomheder der har parent i hierarkiet ─
  // Fx JaJR Ejendomme har register direkte fra Jakob, men ejes af JaJR Holding 2.
  // Fjern person→virksomhed edge og behold kun hierarki-edgen.
  {
    const companiesWithHierarchyParent = new Set<string>();
    for (const edge of edges) {
      // Find edges fra virksomhed→virksomhed (hierarki-edges)
      if (edge.from.startsWith('cvr-') && edge.to.startsWith('cvr-')) {
        companiesWithHierarchyParent.add(edge.to);
      }
    }
    // Fjern person→virksomhed edges for virksomheder der har en hierarki-parent
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].from === mainId && companiesWithHierarchyParent.has(edges[i].to)) {
        edges.splice(i, 1);
      }
    }
  }

  // ── BIZZ-1545: Fjern historiske ejer-edges. cvr_virksomhed_ejerskab har
  // dårlige gyldig_til-data (alle NULL selv for ophørte relationer). Hvis et
  // selskab har flere virksomheds-parents OG mindst én har defineret ejerandel,
  // betragter vi de uden ejerandel som historiske og fjerner dem.
  {
    const cvrEdgeGroups = new Map<string, Array<{ idx: number; hasEjerandel: boolean }>>();
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      // Kun virksomhed→virksomhed-edges (hierarki)
      if (!e.from.startsWith('cvr-') || !e.to.startsWith('cvr-')) continue;
      const arr = cvrEdgeGroups.get(e.to) ?? [];
      arr.push({ idx: i, hasEjerandel: !!e.ejerandel });
      cvrEdgeGroups.set(e.to, arr);
    }
    const indicesToRemove = new Set<number>();
    for (const [, parents] of cvrEdgeGroups) {
      if (parents.length < 2) continue;
      const withEjerandel = parents.filter((p) => p.hasEjerandel);
      // Hvis nogen har ejerandel og andre ikke har, behold KUN dem med ejerandel
      if (withEjerandel.length > 0 && withEjerandel.length < parents.length) {
        for (const p of parents) {
          if (!p.hasEjerandel) indicesToRemove.add(p.idx);
        }
      }
    }
    if (indicesToRemove.size > 0) {
      // Slet baglæns for at undgå index-shift
      const sorted = Array.from(indicesToRemove).sort((a, b) => b - a);
      for (const idx of sorted) edges.splice(idx, 1);
      logger.log(
        `[diagram/resolve] BIZZ-1545: fjernet ${indicesToRemove.size} historiske ejer-edges uden ejerandel`
      );
    }
  }

  // ── ROLLE-VIRKSOMHEDER (bestyrelse/direktion — direkte under person) ─────
  // Vises direkte under personen med rolle-tekst på edge (ingen container-node).
  // layoutSection: 'role' sikrer at DiagramForce placerer dem lavere end ejerskab.

  if (roleCvrs.length > 0) {
    for (const cvrStr of roleCvrs) {
      const companyId = `cvr-${cvrStr}`;
      if (nodeIds.has(companyId)) continue;

      const company = companyMap.get(cvrStr) ?? null;
      const roller = personVirkRollerMap.get(cvrStr) ?? [];
      const rolleStr = roller.slice(0, 2).join(', ');
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
        personRolle: rolleStr || undefined,
        layoutSection: 'role',
      });
      nodeIds.add(companyId);
      // Ingen ejerandel-tekst på rolle-edges — rollen vises allerede i boksen (personRolle)
      edges.push({ from: mainId, to: companyId });
    }
  }

  // ── BIZZ-1259 + BIZZ-1273: Personlige ejendomme via ejf_ejerskab ─────────
  // Prøv ejer_enheds_nummer først (præcist link), derefter navn-match som fallback.
  // Samme mønster som step 4 i resolveCompanyGraph (BIZZ-1082).
  {
    let personProps: Array<{
      bfe_nummer: number;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }> = [];

    // BIZZ-1273: Præcist link via ejer_enheds_nummer (populeret af backfill)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: byEnheds } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
      .eq('ejer_enheds_nummer', Number(enhedsNummer))
      .eq('status', 'gældende')
      .limit(MAX_PROPS_PER_OWNER + 1);

    if (byEnheds && byEnheds.length > 0) {
      personProps = byEnheds;
    } else if (personName && !personName.startsWith('Person ')) {
      // Fallback: navn-match (BIZZ-1259 original approach)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: byNavn } = await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
        .eq('ejer_navn', personName)
        .eq('ejer_type', 'person')
        .eq('status', 'gældende')
        .limit(MAX_PROPS_PER_OWNER + 1);
      personProps = byNavn ?? [];
    }

    for (const pp of personProps) {
      const propId = `bfe-${pp.bfe_nummer}`;
      if (!nodeIds.has(propId)) {
        nodes.push({
          id: propId,
          label: `BFE ${pp.bfe_nummer}`,
          type: 'property',
          bfeNummer: pp.bfe_nummer,
          // BIZZ-1757: personlige ejendomme direkte under person
          layoutSection: 'personal-property',
        });
        nodeIds.add(propId);
      }
      edges.push({
        from: mainId,
        to: propId,
        ejerandel: formatEjerandel(pp.ejerandel_taeller, pp.ejerandel_naevner),
        personallyOwned: true,
        ownerPersonId: mainId,
      });
    }
  }

  // ── POST-PROCESS: berig datterselskabs-noder med personens rolle ──────────
  // Datterselskaber (level 1/2 subsidiaries) oprettes uden personRolle fordi
  // de tilføjes via cvr_virksomhed_ejerskab (virksomhed→virksomhed), ikke
  // cvr_deltagerrelation (person→virksomhed). Men personen kan godt have en
  // direkte rolle i datterselskabet (fx direktør, stifter).
  {
    const nodesWithoutRolle = nodes.filter(
      (n) => n.type === 'company' && !n.personRolle && n.id !== mainId
    );
    if (nodesWithoutRolle.length > 0) {
      const cvrsMissingRolle = nodesWithoutRolle.map((n) => String(n.cvr)).filter(Boolean);
      if (cvrsMissingRolle.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: extraRels } = await (admin as any)
          .from('cvr_deltagerrelation')
          .select('virksomhed_cvr, type')
          .eq('deltager_enhedsnummer', Number(enhedsNummer))
          .in('virksomhed_cvr', cvrsMissingRolle)
          .is('gyldig_til', null);

        const extraRollerMap = new Map<string, string[]>();
        for (const r of (extraRels ?? []) as Array<{
          virksomhed_cvr: string;
          type: string;
        }>) {
          const arr = extraRollerMap.get(r.virksomhed_cvr) ?? [];
          arr.push(r.type);
          extraRollerMap.set(r.virksomhed_cvr, arr);
        }

        for (const node of nodesWithoutRolle) {
          const cvr = String(node.cvr);
          const roller = extraRollerMap.get(cvr);
          if (roller && roller.length > 0) {
            node.personRolle = roller.slice(0, 2).join(', ');
          }
        }
      }
    }
  }

  // ── Virksomheds-ejede ejendomme ──────────────────────────────────────────
  // BIZZ-1545: Hent ejendomme for alle ejer-virksomheder i grafen.
  // Vises som property-noder under hver virksomhed.
  const ownerCompanyCvrs = nodes
    .filter((n) => n.type === 'company' && n.cvr && n.layoutSection !== 'role')
    .map((n) => String(n.cvr));
  if (ownerCompanyCvrs.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: compProps } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr')
      .in('ejer_cvr', ownerCompanyCvrs)
      .eq('status', 'gældende')
      .limit(100);

    const propsByCvr = new Map<string, number[]>();
    for (const row of (compProps ?? []) as Array<{ bfe_nummer: number; ejer_cvr: string }>) {
      if (!propsByCvr.has(row.ejer_cvr)) propsByCvr.set(row.ejer_cvr, []);
      propsByCvr.get(row.ejer_cvr)!.push(row.bfe_nummer);
    }

    for (const [cvr, bfes] of propsByCvr) {
      const compId = `cvr-${cvr}`;
      const shown = bfes.slice(0, MAX_PROPS_PER_OWNER);
      for (const bfe of shown) {
        const propId = `bfe-${bfe}`;
        if (nodeIds.has(propId)) continue;
        nodes.push({
          id: propId,
          label: `BFE ${bfe}`,
          type: 'property',
          bfeNummer: bfe,
        });
        nodeIds.add(propId);
        edges.push({ from: compId, to: propId });
      }
      // Overflow count
      if (bfes.length > MAX_PROPS_PER_OWNER) {
        const overflowId = `props-overflow-${cvr}`;
        if (!nodeIds.has(overflowId)) {
          nodes.push({
            id: overflowId,
            label: `+${bfes.length - MAX_PROPS_PER_OWNER} ejendomme`,
            type: 'property',
            overflowItems: bfes.slice(MAX_PROPS_PER_OWNER).map((b) => ({
              bfeNummer: b,
              label: `BFE ${b}`,
            })),
          });
          nodeIds.add(overflowId);
          edges.push({ from: compId, to: overflowId });
        }
      }
    }
  }

  // ── BIZZ-1743: Administrerede ejendomme (ejerforeninger) ────────────────
  // For virksomheder der administrerer ejendomme via ejf_administrator
  // (typisk ejerforeninger), tilføj administrerede BFE'er med stiplet edge.
  const mainCvr = nodes.find((n) => n.type === 'main')?.cvr;
  if (mainCvr) {
    const administered = await _fetchAdministeredByCvr(admin, String(mainCvr));
    const adminBfes = administered
      .map((a) => a.bfe_nummer)
      .filter((bfe) => !nodeIds.has(`bfe-${bfe}`));

    for (const bfe of adminBfes.slice(0, MAX_PROPS_PER_OWNER)) {
      const propId = `bfe-admin-${bfe}`;
      if (nodeIds.has(propId)) continue;
      nodes.push({
        id: propId,
        label: `BFE ${bfe}`,
        sublabel: 'Administreret',
        type: 'property',
        bfeNummer: bfe,
      });
      nodeIds.add(propId);
      edges.push({ from: `cvr-${mainCvr}`, to: propId });
    }
    if (adminBfes.length > MAX_PROPS_PER_OWNER) {
      const overflowId = `admin-overflow-${mainCvr}`;
      nodes.push({
        id: overflowId,
        label: `+${adminBfes.length - MAX_PROPS_PER_OWNER} administrerede`,
        type: 'property',
        overflowItems: adminBfes.slice(MAX_PROPS_PER_OWNER).map((b) => ({
          bfeNummer: b,
          label: `BFE ${b}`,
        })),
      });
      nodeIds.add(overflowId);
      edges.push({ from: `cvr-${mainCvr}`, to: overflowId });
    }
  }

  return { nodes, edges, mainId };
}

/**
 * Berig virksomheds-noder med nøglepersoner (bestyrelse/direktion) fra cvr_deltagerrelation.
 * Henter aktive relationer for alle virksomheder i grafen og sætter noeglePersoner.
 *
 * @param graph - DiagramGraph med company-noder
 * @param admin - Supabase admin client
 * @param excludeEnhedsNummer - Person der allerede er root (vises ikke som nøgleperson)
 */
async function enrichNoeglePersoner(
  graph: DiagramGraph,
  admin: ReturnType<typeof createAdminClient>,
  excludeEnhedsNummer?: number
): Promise<void> {
  const companyNodes = graph.nodes.filter(
    (n) => (n.type === 'company' || n.type === 'main') && n.cvr
  );
  if (companyNodes.length === 0) return;

  const cvrs = companyNodes.map((n) => String(n.cvr));

  // Batch-hent alle aktive deltager-relationer for alle virksomheder
  // Kun ledelsesroller — IKKE ejerskab (register/reel_ejer/interessenter/hovedselskab)
  const OWNERSHIP_ONLY_TYPES = new Set([
    'register',
    'reel_ejer',
    'interessenter',
    'hovedselskab',
    'indehaver',
    'stiftere',
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: relRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, deltager_enhedsnummer, type')
    .in('virksomhed_cvr', cvrs.slice(0, 50))
    .is('gyldig_til', null)
    .limit(500);

  if (!relRows?.length) return;

  // Filtrer til ledelsesroller og samle unikke enhedsnumre
  const filteredRels = (
    relRows as Array<{
      virksomhed_cvr: string;
      deltager_enhedsnummer: number;
      type: string;
    }>
  ).filter((r) => !OWNERSHIP_ONLY_TYPES.has(r.type));

  const allEns = new Set<number>();
  for (const r of filteredRels) {
    if (r.deltager_enhedsnummer !== excludeEnhedsNummer) {
      allEns.add(r.deltager_enhedsnummer);
    }
  }

  if (allEns.size === 0) return;

  // Batch-hent navne
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: nameRows } = await (admin as any)
    .from('cvr_deltager')
    .select('enhedsnummer, navn')
    .in('enhedsnummer', Array.from(allEns).slice(0, 200));
  const nameMap = new Map<number, string>(
    ((nameRows ?? []) as Array<{ enhedsnummer: number; navn: string }>).map((d) => [
      d.enhedsnummer,
      d.navn,
    ])
  );

  // Gruppér per CVR → person → roller
  const cvrPersonMap = new Map<string, Map<number, string[]>>();
  for (const r of filteredRels) {
    if (r.deltager_enhedsnummer === excludeEnhedsNummer) continue;
    const personMap = cvrPersonMap.get(r.virksomhed_cvr) ?? new Map();
    const roles = personMap.get(r.deltager_enhedsnummer) ?? [];
    roles.push(r.type);
    personMap.set(r.deltager_enhedsnummer, roles);
    cvrPersonMap.set(r.virksomhed_cvr, personMap);
  }

  // Sæt noeglePersoner på noder
  for (const node of companyNodes) {
    const personMap = cvrPersonMap.get(String(node.cvr));
    if (!personMap) continue;
    const persons: Array<{ navn: string; enhedsNummer: number; rolle: string }> = [];
    for (const [en, roles] of personMap) {
      const navn = nameMap.get(en);
      if (!navn) continue;
      persons.push({ navn, enhedsNummer: en, rolle: roles.slice(0, 2).join(', ') });
    }
    if (persons.length > 0) {
      node.noeglePersoner = persons.slice(0, 5);
    }
  }
}

/**
 * Berig property-noder med adresser fra /api/bfe-addresses.
 * Opdaterer label, sublabel og link på alle property-noder i grafen.
 *
 * @param graph - DiagramGraph med property-noder der har BFE-numre
 * @param host - Request host for internt API-kald
 * @param cookie - Auth cookie
 */
/**
 * BIZZ-1587: Berig "Ukendt ejer (en NNNN)" placeholder-noder ved at slå op i
 * CVR ES Vrvirksomhed. Nogle enhedsnumre er fejlcached som personer men er
 * faktisk holdingselskaber — konvertér dem til company-noder.
 *
 * Kører på alle diagram-typer (company/property/person) før respons.
 */
async function enrichVirksomhedFejlcacheNodes(graph: DiagramGraph): Promise<void> {
  const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
  const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';
  if (!CVR_ES_USER || !CVR_ES_PASS) return;

  const isPlaceholderLabel = (label: string): boolean => /^Ukendt ejer\s*\(en\s*\d+\)$/.test(label);

  const placeholders = graph.nodes.filter(
    (n) => n.type === 'person' && typeof n.enhedsNummer === 'number' && isPlaceholderLabel(n.label)
  );
  if (placeholders.length === 0) return;

  const auth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
  const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';

  try {
    const results = await Promise.allSettled(
      placeholders.map((node) =>
        fetch(`${CVR_ES_BASE}/virksomhed/_search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
          body: JSON.stringify({
            query: { term: { 'Vrvirksomhed.enhedsNummer': String(node.enhedsNummer) } },
            _source: ['Vrvirksomhed.cvrNummer', 'Vrvirksomhed.navne.navn'],
            size: 1,
          }),
          signal: AbortSignal.timeout(5000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    );
    let converted = 0;
    for (let i = 0; i < placeholders.length; i++) {
      const result = results[i];
      if (result.status !== 'fulfilled' || !result.value) continue;
      const src = result.value?.hits?.hits?.[0]?._source?.Vrvirksomhed;
      if (!src) continue;
      const cvrNr = src.cvrNummer;
      const navne = src.navne;
      let navn: string | undefined;
      if (Array.isArray(navne) && navne.length > 0) {
        navn = navne[navne.length - 1]?.navn;
      }
      if (!cvrNr || !navn) continue;
      const node = placeholders[i];
      node.label = navn;
      node.type = 'company';
      node.cvr = Number(cvrNr);
      node.link = `/dashboard/companies/${cvrNr}`;
      converted++;
    }
    if (converted > 0) {
      logger.log(
        `[diagram/resolve] virksomhed-fejlcache enrichment konverterede ${converted}/${placeholders.length} noder`
      );
    }
  } catch (err) {
    logger.warn('[diagram/resolve] virksomhed-fejlcache enrichment fejl:', err);
  }
}

async function enrichPropertyNodes(
  graph: DiagramGraph,
  host: string,
  cookie: string
): Promise<void> {
  const propNodes = graph.nodes.filter((n) => n.type === 'property' && n.bfeNummer != null);
  // BIZZ-1349: Saml også BFE-numre fra overflow items
  const overflowNodes = graph.nodes.filter((n) => n.overflowItems && n.overflowItems.length > 0);
  const overflowBfes = overflowNodes.flatMap((n) =>
    (n.overflowItems ?? []).filter((i) => i.bfeNummer).map((i) => i.bfeNummer!)
  );
  const allBfes = [...propNodes.map((n) => n.bfeNummer!), ...overflowBfes];
  if (allBfes.length === 0) return;

  try {
    const res = await fetch(`${host}/api/bfe-addresses?bfes=${allBfes.join(',')}`, {
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

    /**
     * Formatér adresse-label fra bfe-addresses response.
     * BIZZ-1543: Brug mellemrum mellem adresse og etage (ikke komma).
     * DiagramForce splitter label på komma for at lave linje 1 / linje 2.
     * Med komma havnede etage/dør på linje 2 sammen med postnr+by, så to
     * ejerlejligheder i samme opgang så identiske ud. Med space holdes
     * "vejnavn nr. etage. dør" samlet på linje 1.
     */
    const fmtLabel = (info: {
      adresse: string | null;
      postnr: string | null;
      by: string | null;
      etage: string | null;
      doer: string | null;
    }): string | null => {
      if (!info.adresse) return null;
      const etageStr = info.etage ? ` ${info.etage}.` : '';
      const doerStr = info.doer ? ` ${info.doer}` : '';
      const postStr = info.postnr && info.by ? `, ${info.postnr} ${info.by}` : '';
      return `${info.adresse}${etageStr}${doerStr}${postStr}`;
    };

    /**
     * BIZZ-1542: Byg property-link med BFE-fallback for ejerlejligheder.
     * For ejerlejligheder (har etage) bruger vi BFE-URL fremfor DAWA UUID,
     * fordi DAWA UUID'er for enhedsadresser ikke kan resolves via
     * /adgangsadresser → "Adresse ikke fundet". page.tsx resolver BFE→DAWA
     * via bbr_ejendom_status eller jordstykker-chain.
     */
    const buildLink = (
      info: { etage: string | null; dawaId: string | null },
      bfeNummer: number | null
    ): string | undefined => {
      if (info.etage && bfeNummer) return `/dashboard/ejendomme/${bfeNummer}`;
      if (info.dawaId) return `/dashboard/ejendomme/${info.dawaId}`;
      if (bfeNummer) return `/dashboard/ejendomme/${bfeNummer}`;
      return undefined;
    };

    for (const node of propNodes) {
      // BIZZ-1114: Skip noder der allerede har et client-supplied label (rootLabel)
      // — undgå at overskrive korrekt adresse med forkert BFE→DAWA mapping
      if (node.label && !node.label.startsWith('BFE ')) continue;

      const info = data[String(node.bfeNummer)];
      if (!info?.adresse) continue;
      node.label = fmtLabel(info) ?? node.label;
      if (info.postnr && info.by) {
        node.sublabel = `${info.postnr} ${info.by}`;
      }
      const link = buildLink(info, node.bfeNummer ?? null);
      if (link) node.link = link;
    }

    // BIZZ-1349: Berig overflow items med adresser + links
    for (const node of overflowNodes) {
      for (const item of node.overflowItems ?? []) {
        if (!item.bfeNummer) continue;
        const info = data[String(item.bfeNummer)];
        if (!info) continue;
        const label = fmtLabel(info);
        if (label) item.label = label;
        const link = buildLink(info, item.bfeNummer ?? null);
        if (link) item.link = link;
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

    // Berig virksomheds-noder med nøglepersoner — KUN på person-diagrammer
    if (type === 'person') {
      await enrichNoeglePersoner(graph, admin, Number(id));
    }

    // BIZZ-1587: Berig fejlcachede person-enhedsnumre der faktisk er virksomheder
    await enrichVirksomhedFejlcacheNodes(graph);

    // Berig property-noder med adresser (best-effort)
    await enrichPropertyNodes(graph, reqHost, reqCookie);

    return NextResponse.json({ graph });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    void message;
    return NextResponse.json({ graph: null, error: 'Ekstern API fejl' }, { status: 500 });
  }
}
