/**
 * GET /api/adresse/autocomplete?q=...
 *
 * Server-side proxy for DAR autocomplete.
 * Nødvendig fordi DAR kræver API-nøgle (server-side env var),
 * mens autocomplete bruges fra client-side komponenter.
 *
 * Logs 'address_search' events to activity_log for usage analytics.
 * Payload: { queryLength } — no raw query string stored (avoids PII risk).
 *
 * @param request - Next.js request med ?q=søgestreng
 * @returns Array af DawaAutocompleteResult (DAR-kompatibelt format)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { darAutocomplete } from '@/app/lib/dar';
import { expandAddressQueryVariants, hasInitialPrefix } from '@/app/lib/search/normalizeQuery';
import { checkRateLimit, rateLimit } from '@/app/lib/rateLimit';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { logActivity } from '@/app/lib/activityLog';
import { logger } from '@/app/lib/logger';
import { parseQuery } from '@/app/lib/validate';
import { fetchBbrStatusForAdresser } from '@/app/lib/bbrEjendomStatus';
import { DAR_STATUS } from '@/app/lib/bbrKoder';

/** Zod schema for autocomplete query params */
const autocompleteSchema = z.object({
  q: z.string().default(''),
});

export async function GET(request: NextRequest) {
  const limited = await checkRateLimit(request, rateLimit);
  if (limited) return limited;

  const parsed = parseQuery(request, autocompleteSchema);
  if (!parsed.success) return parsed.response;
  const { q } = parsed.data;

  if (q.trim().length < 2) {
    return NextResponse.json([]);
  }

  // Resolve auth context for activity logging — non-blocking if unauthenticated
  // (autocomplete is also called during login flow, so we don't gate on auth here)
  const auth = await resolveTenantId();
  if (auth) {
    logActivity(createAdminClient(), auth.tenantId, auth.userId, 'address_search', {
      // Store query length only — raw query string is omitted to avoid PII risk
      queryLength: q.trim().length,
    });
  }

  try {
    // BIZZ-843: Initialer-normalisering. Brugere skriver ofte "HC
    // Møllersvej" / "H.C. Andersens" hvor DAR har "H C Møllersvej".
    // Når query har et initialer-mønster prøver vi begge varianter
    // parallelt og merger resultater (dedup på adresse.id).
    const variants = hasInitialPrefix(q) ? expandAddressQueryVariants(q) : [q];
    const variantResults = await Promise.all(variants.map((v) => darAutocomplete(v)));
    const seenIds = new Set<string>();
    const results = [];
    for (const batch of variantResults) {
      for (const r of batch) {
        if (seenIds.has(r.adresse.id)) continue;
        seenIds.add(r.adresse.id);
        results.push(r);
      }
    }
    // BIZZ-785 iter 2a: berig med server-side is_udfaset flag fra
    // lokal bbr_ejendom_status-tabel. Batch-lookup pr. adresse-ID.
    // Tabellen er populated af backfill-scriptet + cron-refresh.
    // Missing row → status bliver ikke overskrevet (ukendt = aktiv).
    const adgangsadresseIds = results
      .filter((r) => r.type === 'adgangsadresse' && r.adresse.id.length >= 20)
      .map((r) => r.adresse.id);
    if (adgangsadresseIds.length > 0) {
      const statusMap = await fetchBbrStatusForAdresser(adgangsadresseIds);
      for (const r of results) {
        const entry = statusMap.get(r.adresse.id.toLowerCase());
        if (entry) {
          // Server-side verificeret udfaset-flag — overskriver DAR-
          // status-proxy hvis tilgængelig.
          if (entry.isUdfaset) {
            r.status = DAR_STATUS.Nedlagt;
          }
          // BIZZ-831: Pass BFE through for SFE href routing
          if (entry.bfeNummer) {
            r.bfe = entry.bfeNummer;
          }
        }
      }
    }
    return NextResponse.json(results, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (err) {
    logger.error('[adresse/autocomplete] Fejl:', err);
    return NextResponse.json([], { status: 200 });
  }
}
