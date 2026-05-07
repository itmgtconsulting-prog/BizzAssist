/**
 * EjerKort — Simpel ejerkort-visning for ejendomssiden.
 *
 * Viser per-ejer info-bokse med overtagelsesdato, ejertype, adkomsttype, købesum.
 * Ren præsentationskomponent — al data leveres via props.
 *
 * BIZZ-1143: Erstatter PropertyOwnerDiagram (cardsOnly=true) med en rendyrket
 * præsentationskomponent uden intern fetch eller DiagramForce overhead.
 *
 * @module app/dashboard/ejendomme/[id]/EjerKort
 */

'use client';

import Link from 'next/link';
import { Building2, ChevronRight, Users } from 'lucide-react';

/** Ejer-detalje fra /api/ejerskab/chain → ejerDetaljer[] */
export interface EjerDetalje {
  /** Ejerens fulde navn */
  navn: string;
  /** CVR-nummer (virksomheder) */
  cvr: string | null;
  /** EnhedsNummer (personer fra CVR ES) */
  enhedsNummer: number | null;
  /** Ejertype */
  type: 'person' | 'selskab' | 'status';
  /** Ejerandel (f.eks. "50%") */
  andel: string | null;
  /** Ejerens adresse */
  adresse: string | null;
  /** Overtagelsesdato (ISO-format) */
  overtagelsesdato: string | null;
  /** Adkomsttype (skoede, arv, gave m.m.) */
  adkomstType: string | null;
  /** Købesum i DKK */
  koebesum: number | null;
  /** True hvis virksomheden er ophørt */
  isCeased?: boolean;
}

/**
 * EjerKort — ren præsentation af ejerkort.
 *
 * @param ejerDetaljer - Liste af ejer-detaljer fra chain-endpointet
 * @param lang - Sprog (da/en)
 * @returns Ejerkort JSX, eller null hvis ingen ejere
 */
export default function EjerKort({
  ejerDetaljer,
  lang,
}: {
  ejerDetaljer: EjerDetalje[];
  lang: 'da' | 'en';
}) {
  const da = lang === 'da';

  if (ejerDetaljer.length === 0) return null;

  const adkomstTypeMap: Record<string, string> = {
    skoede: da ? 'Skøde' : 'Deed',
    auktionsskoede: da ? 'Auktionsskøde' : 'Auction deed',
    arv: da ? 'Arv' : 'Inheritance',
    gave: da ? 'Gave' : 'Gift',
  };

  return (
    <div className="space-y-2">
      {ejerDetaljer.map((ejer, i) => (
        <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div
                className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  ejer.type === 'selskab'
                    ? 'bg-blue-500/20 border border-blue-500/30'
                    : ejer.type === 'status'
                      ? 'bg-slate-600/20 border border-slate-600/30'
                      : 'bg-purple-500/20 border border-purple-500/30'
                }`}
              >
                {ejer.type === 'selskab' ? (
                  <Building2 size={15} className="text-blue-400" />
                ) : ejer.type === 'status' ? (
                  <Building2 size={15} className="text-slate-400" />
                ) : (
                  <Users size={15} className="text-purple-400" />
                )}
              </div>
              <div>
                {ejer.type === 'status' ? (
                  <p className="text-slate-300 font-semibold text-sm">{ejer.navn}</p>
                ) : ejer.cvr ? (
                  <Link
                    href={`/dashboard/companies/${ejer.cvr}`}
                    className="text-blue-300 font-semibold text-sm hover:text-blue-200 transition-colors flex items-center gap-1 underline decoration-blue-500/30 hover:decoration-blue-400/50"
                  >
                    {ejer.navn} {ejer.andel ? `(${ejer.andel})` : ''}
                    {ejer.isCeased && (
                      <span className="ml-1.5 text-[10px] font-medium text-red-400 bg-red-500/15 border border-red-500/30 rounded px-1.5 py-0.5">
                        {da ? 'Ophørt' : 'Ceased'}
                      </span>
                    )}
                    <ChevronRight size={13} />
                  </Link>
                ) : ejer.enhedsNummer ? (
                  <Link
                    href={`/dashboard/owners/${ejer.enhedsNummer}`}
                    className="text-purple-300 font-semibold text-sm hover:text-purple-200 transition-colors flex items-center gap-1 underline decoration-purple-500/30 hover:decoration-purple-400/50"
                  >
                    {ejer.navn} {ejer.andel ? `(${ejer.andel})` : ''}
                    <ChevronRight size={13} />
                  </Link>
                ) : (
                  <p className="text-white font-semibold text-sm">
                    {ejer.navn} {ejer.andel ? `(${ejer.andel})` : ''}
                  </p>
                )}
                {ejer.adresse && (
                  <p className="text-slate-400 text-xs mt-0.5 break-words">{ejer.adresse}</p>
                )}
              </div>
            </div>
          </div>

          {ejer.type === 'status' ? (
            <p className="text-slate-500 text-xs mt-2 pt-2 border-t border-slate-700/30">
              {da
                ? 'Ejerskab registreret på de enkelte ejerlejligheder'
                : 'Ownership registered on the individual condominiums'}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 mt-2 pt-2 border-t border-slate-700/30">
              {ejer.overtagelsesdato && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Overtagelsesdato' : 'Acquisition date'}
                  </p>
                  <p className="text-slate-200 text-xs">
                    {new Date(ejer.overtagelsesdato.split('+')[0]).toLocaleDateString('da-DK', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              )}
              <div>
                <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                  {da ? 'Ejertype' : 'Owner type'}
                </p>
                <p className="text-slate-200 text-xs">
                  {ejer.type === 'selskab'
                    ? da
                      ? 'Selskab'
                      : 'Company'
                    : da
                      ? 'Privatperson'
                      : 'Private person'}
                </p>
              </div>
              {ejer.adkomstType && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Adkomsttype' : 'Title type'}
                  </p>
                  <p className="text-slate-200 text-xs">
                    {adkomstTypeMap[ejer.adkomstType] ?? ejer.adkomstType}
                  </p>
                </div>
              )}
              {ejer.koebesum != null && ejer.koebesum > 0 && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Købesum' : 'Purchase price'}
                  </p>
                  <p className="text-slate-200 text-xs">
                    {ejer.koebesum.toLocaleString('da-DK')} DKK
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
