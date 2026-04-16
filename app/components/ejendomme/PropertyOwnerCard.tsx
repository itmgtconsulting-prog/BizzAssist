'use client';

/**
 * PropertyOwnerCard — Viser en opsummering af én ejendom i en ejendomsportefølje.
 *
 * Bruges på virksomheds- og ejersider til at vise ejendomme ejet af en virksomhed
 * eller person. Linker til ejendomsdetaljeside hvis DAWA-id er tilgængeligt.
 *
 * @param ejendom - EjendomSummary objekt fra /api/ejendomme-by-owner
 * @param showOwner - Om ejer-CVR linket skal vises (true når der vises ejendomme for en gruppe)
 * @param lang - Sprog til labels
 */

import Link from 'next/link';
import { Home, ExternalLink, Building2, MapPin } from 'lucide-react';
import type { EjendomSummary } from '@/app/api/ejendomme-by-owner/route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Formaterer BFE-nummer med tusindtalsseparatorer (f.eks. 100.165.718).
 *
 * @param bfe - BFE-nummer som heltal
 * @returns Formateret streng
 */
function formatBfe(bfe: number): string {
  return bfe.toLocaleString('da-DK');
}

/**
 * Mapper ejendomstype til en kortere visningsform og farve.
 *
 * @param type - Rå ejendomstype fra DAWA (f.eks. "Ejerlejlighed", "Normal ejendom")
 * @returns { label: string; color: string }
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
  /** Ejendomsdata fra /api/ejendomme-by-owner */
  ejendom: EjendomSummary;
  /** Vis ejer-CVR som link til virksomhedssiden (til gruppe-visning) */
  showOwner?: boolean;
  /** Aktivt sprog */
  lang: 'da' | 'en';
}

/**
 * PropertyOwnerCard — Kortvisning af én ejendom i porteføljeoversigten.
 * Linker til ejendomsdetaljeside hvis DAWA adgangsadresse-id er tilgængeligt.
 *
 * @param props - Se PropertyOwnerCardProps
 */
export default function PropertyOwnerCard({
  ejendom,
  showOwner = false,
  lang,
}: PropertyOwnerCardProps) {
  const { label: typeLabel, color: typeColor } = mapEjendomstype(ejendom.ejendomstype);

  const detailHref = ejendom.dawaId ? `/dashboard/ejendomme/${ejendom.dawaId}` : null;

  const adresselinje = ejendom.adresse ?? `BFE ${formatBfe(ejendom.bfeNummer)}`;
  const postalLinje =
    ejendom.postnr && ejendom.by ? `${ejendom.postnr} ${ejendom.by}` : (ejendom.kommune ?? null);

  return (
    <div className="group relative flex flex-col bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden hover:border-blue-500/40 hover:bg-slate-800/80 transition-all duration-150">
      {/* Top stripe — farveindikator */}
      <div className="h-1 bg-gradient-to-r from-blue-600/60 to-blue-500/20 flex-shrink-0" />

      <div className="p-4 flex flex-col gap-3 flex-1">
        {/* Adresse */}
        <div className="flex items-start gap-2">
          <MapPin size={14} className="text-slate-500 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-white font-medium text-sm leading-snug truncate">{adresselinje}</p>
            {postalLinje && <p className="text-slate-400 text-xs mt-0.5">{postalLinje}</p>}
          </div>
        </div>

        {/* BIZZ-266: Enhanced meta section with badges + kommune */}
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

        {/* Ejer-CVR (vises kun i gruppe-mode) */}
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

      {/* Footer med link */}
      <div className="px-4 pb-4 pt-0">
        {detailHref ? (
          <Link
            href={detailHref}
            className="flex items-center justify-between w-full px-3 py-2 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 text-xs font-medium transition-colors group-hover:text-blue-300"
          >
            <span>{lang === 'da' ? 'Se ejendomsdetaljer' : 'View property details'}</span>
            <ExternalLink size={12} />
          </Link>
        ) : (
          <div className="flex items-center justify-between w-full px-3 py-2 rounded-lg bg-slate-900/40 text-slate-500 text-xs">
            <span>
              {lang === 'da'
                ? 'Ingen detaljeside (DAWA-id mangler)'
                : 'No detail page (DAWA id missing)'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
