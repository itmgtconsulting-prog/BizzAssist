/**
 * SFE (Samlet Fast Ejendom) detaljeside.
 *
 * BIZZ-795 iter 1. Drill-down fra ejerlejlighed/bygning til deres
 * hovedejendom (SFE) med oversigt over alle komponenter.
 *
 * Route: /dashboard/ejendomme/sfe/[bfe]
 *
 * Data flow:
 *   1. Fetch MAT (`/api/matrikel?bfeNummer=...`) for SFE — giver
 *      jordstykker + ejerlavskode + matrikelnummer.
 *   2. For hvert jordstykke: fetch ejerlejligheder/bygninger via
 *      `/api/ejerlejligheder?ejerlavKode=X&matrikelnr=Y&includeUdfasede=true`.
 *   3. Grupper komponenter efter bygnings-prefix (fx "62A" vs "62B"
 *      parses fra første komma-del af adressen).
 *
 * Iter 2 (BIZZ-795b, parkeret):
 *   * Kort med farve-kodede markører pr. bygning
 *   * Ejerforening fra EJF (separate query)
 *   * Ejerandele pr. lejlighed
 *   * E2E-test for drill-down-flow
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Building2, Home } from 'lucide-react';
import { logger } from '@/app/lib/logger';
import type { MatrikelResponse } from '@/app/api/matrikel/route';
import EjendomBreadcrumb from '@/app/components/ejendomme/EjendomBreadcrumb';

export const dynamic = 'force-dynamic';

interface SfeDetailPageProps {
  params: Promise<{ bfe: string }>;
}

interface EjerlejlighedItem {
  bfe: number;
  adresse: string;
  etage: string | null;
  doer: string | null;
  ejer: string;
  areal: number | null;
  dawaId: string | null;
}

/**
 * Server-side fetch af MAT-data for SFE BFE.
 *
 * @param bfeNummer - BFE som string fra URL
 * @returns MatrikelResponse eller null ved fejl
 */
async function fetchMatrikel(bfeNummer: string): Promise<MatrikelResponse | null> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const res = await fetch(`${base}/api/matrikel?bfeNummer=${encodeURIComponent(bfeNummer)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as MatrikelResponse;
  } catch (err) {
    logger.error('[sfe-page] matrikel fetch fejl:', err);
    return null;
  }
}

/**
 * Server-side fetch af alle komponenter på en matrikel via
 * `/api/ejerlejligheder`. Returnerer tom array ved fejl (UI viser
 * "ingen komponenter fundet" fallback).
 */
async function fetchEjerlejligheder(
  ejerlavKode: string,
  matrikelnr: string,
  moderBfe: number
): Promise<EjerlejlighedItem[]> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const params = new URLSearchParams({
      ejerlavKode,
      matrikelnr,
      moderBfe: String(moderBfe),
      includeUdfasede: 'true',
    });
    const res = await fetch(`${base}/api/ejerlejligheder?${params}`, { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as { lejligheder: EjerlejlighedItem[] };
    return data.lejligheder ?? [];
  } catch (err) {
    logger.error('[sfe-page] ejerlejligheder fetch fejl:', err);
    return [];
  }
}

/**
 * Parser bygnings-prefix fra adresse. For "Arnold Nielsens Boulevard
 * 62A, 1. tv, 1234 By" → returnerer "62A" som grupperings-nøgle.
 * For "Arnold Nielsens Boulevard 62, 1234 By" (uden bogstav) → "62".
 */
function parseBygningsPrefix(adresse: string): string {
  const first = adresse.split(',')[0].trim();
  // Match sidste talgruppe evt. efterfulgt af bogstav (husnr + evt. bogstav)
  const match = first.match(/(\d+[A-Za-zÆØÅæøå]?)$/);
  return match ? match[1].toUpperCase() : first;
}

/**
 * SFE-detaljeside server component. Fetcher MAT + komponenter og
 * grupperer dem til visning.
 */
export default async function SfeDetailPage({ params }: SfeDetailPageProps) {
  const { bfe } = await params;
  if (!/^\d+$/.test(bfe)) notFound();

  const mat = await fetchMatrikel(bfe);
  if (!mat?.matrikel) notFound();

  const { matrikel } = mat;
  const bfeNum = Number(bfe);

  // Hent komponenter for hvert jordstykke
  const komponenter: EjerlejlighedItem[] = [];
  for (const js of matrikel.jordstykker) {
    if (!js.ejerlavskode || !js.matrikelnummer) continue;
    const comps = await fetchEjerlejligheder(js.ejerlavskode, js.matrikelnummer, bfeNum);
    komponenter.push(...comps);
  }

  // Grupper per bygnings-prefix
  const groups = new Map<string, EjerlejlighedItem[]>();
  for (const k of komponenter) {
    const prefix = parseBygningsPrefix(k.adresse);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(k);
  }
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, 'da'));

  const jordstykkeLabel = matrikel.jordstykker
    .map((j) => `${j.matrikelnummer}${j.ejerlavsnavn ? `, ${j.ejerlavsnavn}` : ''}`)
    .join(' · ');

  return (
    <div className="bg-[#0a1020] min-h-screen">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* BIZZ-797: Breadcrumb giver ensartet navigation på tværs af
            SFE/bygning/lejlighed. SFE er top-niveau så breadcrumb stopper
            her. */}
        <EjendomBreadcrumb
          levels={[
            { label: 'Dashboard', href: '/dashboard' },
            { label: 'Ejendomme', href: '/dashboard/ejendomme' },
            { label: `SFE ${bfe}` },
          ]}
        />

        {/* Back-link */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
        >
          <ArrowLeft size={14} />
          Tilbage
        </Link>

        {/* Header */}
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
            <Building2 size={12} />
            <span>Samlet Fast Ejendom (hovedejendom)</span>
          </div>
          <h1 className="text-white text-2xl font-bold">
            BFE <span className="font-mono">{bfe}</span>
          </h1>
          <p className="text-slate-400 text-sm mt-1">{jordstykkeLabel}</p>
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            <span className="px-2 py-0.5 rounded-full bg-slate-800/60 border border-slate-700/50 text-slate-300">
              {komponenter.length} komponent{komponenter.length === 1 ? '' : 'er'}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-slate-800/60 border border-slate-700/50 text-slate-300">
              {sortedGroups.length} bygning{sortedGroups.length === 1 ? '' : 'er'}
            </span>
            {matrikel.opdeltIEjerlejligheder && (
              <span className="px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300">
                Opdelt i ejerlejligheder
              </span>
            )}
            {matrikel.landbrugsnotering && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300">
                Landbrug
              </span>
            )}
          </div>
        </div>

        {/* Komponenter grupperet per bygning */}
        {sortedGroups.length === 0 ? (
          <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-8 text-center text-slate-400">
            Ingen komponenter fundet for denne SFE. Matriklen indeholder muligvis kun grund (ingen
            bygninger registreret i BBR).
          </div>
        ) : (
          <div className="space-y-6">
            {sortedGroups.map(([prefix, items]) => (
              <section key={prefix}>
                <h2 className="text-white text-lg font-semibold flex items-center gap-2 mb-3">
                  <Building2 size={18} className="text-emerald-400" />
                  Bygning {prefix}
                  <span className="text-xs text-slate-500 font-normal">
                    ({items.length} enhed{items.length === 1 ? '' : 'er'})
                  </span>
                </h2>
                <div className="space-y-2">
                  {items.map((k) => {
                    // Link: foretræk dawaId til detalje-side (giver
                    // adgang til BBR-data), ellers BFE.
                    const href = k.dawaId
                      ? `/dashboard/ejendomme/${k.dawaId}`
                      : `/dashboard/ejendomme/${k.bfe}`;
                    const unitLabel =
                      k.etage || k.doer
                        ? [k.etage, k.doer].filter(Boolean).join('. ')
                        : 'Hovedadresse';
                    return (
                      <Link
                        key={`${k.bfe}-${k.adresse}`}
                        href={href}
                        className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[#0f172a] border border-slate-700/50 hover:border-blue-500/40 transition-colors"
                      >
                        <Home size={14} className="text-blue-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm font-medium truncate">{k.adresse}</p>
                          <p className="text-slate-500 text-xs mt-0.5">
                            {unitLabel}
                            {k.areal != null && ` · ${k.areal} m²`}
                            {k.bfe > 0 && ` · BFE ${k.bfe}`}
                            {k.ejer && k.ejer !== '–' && ` · ${k.ejer}`}
                          </p>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Iter 2 placeholder note (visuelt skjult for brugere men i kode) */}
        <div className="text-xs text-slate-600 italic pt-4">
          Iter 2: kort, ejerforening, ejerandele — BIZZ-795b.
        </div>
      </div>
    </div>
  );
}
