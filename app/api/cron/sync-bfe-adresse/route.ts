/**
 * GET /api/cron/sync-bfe-adresse
 *
 * BIZZ-1670: Daglig cron-job der finder nye BFE'er i ejf_ejerskab uden
 * cached adresse og prøver at resolve dem via DAWA + VP.
 *
 * Kører som Vercel cron (schedule: "0 5 * * *" — kl 05:00 UTC dagligt).
 * Max 50 BFE'er per kørsel for at holde execution time under 30s.
 *
 * @module api/cron/sync-bfe-adresse
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { fetchDawa } from '@/app/lib/dawa';
import { DAWA_BASE_URL } from '@/app/lib/serviceEndpoints';

export const maxDuration = 30;

/** Verify cron secret in production */
function verifyCron(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization');
  const isCron = request.headers.get('x-vercel-cron') === '1';
  return auth === `Bearer ${secret}` || isCron;
}

/**
 * GET handler — sync missing BFE addresses.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'sync-bfe-adresse', schedule: '0 6 * * *', intervalMinutes: 1440 },
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const admin = createAdminClient() as any;
      const BATCH_LIMIT = 50;

      try {
        // Find BFE'er i ejf_ejerskab + ejf_administrator uden cached adresse.
        // BIZZ-1841: Inkludér historisk ejerskab og administrator-records —
        // SFE-BFE'er har ofte kun historisk ejerskab eller administrator-data.
        const { data: ejfGaeldende } = await admin
          .from('ejf_ejerskab')
          .select('bfe_nummer')
          .eq('status', 'gældende')
          .limit(5000);
        const { data: ejfHistorisk } = await admin
          .from('ejf_ejerskab')
          .select('bfe_nummer')
          .eq('status', 'historisk')
          .limit(5000);
        const { data: adminGaeldende } = await admin
          .from('ejf_administrator')
          .select('bfe_nummer')
          .not('virksomhed_cvr', 'is', null)
          .limit(5000);

        const allBfeSet = new Set<number>();
        for (const r of (ejfGaeldende ?? []) as Array<{ bfe_nummer: number }>)
          allBfeSet.add(r.bfe_nummer);
        for (const r of (ejfHistorisk ?? []) as Array<{ bfe_nummer: number }>)
          allBfeSet.add(r.bfe_nummer);
        for (const r of (adminGaeldende ?? []) as Array<{ bfe_nummer: number }>)
          allBfeSet.add(r.bfe_nummer);

        // Find cached BFEs — inkl. dem med postnr=null (korrupt data der skal re-resolves)
        // BIZZ-1850: Ekskluder kilde='unresolvable' indtil next_retry_after — disse BFE'er
        // fejlede alle 3 fallbacks og skal kun retry kvartalsvist.
        const { data: allCached } = await admin
          .from('bfe_adresse_cache')
          .select('bfe_nummer, postnr, kilde, next_retry_after');

        const nowIso = new Date().toISOString();
        const skipSet = new Set<number>();
        for (const r of (allCached ?? []) as Array<{
          bfe_nummer: number;
          postnr: string | null;
          kilde: string;
          next_retry_after: string | null;
        }>) {
          // Skip BFE'er der enten er resolved (postnr!=null) ELLER er markeret unresolvable
          // og endnu ikke er klar til retry.
          const hasGoodAddress = r.postnr !== null;
          const isUnresolvable =
            r.kilde === 'unresolvable' && (!r.next_retry_after || r.next_retry_after > nowIso);
          if (hasGoodAddress || isUnresolvable) skipSet.add(r.bfe_nummer);
        }
        const missing = [...allBfeSet].filter((b) => !skipSet.has(b)).slice(0, BATCH_LIMIT);

        if (missing.length === 0) {
          return NextResponse.json({ synced: 0, message: 'Alle BFE-adresser er cached' });
        }

        let resolved = 0;
        let markedUnresolvable = 0;
        // BIZZ-1850: Skub retry 90 dage frem for BFE'er der fejler alle 3 fallbacks
        const RETRY_DELAY_DAYS = 90;

        for (const bfe of missing) {
          try {
            // Fallback 1: DAWA /bfe
            const dawaRes = await fetchDawa(
              `${DAWA_BASE_URL}/bfe/${bfe}`,
              { signal: AbortSignal.timeout(5000), next: { revalidate: 86400 } },
              { caller: 'cron.sync-bfe-adresse' }
            );

            if (dawaRes.ok) {
              const json = await dawaRes.json();
              const bel = (
                json as {
                  beliggenhedsadresse?: {
                    vejnavn?: string;
                    husnr?: string;
                    etage?: string;
                    dør?: string;
                    postnr?: string;
                    postnrnavn?: string;
                    kommunenavn?: string;
                    kommunekode?: string;
                    id?: string;
                  };
                }
              ).beliggenhedsadresse;
              if (bel?.vejnavn) {
                await admin.from('bfe_adresse_cache').upsert(
                  {
                    bfe_nummer: bfe,
                    adresse: `${bel.vejnavn} ${bel.husnr ?? ''}`.trim(),
                    etage: bel.etage ?? null,
                    doer: bel.dør ?? null,
                    postnr: bel.postnr ?? null,
                    postnrnavn: bel.postnrnavn ?? null,
                    kommune: bel.kommunenavn ?? null,
                    kommune_kode: bel.kommunekode ?? null,
                    dawa_id: bel.id ?? null,
                    ejendomstype: (json as { ejendomstype?: string }).ejendomstype ?? null,
                    kilde: 'cron_dawa',
                    sidst_opdateret: new Date().toISOString(),
                  },
                  { onConflict: 'bfe_nummer' }
                );
                resolved++;
                continue;
              }
            }

            // Fallback 2: VP ES
            const vpRes = await fetch(
              'https://api-fs.vurderingsportalen.dk/preliminaryproperties/_search',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                body: JSON.stringify({
                  query: { term: { bfeNumbers: bfe } },
                  size: 1,
                  _source: [
                    'roadName',
                    'houseNumber',
                    'zipcode',
                    'postDistrict',
                    'floor',
                    'door',
                    'adgangsAdresseID',
                  ],
                }),
                signal: AbortSignal.timeout(5000),
              }
            );

            if (vpRes.ok) {
              const vpData = (await vpRes.json()) as {
                hits?: { hits?: Array<{ _source?: Record<string, string> }> };
              };
              const src = vpData.hits?.hits?.[0]?._source;
              if (src?.roadName) {
                await admin.from('bfe_adresse_cache').upsert(
                  {
                    bfe_nummer: bfe,
                    adresse: `${src.roadName} ${src.houseNumber ?? ''}`.trim(),
                    etage: src.floor ?? null,
                    doer: src.door ?? null,
                    postnr: src.zipcode ?? null,
                    postnrnavn: src.postDistrict ?? null,
                    dawa_id: src.adgangsAdresseID ?? null,
                    kilde: 'cron_vp',
                    sidst_opdateret: new Date().toISOString(),
                  },
                  { onConflict: 'bfe_nummer' }
                );
                resolved++;
                continue;
              }
            }

            // Fallback 3: DAWA jordstykke — for SFE-BFE'er der ikke har
            // beliggenhedsadresse (DAWA /bfe/ returnerer fejl for SFE'er).
            // Via jordstykke finder vi matrikel → adresser → bruger første adresse.
            const jordRes = await fetchDawa(
              `${DAWA_BASE_URL}/jordstykker?bfenummer=${bfe}&format=json`,
              { signal: AbortSignal.timeout(8000) },
              { caller: 'cron.sync-bfe-adresse.jordstykke' }
            );
            if (jordRes.ok) {
              const jordstykker = (await jordRes.json()) as Array<{
                ejerlav?: { kode?: number };
                matrikelnr?: string;
              }>;
              const ejerlav = jordstykker[0]?.ejerlav?.kode;
              const matr = jordstykker[0]?.matrikelnr;
              if (ejerlav && matr) {
                const adrRes = await fetchDawa(
                  `${DAWA_BASE_URL}/adresser?ejerlavkode=${ejerlav}&matrikelnr=${encodeURIComponent(matr)}&format=json&struktur=mini&per_side=1`,
                  { signal: AbortSignal.timeout(8000) },
                  { caller: 'cron.sync-bfe-adresse.matrikel-adr' }
                );
                if (adrRes.ok) {
                  const adresser = (await adrRes.json()) as Array<{
                    vejnavn?: string;
                    husnr?: string;
                    postnr?: string;
                    postnrnavn?: string;
                    id?: string;
                  }>;
                  const a = adresser[0];
                  if (a?.vejnavn && a?.postnr) {
                    await admin.from('bfe_adresse_cache').upsert(
                      {
                        bfe_nummer: bfe,
                        adresse: a.vejnavn,
                        postnr: a.postnr,
                        postnrnavn: a.postnrnavn ?? null,
                        dawa_id: a.id ?? null,
                        kilde: 'cron_jordstykke',
                        sidst_opdateret: new Date().toISOString(),
                      },
                      { onConflict: 'bfe_nummer' }
                    );
                    resolved++;
                    continue;
                  }
                }
              }
            }

            // Fallback 4: DAWA adgangsadresse via adresseId — for BFEs der har
            // en adgangsadresse-id i ejf_ejerskab/ejf_administrator men ikke
            // en beliggenhedsadresse via /bfe/ endpoint.
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const { data: ejfRow } = await (admin as any)
                .from('ejf_ejerskab')
                .select('bfe_nummer')
                .eq('bfe_nummer', bfe)
                .maybeSingle();
              if (ejfRow) {
                // Prøv DAWA adresser med BFE som søgeparameter
                const dawaAdrRes = await fetchDawa(
                  `${DAWA_BASE_URL}/adresser?bfenummer=${bfe}&format=json&struktur=mini&per_side=1`,
                  { signal: AbortSignal.timeout(5000) },
                  { caller: 'cron.sync-bfe-adresse.dawa-adr' }
                );
                if (dawaAdrRes.ok) {
                  const adrData = (await dawaAdrRes.json()) as Array<{
                    vejnavn?: string;
                    husnr?: string;
                    etage?: string;
                    dør?: string;
                    postnr?: string;
                    postnrnavn?: string;
                    id?: string;
                  }>;
                  const a = adrData[0];
                  if (a?.vejnavn && a?.postnr) {
                    await admin.from('bfe_adresse_cache').upsert(
                      {
                        bfe_nummer: bfe,
                        adresse: `${a.vejnavn} ${a.husnr ?? ''}`.trim(),
                        etage: a.etage ?? null,
                        doer: a.dør ?? null,
                        postnr: a.postnr,
                        postnrnavn: a.postnrnavn ?? null,
                        dawa_id: a.id ?? null,
                        kilde: 'cron_dawa_adr',
                        sidst_opdateret: new Date().toISOString(),
                      },
                      { onConflict: 'bfe_nummer' }
                    );
                    resolved++;
                    continue;
                  }
                }
              }
            } catch {
              /* Fallback 4 non-fatal */
            }

            // BIZZ-1850: Alle 4 fallbacks fejlede → marker som unresolvable så cron
            // ikke retry hver dag. next_retry_after = nu + 90 dage så datakilder kan
            // få nye data over tid.
            const retryAfter = new Date(
              Date.now() + RETRY_DELAY_DAYS * 24 * 3600 * 1000
            ).toISOString();
            await admin.from('bfe_adresse_cache').upsert(
              {
                bfe_nummer: bfe,
                kilde: 'unresolvable',
                next_retry_after: retryAfter,
                sidst_opdateret: new Date().toISOString(),
              },
              { onConflict: 'bfe_nummer' }
            );
            markedUnresolvable++;
          } catch {
            /* individual BFE failure non-fatal */
          }
        }

        logger.log(
          `[sync-bfe-adresse] Synced ${resolved}/${missing.length} BFE addresses, marked ${markedUnresolvable} unresolvable`
        );
        return NextResponse.json({
          synced: resolved,
          unresolvable: markedUnresolvable,
          missing: missing.length,
        });
      } catch (err) {
        logger.error('[sync-bfe-adresse] Error:', err);
        return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
      }
    }
  );
}
