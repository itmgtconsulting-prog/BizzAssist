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
import { Building2, Users } from 'lucide-react';

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

  // BIZZ-1305: Saml ejere i én tabel i stedet for separate kort
  const statusEjere = ejerDetaljer.filter((e) => e.type === 'status');
  const realEjere = ejerDetaljer.filter((e) => e.type !== 'status');

  return (
    <div className="space-y-2">
      {/* Status-ejere (fx "Ejerskab registreret på ejerlejligheder") */}
      {statusEjere.map((ejer, i) => (
        <div
          key={`status-${i}`}
          className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <Building2 size={14} className="text-slate-400" />
            <p className="text-slate-300 text-sm">{ejer.navn}</p>
          </div>
          <p className="text-slate-500 text-xs mt-1">
            {da
              ? 'Ejerskab registreret på de enkelte ejerlejligheder'
              : 'Ownership registered on the individual condominiums'}
          </p>
        </div>
      ))}

      {/* Ejertabel */}
      {realEjere.length > 0 && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-700/30">
                  <th className="px-3 py-2 text-left font-medium">{da ? 'Ejer' : 'Owner'}</th>
                  <th className="px-3 py-2 text-right font-medium">{da ? 'Andel' : 'Share'}</th>
                  <th className="px-3 py-2 text-left font-medium">
                    {da ? 'Overtagelse' : 'Acquired'}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">{da ? 'Adkomst' : 'Title'}</th>
                  <th className="px-3 py-2 text-right font-medium">{da ? 'Købesum' : 'Price'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/20">
                {realEjere.map((ejer, i) => {
                  const Icon = ejer.type === 'selskab' ? Building2 : Users;
                  const iconColor = ejer.type === 'selskab' ? 'text-blue-400' : 'text-purple-400';
                  const linkColor =
                    ejer.type === 'selskab'
                      ? 'text-blue-300 hover:text-blue-200'
                      : 'text-purple-300 hover:text-purple-200';
                  /* BIZZ-1826: Person-ejere uden enhedsNummer (typisk fra
                     ejf_ejerskab cache) får et søge-link som fallback, så
                     navnet altid er klikbart. */
                  const href = ejer.cvr
                    ? `/dashboard/companies/${ejer.cvr}`
                    : ejer.enhedsNummer
                      ? `/dashboard/owners/${ejer.enhedsNummer}`
                      : ejer.type === 'person' && ejer.navn
                        ? `/dashboard?q=${encodeURIComponent(ejer.navn)}`
                        : null;

                  return (
                    <tr key={i} className="hover:bg-slate-700/10">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Icon size={13} className={iconColor} />
                          {href ? (
                            <Link
                              href={href}
                              className={`font-medium transition-colors ${linkColor}`}
                            >
                              {ejer.navn}
                              {ejer.isCeased && (
                                <span className="ml-1 text-[9px] text-red-400 bg-red-500/15 border border-red-500/30 rounded px-1 py-0.5">
                                  {da ? 'Ophørt' : 'Ceased'}
                                </span>
                              )}
                            </Link>
                          ) : (
                            <span className="text-slate-200 font-medium">{ejer.navn}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300 font-medium">
                        {ejer.andel ?? '–'}
                      </td>
                      <td className="px-3 py-2 text-slate-400">
                        {ejer.overtagelsesdato
                          ? new Date(ejer.overtagelsesdato.split('+')[0]).toLocaleDateString(
                              'da-DK',
                              {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              }
                            )
                          : '–'}
                      </td>
                      <td className="px-3 py-2 text-slate-400">
                        {ejer.adkomstType
                          ? (adkomstTypeMap[ejer.adkomstType] ?? ejer.adkomstType)
                          : '–'}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">
                        {ejer.koebesum != null && ejer.koebesum > 0
                          ? `${ejer.koebesum.toLocaleString('da-DK')} DKK`
                          : '–'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
