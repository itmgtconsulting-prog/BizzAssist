/**
 * GET /api/ejerskab/raw?bfeNummer=<N>
 *
 * DIAGNOSTISK endpoint — deaktiveret i produktion.
 *
 * Brugt under EJF-adgangs-analysen (se BIZZ-XXX EJF bulk-ingestion) til at
 * probe hvilke felter EJFCustom_EjerskabBegraenset eksponerer på nodes.
 * Returnerer HTTP 410 indtil re-aktiveret.
 *
 * Re-aktivering: unwrap DISABLED-blokken nedenfor og gen-udrul.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { error: 'Diagnostic endpoint disabled in production' },
    { status: 410 }
  );
}

/* ─────────── DISABLED — re-enable by moving code above the stub ───────────

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { getCertOAuthToken, isCertAuthConfigured } from '@/app/lib/dfCertAuth';
import { proxyUrl, proxyHeaders } from '@/app/lib/dfProxy';

export const maxDuration = 30;

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';

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
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    let parseError: string | null = null;
    try { parsed = text ? JSON.parse(text) : null; }
    catch (e) { parseError = e instanceof Error ? e.message : String(e); }
    return NextResponse.json(
      { bfeNummer, tokenSource, httpStatus: res.status, responseLen: text.length,
        rawPreview: text.slice(0, 1200), parseError, result: parsed },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return NextResponse.json(
      { bfeNummer, error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5) : null },
      { status: 502 }
    );
  }
}

─────────── END DISABLED ─────────── */
