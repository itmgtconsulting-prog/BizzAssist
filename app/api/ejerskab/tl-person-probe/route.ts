/**
 * GET /api/ejerskab/tl-person-probe
 *
 * Probe Tinglysning's person-søge-endpoints for at finde ud af om vi kan slå
 * en persons ejendomme op via navn + fødselsdato. Vi ved fra http-api-
 * beskrivelse v1.12 at soegpersonbogcvr accepterer fdato+navn, men endpointet
 * returnerer primært personbog-UUIDs (løsøre-pant).
 *
 * Testet:
 *   1. /soegpersonbogcvr?fdato=DDMMYY&navn=X&udenfdato=false
 *   2. /soegvirksomhed/cvr?bog=1&cvr=X&rolle=ejer — virker for CVR
 *   3. Forskellige varianter der kombinerer fdato+navn med bog/rolle
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { tlFetch } from '@/app/lib/tlFetch';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const navn = req.nextUrl.searchParams.get('navn') ?? 'Jakob Juul Rasmussen';
  const fdatoIso = req.nextUrl.searchParams.get('fdato') ?? '1972-07-11';
  // Konverter ISO (YYYY-MM-DD) til Tinglysning-format (DDMMYY)
  const [y, m, d] = fdatoIso.split('-');
  const fdatoShort = `${d}${m}${y.slice(2)}`;

  const encodedNavn = encodeURIComponent(navn);

  // Liste af endpoints vi vil prøve — både /unsecuressl/ og /ssl/ varianter
  const probes: Array<{ label: string; path: string; apiPath?: string }> = [
    // Kendt endpoint: personbog-søgning (løsøre) med fdato+navn
    {
      label: 'soegpersonbogcvr_fdato_navn_unsecuressl',
      path: `/soegpersonbogcvr?fdato=${fdatoShort}&navn=${encodedNavn}&udenfdato=false`,
      apiPath: '/tinglysning/unsecuressl',
    },
    // Samme men via ssl
    {
      label: 'soegpersonbogcvr_fdato_navn_ssl',
      path: `/soegpersonbogcvr?fdato=${fdatoShort}&navn=${encodedNavn}&udenfdato=false`,
    },
    // Prøv soegvirksomhed med navn+fdato i stedet for cvr (langskud)
    {
      label: 'soegvirksomhed_fdato_navn_bog1',
      path: `/soegvirksomhed/cvr?bog=1&rolle=ejer&fdato=${fdatoShort}&navn=${encodedNavn}`,
    },
    // Tingbog-søgning via adresse for Jakobs bopæl (uafhængig check)
    {
      label: 'ejendom_adresse_soebyvej11',
      path: `/ejendom/adresse?husnummer=11&postnummer=2650&vejnavn=S%C3%B8byvej`,
    },
    // Person-UUID opslag når vi kender uuid (placeholder)
    {
      label: 'personbog_opslag_via_uuid_placeholder',
      path: `/personbog/TEST-UUID`,
      apiPath: '/tinglysning/unsecuressl',
    },
  ];

  const results: Record<string, unknown> = {};
  for (const p of probes) {
    try {
      const r = await tlFetch(p.path, { apiPath: p.apiPath });
      results[p.label] = {
        path: p.path,
        apiPath: p.apiPath ?? '/tinglysning/ssl',
        status: r.status,
        bodyPreview: r.body.slice(0, 1500),
      };
    } catch (err) {
      results[p.label] = {
        path: p.path,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json(
    { inputs: { navn, fdatoIso, fdatoShort }, results },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
