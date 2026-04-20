/**
 * GET /api/ejerskab/person-bridge?enhedsNummer=4000115446
 *
 * Bro mellem CVR ES personer og EJF (Ejerfortegnelsen). CVR ES og EJF bruger
 * forskellige person-identifikatorer, så en direkte enhedsNummer-lookup på
 * EJF returnerer 0 selv når personen faktisk ejer ejendomme. Denne route
 * løser problemet deterministisk:
 *
 *   1. Hent personens data fra CVR ES (/api/cvr-public/person) → navn + hjem-adresse
 *   2. Resolver hjem-adressen til et BFE via DAWA (adresseId → BFE)
 *   3. Hent EJF-ejerskab for det BFE (/api/ejerskab)
 *   4. Match ejer-entry mod personens navn
 *   5. Returner EJF person-id + foedselsdato — stabil nøgle til senere lookups
 *
 * Fordelen: ingen navne-gæt, fordi vi verificerer via personens egen
 * registrerede adresse i CVR. To personer med samme navn har forskellig
 * registreret adresse i CVR ES og vil derfor finde forskellige EJF-records.
 *
 * @param enhedsNummer - CVR ES enhedsNummer for personen
 * @returns { ejfPersonId, foedselsdato, navn, viaBfe, viaAdresse } eller fejl
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { fetchDawa } from '@/app/lib/dawa';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 30;

export interface PersonBridgeResponse {
  /** CVR ES enhedsNummer (input-parameteren) */
  cvrEnhedsNummer: number;
  /** Personens navn fra CVR */
  navn: string | null;
  /** Personens EJF id (uuid) — stabil nøgle til alle deres ejendomme */
  ejfPersonId: string | null;
  /** Personens fødselsdato fra EJF — sekundær disambiguator */
  foedselsdato: string | null;
  /** BFE for hjem-adressen vi brugte som anker (transparens) */
  viaBfe: number | null;
  /** Adressen vi slog op på (transparens) */
  viaAdresse: string | null;
  /** Hvorfor vi evt. ikke kunne binde */
  fejl: string | null;
}

async function fetchJson<T>(url: string, cookie: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { cookie },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Normaliserer navn: lowercase + trim + collapse whitespace */
function normNavn(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const enParam = req.nextUrl.searchParams.get('enhedsNummer');
  const enhedsNr = enParam ? parseInt(enParam, 10) : NaN;
  if (!Number.isFinite(enhedsNr) || enhedsNr <= 0) {
    return NextResponse.json({ error: 'enhedsNummer required' }, { status: 400 });
  }

  const base = req.nextUrl.origin;
  const cookie = req.headers.get('cookie') ?? '';

  // Trin 1 — hent person fra CVR ES
  const person = await fetchJson<{
    navn: string;
    beliggenhedsadresse: {
      adresseId: string | null;
      vejnavn: string | null;
      husnummerFra: number | null;
      bogstavFra: string | null;
      postnummer: number | null;
      postdistrikt: string | null;
    } | null;
  }>(`${base}/api/cvr-public/person?enhedsNummer=${enhedsNr}`, cookie);

  if (!person?.navn) {
    return NextResponse.json({
      cvrEnhedsNummer: enhedsNr,
      navn: null,
      ejfPersonId: null,
      foedselsdato: null,
      viaBfe: null,
      viaAdresse: null,
      fejl: 'Person ikke fundet i CVR',
    } satisfies PersonBridgeResponse);
  }

  const adr = person.beliggenhedsadresse;
  if (!adr?.adresseId) {
    return NextResponse.json({
      cvrEnhedsNummer: enhedsNr,
      navn: person.navn,
      ejfPersonId: null,
      foedselsdato: null,
      viaBfe: null,
      viaAdresse: null,
      fejl: 'Ingen hjem-adresse registreret på personen i CVR',
    } satisfies PersonBridgeResponse);
  }

  // Trin 2 — DAWA: adresseId → jordstykke (ejerlavkode + matrikelnr) → BFE.
  // DAWA's adresse-endpoints eksponerer IKKE bfenummer direkte, kun ejerlav +
  // matrikelnr. Men /jordstykker/{ejerlavkode}/{matrikelnr} har bfenummer.
  const encoded = encodeURIComponent(adr.adresseId);
  const viaAdresse =
    `${adr.vejnavn ?? ''} ${adr.husnummerFra ?? ''}${adr.bogstavFra ?? ''}, ${adr.postnummer ?? ''} ${adr.postdistrikt ?? ''}`.trim();

  /** Slår jordstykket op på ejerlavkode + matrikelnr for at få BFE. */
  async function jordstykkeBfe(
    ejerlavkode: number | string,
    matrikelnr: string
  ): Promise<number | null> {
    try {
      const url = `https://api.dataforsyningen.dk/jordstykker/${ejerlavkode}/${encodeURIComponent(matrikelnr)}`;
      const res = await fetchDawa(
        url,
        { signal: AbortSignal.timeout(10000) },
        { caller: 'person-bridge.jordstykker' }
      );
      if (!res.ok) return null;
      const j = (await res.json()) as { bfenummer?: number };
      return j.bfenummer ?? null;
    } catch {
      return null;
    }
  }

  let bfeNummer: number | null = null;
  const dawaDiag: Array<{ label: string; status: number; info?: unknown }> = [];

  /**
   * Forsøg 1: /adresser/{id} returnerer adgangsadresse med ejerlav + matrikelnr.
   */
  try {
    const res = await fetchDawa(
      `https://api.dataforsyningen.dk/adresser/${encoded}`,
      { signal: AbortSignal.timeout(10000) },
      { caller: 'person-bridge.adresser' }
    );
    if (res.ok) {
      const d = (await res.json()) as {
        adgangsadresse?: { ejerlav?: { kode?: number }; matrikelnr?: string };
      };
      const ek = d.adgangsadresse?.ejerlav?.kode;
      const mn = d.adgangsadresse?.matrikelnr;
      if (ek && mn) bfeNummer = await jordstykkeBfe(ek, mn);
      dawaDiag.push({ label: 'adresser-by-id', status: res.status, info: { ek, mn, bfeNummer } });
    } else {
      dawaDiag.push({ label: 'adresser-by-id', status: res.status });
    }
  } catch (e) {
    dawaDiag.push({ label: 'adresser-by-id', status: 0, info: String(e) });
  }

  /**
   * Forsøg 2 (fallback): søg på vejnavn+husnr+postnr hvis adresseId ikke gav resultat.
   */
  if (bfeNummer == null && adr.vejnavn && adr.husnummerFra != null && adr.postnummer != null) {
    try {
      const params = new URLSearchParams({
        vejnavn: adr.vejnavn,
        husnr: `${adr.husnummerFra}${adr.bogstavFra ?? ''}`,
        postnr: String(adr.postnummer),
      });
      const res = await fetchDawa(
        `https://api.dataforsyningen.dk/adgangsadresser?${params.toString()}`,
        { signal: AbortSignal.timeout(10000) },
        { caller: 'person-bridge.adgangsadresser' }
      );
      if (res.ok) {
        const arr = (await res.json()) as Array<{
          ejerlav?: { kode?: number };
          matrikelnr?: string;
        }>;
        const first = arr[0];
        const ek = first?.ejerlav?.kode;
        const mn = first?.matrikelnr;
        if (ek && mn) bfeNummer = await jordstykkeBfe(ek, mn);
        dawaDiag.push({
          label: 'adgangsadresser-search',
          status: res.status,
          info: { ek, mn, bfeNummer, count: arr.length },
        });
      } else {
        dawaDiag.push({ label: 'adgangsadresser-search', status: res.status });
      }
    } catch (e) {
      dawaDiag.push({ label: 'adgangsadresser-search', status: 0, info: String(e) });
    }
  }

  if (bfeNummer == null) {
    return NextResponse.json({
      cvrEnhedsNummer: enhedsNr,
      navn: person.navn,
      ejfPersonId: null,
      foedselsdato: null,
      viaBfe: null,
      viaAdresse,
      fejl: `Kunne ikke resolve hjem-adresse til BFE via DAWA (diag: ${JSON.stringify(dawaDiag)})`,
    } satisfies PersonBridgeResponse);
  }

  // Trin 3+4 — hent EJF ejerskab for hjem-BFE via vores raw probe
  // (eller evt. en dedikeret endpoint). Raw-routen returnerer alle felter
  // inklusive ejendePersonBegraenset.id + foedselsdato som vi skal bruge.
  const rawEjerskab = await fetchJson<{
    result?: {
      data?: {
        EJFCustom_EjerskabBegraenset?: {
          nodes?: Array<{
            status?: string;
            ejendePersonBegraenset?: {
              id?: string;
              foedselsdato?: string;
              navn?: { navn?: string };
            } | null;
          }>;
        };
      };
    };
  }>(`${base}/api/ejerskab/raw?bfeNummer=${bfeNummer}`, cookie);

  const nodes = rawEjerskab?.result?.data?.EJFCustom_EjerskabBegraenset?.nodes ?? [];
  const normTarget = normNavn(person.navn);
  const match = nodes.find((n) => {
    if (n.status && n.status !== 'gældende') return false; // kun aktuel ejer
    const personNavnEjer = n.ejendePersonBegraenset?.navn?.navn;
    return personNavnEjer ? normNavn(personNavnEjer) === normTarget : false;
  });

  if (!match?.ejendePersonBegraenset?.id) {
    // BIZZ-534 fallback: Personen er ikke direkte ejer af hjem-adressen
    // (f.eks. fordi et holdingselskab ejer bopælen). Søg i bulk-data
    // efter unik navne-match for at finde fødselsdato. Hvis præcis én
    // (navn, fdato)-kombination matcher, returner den — ellers fejl.
    try {
      const admin = createAdminClient();
      // BIZZ-534: Brug .eq() med ix_ejf_person_navn_exact-index (migration 048).
      // .ilike() uden wildcards ramte ikke det eksisterende lower()-index og
      // kørte fuld scan på 3M+ rækker → statement timeout.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rows, error } = await (admin as any)
        .from('ejf_ejerskab')
        .select('ejer_navn, ejer_foedselsdato')
        .eq('ejer_navn', person.navn)
        .eq('ejer_type', 'person')
        .eq('status', 'gældende')
        .not('ejer_foedselsdato', 'is', null)
        .limit(100);

      if (!error && Array.isArray(rows) && rows.length > 0) {
        // Distinct (navn, foedselsdato)-kombinationer
        const distinct = Array.from(
          new Set(rows.map((r) => `${r.ejer_navn}|${r.ejer_foedselsdato}`))
        ).map((k) => {
          const [navn, fdato] = k.split('|');
          return { navn, fdato };
        });

        if (distinct.length === 1) {
          return NextResponse.json(
            {
              cvrEnhedsNummer: enhedsNr,
              navn: person.navn,
              ejfPersonId: null, // bulk-data har ikke EJF person-id direkte
              foedselsdato: distinct[0].fdato,
              viaBfe: bfeNummer,
              viaAdresse,
              fejl: null,
            } satisfies PersonBridgeResponse,
            {
              status: 200,
              headers: { 'Cache-Control': 'private, s-maxage=3600' },
            }
          );
        }
        // Flere distinct — kan ikke entydigt bestemme fdato uden kommune-filter
        logger.warn(
          `[person-bridge] ${distinct.length} distinct fdato for navn="${person.navn}" — kan ikke disambiguere`
        );
      }
    } catch (err) {
      logger.error(
        '[person-bridge] Bulk-data fallback fejlede:',
        err instanceof Error ? err.message : err
      );
    }

    return NextResponse.json({
      cvrEnhedsNummer: enhedsNr,
      navn: person.navn,
      ejfPersonId: null,
      foedselsdato: null,
      viaBfe: bfeNummer,
      viaAdresse,
      fejl: 'Personen blev ikke fundet som aktuel ejer af hjem-adressen i EJF',
    } satisfies PersonBridgeResponse);
  }

  return NextResponse.json(
    {
      cvrEnhedsNummer: enhedsNr,
      navn: person.navn,
      ejfPersonId: match.ejendePersonBegraenset.id ?? null,
      foedselsdato: match.ejendePersonBegraenset.foedselsdato ?? null,
      viaBfe: bfeNummer,
      viaAdresse,
      fejl: null,
    } satisfies PersonBridgeResponse,
    {
      status: 200,
      headers: { 'Cache-Control': 'private, s-maxage=3600' },
    }
  );
}
