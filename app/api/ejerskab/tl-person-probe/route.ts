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
  // Jakobs kendte person-UUID fundet via tidligere probe
  const personUuid =
    req.nextUrl.searchParams.get('personUuid') ?? '905ba322-eb8e-42e9-ab76-19027c296523';

  // Liste af endpoints vi vil prøve — både /unsecuressl/ og /ssl/ varianter
  const probes: Array<{ label: string; path: string; apiPath?: string }> = [
    // Kendt endpoint som bekræftet virker
    {
      label: 'soegpersonbogcvr_fdato_navn',
      path: `/soegpersonbogcvr?fdato=${fdatoShort}&navn=${encodedNavn}&udenfdato=false`,
      apiPath: '/tinglysning/unsecuressl',
    },
    // Person-UUID til personbog-opslag (kendt: løsøre)
    {
      label: 'personbog_by_uuid',
      path: `/personbog/${personUuid}`,
      apiPath: '/tinglysning/unsecuressl',
    },
    // MÅLET: Find alle ejendomme hvor denne person er adkomsthaver.
    // Prøv soegvirksomhed-stilen med uuid-parameter
    {
      label: 'soegvirksomhed_uuid_bog1_ejer',
      path: `/soegvirksomhed/cvr?bog=1&rolle=ejer&uuid=${personUuid}`,
    },
    {
      label: 'soegvirksomhed_plain_uuid',
      path: `/soegvirksomhed?bog=1&rolle=ejer&uuid=${personUuid}`,
    },
    {
      label: 'soegperson_uuid',
      path: `/soegperson/uuid/${personUuid}?bog=1&rolle=ejer`,
    },
    {
      label: 'soegperson_fdatonavn_bog1',
      path: `/soegperson/fdatonavn?bog=1&rolle=ejer&fdato=${fdatoShort}&navn=${encodedNavn}`,
    },
    {
      label: 'soegfastejendom_person_uuid',
      path: `/soegfastejendom?personuuid=${personUuid}&rolle=ejer`,
    },
    // Prøv at hente dokumenter hvor person-uuid er med
    {
      label: 'soegdokument_person_uuid',
      path: `/soegdokument?personuuid=${personUuid}&bog=1&rolle=ejer`,
    },
    // Udvidet personbog-søgning med rolle/bog
    {
      label: 'soegpersonbog_with_bog1',
      path: `/soegpersonbogcvr?fdato=${fdatoShort}&navn=${encodedNavn}&bog=1&rolle=ejer&udenfdato=false`,
      apiPath: '/tinglysning/unsecuressl',
    },
    // Direkte REST-path-variant
    {
      label: 'person_ejendomme_by_uuid',
      path: `/person/${personUuid}/ejendomme`,
    },
    {
      label: 'persons_adkomster',
      path: `/persons/${personUuid}/adkomster`,
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
