/**
 * GET /api/debug/ejf-admin-probe
 *
 * BIZZ-1644: Probe EJFCustom_EjendomsadministratorBegraenset og
 * EJFCustom_PersonEllerVirksomhedsadminiBegraenset for at finde
 * brugbare felter og filtre til E/F ejendoms-resolution.
 *
 * Auth: admin user (app_metadata.isAdmin)
 */

import { NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 60;

const EJF_GQL_URL = 'https://graphql.datafordeler.dk/flexibleCurrent/v1/';

async function probe(token: string, name: string, query: string) {
  try {
    const res = await fetch(proxyUrl(EJF_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });
    const json = await res.json();
    const errors = json.errors?.map((e: { message: string }) => e.message.slice(0, 100)) ?? [];
    const firstKey = Object.keys(json.data ?? {})[0];
    const nodes = firstKey ? (json.data[firstKey]?.nodes ?? []) : [];
    return {
      name,
      ok: res.ok && errors.length === 0,
      status: res.status,
      nodes: nodes.length,
      errors,
      sample: nodes[0] ?? null,
    };
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Verify admin
  const admin = createAdminClient();
  const { data: freshUser } = await admin.auth.admin.getUserById(auth.userId);
  if (!freshUser?.user?.app_metadata?.isAdmin) {
    return NextResponse.json({ error: 'Admin required' }, { status: 403 });
  }

  const token = await getSharedOAuthToken();
  if (!token) return NextResponse.json({ error: 'No DF token' }, { status: 500 });

  const VT = new Date().toISOString();
  const results = [];

  // ── 1. EjendomsadministratorBegraenset — basis ──
  results.push(
    await probe(
      token,
      '1. Admin basis (id+status)',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId status } } }`
    )
  );

  // ── 2. Admin med BFE-felt ──
  results.push(
    await probe(
      token,
      '2. Admin + BFE',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId status bestemtFastEjendomBFENr } } }`
    )
  );

  // ── 3. Admin med CVR-felt guesses ──
  results.push(
    await probe(
      token,
      '3. Admin + CVRNr',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId administratorCVRNr } } }`
    )
  );

  results.push(
    await probe(
      token,
      '4. Admin + virksomhedCVRNr',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId virksomhedCVRNr } } }`
    )
  );

  results.push(
    await probe(
      token,
      '5. Admin + ejendeVirksomhedCVRNr',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId ejendeVirksomhedCVRNr } } }`
    )
  );

  // ── 4. Admin med relation-guesses ──
  results.push(
    await probe(
      token,
      '6. Admin + personEllerVirksomhed relation',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId administratorPersonEllerVirksomhedsadmini { id_lokalId } } } }`
    )
  );

  results.push(
    await probe(
      token,
      '7. Admin + navn relation',
      `{ EJFCustom_EjendomsadministratorBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId navn } } }`
    )
  );

  // ── 5. PersonEllerVirksomhedsadmini — basis ──
  results.push(
    await probe(
      token,
      '8. PersVirk basis',
      `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId status } } }`
    )
  );

  // ── 6. PersVirk med felter ──
  results.push(
    await probe(
      token,
      '9. PersVirk + navn+CVR',
      `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId navn CVRNr } } }`
    )
  );

  results.push(
    await probe(
      token,
      '10. PersVirk + virksomhedsnavn',
      `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId virksomhedsnavn } } }`
    )
  );

  results.push(
    await probe(
      token,
      '11. PersVirk + fiktivtPVnummer+adresse',
      `{ EJFCustom_PersonEllerVirksomhedsadminiBegraenset(first: 3, virkningstid: "${VT}") { nodes { id_lokalId fiktivtPVnummer adresselinje1 landeKodeNumerisk } } }`
    )
  );

  // ── 7. Reverse query: EjerskabBegraenset WHERE CVR = E/F ──
  results.push(
    await probe(
      token,
      '12. Ejerskab reverse CVR=34671761',
      `{ EJFCustom_EjerskabBegraenset(first: 10, virkningstid: "${VT}", where: { ejendeVirksomhedCVRNr: { eq: 34671761 } }) { nodes { bestemtFastEjendomBFENr ejerforholdskode status } } }`
    )
  );

  // ── 8. Introspection ──
  results.push(
    await probe(
      token,
      '13. Introspection Query fields',
      `{ __type(name: "Query") { fields { name } } }`
    )
  );

  return NextResponse.json({ probes: results });
}
