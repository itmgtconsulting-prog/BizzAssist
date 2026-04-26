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
import EjendomHierarkiSections from '@/app/components/ejendomme/EjendomHierarkiSections';
import EjerandelBadge from '@/app/components/ejendomme/EjerandelBadge';

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
  /** BIZZ-880 (845c): BBR bygning-UUID til SFE-gruppering */
  bygningId?: string | null;
  bygningBetegnelse?: string | null;
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
 * BIZZ-833: Server-side fetch af administrator (ejerforening) via
 * /api/ejendomsadmin. Returnerer tom array ved fejl — ikke-fatal.
 */
interface AdminInfo {
  cvr: string | null;
  navn: string | null;
  type: 'virksomhed' | 'person' | 'ukendt';
}
async function fetchAdminForBfe(bfeNummer: number): Promise<AdminInfo[]> {
  try {
    const base = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const res = await fetch(`${base}/api/ejendomsadmin?bfeNummer=${bfeNummer}`, {
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      administratorer?: Array<{
        cvr: string | null;
        navn: string | null;
        type: 'virksomhed' | 'person' | 'ukendt';
        virkningTil: string | null;
      }>;
    };
    // Kun aktuelle administratorer (virkningTil === null)
    return (data.administratorer ?? [])
      .filter((a) => a.virkningTil === null && a.type !== 'ukendt' && (a.cvr || a.navn))
      .map((a) => ({ cvr: a.cvr, navn: a.navn, type: a.type }));
  } catch (err) {
    logger.error('[sfe-page] admin fetch fejl:', err);
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

  // BIZZ-833: Parallelt fetch af komponenter + administrator via Promise.all.
  // Tidligere var MAT → komponenter pr jordstykke sekventielt; admin blev
  // kaldt slet ikke. Nu kommer begge ind parallelt for hurtigere render.
  const komponenterPromises = matrikel.jordstykker
    .filter((js) => js.ejerlavskode && js.matrikelnummer)
    .map((js) => fetchEjerlejligheder(js.ejerlavskode!, js.matrikelnummer!, bfeNum));
  const adminPromise = fetchAdminForBfe(bfeNum);

  const [komponenterArrays, adminer] = await Promise.all([
    Promise.all(komponenterPromises),
    adminPromise,
  ]);
  const komponenter: EjerlejlighedItem[] = komponenterArrays.flat();

  // BIZZ-846: Grupper på BBR bygning_id (FK) når tilgængeligt, fallback til
  // adresse-prefix-parsing når ikke. bygningId-populeres af BIZZ-880 via
  // resolveEnhedByDawaId → BBR_Enhed.bygning. Giver korrekt gruppering selv
  // for adresser uden konsistent bogstav-suffix (fx "62" + "Vestergade 5").
  const groups = new Map<string, EjerlejlighedItem[]>();
  for (const k of komponenter) {
    const groupKey = k.bygningId ?? `adresse:${parseBygningsPrefix(k.adresse)}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(k);
  }
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, 'da'));

  const jordstykkeLabel = matrikel.jordstykker
    .map((j) => `${j.matrikelnummer}${j.ejerlavsnavn ? `, ${j.ejerlavsnavn}` : ''}`)
    .join(' · ');

  return (
    <div className="bg-[#0a1020] min-h-screen">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* BIZZ-797 + BIZZ-827 iter 2b: Bilingual breadcrumb via client-
            komponent. SFE er top-niveau så stop her. */}
        <EjendomHierarkiSections
          breadcrumb={[
            { key: 'dashboard', href: '/dashboard' },
            { key: 'properties', href: '/dashboard/ejendomme' },
            { key: 'sfe', param: bfe },
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

        {/* BIZZ-833: Administrator (ejerforening) - vises øverst når tilstede */}
        {adminer.length > 0 && (
          <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-4 space-y-2">
            <div className="flex items-center gap-2 text-amber-300 text-xs font-medium uppercase tracking-wide">
              <Building2 size={12} />
              Ejendomsadministrator
            </div>
            <div className="flex flex-wrap gap-2">
              {adminer.map((a, i) => {
                const label = a.navn ?? (a.cvr ? `CVR ${a.cvr}` : 'Administrator');
                const content = (
                  <>
                    <span className="text-amber-200 font-medium">{label}</span>
                    {a.cvr && <span className="text-amber-400/70 text-[11px]">CVR {a.cvr}</span>}
                  </>
                );
                return a.cvr ? (
                  <Link
                    key={`${a.cvr}-${i}`}
                    href={`/dashboard/companies/${a.cvr}`}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-amber-500/20 hover:border-amber-500/40 text-sm transition-colors"
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    key={`${a.navn}-${i}`}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-amber-500/20 text-sm"
                  >
                    {content}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Komponenter grupperet per bygning */}
        {sortedGroups.length === 0 ? (
          <div className="rounded-xl bg-slate-800/40 border border-slate-700/40 p-8 text-center text-slate-400">
            Ingen komponenter fundet for denne SFE. Matriklen indeholder muligvis kun grund (ingen
            bygninger registreret i BBR).
          </div>
        ) : (
          <div className="space-y-6">
            {sortedGroups.map(([groupKey, items]) => {
              // BIZZ-846: groupKey er enten bygning-UUID eller "adresse:<prefix>"-fallback.
              // Vis kortlabel for UUID-grupper (adresse-prefix fra første item) så brugeren
              // ikke ser den rå UUID. Når bygning_id findes, wrap heading i link til
              // bygning-detaljesiden.
              const isUuidGroup = !groupKey.startsWith('adresse:');
              const displayLabel = isUuidGroup
                ? parseBygningsPrefix(items[0]?.adresse ?? '')
                : groupKey.replace(/^adresse:/, '');
              const headingContent = (
                <>
                  <Building2 size={18} className="text-emerald-400" />
                  Bygning {displayLabel}
                  <span className="text-xs text-slate-500 font-normal">
                    ({items.length} enhed{items.length === 1 ? '' : 'er'})
                  </span>
                </>
              );
              return (
                <section key={groupKey}>
                  {isUuidGroup ? (
                    <Link
                      href={`/dashboard/ejendomme/bygning/${groupKey}`}
                      className="text-white text-lg font-semibold flex items-center gap-2 mb-3 hover:text-emerald-300 transition-colors"
                    >
                      {headingContent}
                    </Link>
                  ) : (
                    <h2 className="text-white text-lg font-semibold flex items-center gap-2 mb-3">
                      {headingContent}
                    </h2>
                  )}
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
                          {/* BIZZ-833 iter 2: Per-unit ejerandels-badge (lazy-loaded client-side). */}
                          {k.bfe > 0 && (
                            <div className="shrink-0">
                              <EjerandelBadge bfe={k.bfe} />
                            </div>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {/* BIZZ-833 iter 2: ejerforening (admin) shipped via BIZZ-889 / admin-
            sektion øverst. Ejerandele per lejlighed via EjerandelBadge (client-
            lazy-load). Mapbox-kort med byg021-farvekodede markører parkes til
            iter 3 — kræver byg021-per-bygning data i jordstykke-response. */}
        <div className="text-xs text-slate-600 italic pt-4">
          Iter 3 parked: kort med farve-kodede bygnings-markører (kræver byg021- data pr. bygning i
          komponent-response).
        </div>
      </div>
    </div>
  );
}
