'use client';

/**
 * PropertyOwnerCard — Viser en opsummering af én ejendom i en ejendomsportefølje.
 *
 * BIZZ-397: Redesigned med progressive enrichment — viser adresse + badges
 * straks, beriger med areal, vurdering, ejer-navn i baggrunden.
 *
 * @param ejendom - EjendomSummary objekt fra /api/ejendomme-by-owner
 * @param showOwner - Om ejer-CVR linket skal vises
 * @param lang - Sprog til labels
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Home, ExternalLink, Building2, MapPin, Ruler, TrendingUp, User } from 'lucide-react';
import type { EjendomSummary } from '@/app/api/ejendomme-by-owner/route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Formaterer BFE-nummer med tusindtalsseparatorer.
 *
 * @param bfe - BFE-nummer som heltal
 */
function formatBfe(bfe: number): string {
  return bfe.toLocaleString('da-DK');
}

/**
 * Formaterer DKK beløb kortfattet (f.eks. 2.5M, 350K).
 *
 * @param val - Beløb i DKK
 */
function formatDkkShort(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1).replace('.0', '')} mio`;
  if (val >= 1_000) return `${Math.round(val / 1_000)}K`;
  return val.toLocaleString('da-DK');
}

/**
 * Mapper ejendomstype til kortere visningsform og farve.
 *
 * @param type - Rå ejendomstype fra DAWA
 */
function mapEjendomstype(type: string | null): { label: string; color: string } {
  if (!type) return { label: 'Ukendt', color: 'text-slate-500 bg-slate-800' };
  const t = type.toLowerCase();
  if (t.includes('ejerlejlighed'))
    return { label: 'Ejerlejlighed', color: 'text-purple-300 bg-purple-900/40' };
  if (t.includes('landbrugsejendom') || t.includes('landbrug'))
    return { label: 'Landbrug', color: 'text-emerald-300 bg-emerald-900/40' };
  if (t.includes('erhverv')) return { label: 'Erhverv', color: 'text-amber-300 bg-amber-900/40' };
  if (t.includes('normal'))
    return { label: 'Parcelhus/grund', color: 'text-blue-300 bg-blue-900/40' };
  return { label: type, color: 'text-slate-300 bg-slate-800' };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface PropertyOwnerCardProps {
  ejendom: EjendomSummary;
  showOwner?: boolean;
  lang: 'da' | 'en';
}

/**
 * PropertyOwnerCard — Redesigned med progressiv berigelse.
 * Viser adresse + badges straks, beriger med areal/vurdering/ejer i baggrunden.
 */
export default function PropertyOwnerCard({
  ejendom,
  showOwner = false,
  lang,
}: PropertyOwnerCardProps) {
  const { label: typeLabel, color: typeColor } = mapEjendomstype(ejendom.ejendomstype);
  const da = lang === 'da';

  // Progressive enrichment state
  const [enriched, setEnriched] = useState<{
    areal: number | null;
    vurdering: number | null;
    vurderingsaar: number | null;
    ejerNavn: string | null;
  } | null>(
    ejendom.areal != null
      ? {
          areal: ejendom.areal,
          vurdering: ejendom.vurdering ?? null,
          vurderingsaar: ejendom.vurderingsaar ?? null,
          ejerNavn: ejendom.ejerNavn ?? null,
        }
      : null
  );

  useEffect(() => {
    if (enriched) return; // Already have data
    let ignore = false;
    fetch(`/api/ejendomme-by-owner/enrich?bfe=${ejendom.bfeNummer}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!ignore && d) setEnriched(d);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [ejendom.bfeNummer, enriched]);

  const detailHref = ejendom.dawaId ? `/dashboard/ejendomme/${ejendom.dawaId}` : null;
  const adresselinje = ejendom.adresse ?? `BFE ${formatBfe(ejendom.bfeNummer)}`;
  const postalLinje =
    ejendom.postnr && ejendom.by ? `${ejendom.postnr} ${ejendom.by}` : (ejendom.kommune ?? null);

  const CardContent = (
    <div className="group relative flex flex-col bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden hover:border-blue-500/40 hover:bg-slate-800/80 transition-all duration-150">
      {/* Top stripe */}
      <div className="h-1 bg-gradient-to-r from-blue-600/60 to-blue-500/20 flex-shrink-0" />

      <div className="p-4 flex flex-col gap-2.5 flex-1">
        {/* Adresse — hovedtekst */}
        <div className="flex items-start gap-2">
          <MapPin size={14} className="text-slate-500 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-white font-medium text-sm leading-snug truncate">{adresselinje}</p>
            {postalLinje && <p className="text-slate-400 text-xs mt-0.5">{postalLinje}</p>}
          </div>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-1.5">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${typeColor}`}
          >
            <Home size={9} />
            {typeLabel}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-slate-400 bg-slate-900/60 font-mono">
            BFE {formatBfe(ejendom.bfeNummer)}
          </span>
          {ejendom.kommune && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-slate-500 bg-slate-900/40">
              {ejendom.kommune}
            </span>
          )}
        </div>

        {/* BIZZ-397: Enriched data — areal, vurdering, ejer */}
        {enriched && (enriched.areal || enriched.vurdering || enriched.ejerNavn) && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 border-t border-slate-700/30">
            {enriched.areal && (
              <div className="flex items-center gap-1.5">
                <Ruler size={10} className="text-slate-500" />
                <span className="text-slate-300 text-[11px]">
                  {enriched.areal.toLocaleString('da-DK')} m²
                </span>
              </div>
            )}
            {enriched.vurdering && (
              <div className="flex items-center gap-1.5">
                <TrendingUp size={10} className="text-slate-500" />
                <span className="text-slate-300 text-[11px]">
                  {formatDkkShort(enriched.vurdering)} DKK
                  {enriched.vurderingsaar && (
                    <span className="text-slate-500 ml-0.5">({enriched.vurderingsaar})</span>
                  )}
                </span>
              </div>
            )}
            {enriched.ejerNavn && (
              <div className="flex items-center gap-1.5 col-span-2">
                <User size={10} className="text-slate-500" />
                <span className="text-slate-400 text-[11px] truncate">{enriched.ejerNavn}</span>
              </div>
            )}
          </div>
        )}

        {/* Loading shimmer while enriching */}
        {!enriched && (
          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-700/30 animate-pulse">
            <div className="h-3 bg-slate-700/40 rounded w-16" />
            <div className="h-3 bg-slate-700/40 rounded w-20" />
          </div>
        )}

        {/* Ejer-CVR (gruppe-mode) */}
        {showOwner && ejendom.ownerCvr && (
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Building2 size={11} />
            <Link
              href={`/dashboard/companies/${ejendom.ownerCvr}`}
              className="hover:text-blue-400 transition-colors font-mono"
              onClick={(e) => e.stopPropagation()}
            >
              CVR {ejendom.ownerCvr}
            </Link>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 pb-3 pt-0">
        {detailHref ? (
          <span className="flex items-center justify-between w-full px-3 py-1.5 rounded-lg bg-blue-600/15 text-blue-400 text-xs font-medium group-hover:bg-blue-600/25 group-hover:text-blue-300 transition-colors">
            <span>{da ? 'Se detaljer' : 'View details'}</span>
            <ExternalLink size={11} />
          </span>
        ) : (
          <span className="flex items-center w-full px-3 py-1.5 rounded-lg bg-slate-900/40 text-slate-500 text-[10px]">
            {da ? 'DAWA-id mangler' : 'DAWA id missing'}
          </span>
        )}
      </div>
    </div>
  );

  // Wrap in Link if detail page available
  if (detailHref) {
    return (
      <Link href={detailHref} className="block">
        {CardContent}
      </Link>
    );
  }
  return CardContent;
}
