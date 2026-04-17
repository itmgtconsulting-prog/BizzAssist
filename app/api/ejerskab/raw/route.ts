/**
 * GET /api/ejerskab/raw?bfeNummer=2081243
 *
 * Diagnostisk endpoint der henter de UDVIDEDE EJF-felter for en BFE, så vi
 * kan verificere at `ejendePersonBegraenset.id` og `.foedselsdato` er
 * tilgængelige og bygge en deterministisk bro fra CVR ES-person til EJF-ejer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { proxyUrl, proxyHeaders } from '@/app/lib/dfProxy';

export const runtime = 'nodejs';
export const maxDuration = 30;

const EJF_GQL_URL = 'https://services.datafordeler.dk/EJF/Ejerfortegnelsen/3/REST/graphql';

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bfeParam = req.nextUrl.searchParams.get('bfeNummer');
  const bfeNummer = bfeParam ? parseInt(bfeParam, 10) : NaN;
  if (!Number.isFinite(bfeNummer) || bfeNummer <= 0) {
    return NextResponse.json({ error: 'bfeNummer required' }, { status: 400 });
  }

  let token: string | null = await getSharedOAuthToken().catch(() => null);
  let tokenSource = 'shared-secret';
  if (!token && isCertAuthConfigured()) {
    token = await getCertOAuthToken().catch(() => null);
    tokenSource = 'cert';
  }
  if (!token) {
    return NextResponse.json(
      { error: 'OAuth token unavailable', tokenSource: 'none' },
      { status: 503 }
    );
  }

  const virkningstid = new Date().toISOString();
  const query = `{
    EJFCustom_EjerskabBegraenset(
      first: 50
      virkningstid: "${virkningstid}"
      where: { bestemtFastEjendomBFENr: { eq: ${bfeNummer} } }
    ) {
      nodes {
        bestemtFastEjendomBFENr
        ejerforholdskode
        faktiskEjerandel_taeller
        faktiskEjerandel_naevner
        tinglystEjerandel_taeller
        tinglystEjerandel_naevner
        virkningFra
        virkningTil
        status
        ejendeVirksomhedCVRNr_20_Virksomhed_CVRNummer_ref {
          CVRNummer
          id_CVR_Navn_CVREnhedsId_ref { vaerdi }
        }
        ejendePersonBegraenset {
          id
          status
          statusdato
          navn { navn }
          foedselsdato
          foedselsdatoUsikkerhedsmarkering
          standardadresse
        }
      }
    }
  }`;

  try {
    const res = await fetch(proxyUrl(EJF_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    const json = await res.json();
    return NextResponse.json(
      { bfeNummer, tokenSource, status: res.status, result: json },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return NextResponse.json(
      {
        bfeNummer,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
