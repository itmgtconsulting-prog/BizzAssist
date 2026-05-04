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
  /** BIZZ-1122: diagram context — 'company' filtrerer person-expand til ejerskab */
  context?: 'company' | 'person' | 'property';
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
 * Bruger udelukkende cache-tabeller (ejf_ejerskab, cvr_virksomhed_ejerskab, cvr_deltagerrelation).
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

  // Medejere: find andre virksomheder der ejer de SAMME ejendomme som denne virksomhed.
  // Tilføj dem som nye noder (hvis ikke allerede i grafen) eller som 2nd-degree edges.
  const allBfes = props.map((p) => p.bfe_nummer);
  if (allBfes.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: coOwnerRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_cvr, ejer_navn, ejer_type, ejerandel_taeller, ejerandel_naevner')
      .in('bfe_nummer', allBfes.slice(0, 50))
      .eq('status', 'gældende')
      .limit(200);

    // Batch-hent enhedsNummer for person-medejere via cvr_deltager navne-match.
    // Gør det muligt at expandere person-noder der kommer fra ejf_ejerskab.
    const personCoOwnerNames = new Set<string>();
    for (const co of (coOwnerRows ?? []) as Array<{
      ejer_cvr: string | null;
      ejer_navn: string;
      ejer_type: string;
    }>) {
      if (co.ejer_cvr === cvr || co.ejer_cvr) continue;
      if (co.ejer_type === 'person') personCoOwnerNames.add(co.ejer_navn);
    }
    const personEnMap = new Map<string, number>();
    if (personCoOwnerNames.size > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: deltagerMatches } = await (admin as any)
        .from('cvr_deltager')
        .select('enhedsnummer, navn')
        .in('navn', Array.from(personCoOwnerNames).slice(0, 20));
      for (const d of (deltagerMatches ?? []) as Array<{ enhedsnummer: number; navn: string }>) {
        // Kun sæt hvis ikke allerede sat (undgå overwrite ved duplikat-navne)
        if (!personEnMap.has(d.navn)) personEnMap.set(d.navn, d.enhedsnummer);
      }
    }

    // Gruppér medejere — dedup på CVR/navn
    const seenCoOwners = new Set<string>();
    for (const co of (coOwnerRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_cvr: string | null;
      ejer_navn: string;
      ejer_type: string;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }>) {
      if (co.ejer_cvr === cvr) continue;
      // Person-noder: brug enhedsNummer-baseret ID hvis tilgængeligt
      const personEn =
        !co.ejer_cvr && co.ejer_type === 'person' ? personEnMap.get(co.ejer_navn) : undefined;
      const coId = co.ejer_cvr
        ? `cvr-${co.ejer_cvr}`
        : personEn
          ? `en-${personEn}`
          : `person-${co.ejer_navn.replace(/\s+/g, '-').toLowerCase()}`;
      const propId = `bfe-${co.bfe_nummer}`;

      if (existingIds.has(coId) || addedIds.has(coId)) {
        // Allerede i grafen → 2nd-degree edge til ejendommen
        if (existingIds.has(propId) || addedIds.has(propId)) {
          newEdges.push({
            from: coId,
            to: propId,
            ejerandel: formatEjerandel(co.ejerandel_taeller, co.ejerandel_naevner),
            crossOwnership: true,
          });
        }
        continue;
      }

      // Ny medejer — tilføj som node + edge til ejendommen
      if (!seenCoOwners.has(coId)) {
        seenCoOwners.add(coId);
        if (co.ejer_type === 'virksomhed' && co.ejer_cvr) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: coCompany } = await (admin as any)
            .from('cvr_virksomhed')
            .select('navn, virksomhedsform, branche_tekst, ophoert')
            .eq('cvr', co.ejer_cvr)
            .maybeSingle();
          if (coCompany?.ophoert != null) continue;
          const subParts = [coCompany?.virksomhedsform, coCompany?.branche_tekst].filter(Boolean);
          newNodes.push({
            id: coId,
            label: coCompany?.navn ?? co.ejer_navn,
            sublabel: subParts.length > 0 ? subParts.join(' · ') : undefined,
            type: 'company',
            cvr: Number(co.ejer_cvr),
            link: `/dashboard/companies/${co.ejer_cvr}`,
            isCeased: false,
          });
        } else {
          newNodes.push({
            id: coId,
            label: co.ejer_navn,
            type: 'person',
            enhedsNummer: personEn,
            link: personEn ? `/dashboard/owners/${personEn}` : undefined,
          });
        }
        addedIds.add(coId);
      }

      // Edge fra medejer til ejendommen
      if (existingIds.has(propId) || addedIds.has(propId)) {
        newEdges.push({
          from: coId,
          to: propId,
          ejerandel: formatEjerandel(co.ejerandel_taeller, co.ejerandel_naevner),
        });
      }
    }
  }

  // BIZZ-1125: Ejerskab opad + nedad via cvr_virksomhed_ejerskab cache.

  // Cache-first: opad (hvem ejer denne virksomhed?)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: cachedOwners } = await (admin as any)
    .from('cvr_virksomhed_ejerskab')
    .select('ejer_cvr, ejerandel_min, ejerandel_max')
    .eq('ejet_cvr', cvr)
    .is('gyldig_til', null)
    .limit(20);
  for (const co of (cachedOwners ?? []) as Array<{
    ejer_cvr: string;
    ejerandel_min: number | null;
    ejerandel_max: number | null;
  }>) {
    const coId = `cvr-${co.ejer_cvr}`;
    if (existingIds.has(coId) || addedIds.has(coId)) {
      // Reel ejerskabs-edge (ikke crossOwnership)
      newEdges.push({ from: coId, to: nodeId });
      continue;
    }

    let ownerComp: {
      navn: string;
      virksomhedsform: string | null;
      branche_tekst: string | null;
      ophoert: string | null;
    } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownerCompRes = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn, virksomhedsform, branche_tekst, ophoert')
      .eq('cvr', co.ejer_cvr)
      .maybeSingle();
    ownerComp = ownerCompRes.data;
    // Fallback: hent navn fra ejf_ejerskab (ejer_navn) eller CVR ES
    if (!ownerComp) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: ejfRow } = await (admin as any)
        .from('ejf_ejerskab')
        .select('ejer_navn')
        .eq('ejer_cvr', co.ejer_cvr)
        .limit(1)
        .maybeSingle();
      if (ejfRow?.ejer_navn) {
        ownerComp = {
          navn: ejfRow.ejer_navn,
          virksomhedsform: null,
          branche_tekst: null,
          ophoert: null,
        };
      }
    }
    if (ownerComp?.ophoert != null) continue;
    const sub = [ownerComp?.virksomhedsform, ownerComp?.branche_tekst].filter(Boolean);
    const ejerStr =
      co.ejerandel_min != null && co.ejerandel_max != null
        ? `${co.ejerandel_min}-${co.ejerandel_max}%`
        : undefined;
    newNodes.push({
      id: coId,
      label: ownerComp?.navn ?? `CVR ${co.ejer_cvr}`,
      sublabel: sub.length > 0 ? sub.join(' · ') : undefined,
      type: 'company',
      cvr: Number(co.ejer_cvr),
      link: `/dashboard/companies/${co.ejer_cvr}`,
      isCeased: false,
    });
    addedIds.add(coId);
    newEdges.push({ from: coId, to: nodeId, ejerandel: ejerStr });

    // Check om denne ejer også ejer andre virksomheder allerede i grafen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: otherOwned } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejet_cvr, ejerandel_min, ejerandel_max')
      .eq('ejer_cvr', co.ejer_cvr)
      .is('gyldig_til', null)
      .limit(20);
    for (const oo of (otherOwned ?? []) as Array<{
      ejet_cvr: string;
      ejerandel_min: number | null;
      ejerandel_max: number | null;
    }>) {
      const ooId = `cvr-${oo.ejet_cvr}`;
      if (oo.ejet_cvr === cvr) continue; // allerede håndteret
      if (existingIds.has(ooId)) {
        newEdges.push({
          from: coId,
          to: ooId,
          ejerandel:
            oo.ejerandel_min != null ? `${oo.ejerandel_min}-${oo.ejerandel_max}%` : undefined,
        });
      }
    }
  }

  // Cache-first: nedad (hvad ejer denne virksomhed?)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: cachedSubs } = await (admin as any)
    .from('cvr_virksomhed_ejerskab')
    .select('ejet_cvr, ejerandel_min, ejerandel_max')
    .eq('ejer_cvr', cvr)
    .is('gyldig_til', null)
    .limit(20);
  for (const cs of (cachedSubs ?? []) as Array<{
    ejet_cvr: string;
    ejerandel_min: number | null;
    ejerandel_max: number | null;
  }>) {
    const csId = `cvr-${cs.ejet_cvr}`;
    if (existingIds.has(csId) || addedIds.has(csId)) {
      // Reel ejerskabs-edge (ikke crossOwnership) — viser ejerrelation
      newEdges.push({
        from: nodeId,
        to: csId,
        ejerandel:
          cs.ejerandel_min != null ? `${cs.ejerandel_min}-${cs.ejerandel_max}%` : undefined,
      });
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: subComp } = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn, virksomhedsform, branche_tekst, ophoert')
      .eq('cvr', cs.ejet_cvr)
      .maybeSingle();
    if (subComp?.ophoert != null) continue;
    const sub = [subComp?.virksomhedsform, subComp?.branche_tekst].filter(Boolean);
    newNodes.push({
      id: csId,
      label: subComp?.navn ?? `CVR ${cs.ejet_cvr}`,
      sublabel: sub.length > 0 ? sub.join(' · ') : undefined,
      type: 'company',
      cvr: Number(cs.ejet_cvr),
      link: `/dashboard/companies/${cs.ejet_cvr}`,
      isCeased: false,
    });
    addedIds.add(csId);
    newEdges.push({
      from: nodeId,
      to: csId,
      ejerandel: cs.ejerandel_min != null ? `${cs.ejerandel_min}-${cs.ejerandel_max}%` : undefined,
    });
  }

  // Cache-only — ingen CVR ES fallback

  // OPAD: person-ejere af DENNE virksomhed via cache (cvr_deltagerrelation).
  // Kun personer med interessenter/indehaver-rolle ELLER ejerandel_pct > 0.
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: compPersonRows } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('deltager_enhedsnummer, type, ejerandel_pct')
      .eq('virksomhed_cvr', cvr)
      .is('gyldig_til', null)
      .limit(100);
    // Filtrer til ejerskabs-relevante personer
    const PERSON_OWNER_TYPES = new Set(['interessenter', 'indehaver']);
    const filteredPersonRows = (
      (compPersonRows ?? []) as Array<{
        deltager_enhedsnummer: number;
        type: string;
        ejerandel_pct: number | null;
      }>
    ).filter((r) => {
      if (PERSON_OWNER_TYPES.has(r.type)) return true;
      return r.ejerandel_pct != null && r.ejerandel_pct > 0;
    });
    if (filteredPersonRows.length > 0) {
      const ownerEnheder = Array.from(
        new Set(filteredPersonRows.map((r) => r.deltager_enhedsnummer))
      ).filter((en) => !existingIds.has(`en-${en}`) && !addedIds.has(`en-${en}`));

      // Hent navne
      let nameMap = new Map<number, string>();
      if (ownerEnheder.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: personNames } = await (admin as any)
          .from('cvr_deltager')
          .select('enhedsnummer, navn')
          .in('enhedsnummer', ownerEnheder.slice(0, 10));
        nameMap = new Map(
          ((personNames ?? []) as Array<{ enhedsnummer: number; navn: string }>).map((d) => [
            d.enhedsnummer,
            d.navn,
          ])
        );
      }

      // Tilføj person-noder for ejerskabs-typer (uden ejerandel — cache har ikke den)
      for (const en of ownerEnheder.slice(0, 10)) {
        const personNavn = nameMap.get(en);
        if (!personNavn) continue;
        const pId = `en-${en}`;
        newNodes.push({
          id: pId,
          label: personNavn,
          type: 'person',
          enhedsNummer: en,
          link: `/dashboard/owners/${en}`,
        });
        addedIds.add(pId);
        newEdges.push({ from: pId, to: nodeId });
      }
    }
  }

  // Final pass: for ALLE nye virksomheds-noder, check om de har ejerskabs-
  // relationer til eksisterende noder i grafen (begge retninger).
  // Tegner edges med det samme — ikke først ved expand af den nye node.
  const newCompanyCvrs = newNodes
    .filter((n) => n.type === 'company' && n.cvr)
    .map((n) => String(n.cvr));
  if (newCompanyCvrs.length > 0) {
    // Nedad: hvad ejer de nye noder der allerede er i grafen?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newOwnedRows } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
      .in('ejer_cvr', newCompanyCvrs)
      .is('gyldig_til', null)
      .limit(100);
    for (const r of (newOwnedRows ?? []) as Array<{
      ejer_cvr: string;
      ejet_cvr: string;
      ejerandel_min: number | null;
      ejerandel_max: number | null;
    }>) {
      const fromId = `cvr-${r.ejer_cvr}`;
      const toId = `cvr-${r.ejet_cvr}`;
      if (!existingIds.has(toId) && !addedIds.has(toId)) continue;
      // Skip edges der allerede findes
      if (newEdges.some((e) => e.from === fromId && e.to === toId)) continue;
      newEdges.push({
        from: fromId,
        to: toId,
        ejerandel: r.ejerandel_min != null ? `${r.ejerandel_min}-${r.ejerandel_max}%` : undefined,
      });
    }
    // Opad: hvem ejer de nye noder der allerede er i grafen?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newOwnerRows } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejer_cvr, ejet_cvr, ejerandel_min, ejerandel_max')
      .in('ejet_cvr', newCompanyCvrs)
      .is('gyldig_til', null)
      .limit(100);
    for (const r of (newOwnerRows ?? []) as Array<{
      ejer_cvr: string;
      ejet_cvr: string;
      ejerandel_min: number | null;
      ejerandel_max: number | null;
    }>) {
      const fromId = `cvr-${r.ejer_cvr}`;
      const toId = `cvr-${r.ejet_cvr}`;
      if (!existingIds.has(fromId) && !addedIds.has(fromId)) continue;
      if (newEdges.some((e) => e.from === fromId && e.to === toId)) continue;
      newEdges.push({
        from: fromId,
        to: toId,
        ejerandel: r.ejerandel_min != null ? `${r.ejerandel_min}-${r.ejerandel_max}%` : undefined,
      });
    }
  }

  // Final pass: person-noder → ejf_ejerskab.
  // Checker om ALLE person-noder (nye + eksisterende i grafen) ejer ejendomme
  // der er i grafen. Tegner personallyOwned crossOwnership-edges.
  // Samler BFE'er fra ALLE ejendomme i grafen (eksisterende + nye).
  const allBfeIds = new Set<number>(Array.from(existingBfes));
  for (const n of newNodes) {
    if (n.bfeNummer != null) allBfeIds.add(n.bfeNummer);
  }

  if (allBfeIds.size > 0) {
    // Hent ALLE person-ejere af ejendomme i grafen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: personPropRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejer_navn, ejerandel_taeller, ejerandel_naevner')
      .in('bfe_nummer', Array.from(allBfeIds).slice(0, 100))
      .eq('ejer_type', 'person')
      .eq('status', 'gældende')
      .limit(500);

    // Map person label → node ID for alle person-noder (nye + eksisterende)
    const personLabelToId = new Map<string, string>();
    for (const pn of newNodes.filter((n) => n.type === 'person')) {
      personLabelToId.set(pn.label, pn.id);
    }
    // Eksisterende person-noder: hent navne fra cvr_deltager for en-* ID'er
    const existingPersonEns: number[] = [];
    for (const existId of Array.from(existingIds)) {
      if (existId.startsWith('en-')) {
        const en = parseInt(existId.slice(3), 10);
        if (Number.isFinite(en)) existingPersonEns.push(en);
      }
    }
    if (existingPersonEns.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existingPersonNames } = await (admin as any)
        .from('cvr_deltager')
        .select('enhedsnummer, navn')
        .in('enhedsnummer', existingPersonEns.slice(0, 20));
      for (const d of (existingPersonNames ?? []) as Array<{
        enhedsnummer: number;
        navn: string;
      }>) {
        personLabelToId.set(d.navn, `en-${d.enhedsnummer}`);
      }
    }

    for (const r of (personPropRows ?? []) as Array<{
      bfe_nummer: number;
      ejer_navn: string;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }>) {
      const propId = `bfe-${r.bfe_nummer}`;
      if (!existingIds.has(propId) && !addedIds.has(propId)) continue;
      const fromId = personLabelToId.get(r.ejer_navn);
      if (!fromId) continue;
      // Skip duplikat-edges
      if (newEdges.some((e) => e.from === fromId && e.to === propId)) continue;
      newEdges.push({
        from: fromId,
        to: propId,
        ejerandel: formatEjerandel(r.ejerandel_taeller, r.ejerandel_naevner),
        personallyOwned: true,
        crossOwnership: true,
      });
    }
  }

  // BIZZ-fix: For nye person-noder — hent personlige ejendomme og tilføj dem
  // direkte til grafen, så relationen tegnes med det samme (ikke først ved expand).
  // Beregner også expandableChildren for virksomheder der IKKE allerede er i grafen.
  const newPersonNodes = newNodes.filter((n) => n.type === 'person' && n.enhedsNummer != null);
  if (newPersonNodes.length > 0) {
    const newPersonEns = newPersonNodes.map((n) => n.enhedsNummer!);

    // 1. Tæl virksomheder der kan udvides (interessenter/indehaver eller ejerandel > 0)
    const PERSON_OWNER_TYPES = new Set(['interessenter', 'indehaver']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: personExpandRels } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('deltager_enhedsnummer, virksomhed_cvr, type, ejerandel_pct')
      .in('deltager_enhedsnummer', newPersonEns.slice(0, 20))
      .is('gyldig_til', null)
      .limit(500);
    const personExpandCounts = new Map<number, number>();
    for (const r of (personExpandRels ?? []) as Array<{
      deltager_enhedsnummer: number;
      virksomhed_cvr: string;
      type: string;
      ejerandel_pct: number | null;
    }>) {
      // Tæl kun virksomheder IKKE allerede i grafen — virksomheder der allerede
      // vises har intet at tilføje ved person-expand.
      if (existingIds.has(`cvr-${r.virksomhed_cvr}`) || addedIds.has(`cvr-${r.virksomhed_cvr}`))
        continue;
      const isPersonlig = PERSON_OWNER_TYPES.has(r.type);
      const hasEjerandel = r.ejerandel_pct != null && r.ejerandel_pct > 0;
      if (!isPersonlig && !hasEjerandel) continue;
      personExpandCounts.set(
        r.deltager_enhedsnummer,
        (personExpandCounts.get(r.deltager_enhedsnummer) ?? 0) + 1
      );
    }

    // 2. Hent personlige ejendomme via navne-match i ejf_ejerskab og tilføj til grafen
    for (const pNode of newPersonNodes) {
      // Hent personnavn
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: dRow } = await (admin as any)
        .from('cvr_deltager')
        .select('navn')
        .eq('enhedsnummer', pNode.enhedsNummer)
        .maybeSingle();
      const pNavn = dRow?.navn;

      // Sæt expandableChildren ALTID — uanset om navne-lookup fejler
      const compCount = personExpandCounts.get(pNode.enhedsNummer!) ?? 0;
      pNode.expandableChildren = compCount > 0 ? compCount : 0;

      if (!pNavn) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pProps } = await (admin as any)
        .from('ejf_ejerskab')
        .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
        .ilike('ejer_navn', pNavn)
        .eq('ejer_type', 'person')
        .eq('status', 'gældende')
        .limit(20);

      for (const pp of (pProps ?? []) as Array<{
        bfe_nummer: number;
        ejerandel_taeller: number | null;
        ejerandel_naevner: number | null;
      }>) {
        const ppId = `bfe-${pp.bfe_nummer}`;
        // Ejendom allerede i grafen → kryds-edge
        if (existingBfes.has(pp.bfe_nummer) || addedIds.has(ppId)) {
          newEdges.push({
            from: pNode.id,
            to: ppId,
            ejerandel: formatEjerandel(pp.ejerandel_taeller, pp.ejerandel_naevner),
            personallyOwned: true,
            crossOwnership: true,
          });
        } else {
          // Ny ejendom → tilføj som node + edge
          if (!existingIds.has(ppId) && !addedIds.has(ppId)) {
            newNodes.push({
              id: ppId,
              label: `BFE ${pp.bfe_nummer}`,
              type: 'property',
              bfeNummer: pp.bfe_nummer,
            });
            addedIds.add(ppId);
          }
          newEdges.push({
            from: pNode.id,
            to: ppId,
            ejerandel: formatEjerandel(pp.ejerandel_taeller, pp.ejerandel_naevner),
            personallyOwned: true,
          });
        }
      }
    }
  }

  return { nodes: newNodes, edges: newEdges };
}

/**
 * Expand en person-node: hent virksomheder + ejendomme via cache-tabeller.
 *
 * @param admin - Supabase admin client
 * @param nodeId - Node-ID i grafen
 * @param enhedsNummer - Personens enhedsNummer
 * @param existingIds - Set af node-IDs allerede i grafen
 * @param existingBfes - Set af BFE-numre allerede i grafen
 * @param context - Diagram-kontekst ('company' | 'person' | 'property')
 * @returns Nye noder + edges
 */
async function expandPerson(
  admin: ReturnType<typeof createAdminClient>,
  nodeId: string,
  enhedsNummer: string,
  existingIds: Set<string>,
  existingBfes: Set<number>,
  context?: string
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  const newNodes: DiagramNode[] = [];
  const newEdges: DiagramEdge[] = [];
  const addedIds = new Set<string>();

  // Cache-first: hent personens virksomheder via cvr_deltagerrelation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: personRelRows } = await (admin as any)
    .from('cvr_deltagerrelation')
    .select('virksomhed_cvr, type')
    .eq('deltager_enhedsnummer', Number(enhedsNummer))
    .is('gyldig_til', null)
    .limit(50);

  // Gruppér roller per virksomhed
  const virkRollerMap = new Map<string, string[]>();
  for (const r of (personRelRows ?? []) as Array<{ virksomhed_cvr: string; type: string }>) {
    const arr = virkRollerMap.get(r.virksomhed_cvr) ?? [];
    arr.push(r.type);
    virkRollerMap.set(r.virksomhed_cvr, arr);
  }

  // BIZZ-1122/1125: På virksomhedsdiagram (context=company), vis KUN:
  // 1. Personlige virksomheder (interessenter/indehaver — enkeltmand/I/S)
  // 2. Virksomheder med ejerandel_pct > 0 OG gyldig (gyldig_til IS NULL)
  // Stiftere, direktører og bestyrelsesmedlemmer uden ejerandel filtreres fra.
  const PERSONLIGE_TYPER = new Set(['interessenter', 'indehaver']);

  // Hent ejerandel_pct for alle relationer med ejerandel > 0
  const ejerandelByCvr = new Map<string, number>();
  if (context === 'company') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ejerandelRows } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('virksomhed_cvr, ejerandel_pct')
      .eq('deltager_enhedsnummer', Number(enhedsNummer))
      .is('gyldig_til', null)
      .not('ejerandel_pct', 'is', null)
      .gt('ejerandel_pct', 0)
      .limit(50);
    for (const r of (ejerandelRows ?? []) as Array<{
      virksomhed_cvr: string;
      ejerandel_pct: number;
    }>) {
      ejerandelByCvr.set(r.virksomhed_cvr, r.ejerandel_pct);
    }
  }

  let filteredCvrs = Array.from(virkRollerMap.keys());
  if (context === 'company') {
    filteredCvrs = filteredCvrs.filter((cvrStr) => {
      const roller = virkRollerMap.get(cvrStr) ?? [];
      // Altid vis interessenter/indehaver (personlige virksomheder)
      if (roller.some((t) => PERSONLIGE_TYPER.has(t))) return true;
      // Vis kun virksomheder med ejerandel > 0
      return ejerandelByCvr.has(cvrStr);
    });

    // Fjern datterselskaber af andre i listen
    if (filteredCvrs.length > 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: subRows } = await (admin as any)
        .from('cvr_virksomhed_ejerskab')
        .select('ejet_cvr')
        .in('ejer_cvr', filteredCvrs)
        .in('ejet_cvr', filteredCvrs)
        .is('gyldig_til', null);
      const subsidiaries = new Set(
        ((subRows ?? []) as Array<{ ejet_cvr: string }>).map((r) => r.ejet_cvr)
      );
      if (subsidiaries.size > 0) {
        filteredCvrs = filteredCvrs.filter((c) => !subsidiaries.has(c));
      }
    }
  }

  for (const cvrStr of filteredCvrs) {
    const companyId = `cvr-${cvrStr}`;
    const roller = virkRollerMap.get(cvrStr) ?? [];
    const rolleStr = roller.slice(0, 2).join(', ');

    if (existingIds.has(companyId)) {
      // På virksomhedsdiagram — skip kryds-edges (ejerstrukturen vises via resolve)
      if (context === 'company') continue;
      // Person/property-diagram: vis 2nd-degree edge
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
      .select('navn, status, virksomhedsform, branche_tekst, ophoert')
      .eq('cvr', cvrStr)
      .maybeSingle();

    // Tæl ejendomme for expandableChildren (ekskludér allerede viste)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: propRows } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer')
      .eq('ejer_cvr', cvrStr)
      .eq('status', 'gældende')
      .limit(20);
    const newPropCount = (propRows ?? []).filter(
      (p: { bfe_nummer: number }) => !existingBfes.has(p.bfe_nummer)
    ).length;

    // Tæl ejerskabs-relationer IKKE allerede i grafen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ownershipRows } = await (admin as any)
      .from('cvr_virksomhed_ejerskab')
      .select('ejet_cvr, ejer_cvr, ejerandel_min, ejerandel_max')
      .or(`ejer_cvr.eq.${cvrStr},ejet_cvr.eq.${cvrStr}`)
      .is('gyldig_til', null)
      .limit(20);
    const newOwnershipCount = (ownershipRows ?? []).filter(
      (r: { ejet_cvr: string; ejer_cvr: string }) => {
        const relCvr = r.ejer_cvr === cvrStr ? r.ejet_cvr : r.ejer_cvr;
        return !existingIds.has(`cvr-${relCvr}`) && !addedIds.has(`cvr-${relCvr}`);
      }
    ).length;

    // Inkluder branche_tekst i sublabel
    const expandSubParts = [company?.virksomhedsform, company?.branche_tekst].filter(Boolean);
    newNodes.push({
      id: companyId,
      label: company?.navn ?? `CVR ${cvrStr}`,
      sublabel: expandSubParts.length > 0 ? expandSubParts.join(' · ') : undefined,
      branche: company?.branche_tekst ?? undefined,
      type: 'company',
      cvr: Number(cvrStr),
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null,
      expandableChildren:
        newPropCount + newOwnershipCount > 0 ? newPropCount + newOwnershipCount : 0,
    });
    addedIds.add(companyId);

    // Edge fra person til virksomhed
    newEdges.push({
      from: nodeId,
      to: companyId,
      ejerandel: rolleStr || undefined,
    });

    // BIZZ-1125: Tegn ejerskabs-edges til noder ALLEREDE i grafen.
    // Fx DJKL Holding → JaJR Holding 2: begge er i grafen, men edge'en
    // mangler fordi resolve kun henter 2 niveauer ned.
    for (const r of (ownershipRows ?? []) as Array<{
      ejet_cvr: string;
      ejer_cvr: string;
    }>) {
      const relCvr = r.ejer_cvr === cvrStr ? r.ejet_cvr : r.ejer_cvr;
      const relId = `cvr-${relCvr}`;
      if (!existingIds.has(relId) && !addedIds.has(relId)) continue;
      // Tegn edge i korrekt retning
      const from = r.ejer_cvr === cvrStr ? companyId : relId;
      const to = r.ejer_cvr === cvrStr ? relId : companyId;
      // Find ejerandel
      const ejerandelRow = (
        ownershipRows as Array<{
          ejet_cvr: string;
          ejer_cvr: string;
          ejerandel_min?: number | null;
          ejerandel_max?: number | null;
        }>
      ).find((o) => o.ejer_cvr === r.ejer_cvr && o.ejet_cvr === r.ejet_cvr);
      const ejerandelLabel =
        ejerandelRow?.ejerandel_min != null
          ? `${ejerandelRow.ejerandel_min}-${ejerandelRow.ejerandel_max}%`
          : undefined;
      newEdges.push({ from, to, ejerandel: ejerandelLabel });
    }
  }

  // Personligt ejede ejendomme via cvr_deltager navne-match + ejf_ejerskab
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: deltagerRow } = await (admin as any)
    .from('cvr_deltager')
    .select('navn')
    .eq('enhedsnummer', Number(enhedsNummer))
    .maybeSingle();
  const personNavn = deltagerRow?.navn ?? null;

  // Forsøg at finde person-ejerskab i ejf_ejerskab via navn-match
  if (personNavn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: personalProps } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer, ejerandel_taeller, ejerandel_naevner')
      .ilike('ejer_navn', personNavn)
      .eq('ejer_type', 'person')
      .eq('status', 'gældende')
      .limit(50);

    const props: Array<{
      bfe_nummer: number;
      ejerandel_taeller: number | null;
      ejerandel_naevner: number | null;
    }> = personalProps ?? [];
    const newProps = props.filter((p) => !existingBfes.has(p.bfe_nummer));

    // Edges til ejendomme der ALLEREDE er i grafen (fx via selskabs-expand)
    const existingPersonalProps = props.filter((p) => existingBfes.has(p.bfe_nummer));
    for (const prop of existingPersonalProps) {
      const propId = `bfe-${prop.bfe_nummer}`;
      newEdges.push({
        from: nodeId,
        to: propId,
        ejerandel: formatEjerandel(prop.ejerandel_taeller, prop.ejerandel_naevner),
        personallyOwned: true,
        crossOwnership: true,
      });
    }

    // Personlige ejendomme direkte under person-noden (ingen container-boks)
    for (const prop of newProps) {
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
        personallyOwned: true,
      });
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

  const { nodeType, nodeId, cvr, enhedsNummer, existingNodeIds, existingBfes, context } = body;
  const existingIds = new Set(existingNodeIds ?? []);
  const existingBfeSet = new Set(existingBfes ?? []);

  const admin = createAdminClient();

  try {
    let result: { nodes: DiagramNode[]; edges: DiagramEdge[] };

    const proto = request.headers.get('x-forwarded-proto') ?? 'http';
    const reqHost = `${proto}://${request.headers.get('host') ?? 'localhost:3000'}`;
    const reqCookie = request.headers.get('cookie') ?? '';

    if (nodeType === 'company' && cvr) {
      result = await expandCompany(admin, nodeId, cvr, existingIds, existingBfeSet);
    } else if (nodeType === 'person' && enhedsNummer) {
      result = await expandPerson(
        admin,
        nodeId,
        enhedsNummer,
        existingIds,
        existingBfeSet,
        context
      );
    } else {
      return NextResponse.json(
        { nodes: [], edges: [], error: 'Missing cvr or enhedsNummer' },
        { status: 400 }
      );
    }

    // Berig virksomheds-noder uden navn med live CVR API + writeback til cache
    const namelessCompanies = result.nodes.filter(
      (n) => n.type === 'company' && n.cvr && n.label.startsWith('CVR ')
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
                // så næste opslag er cached (best-effort, fejl ignoreres)
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
    const propNodes = result.nodes.filter((n) => n.type === 'property' && n.bfeNummer != null);
    if (propNodes.length > 0) {
      try {
        const bfes = propNodes.map((n) => n.bfeNummer!).join(',');
        const addrRes = await fetch(`${reqHost}/api/bfe-addresses?bfes=${bfes}`, {
          headers: { cookie: reqCookie },
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
