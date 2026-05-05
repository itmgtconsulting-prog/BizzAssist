/**
 * PropertyOwnerDiagram — Ejerskabs-relationsdiagram på ejendoms-detaljesiden.
 *
 * Henter ejerskabskæden for en ejendom via /api/ejerskab/chain og viser den
 * som et relationsdiagram:
 *  - Ejendom (grøn)
 *  - Virksomheder (blå)
 *  - Personer (lilla)
 *
 * Viser også per-ejer info-bokse med overtagelsesdato, adkomsttype, købesum.
 *
 * BIZZ-601: Extraheret fra EjendomDetaljeClient.tsx for at reducere master-
 * file-størrelsen. Ren filopdeling — ingen logikskifte.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Building2, ChevronRight, Users } from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import type { DiagramGraph } from '@/app/components/diagrams/DiagramData';
import { logger } from '@/app/lib/logger';

/** BIZZ-600: DiagramForce uses d3-force — dynamic() keeps d3-force out of initial bundle */
// prettier-ignore
const DiagramForce = dynamic(/* d3-force */ () => import('@/app/components/diagrams/DiagramForce'), { ssr: false });

interface EjerDetalje {
  navn: string;
  cvr: string | null;
  enhedsNummer: number | null;
  type: 'person' | 'selskab' | 'status';
  andel: string | null;
  adresse: string | null;
  overtagelsesdato: string | null;
  adkomstType: string | null;
  koebesum: number | null;
  isCeased?: boolean;
}

export default function PropertyOwnerDiagram({
  bfe,
  adresse,
  lang,
  erEjerlejlighed = false,
  cardsOnly = false,
}: {
  bfe: number;
  adresse: string;
  lang: 'da' | 'en';
  /**
   * BIZZ-470: True når ejendommen er en ejerlejlighed. Signalerer til
   * /api/ejerskab/chain at Tinglysning-opslagene kan springes over —
   * Tinglysning returnerer alligevel kun "Opdelt i ejerlejlighed" som
   * status, og EJF leverer de faktiske ejere meget hurtigere.
   */
  erEjerlejlighed?: boolean;
  /** Vis kun ejerkort (ingen DiagramForce) — bruges når DiagramV2 erstatter grafen */
  cardsOnly?: boolean;
}) {
  const _router = useRouter();
  const da = lang === 'da';
  const [graph, setGraph] = useState<DiagramGraph | null>(null);
  const [ejerDetaljer, setEjerDetaljer] = useState<EjerDetalje[]>([]);
  const [loading, setLoading] = useState(true);
  const [_chainFejl, setChainFejl] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setGraph(null);
    setEjerDetaljer([]);
    setChainFejl(null);

    const controller = new AbortController();

    // BIZZ-1174: Gendan skipTinglysning for ejerlejligheder (performance).
    // Adkomsttype+købesum beriges fra salgshistorik i parent i stedet.
    const typeParam = erEjerlejlighed ? '&type=ejerlejlighed' : '';
    // BIZZ-973: Hent KUN ejerskabs-chain (ikke administratorer).
    // Administratorer hører til ejerskabs-tabben, ikke diagrammet.
    fetch(`/api/ejerskab/chain?bfe=${bfe}&adresse=${encodeURIComponent(adresse)}${typeParam}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setChainFejl((data.fejl as string | null) ?? null);

        if (data.nodes?.length > 0) {
          const nodes = data.nodes.map((n: Record<string, unknown>) => ({
            id: n.id as string,
            label: n.label as string,
            type: n.type as 'person' | 'company' | 'property' | 'status',
            cvr: n.cvr as number | undefined,
            link: n.link as string | undefined,
            bfeNummer: n.bfeNummer as number | undefined,
          }));
          const edges = data.edges.map((e: Record<string, unknown>) => ({
            from: e.from as string,
            to: e.to as string,
            ejerandel: e.ejerandel as string | undefined,
          }));

          setGraph({
            nodes,
            edges,
            mainId: data.mainId as string,
          });
          setEjerDetaljer(data.ejerDetaljer ?? []);
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') logger.error('[ejerskab/chain] fetch error:', err);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [bfe, adresse, erEjerlejlighed]);

  if (loading) {
    // cardsOnly: kun blå bar uden tekst; fuld: med tekst
    return cardsOnly ? (
      <TabLoadingSpinner ariaLabel={da ? 'Henter ejerskabsdata' : 'Loading ownership data'} />
    ) : (
      <TabLoadingSpinner label={da ? 'Henter ejerstruktur…' : 'Loading ownership structure…'} />
    );
  }

  if (!graph || graph.nodes.length <= 1) {
    // cardsOnly: vis intet (DiagramV2 håndterer tom-state)
    if (cardsOnly) return null;
    const besked = da ? 'Ingen ejerstruktur tilgængelig' : 'No ownership structure available';
    return (
      <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 text-center">
        <p className="text-slate-500 text-sm">{besked}</p>
      </div>
    );
  }

  const adkomstTypeMap: Record<string, string> = {
    skoede: da ? 'Skøde' : 'Deed',
    auktionsskoede: da ? 'Auktionsskøde' : 'Auction deed',
    arv: da ? 'Arv' : 'Inheritance',
    gave: da ? 'Gave' : 'Gift',
  };

  return (
    <div className="space-y-2">
      {/* Ejer info-bokse */}
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

      {/* Relationsdiagram — skjules når cardsOnly er true (DiagramV2 bruges i stedet) */}
      {!cardsOnly && <DiagramForce graph={graph} lang={lang} />}
    </div>
  );
}
