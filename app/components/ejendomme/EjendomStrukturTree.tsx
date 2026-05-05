/**
 * EjendomStrukturTree — Viser den fulde ejendomsstruktur som et træ.
 *
 * Rendererer SFE → Hovedejendom → Ejerlejlighed med korrekt
 * farvekodning (amber for SFE/hovedejendom, emerald for ejerlejlighed)
 * og inline vurderinger på hovedejendomme. Noder er klikbare og
 * navigerer til den pågældende ejendoms detaljevisning.
 *
 * @module app/components/ejendomme/EjendomStrukturTree
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, Home, ChevronDown, ChevronRight } from 'lucide-react';
import type { StrukturNode, StrukturNiveau } from '@/app/api/ejendom-struktur/route';

/** Ikon + farve per niveau */
const NIVEAU_STYLE: Record<
  StrukturNiveau,
  { Icon: typeof Building2; color: string; bg: string; badge: string }
> = {
  sfe: {
    Icon: Building2,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    badge: 'SFE',
  },
  hovedejendom: {
    Icon: Building2,
    color: 'text-amber-300',
    bg: 'bg-amber-500/10',
    badge: 'Hovedejendom',
  },
  ejerlejlighed: {
    Icon: Home,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    badge: 'Ejerlejlighed',
  },
};

/**
 * Formatterer DKK-beløb.
 *
 * @param amount - Beløb i DKK
 * @returns Formateret streng
 */
function fmtDkk(amount: number): string {
  return amount.toLocaleString('da-DK') + ' DKK';
}

/**
 * Kort adresse — fjern postnr+by fra enden.
 *
 * @param adresse - Fuld adressestreng
 * @returns Kort version (vejnavn + husnr + evt. etage)
 */
function shortAddr(adresse: string): string {
  const parts = adresse.split(',').map((s) => s.trim());
  if (parts.length > 1) return parts.slice(0, -1).join(', ');
  return adresse;
}

interface TreeNodeProps {
  node: StrukturNode;
  depth: number;
  lang: 'da' | 'en';
  currentBfe?: number;
}

/**
 * Rekursiv tree-node komponent. Klikbar via DAWA-ID link.
 *
 * @param props - Node, dybde, sprog
 */
function TreeNode({ node, depth, lang, currentBfe }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const style = NIVEAU_STYLE[node.niveau];
  const Icon = style.Icon;
  const hasChildren = node.children.length > 0;
  const da = lang === 'da';
  const isCurrent = currentBfe != null && node.bfe === currentBfe;
  const canNavigate = node.dawaId != null && !isCurrent;

  const vurdering = node.ejendomsvaerdi ?? node.tlVurdering;

  /** Indhold af en node-linje */
  const nodeContent = (
    <>
      {/* Icon */}
      <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${style.bg}`}>
        <Icon size={14} className={style.color} />
      </div>

      {/* Adresse + badge */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium truncate ${canNavigate ? 'text-blue-300' : 'text-slate-200'}`}
          >
            {shortAddr(node.adresse)}
          </span>
          <span
            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border shrink-0 ${
              node.niveau === 'ejerlejlighed'
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
                : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
            }`}
          >
            {style.badge}
          </span>
          {node.bfe > 0 && (
            <span className="text-slate-600 text-[9px] shrink-0">BFE {node.bfe}</span>
          )}
          {isCurrent && (
            <span className="text-blue-400 text-[9px] font-medium shrink-0">
              {da ? '(denne)' : '(current)'}
            </span>
          )}
        </div>

        {/* Vurdering inline for hovedejendomme */}
        {node.niveau === 'hovedejendom' && vurdering != null && vurdering > 0 && (
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-slate-400 text-[10px]">
              {da ? 'Vurdering' : 'Valuation'}
              {node.vurderingsaar ? ` ${node.vurderingsaar}` : ''}:{' '}
              <span className="text-slate-200 font-medium">{fmtDkk(vurdering)}</span>
            </span>
            {node.grundvaerdi != null && node.grundvaerdi > 0 && (
              <span className="text-slate-500 text-[10px]">
                {da ? 'Grund' : 'Land'}: {fmtDkk(node.grundvaerdi)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Child count badge */}
      {hasChildren && (
        <span className="text-slate-500 text-[10px] tabular-nums shrink-0">
          {node.children.length}{' '}
          {node.children[0]?.niveau === 'ejerlejlighed'
            ? da
              ? 'lejl.'
              : 'units'
            : da
              ? 'ejendomme'
              : 'properties'}
        </span>
      )}
    </>
  );

  return (
    <div className={depth > 0 ? 'ml-4 border-l border-slate-700/40 pl-3' : ''}>
      <div className="flex items-center gap-1">
        {/* Expand/collapse */}
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 text-slate-500 hover:text-slate-300 transition-colors shrink-0"
            aria-label={expanded ? 'Fold sammen' : 'Udvid'}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}

        {/* Klikbar node med link */}
        {canNavigate ? (
          <Link
            href={`/dashboard/ejendomme/${node.dawaId}`}
            className={`flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors flex-1 min-w-0 hover:bg-slate-700/30`}
          >
            {nodeContent}
          </Link>
        ) : (
          <div
            className={`flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors flex-1 min-w-0 ${
              isCurrent ? 'bg-blue-500/10 border border-blue-500/20' : ''
            }`}
          >
            {nodeContent}
          </div>
        )}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div className="mt-0.5">
          {node.children.map((child) => (
            <TreeNode
              key={child.bfe || child.adresse}
              node={child}
              depth={depth + 1}
              lang={lang}
              currentBfe={currentBfe}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  /** Træ-data fra /api/ejendom-struktur */
  tree: StrukturNode;
  /** Sprog */
  lang: 'da' | 'en';
  /** BFE for den aktuelle ejendom (highlightes i træet) */
  currentBfe?: number;
}

/**
 * Viser det fulde ejendomshierarki som et collapsible tree.
 *
 * @param props - tree, lang, currentBfe
 */
export default function EjendomStrukturTree({ tree, lang, currentBfe }: Props) {
  const da = lang === 'da';

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <h3 className="text-white font-semibold text-sm mb-3">
        {da ? 'Ejendomsstruktur' : 'Property structure'}
      </h3>
      <TreeNode node={tree} depth={0} lang={lang} currentBfe={currentBfe} />
    </div>
  );
}
