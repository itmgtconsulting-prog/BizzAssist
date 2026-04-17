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

  // Trin 2 — DAWA: adresseId → BFE via jordstykke-opslag
  // DAWA returnerer adgangsadressedata inkl. jordstykke.bfenummer
  const dawaUrl = `https://api.dataforsyningen.dk/adgangsadresser/${encodeURIComponent(adr.adresseId)}`;
  let bfeNummer: number | null = null;
  const viaAdresse =
    `${adr.vejnavn ?? ''} ${adr.husnummerFra ?? ''}${adr.bogstavFra ?? ''}, ${adr.postnummer ?? ''} ${adr.postdistrikt ?? ''}`.trim();
  try {
    const res = await fetch(dawaUrl, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const d = (await res.json()) as {
        jordstykke?: { bfenummer?: number };
        adgangspunkt?: { bfenummer?: number };
      };
      bfeNummer = d.jordstykke?.bfenummer ?? d.adgangspunkt?.bfenummer ?? null;
    }
  } catch {
    /* fortsæt — ingen BFE */
  }

  if (bfeNummer == null) {
    return NextResponse.json({
      cvrEnhedsNummer: enhedsNr,
      navn: person.navn,
      ejfPersonId: null,
      foedselsdato: null,
      viaBfe: null,
      viaAdresse,
      fejl: 'Kunne ikke resolve hjem-adresse til BFE via DAWA',
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
