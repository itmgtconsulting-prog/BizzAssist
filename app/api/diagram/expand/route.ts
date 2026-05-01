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
  existingBfes: Set<number>,
  host: string,
  cookie: string
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
      const coId = co.ejer_cvr
        ? `cvr-${co.ejer_cvr}`
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

  // BIZZ-1125: Ejerskab opad + nedad — CACHE-FIRST via cvr_virksomhed_ejerskab.
  // Fallback til CVR ES /api/cvr-public/related + person-lookup.

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ownerComp } = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn, virksomhedsform, branche_tekst, ophoert')
      .eq('cvr', co.ejer_cvr)
      .maybeSingle();
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

  // Fallback til CVR ES hvis cache er tom (backfill ikke nået denne virksomhed endnu)
  const hasCacheData = (cachedOwners?.length ?? 0) > 0 || (cachedSubs?.length ?? 0) > 0;
  if (hasCacheData) {
    // Cache havde data — spring CVR ES over
    return { nodes: newNodes, edges: newEdges };
  }
  try {
    // NEDAD: hvad ejer denne virksomhed?
    const relRes = await fetch(`${host}/api/cvr-public/related?cvr=${cvr}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (relRes.ok) {
      const relData = await relRes.json();
      interface RelComp {
        cvr: number;
        navn: string;
        form: string | null;
        branche: string | null;
        aktiv: boolean;
        ejerandel: string | null;
        ejetAfCvr: number | null;
      }
      for (const rel of (relData?.virksomheder ?? []) as RelComp[]) {
        if (!rel.aktiv) continue;
        // Kun DIREKTE datterselskaber (ejetAfCvr = null = direkte under root)
        // Indirekte (ejetAfCvr != null) vises ved expand af mellemnoden
        if (rel.ejetAfCvr != null) continue;
        const relId = `cvr-${rel.cvr}`;
        // Allerede i grafen → tilføj ejerskabs-edge
        if (existingIds.has(relId) || addedIds.has(relId)) {
          newEdges.push({
            from: nodeId,
            to: relId,
            ejerandel: rel.ejerandel ?? undefined,
          });
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: relComp } = await (admin as any)
          .from('cvr_virksomhed')
          .select('navn, virksomhedsform, branche_tekst, ophoert')
          .eq('cvr', String(rel.cvr))
          .maybeSingle();
        if (relComp?.ophoert != null) continue;
        const sub = [
          relComp?.virksomhedsform ?? rel.form,
          relComp?.branche_tekst ?? rel.branche,
        ].filter(Boolean);
        newNodes.push({
          id: relId,
          label: relComp?.navn ?? rel.navn,
          sublabel: sub.length > 0 ? sub.join(' · ') : undefined,
          type: 'company',
          cvr: rel.cvr,
          link: `/dashboard/companies/${rel.cvr}`,
          isCeased: false,
        });
        addedIds.add(relId);
        newEdges.push({ from: nodeId, to: relId, ejerandel: rel.ejerandel ?? undefined });
      }
    }
  } catch {
    // Best-effort
  }

  // OPAD: person-ejere af DENNE virksomhed.
  // Vises KUN hvis virksomheden ikke har virksomheds-ejere i cache/CVR ES.
  // Hvis holdingselskaber ejer virksomheden, er person-ejere (register/reel_ejer)
  // redundante — de vises via holding-kæden i stedet.
  const hasCompanyOwners = newNodes.some((n) => n.type === 'company');
  const PERSON_OWNER_TYPES = ['register', 'reel_ejer', 'stifter', 'interessenter'];
  if (hasCompanyOwners) {
    // Spring person-ejere over — virksomheds-ejere dækker
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: compPersonRows } = await (admin as any)
      .from('cvr_deltagerrelation')
      .select('deltager_enhedsnummer, type')
      .eq('virksomhed_cvr', cvr)
      .is('gyldig_til', null)
      .limit(30);
    if (compPersonRows?.length) {
      // Tilføj person-noder for registrerede ejere
      const ownerPersons = (
        compPersonRows as Array<{ deltager_enhedsnummer: number; type: string }>
      ).filter((r) => PERSON_OWNER_TYPES.includes(r.type));
      const ownerEnheder = Array.from(
        new Set(ownerPersons.map((r) => r.deltager_enhedsnummer))
      ).filter((en) => !existingIds.has(`en-${en}`) && !addedIds.has(`en-${en}`));

      if (ownerEnheder.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: personNames } = await (admin as any)
          .from('cvr_deltager')
          .select('enhedsnummer, navn')
          .in('enhedsnummer', ownerEnheder.slice(0, 10));
        const nameMap = new Map<number, string>(
          ((personNames ?? []) as Array<{ enhedsnummer: number; navn: string }>).map((d) => [
            d.enhedsnummer,
            d.navn,
          ])
        );
        for (const en of ownerEnheder.slice(0, 5)) {
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
          // Hent ejerandel fra CVR ES
          let personEjerandel: string | undefined;
          try {
            const pRes = await fetch(`${host}/api/cvr-public/person?enhedsNummer=${en}`, {
              headers: { cookie },
              signal: AbortSignal.timeout(8000),
            });
            if (pRes.ok) {
              const pData = await pRes.json();
              const match = (pData?.virksomheder ?? []).find(
                (v: { cvr: number }) => v.cvr === Number(cvr)
              );
              if (match) {
                personEjerandel = match.roller?.find(
                  (r: { ejerandel?: string | null }) => r.ejerandel
                )?.ejerandel;
              }
            }
          } catch {
            /* best-effort */
          }
          newEdges.push({ from: pId, to: nodeId, ejerandel: personEjerandel });
        }
      }

      // Virksomheds-ejere via CVR ES (holding-selskaber)
      const newPersons = Array.from(
        new Set(
          (compPersonRows as Array<{ deltager_enhedsnummer: number }>)
            .map((r) => r.deltager_enhedsnummer)
            .filter((en) => !existingIds.has(`en-${en}`))
        )
      );

      // For hver ny person: hent virksomheder med ejerandel, og check om nogen
      // af dem har den udvidede virksomhed (cvr) i sin related-liste
      for (const en of newPersons.slice(0, 5)) {
        try {
          const personRes = await fetch(`${host}/api/cvr-public/person?enhedsNummer=${en}`, {
            headers: { cookie },
            signal: AbortSignal.timeout(8000),
          });
          if (!personRes.ok) continue;
          const personData = await personRes.json();
          interface PVirk {
            cvr: number;
            navn: string;
            aktiv: boolean;
            roller: Array<{ rolle?: string; ejerandel?: string | null }>;
          }
          // Find virksomheder personen har ejerandel i
          const owned: PVirk[] = (personData?.virksomheder ?? []).filter(
            (v: PVirk) => v.aktiv && v.roller.some((r) => r.ejerandel != null)
          );
          for (const v of owned) {
            const vId = `cvr-${v.cvr}`;
            if (existingIds.has(vId) || addedIds.has(vId)) continue;
            if (v.cvr === Number(cvr)) continue;
            // Check: ejer denne virksomhed den udvidede virksomhed?
            try {
              const relCheck = await fetch(`${host}/api/cvr-public/related?cvr=${v.cvr}`, {
                headers: { cookie },
                signal: AbortSignal.timeout(8000),
              });
              if (!relCheck.ok) continue;
              const relCheckData = await relCheck.json();
              const ownsTarget = (relCheckData?.virksomheder ?? []).some(
                (r: { cvr: number }) => r.cvr === Number(cvr)
              );
              if (!ownsTarget) continue;
              // Denne virksomhed EJER den udvidede virksomhed — tilføj!
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: ownerComp } = await (admin as any)
                .from('cvr_virksomhed')
                .select('navn, virksomhedsform, branche_tekst, ophoert')
                .eq('cvr', String(v.cvr))
                .maybeSingle();
              if (ownerComp?.ophoert != null) continue;
              const sub = [ownerComp?.virksomhedsform, ownerComp?.branche_tekst].filter(Boolean);
              const ejerandelStr = v.roller.find((r) => r.ejerandel)?.ejerandel ?? undefined;
              newNodes.push({
                id: vId,
                label: ownerComp?.navn ?? v.navn,
                sublabel: sub.length > 0 ? sub.join(' · ') : undefined,
                type: 'company',
                cvr: v.cvr,
                link: `/dashboard/companies/${v.cvr}`,
                isCeased: false,
              });
              addedIds.add(vId);
              newEdges.push({ from: vId, to: nodeId, ejerandel: ejerandelStr });
              break; // Max 1 holding per person
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }
    }
  } // end else (no company owners)

  // BIZZ-1122: Datterselskaber via /api/cvr-public/related FJERNET fra expand.
  // Resolve henter allerede datterselskaber for initial graf. Expand af
  // datterselskaber gav irrelevante virksomheder (fx Pharma IT ApS).
  // Expand fokuserer nu på: ejendomme + medejere + ejere opad.

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
  cookie: string,
  context?: string
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  const newNodes: DiagramNode[] = [];
  const newEdges: DiagramEdge[] = [];
  const addedIds = new Set<string>();

  // BIZZ-1120: Hent virksomheder via live CVR ES (eneste pålidelige ejerskabs-kilde)
  const personRes = await fetch(`${host}/api/cvr-public/person?enhedsNummer=${enhedsNummer}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  const personData = personRes && personRes.ok ? await personRes.json() : null;

  interface ExpandVirk {
    cvr: number;
    navn: string;
    aktiv: boolean;
    roller: Array<{ rolle?: string; ejerandel?: string | null }>;
  }
  const alleVirksomheder: ExpandVirk[] = personData?.virksomheder ?? [];

  // BIZZ-1122/1125: På virksomhedsdiagram (context=company), vis KUN:
  // - Personlige virksomheder (interessenter/indehaver — enkeltmand/I/S)
  // - Virksomheder med reel ejerandel (>0%) — ikke 0%
  // - Filtrer datterselskaber fra (vises ved expand af parent via cvr_virksomhed_ejerskab)
  const PERSONLIGE_ROLLER = new Set(['interessent', 'interessenter', 'indehaver', 'komplementar']);
  let virksomheder = alleVirksomheder;
  if (context === 'company') {
    virksomheder = alleVirksomheder.filter((v) => {
      if (!v.aktiv) return false;
      return v.roller.some((r) => {
        const rolle = (r.rolle ?? '').toLowerCase();
        if (PERSONLIGE_ROLLER.has(rolle)) return true;
        // Reel ejerandel — filtrer "0%" og "0.0%" fra
        if (r.ejerandel != null) {
          const pctStr = r.ejerandel.replace(/[^0-9.]/g, '');
          const pct = parseFloat(pctStr);
          return !isNaN(pct) && pct > 0;
        }
        return false;
      });
    });

    // BIZZ-1125: Fjern virksomheder der er datterselskaber af andre i listen.
    // Brug cvr_virksomhed_ejerskab: hvis virksomhed A ejes af virksomhed B,
    // og B er i listen, så fjern A (den vises ved expand af B).
    if (virksomheder.length > 1) {
      const listCvrs = virksomheder.map((v) => String(v.cvr));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: subRows } = await (admin as any)
        .from('cvr_virksomhed_ejerskab')
        .select('ejet_cvr')
        .in('ejer_cvr', listCvrs)
        .in('ejet_cvr', listCvrs)
        .is('gyldig_til', null);
      const subsidiaries = new Set(
        ((subRows ?? []) as Array<{ ejet_cvr: string }>).map((r) => r.ejet_cvr)
      );
      if (subsidiaries.size > 0) {
        virksomheder = virksomheder.filter((v) => !subsidiaries.has(String(v.cvr)));
      }
    }
  }

  for (const v of virksomheder) {
    const cvrStr = String(v.cvr);
    const companyId = `cvr-${cvrStr}`;
    const rolleStr =
      v.roller
        ?.map((r) => [r.rolle, r.ejerandel].filter(Boolean).join(' '))
        .filter(Boolean)
        .slice(0, 2)
        .join(', ') ?? '';

    if (existingIds.has(companyId)) {
      // BIZZ-1122: På virksomhedsdiagram — skip kryds-edges til eksisterende
      // noder (gule linier). Ejerstrukturen vises allerede via resolve.
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

    // Tæl ejendomme for expandableChildren
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: propCount } = await (admin as any)
      .from('ejf_ejerskab')
      .select('bfe_nummer', { count: 'exact', head: true })
      .eq('ejer_cvr', cvrStr)
      .eq('status', 'gældende');

    // BIZZ-1123: Inkluder branche_tekst i sublabel
    const expandSubParts = [company?.virksomhedsform, company?.branche_tekst].filter(Boolean);
    newNodes.push({
      id: companyId,
      label: company?.navn ?? v.navn ?? `CVR ${cvrStr}`,
      sublabel: expandSubParts.length > 0 ? expandSubParts.join(' · ') : undefined,
      branche: company?.branche_tekst ?? undefined,
      type: 'company',
      cvr: Number(cvrStr),
      link: `/dashboard/companies/${cvrStr}`,
      isCeased: company?.ophoert != null,
      // 0 = ingen Udvid-knap, >0 = vis knap, undefined = ukendt (vis knap)
      expandableChildren: (propCount ?? 0) > 0 ? (propCount ?? 0) : 0,
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

      // Personlige ejendomme vises ALLE (ingen max-limit — typisk <20)
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
      result = await expandCompany(
        admin,
        nodeId,
        cvr,
        existingIds,
        existingBfeSet,
        reqHost,
        reqCookie
      );
    } else if (nodeType === 'person' && enhedsNummer) {
      result = await expandPerson(
        admin,
        nodeId,
        enhedsNummer,
        existingIds,
        existingBfeSet,
        reqHost,
        reqCookie,
        context
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
