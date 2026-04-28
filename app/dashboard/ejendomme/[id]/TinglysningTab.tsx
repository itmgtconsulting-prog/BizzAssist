/**
 * TinglysningTab — Tinglysning-fane på ejendoms-detaljesiden.
 *
 * Viser tingbogsattest-data fra Datafordeler/Tinglysning:
 *  - Adkomst (ejere), hæftelser, servitutter
 *  - Matrikler, noteringer, tillægstekster
 *  - Dokument-download (PDF) via /api/tinglysning/dokument
 *
 * BIZZ-601: Extraheret fra EjendomDetaljeClient.tsx for at reducere master-
 * file-størrelsen (9665 → ~8070 linjer) og forbedre HMR-performance.
 * Ingen logikskifte — ren filopdeling.
 *
 * Data hentes via:
 *  - /api/tinglysning?bfe=X → UUID
 *  - /api/tinglysning/summarisk?uuid=X&section=ejere|haeftelser|servitutter
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Landmark,
  Paperclip,
} from 'lucide-react';
import TabLoadingSpinner from '@/app/components/TabLoadingSpinner';
import { logger } from '@/app/lib/logger';

export default function TinglysningTab({
  bfe,
  lang,
  moderBfe,
}: {
  bfe: number | null;
  lang: 'da' | 'en';
  moderBfe?: number | null;
}) {
  const da = lang === 'da';
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [ejereLoading, setEjereLoading] = useState(true);
  const [haeftelserLoading, setHaeftelserLoading] = useState(true);
  const [servituterLoading, setServituterLoading] = useState(true);
  interface TLUnderpant {
    prioritet: number | null;
    beloeb: number | null;
    valuta: string;
    havere: string[];
  }
  interface TLItem {
    [key: string]: string | number | boolean | string[] | TLUnderpant | null | undefined;
  }
  interface TLTingbogsattest {
    bfeNr: string | null;
    ejerlejlighedNr: string | null;
    hovedNotering: string | null;
    fordelingstal: { taeller: number; naevner: number } | null;
    matrikler: {
      districtName: string;
      districtId: string;
      matrikelnr: string;
      areal: number | null;
      vejAreal: number | null;
      regDato: string | null;
    }[];
    noteringer: { tekst: string; dato: string | null }[];
    tillaegstekster: { overskrift: string | null; tekst: string | null }[];
  }
  const [ejere, setEjere] = useState<TLItem[]>([]);
  const [haeftelser, setHaeftelser] = useState<TLItem[]>([]);
  const [servitutter, setServitutter] = useState<TLItem[]>([]);
  const [tingbogsattest, setTingbogsattest] = useState<TLTingbogsattest | null>(null);
  /** Tinglysning ejendoms-UUID — bruges til PDF-download af tingbogsattest */
  const [tlUuid, setTlUuid] = useState<string | null>(null);
  const [showAllServitutter, setShowAllServitutter] = useState(false);
  /** True when the servitut fetch was aborted by the 30 s timeout — used to show a timeout warning in the UI. */
  const [servituterTimedOut, setServituterTimedOut] = useState(false);
  /** BIZZ-548: True when the servitut fetch failed (non-timeout) — shows error state with retry */
  const [servituterError, setServituterError] = useState(false);
  const [expandedAdkomst, setExpandedAdkomst] = useState<Set<number>>(new Set());
  const [expandedHaeftelser, setExpandedHaeftelser] = useState<Set<number>>(new Set());
  const [expandedServitutter, setExpandedServitutter] = useState<Set<number>>(new Set());
  const [bilagRefs, setBilagRefs] = useState<{ id: string; tekst: string }[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [showMatrikler, setShowMatrikler] = useState(false);
  const [showNoteringer, setShowNoteringer] = useState(false);
  const [showTillaeg, setShowTillaeg] = useState(false);
  /** Indskannede akter — pre-digitale akt-navne fra EjendomIndskannetAktSamling i ejdsummarisk */
  const [indskannedeAkterNavne, setIndskannedeAkterNavne] = useState<string[]>([]);

  const toggleDoc = (docId: string) => {
    setSelectedDocs((prev) => {
      const n = new Set(prev);
      if (n.has(docId)) n.delete(docId);
      else n.add(docId);
      return n;
    });
  };
  const [fejl, setFejl] = useState<string | null>(null);
  useEffect(() => {
    if (!bfe) {
      setLoading(false);
      return;
    }

    // Nulstil state ved ny fetch (fx BFE skifter)
    setLoading(true);
    setEjereLoading(true);
    setHaeftelserLoading(true);
    setServituterLoading(true);
    setServituterError(false);
    setFejl(null);
    setEjere([]);
    setHaeftelser([]);
    setServitutter([]);
    setBilagRefs([]);
    setTingbogsattest(null);
    setTlUuid(null);
    setIndskannedeAkterNavne([]);

    const controller = new AbortController();
    const { signal } = controller;

    // Trin 1: Hent UUID via tinglysning søgning
    fetch(`/api/tinglysning?bfe=${bfe}`, { signal })
      .then(async (r) => {
        if (r.ok) return r.json();
        // Parse error body even on non-ok status
        const body = await r.json().catch(() => null);
        return body ?? null;
      })
      .then((tlData) => {
        if (!tlData?.uuid) {
          // Distinguish API error from "not found"
          const erApiFejl = tlData?.error && tlData.error !== 'Ejendom ikke fundet i tingbogen';
          setFejl(
            erApiFejl
              ? da
                ? 'Tinglysning er midlertidigt utilgængeligt — prøv igen om lidt.'
                : 'Tinglysning is temporarily unavailable — please try again shortly.'
              : da
                ? 'Ejendom ikke fundet i tingbogen'
                : 'Property not found'
          );
          setLoading(false);
          return;
        }
        setTlUuid(tlData.uuid);
        // Trin 2: Hent summariske data i 3 parallelle sektions-kald
        // Progressiv loading — hver sektion vises straks den er klar
        const base = `/api/tinglysning/summarisk?uuid=${tlData.uuid}`;
        // BIZZ-474: Send altid hovedBfe til summarisk-API'en — for ejerlejligheder
        // bruges moderBfe (lejlighedens forældreejendom), og for hovedejendomme
        // bruges deres egen BFE. API'en slår hovednoteringsnummer op og tilføjer
        // servitutter fra den primære grundbogs-UUID hvis den afviger fra den
        // UUID vi allerede har. Tidligere mistede hovedejendomme servitutter der
        // lå på en anden hovednoteringsnummer-UUID end tlFetch returnerede.
        const effektivtHovedBfe = moderBfe && moderBfe !== bfe ? moderBfe : bfe;
        const servituterUrl = `${base}&section=servitutter&hovedBfe=${effektivtHovedBfe}`;
        return Promise.all([
          fetch(`${base}&section=ejere`, { signal })
            .then((r) => (r.ok ? r.json() : null))
            .then((res) => {
              if (res) {
                setEjere(res.ejere ?? []);
                setTingbogsattest(res.tingbogsattest ?? null);
              }
              setEjereLoading(false);
            }),
          fetch(`${base}&section=haeftelser`, { signal })
            .then((r) => (r.ok ? r.json() : null))
            .then((res) => {
              if (res) {
                setHaeftelser(res.haeftelser ?? []);
                setBilagRefs(res.bilagRefs ?? []);
              }
              setHaeftelserLoading(false);
            }),
          // BIZZ-331: Servitutter for ejerlejligheder can be slow (fetches
          // from hovedejendom). Use separate timeout + error handling so other
          // sections still display even if servitutter times out.
          // BIZZ-474: Bumped to 45s — hovedejendomme with many servitutter
          // need enough headroom for per-document enrichment even with
          // concurrency=10 and cap=30.
          fetch(servituterUrl, { signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) })
            .then((r) => {
              if (!r.ok) {
                setServituterError(true);
                return null;
              }
              return r.json();
            })
            .then((res) => {
              if (res) {
                setServitutter(res.servitutter ?? []);
                setIndskannedeAkterNavne(res.indskannedeAkterNavne ?? []);
              }
              setServituterLoading(false);
            })
            .catch((err) => {
              if (err.name === 'AbortError') {
                // Timed out (45 s) — surface a warning so the user knows the list is incomplete.
                setServituterTimedOut(true);
              } else {
                logger.error('[tinglysning] Servitut fetch fejlede:', err);
                setServituterError(true);
              }
              setServituterLoading(false);
            }),
        ]);
      })
      .catch((err) => {
        if (err.name !== 'AbortError')
          setFejl(da ? 'Kunne ikke hente tingbogsdata' : 'Failed to load registry data');
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [bfe, da, moderBfe]);

  const formatDato = (iso: string | null) => {
    if (!iso) return '–';
    try {
      return new Date(iso.split('+')[0]).toLocaleDateString('da-DK', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  const haeftelseTypeMap: Record<string, string> = {
    realkreditpantebrev: da ? 'Realkreditpantebrev' : 'Mortgage deed',
    ejerpantebrev: da ? 'Ejerpantebrev' : 'Owner mortgage deed',
    pantebrev: da ? 'Pantebrev' : 'Mortgage deed',
    anden: da ? 'Anden hæftelse' : 'Other charge',
    skadesloebrev: da ? 'Skadesløsbrev' : 'Indemnity bond',
  };

  const servitutTypeMap: Record<string, string> = {
    andenServitut: da ? 'Servitut' : 'Easement',
    tillaeg: da ? 'Tillæg' : 'Amendment',
    paatalegning: da ? 'Påtegning' : 'Endorsement',
  };

  /** Konverterer CamelCase-koder fra Tinglysning til læsbar tekst med mellemrum */
  const laanevilkaarMap: Record<string, string> = {
    Refinansiering: 'Refinansiering',
    MulighedForAfdragsfrihed: da ? 'Mulighed for afdragsfrihed' : 'Option for interest-only',
    Inkonvertibel: da ? 'Inkonvertibel' : 'Non-convertible',
    Rentetilpasning: da ? 'Rentetilpasning' : 'Interest rate adjustment',
    Afdragsfrihed: da ? 'Afdragsfrihed' : 'Interest-only',
    Konverterbar: da ? 'Konverterbar' : 'Convertible',
    SDO: 'SDO',
  };

  /** Gør CamelCase-kode til læsbar tekst: indsæt mellemrum før store bogstaver */
  const humanizeCode = (code: string): string => {
    if (laanevilkaarMap[code]) return laanevilkaarMap[code];
    // Indsæt mellemrum før versaler og gør første bogstav stort
    return code
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());
  };

  const laantypeMap: Record<string, string> = {
    Obligationslaan: da ? 'Obligationslån' : 'Bond loan',
    Kontantlaan: da ? 'Kontantlån' : 'Cash loan',
    Indekslaan: da ? 'Indekslån' : 'Index loan',
    Anden: da ? 'Andet' : 'Other',
  };

  // Initial loading — vent kun på UUID-søgning, ikke alle sektioner.
  // BIZZ-478: Ensartet blå loading-bar i stedet for box-spinner.
  if (loading && ejereLoading && haeftelserLoading && servituterLoading && ejere.length === 0)
    return <TabLoadingSpinner label={da ? 'Henter tingbogsdata…' : 'Loading registry data…'} />;

  if (fejl || !bfe)
    return (
      <div className="bg-slate-800/20 border border-slate-700/30 rounded-2xl p-6 text-center">
        <Landmark size={32} className="text-slate-600 mx-auto mb-3" />
        <p className="text-slate-400 text-sm">
          {fejl ?? (da ? 'BFE-nummer mangler' : 'BFE number missing')}
        </p>
      </div>
    );

  /**
   * BIZZ-472: Sortér servitutter så ejendommens egne kommer først, dernæst
   * servitutter arvet fra hovedejendommen. På en ejerlejlighed fortæller
   * rækkefølgen hvilke byrder der er tinglyst direkte på lejligheden og
   * hvilke der hviler på hele komplekset.
   */
  const sorteredeServitutter = [...servitutter].sort((a, b) => {
    const aHoved = a.fraHovedejendom ? 1 : 0;
    const bHoved = b.fraHovedejendom ? 1 : 0;
    return aHoved - bHoved;
  });
  const visServitutter = showAllServitutter
    ? sorteredeServitutter
    : sorteredeServitutter.slice(0, 5);
  const antalFraHovedejendom = servitutter.filter((s) => s.fraHovedejendom).length;

  /**
   * Gruppér adkomst-entries efter dokumentId — to ejere på samme skøde deler dokumentId
   * og skal vises som ét dokument med flere adkomsthavere, ikke to separate rækker.
   * Fallback-nøgle bruges når dokumentId mangler.
   */
  const adkomstGroups: TLItem[][] = (() => {
    const groups: TLItem[][] = [];
    const seen = new Map<string, number>();
    for (const e of ejere) {
      const key =
        String(e.dokumentId ?? '') ||
        `${e.tinglysningsdato ?? ''}_${e.adkomstType ?? ''}_${e.koebesum ?? ''}`;
      if (!seen.has(key)) {
        seen.set(key, groups.length);
        groups.push([e]);
      } else {
        groups[seen.get(key)!].push(e);
      }
    }
    return groups;
  })();

  const hovedNoteringMap: Record<string, string> = {
    samletEjendom: da ? 'Samlet ejendom' : 'Combined property',
    enfamilieshus: da ? 'Enfamilieshus' : 'Single-family house',
    ejerlejlighed: da ? 'Ejerlejlighed' : 'Condominium',
    landbrugsejendom: da ? 'Landbrugsejendom' : 'Agricultural property',
  };

  return (
    <div className="space-y-6">
      {/* ── Tingbogsattest ── */}
      {tingbogsattest && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <FileText size={15} className="text-blue-400" />
            <p className="text-slate-300 text-sm font-semibold">
              {da ? 'Tingbogsattest' : 'Land Registry Certificate'}
            </p>
          </div>
          <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4 relative">
            {tlUuid && (
              <a
                href={`/api/tinglysning/dokument?uuid=${tlUuid}&type=tingbogsattest`}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute top-3 right-3 inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
              >
                <FileText size={11} />
                PDF
              </a>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
              {tingbogsattest.bfeNr && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">BFE-nr.</p>
                  <p className="text-white text-sm font-medium">{tingbogsattest.bfeNr}</p>
                </div>
              )}
              {tingbogsattest.ejerlejlighedNr && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Ejerlejlighed nr.' : 'Unit no.'}
                  </p>
                  <p className="text-white text-sm font-medium">{tingbogsattest.ejerlejlighedNr}</p>
                </div>
              )}
              {tingbogsattest.hovedNotering && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Hovednotering' : 'Main notation'}
                  </p>
                  <p className="text-white text-sm">
                    {hovedNoteringMap[tingbogsattest.hovedNotering] ?? tingbogsattest.hovedNotering}
                  </p>
                </div>
              )}
              {tingbogsattest.fordelingstal && (
                <div>
                  <p className="text-slate-500 text-[10px] uppercase tracking-wider">
                    {da ? 'Fordelingstal' : 'Distribution ratio'}
                  </p>
                  <p className="text-white text-sm font-medium">
                    {tingbogsattest.fordelingstal.taeller.toLocaleString('da-DK')} /{' '}
                    {tingbogsattest.fordelingstal.naevner.toLocaleString('da-DK')}
                  </p>
                </div>
              )}
            </div>

            {/* Matrikler — klappet sammen */}
            {tingbogsattest.matrikler.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-700/30">
                <button
                  onClick={() => setShowMatrikler(!showMatrikler)}
                  className="flex items-center gap-1.5 text-slate-500 text-[10px] uppercase tracking-wider hover:text-slate-300 transition-colors w-full text-left"
                >
                  {showMatrikler ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {da ? 'Matrikler' : 'Cadastral parcels'} ({tingbogsattest.matrikler.length})
                </button>
                {showMatrikler && (
                  <div className="mt-1.5">
                    {tingbogsattest.matrikler.map((m, i) => (
                      <p key={i} className="text-slate-300 text-xs">
                        {m.districtId} {m.districtName}, {m.matrikelnr}
                        {m.areal ? ` (${m.areal.toLocaleString('da-DK')} m²)` : ''}
                        {m.regDato ? ` · ${formatDato(m.regDato)}` : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Noteringer — klappet sammen */}
            {tingbogsattest.noteringer.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-700/30">
                <button
                  onClick={() => setShowNoteringer(!showNoteringer)}
                  className="flex items-center gap-1.5 text-slate-500 text-[10px] uppercase tracking-wider hover:text-slate-300 transition-colors w-full text-left"
                >
                  {showNoteringer ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {da ? 'Noteringstekst' : 'Notation text'} ({tingbogsattest.noteringer.length})
                </button>
                {showNoteringer && (
                  <div className="mt-1.5">
                    {tingbogsattest.noteringer.map((n, i) => (
                      <p key={i} className="text-slate-400 text-xs">
                        {n.tekst}
                        {n.dato ? ` (${formatDato(n.dato)})` : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tillægstekster — klappet sammen */}
            {tingbogsattest.tillaegstekster.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-700/30">
                <button
                  onClick={() => setShowTillaeg(!showTillaeg)}
                  className="flex items-center gap-1.5 text-slate-500 text-[10px] uppercase tracking-wider hover:text-slate-300 transition-colors w-full text-left"
                >
                  {showTillaeg ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  {da ? 'Tillægstekst' : 'Supplementary text'} (
                  {
                    tingbogsattest.tillaegstekster.filter(
                      (t) => t.overskrift && !t.overskrift.includes('Bilagsreference')
                    ).length
                  }
                  )
                </button>
                {showTillaeg && (
                  <div className="mt-1.5 space-y-1">
                    {tingbogsattest.tillaegstekster
                      .filter((t) => t.overskrift && !t.overskrift.includes('Bilagsreference'))
                      .map((t, i) => (
                        <div key={i} className="flex gap-2 text-xs">
                          {t.overskrift && (
                            <span className="text-slate-400 flex-shrink-0">{t.overskrift}:</span>
                          )}
                          {t.tekst && <span className="text-slate-300">{t.tekst}</span>}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tinglyste dokumenter — dokument-tab format ── */}
      <div
        className="bg-slate-800/20 border border-slate-700/30 rounded-2xl"
        style={{ contain: 'layout' }}
      >
        <div className="px-4 py-2.5 border-b border-slate-700/30 flex items-center gap-2">
          <Landmark size={15} className="text-slate-400" />
          <span className="text-sm font-semibold text-slate-200">
            {da ? 'Tinglyste dokumenter' : 'Registered documents'}
          </span>
          <span className="text-slate-600 text-xs">
            ({adkomstGroups.length + haeftelser.length + servitutter.length})
          </span>
          <button
            onClick={async () => {
              for (const docId of selectedDocs) {
                const isBilag = docId.startsWith('bilag-');
                const url = isBilag
                  ? `/api/tinglysning/dokument?bilag=${docId.replace('bilag-', '')}`
                  : `/api/tinglysning/dokument?uuid=${docId}`;
                window.open(url, '_blank', 'noopener,noreferrer');
                await new Promise((r) => setTimeout(r, 300));
              }
            }}
            disabled={selectedDocs.size === 0}
            className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-600 rounded-lg text-slate-300 text-xs font-medium transition-all"
          >
            <Download size={12} />
            {da ? 'Download valgte' : 'Download selected'} ({selectedDocs.size})
          </button>
        </div>

        {/* Kolonneheader: Expand | Pri | Dato | Dokument | Beløb | Type | PDF | Check */}
        <div className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-1.5 border-b border-slate-700/20">
          <span />
          <span className="text-[10px] font-medium text-slate-500 uppercase">Pri.</span>
          <span className="text-[10px] font-medium text-slate-500 uppercase">
            {da ? 'Dato' : 'Date'}
          </span>
          <span className="text-[10px] font-medium text-slate-500 uppercase">
            {da ? 'Dokument' : 'Document'}
          </span>
          <span className="text-[10px] font-medium text-slate-500 uppercase">
            {da ? 'Beløb' : 'Amount'}
          </span>
          <span className="text-[10px] font-medium text-slate-500 uppercase">Type</span>
          <span className="text-[10px] font-medium text-slate-500 uppercase">
            {da ? 'Dok.' : 'Doc.'}
          </span>
          <span />
        </div>

        {/* ── ADKOMST ── */}
        {adkomstGroups.length > 0 && (
          <>
            <div className="px-4 py-1.5 bg-purple-500/5 border-b border-slate-700/20">
              <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider">
                {da ? 'Adkomst' : 'Title'} ({adkomstGroups.length})
              </span>
            </div>
            {adkomstGroups.map((group, i) => {
              // First entry carries shared document metadata (dato, beløb, type etc.)
              const first = group[0];
              const isOpen = expandedAdkomst.has(i);
              const docId = String(first.dokumentId ?? '');
              const typeMap: Record<string, string> = {
                skoede: da ? 'Skøde' : 'Deed',
                auktionsskoede: 'Auktionsskøde',
                arv: 'Arv',
                gave: 'Gave',
              };
              const typeLabel =
                typeMap[String(first.adkomstType ?? '').toLowerCase()] ??
                String(first.adkomstType ?? '');
              return (
                <div key={`a-${i}`} className="border-b border-slate-700/15">
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                    onClick={() =>
                      setExpandedAdkomst((prev) => {
                        const n = new Set(prev);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  >
                    {isOpen ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    <span />
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatDato(String(first.tinglysningsdato ?? first.dato ?? ''))}
                    </span>
                    {/* Collapsed: show document type label, not individual owner name */}
                    <span className="text-sm text-slate-200 truncate">
                      {typeLabel || (da ? 'Adkomst' : 'Title')}
                    </span>
                    <span className="text-xs text-slate-300 tabular-nums text-right">
                      {first.iAltKoebesum != null && Number(first.iAltKoebesum) > 0
                        ? `${Number(first.iAltKoebesum).toLocaleString('da-DK')} DKK`
                        : ''}
                    </span>
                    <span className="text-xs text-slate-400 truncate">{typeLabel}</span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {docId && (
                        <a
                          href={`/api/tinglysning/dokument?uuid=${docId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <FileText size={11} />
                          PDF
                        </a>
                      )}
                    </div>
                    {docId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedDocs.has(docId)}
                          onChange={() => toggleDoc(docId)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedDocs.has(docId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedDocs.has(docId) && (
                            <svg
                              viewBox="0 0 10 10"
                              className="w-2 h-2 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                            </svg>
                          )}
                        </span>
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>
                  {isOpen && (
                    <div className="px-4 pb-3 ml-10 border-l-2 border-purple-500/20">
                      {/* All adkomsthavere for this document */}
                      <div className="space-y-2 mt-1 mb-2">
                        {group.map((e, j) => (
                          <div key={j}>
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Adkomsthaver' : 'Owner'}
                              {group.length > 1 ? ` ${j + 1}` : ''}
                            </p>
                            {e.cvr ? (
                              <Link
                                href={`/dashboard/virksomheder/${String(e.cvr)}`}
                                className="text-blue-300 hover:text-blue-200 text-xs font-medium flex items-center gap-1"
                              >
                                {String(e.navn)}
                                <ChevronRight size={11} />
                              </Link>
                            ) : (
                              <p className="text-slate-200 text-xs font-medium">{String(e.navn)}</p>
                            )}
                            {e.adresse && (
                              <p className="text-slate-400 text-[11px]">{String(e.adresse)}</p>
                            )}
                            {e.andel && (
                              <p className="text-slate-500 text-[11px]">{String(e.andel)}</p>
                            )}
                          </div>
                        ))}
                      </div>
                      {/* Common document fields (from first entry) */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 mt-2 pt-2 border-t border-slate-700/20 text-xs">
                        {first.tinglysningsafgift != null &&
                          Number(first.tinglysningsafgift) > 0 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase">
                                {da ? 'Tinglysningsafgift' : 'Reg. fee'}
                              </p>
                              <p className="text-slate-200">
                                {Number(first.tinglysningsafgift).toLocaleString('da-DK')} DKK
                              </p>
                            </div>
                          )}
                        {first.kontantKoebesum != null && Number(first.kontantKoebesum) > 0 && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Købesum kontant' : 'Cash'}
                            </p>
                            <p className="text-slate-200">
                              {Number(first.kontantKoebesum).toLocaleString('da-DK')} DKK
                            </p>
                          </div>
                        )}
                        {first.iAltKoebesum != null && Number(first.iAltKoebesum) > 0 && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Købesum i alt' : 'Total'}
                            </p>
                            <p className="text-slate-200">
                              {Number(first.iAltKoebesum).toLocaleString('da-DK')} DKK
                            </p>
                          </div>
                        )}
                        {first.koebsaftaledato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Købsaftaledato' : 'Agreement'}
                            </p>
                            <p className="text-slate-200">
                              {formatDato(String(first.koebsaftaledato))}
                            </p>
                          </div>
                        )}
                        {first.overtagelsesdato && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Overtagelsesdato' : 'Acquisition'}
                            </p>
                            <p className="text-slate-200">
                              {formatDato(String(first.overtagelsesdato))}
                            </p>
                          </div>
                        )}
                        {first.ejendomKategori && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Ejendomskategori' : 'Category'}
                            </p>
                            <p className="text-slate-200">{String(first.ejendomKategori)}</p>
                          </div>
                        )}
                        {first.handelKode && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Handelsmetode' : 'Trade'}
                            </p>
                            <p className="text-slate-200">{String(first.handelKode)}</p>
                          </div>
                        )}
                      </div>
                      {(first.anmelderNavn || first.anmelderEmail) && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20 text-xs">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {da ? 'Anmelder' : 'Registrant'}
                          </p>
                          {first.anmelderNavn && (
                            <p className="text-slate-300">{String(first.anmelderNavn)}</p>
                          )}
                          {first.anmelderEmail && (
                            <p className="text-slate-400">{String(first.anmelderEmail)}</p>
                          )}
                        </div>
                      )}
                      {first.skoedeTekst && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20 text-xs">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {da ? 'Skødetekst' : 'Deed text'}
                          </p>
                          <p className="text-slate-400 leading-relaxed">
                            {String(first.skoedeTekst)}
                          </p>
                        </div>
                      )}
                      {first.dokumentAlias && (
                        <p className="text-slate-600 text-[10px] mt-2">
                          Dok: {String(first.dokumentAlias)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ── HÆFTELSER ── */}
        {/* BIZZ-478: Ensartet blå TabLoadingSpinner. */}
        {haeftelserLoading && (
          <TabLoadingSpinner label={da ? 'Henter hæftelser…' : 'Loading charges…'} />
        )}
        {haeftelser.length > 0 && (
          <>
            <div className="px-4 py-1.5 bg-amber-500/5 border-b border-slate-700/20">
              <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">
                {da ? 'Hæftelser' : 'Charges'} ({haeftelser.length})
              </span>
            </div>
            {haeftelser.map((h, i) => {
              const isOpen = expandedHaeftelser.has(i);
              const docId = String(h.dokumentId ?? '');
              return (
                <div key={`h-${i}`} className="border-b border-slate-700/15">
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                    onClick={() =>
                      setExpandedHaeftelser((prev) => {
                        const n = new Set(prev);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  >
                    {isOpen ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    <span className="text-xs text-slate-400 tabular-nums">
                      {String(h.prioritet ?? '')}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatDato(h.dato as string | null)}
                    </span>
                    <div className="min-w-0">
                      <span className="text-sm text-slate-200 truncate block">
                        {haeftelseTypeMap[String(h.type)] ?? String(h.type)}
                      </span>
                      {Array.isArray(h.debitorer) && (h.debitorer as string[]).length > 0 && (
                        <span className="text-[10px] text-slate-500 truncate block">
                          {(h.debitorer as string[]).join(', ')}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-slate-300 tabular-nums text-right">
                      {h.beloeb != null && Number(h.beloeb) > 0
                        ? `${Number(h.beloeb).toLocaleString('da-DK')} ${String(h.valuta ?? 'DKK')}`
                        : ''}
                    </span>
                    <span className="text-xs text-slate-400 truncate">
                      {String(h.kreditor ?? '')}
                    </span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {docId && (
                        <a
                          href={`/api/tinglysning/dokument?uuid=${docId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <FileText size={11} />
                          PDF
                        </a>
                      )}
                    </div>
                    {docId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedDocs.has(docId)}
                          onChange={() => toggleDoc(docId)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedDocs.has(docId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedDocs.has(docId) && (
                            <svg
                              viewBox="0 0 10 10"
                              className="w-2 h-2 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                            </svg>
                          )}
                        </span>
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>
                  {isOpen && (
                    <div className="px-4 pb-3 ml-10 border-l-2 border-amber-500/20 text-xs">
                      {/* ── Grundoplysninger ── */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 mt-1">
                        {h.tinglysningsafgift != null && Number(h.tinglysningsafgift) > 0 && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Tinglysningsafgift' : 'Reg. fee'}
                            </p>
                            <p className="text-slate-300">
                              {Number(h.tinglysningsafgift).toLocaleString('da-DK')} DKK
                            </p>
                          </div>
                        )}
                        {h.pantebrevFormular && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Pantebrev — Lovpligtig kode' : 'Mortgage form code'}
                            </p>
                            <p className="text-slate-300">{String(h.pantebrevFormular)}</p>
                          </div>
                        )}
                        {h.laantype && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Lånetypekode' : 'Loan type'}
                            </p>
                            <p className="text-slate-300">
                              {laantypeMap[String(h.laantype)] ?? humanizeCode(String(h.laantype))}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* ── Særlige lånevilkår (badges) ── */}
                      {h.laanevilkaar &&
                        Array.isArray(h.laanevilkaar) &&
                        h.laanevilkaar.length > 0 && (
                          <div className="mt-3">
                            <p className="text-slate-500 text-[10px] uppercase mb-1">
                              {da ? 'Særlige lånevilkår' : 'Special loan terms'}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                              {(h.laanevilkaar as string[])
                                .flatMap((v) => String(v).split(','))
                                .map((v) => v.trim())
                                .filter((v) => v.length > 0)
                                .map((v, vi) => (
                                  <span
                                    key={vi}
                                    className="px-2 py-0.5 rounded-full bg-slate-700/40 border border-slate-600/30 text-slate-300 text-[11px]"
                                  >
                                    {humanizeCode(v)}
                                  </span>
                                ))}
                            </div>
                          </div>
                        )}

                      {/* ── Kreditorbetegnelse ── */}
                      {h.kreditorbetegnelse && (
                        <div className="mt-3">
                          <p className="text-slate-500 text-[10px] uppercase">
                            {da ? 'Kreditorbetegnelse' : 'Creditor ID'}
                          </p>
                          <p className="text-slate-300">{String(h.kreditorbetegnelse)}</p>
                        </div>
                      )}

                      {/* ── Kreditor + Debitorer ── */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 mt-3">
                        {h.kreditor && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Kreditor' : 'Creditor'}
                            </p>
                            {h.kreditorCvr ? (
                              <button
                                onClick={() => router.push(`/dashboard/companies/${h.kreditorCvr}`)}
                                className="text-blue-400 hover:text-blue-300"
                              >
                                {String(h.kreditor)} →
                              </button>
                            ) : (
                              <p className="text-slate-300">{String(h.kreditor)}</p>
                            )}
                          </div>
                        )}
                        <div>
                          <p className="text-slate-500 text-[10px] uppercase">
                            {da
                              ? Array.isArray(h.debitorer) && h.debitorer.length > 1
                                ? 'Debitorer'
                                : 'Debitor'
                              : Array.isArray(h.debitorer) && h.debitorer.length > 1
                                ? 'Debtors'
                                : 'Debtor'}
                          </p>
                          {Array.isArray(h.debitorer) && (h.debitorer as string[]).length > 0 ? (
                            (h.debitorer as string[]).map((navn, di) => (
                              <p key={di} className="text-slate-300">
                                {navn}
                              </p>
                            ))
                          ) : (
                            <p className="text-slate-500">—</p>
                          )}
                        </div>
                      </div>

                      {/* ── Rente-sektion ── */}
                      {(h.rente != null || h.renteType || h.referenceRenteNavn) && (
                        <div className="mt-3 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase font-semibold mb-1.5">
                            {da ? 'Rente' : 'Interest'}
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 ml-2">
                            {h.renteType && (
                              <div>
                                <p className="text-slate-500 text-[10px] uppercase">Type</p>
                                <p className="text-slate-300">{String(h.renteType)}</p>
                              </div>
                            )}
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase">
                                {da ? 'Pålydende sats' : 'Nominal rate'}
                              </p>
                              <p className="text-slate-300">
                                {h.rente != null ? `${Number(h.rente).toFixed(4)}%` : '—'}
                              </p>
                            </div>
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase">
                                {da ? 'Foreløbig' : 'Preliminary'}
                              </p>
                              <p className="text-slate-300">
                                {h.renteForeloebig ? (da ? 'Ja' : 'Yes') : da ? 'Nej' : 'No'}
                              </p>
                            </div>
                            {h.referenceRenteNavn && (
                              <div className="col-span-2 sm:col-span-3">
                                <p className="text-slate-500 text-[10px] uppercase">
                                  {da ? 'Referencerente' : 'Reference rate'}
                                </p>
                                <p className="text-slate-300">
                                  {humanizeCode(String(h.referenceRenteNavn))}
                                  {h.referenceRenteSats != null &&
                                    ` : ${Number(h.referenceRenteSats).toFixed(4)}%`}
                                </p>
                                {h.renteTillaeg != null && (
                                  <p className="text-slate-300 mt-0.5">
                                    {da ? 'Tillæg' : 'Spread'}: {Number(h.renteTillaeg).toFixed(2)}%
                                    {h.renteTillaegType &&
                                      ` (${humanizeCode(String(h.renteTillaegType))})`}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ── Underpant ── */}
                      {h.underpant &&
                        (() => {
                          const up = h.underpant as TLUnderpant;
                          return (
                            <div className="mt-3 pt-2 border-t border-slate-700/20">
                              <p className="text-slate-500 text-[10px] uppercase font-semibold mb-1.5">
                                {da ? 'Underpant' : 'Sub-collateral'}
                              </p>
                              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 ml-2">
                                {up.prioritet != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase">
                                      {da ? 'Prioritet' : 'Priority'}
                                    </p>
                                    <p className="text-slate-300">{up.prioritet}</p>
                                  </div>
                                )}
                                {up.beloeb != null && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase">
                                      {da ? 'Underpantsbeløb' : 'Sub-collateral amount'}
                                    </p>
                                    <p className="text-slate-300">
                                      {Number(up.beloeb).toLocaleString('da-DK')} {up.valuta}
                                    </p>
                                  </div>
                                )}
                                {up.havere.length > 0 && (
                                  <div>
                                    <p className="text-slate-500 text-[10px] uppercase">
                                      {da ? 'Underpanthavere' : 'Sub-collateral holders'}
                                    </p>
                                    {up.havere.map((n, ni) => (
                                      <p key={ni} className="text-slate-300">
                                        {n}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                      {/* ── Fuldmagtsbestemmelser ── */}
                      {Array.isArray(h.fuldmagtsbestemmelser) &&
                        (h.fuldmagtsbestemmelser as string[]).length > 0 && (
                          <div className="mt-3 pt-2 border-t border-slate-700/20">
                            <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                              {da ? 'Fuldmagtsbestemmelser' : 'Power of attorney'}
                            </p>
                            {(h.fuldmagtsbestemmelser as string[]).map((navn, fi) => (
                              <p key={fi} className="text-slate-300">
                                {navn}
                              </p>
                            ))}
                          </div>
                        )}

                      {/* ── Lånetekst / beskrivelse ── */}
                      {h.laaneTekst && (
                        <div className="mt-3 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {da ? 'Beskrivelse' : 'Description'}
                          </p>
                          <p className="text-slate-400 whitespace-pre-wrap leading-relaxed">
                            {String(h.laaneTekst)}
                          </p>
                        </div>
                      )}
                      {h.dokumentAlias && (
                        <p className="text-slate-600 text-[10px] mt-2">
                          Dok: {String(h.dokumentAlias)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ── SERVITUTTER ──
            BIZZ-478: Ensartet blå TabLoadingSpinner. */}
        {servituterLoading && (
          <TabLoadingSpinner label={da ? 'Henter servitutter…' : 'Loading easements…'} />
        )}
        {servituterTimedOut && servitutter.length === 0 && (
          <div className="mx-4 my-3 flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
            <span className="mt-0.5 text-yellow-400 text-sm">⚠</span>
            <span className="text-yellow-300 text-sm">
              {da
                ? 'Servitutter kunne ikke hentes inden for tidsgrænsen. Prøv at genindlæse siden.'
                : 'Easements could not be loaded within the time limit. Please reload the page.'}
            </span>
          </div>
        )}
        {/* BIZZ-548: Error state with retry button */}
        {servituterError &&
          !servituterLoading &&
          servitutter.length === 0 &&
          !servituterTimedOut && (
            <div className="mx-4 my-3 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
              <span className="mt-0.5 text-red-400 text-sm">✕</span>
              <span className="text-red-300 text-sm flex-1">
                {da
                  ? 'Servitutter kunne ikke hentes. Tjek forbindelsen og prøv igen.'
                  : 'Easements could not be loaded. Check your connection and try again.'}
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="text-xs text-red-300 border border-red-500/30 px-2 py-0.5 rounded hover:bg-red-500/20 transition-colors"
              >
                {da ? 'Prøv igen' : 'Retry'}
              </button>
            </div>
          )}
        {/* BIZZ-548: Empty state — no servitutter found (not loading, no error, no timeout) */}
        {!servituterLoading &&
          !servituterError &&
          !servituterTimedOut &&
          servitutter.length === 0 && (
            <div className="mx-4 my-3 flex items-center gap-2 rounded-md border border-slate-700/30 bg-slate-800/40 px-3 py-2">
              <span className="text-slate-500 text-sm">
                {da
                  ? 'Ingen servitutter fundet for denne ejendom.'
                  : 'No easements found for this property.'}
              </span>
            </div>
          )}
        {servitutter.length > 0 && (
          <>
            <div className="px-4 py-1.5 bg-teal-500/5 border-b border-slate-700/20 flex items-center gap-2">
              <span className="text-[10px] font-semibold text-teal-400 uppercase tracking-wider">
                {da ? 'Servitutter' : 'Easements'} ({servitutter.length})
              </span>
              {/* BIZZ-472: Fortæl hvor mange af servitutterne der er arvet fra hovedejendommen.
                  Klik åbner hovedejendommens side så brugeren kan se fuld kontekst. */}
              {antalFraHovedejendom > 0 &&
                (moderBfe ? (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const js = await fetch(`/api/adresse/jordstykke?bfe=${moderBfe}`);
                        if (!js.ok) return;
                        const { adgangsadresseId } = (await js.json()) as {
                          adgangsadresseId?: string;
                        };
                        if (adgangsadresseId) {
                          router.push(`/dashboard/ejendomme/${adgangsadresseId}`);
                        }
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded hover:bg-amber-500/20 transition-colors inline-flex items-center gap-1"
                    title={
                      da
                        ? `Se hovedejendommen (BFE ${moderBfe})`
                        : `View parent property (BFE ${moderBfe})`
                    }
                  >
                    <Building2 size={9} />
                    {da
                      ? `${antalFraHovedejendom} fra hovedejendom →`
                      : `${antalFraHovedejendom} from parent →`}
                  </button>
                ) : (
                  <span className="text-[10px] font-medium text-amber-400/90 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                    {da
                      ? `${antalFraHovedejendom} fra hovedejendom`
                      : `${antalFraHovedejendom} from parent property`}
                  </span>
                ))}
            </div>
            {visServitutter.map((s, i) => {
              const docId = String(s.dokumentId ?? '');
              const isOpen = expandedServitutter.has(i);
              const servitutBilag = Array.isArray(s.bilagRefs) ? (s.bilagRefs as string[]) : [];
              const hasDetails =
                s.tillaegsTekst ||
                s.paataleberettiget ||
                (s.indholdKoder && Array.isArray(s.indholdKoder) && s.indholdKoder.length > 0) ||
                s.tinglysningsafgift ||
                s.harBetydningForVaerdi ||
                servitutBilag.length > 0;
              return (
                <div key={`s-${i}`} className="border-b border-slate-700/15">
                  <div
                    className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 hover:bg-slate-700/10 transition-colors items-center cursor-pointer"
                    onClick={() =>
                      hasDetails &&
                      setExpandedServitutter((prev) => {
                        const n = new Set(prev);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                  >
                    {hasDetails ? (
                      isOpen ? (
                        <ChevronDown size={12} className="text-slate-500" />
                      ) : (
                        <ChevronRight size={12} className="text-slate-500" />
                      )
                    ) : (
                      <span />
                    )}
                    <span className="text-xs text-slate-400 tabular-nums">
                      {String(s.prioritet ?? '')}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {formatDato(s.dato as string | null)}
                    </span>
                    <span className="text-sm text-slate-300 truncate flex items-center gap-1.5">
                      <span className="truncate">
                        {String(s.tekst ?? '') ||
                          (servitutTypeMap[String(s.type)] ?? String(s.type))}
                        {s.ogsaaLystPaa != null && Number(s.ogsaaLystPaa) > 1 && (
                          <span className="text-slate-600 text-[10px] ml-1">
                            ({String(s.ogsaaLystPaa)} ejd.)
                          </span>
                        )}
                      </span>
                      {/* BIZZ-472: Marker servitutter arvet fra hovedejendommen */}
                      {s.fraHovedejendom && (
                        <span
                          className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1 py-0.5 rounded"
                          title={
                            da
                              ? 'Denne servitut er tinglyst på hovedejendommen og gælder for alle ejerlejligheder i komplekset'
                              : 'This easement is registered on the parent property and applies to all units in the complex'
                          }
                        >
                          <Building2 size={9} />
                          {da ? 'Hovedejendom' : 'Parent'}
                        </span>
                      )}
                      {/* BIZZ-567: Bilag-tælling som diskret badge efter titlen.
                          BIZZ-605: Badge er nu klikbar — åbner rækken og scroller
                          til "Tilknyttede bilag" så brugeren kan hente hvert bilag
                          separat. Hoveddokument-PDF og bilag er nu adskilt. */}
                      {servitutBilag.length > 0 && (
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setExpandedServitutter((prev) => {
                              const n = new Set(prev);
                              n.add(i);
                              return n;
                            });
                          }}
                          className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-slate-300 bg-slate-700/40 border border-slate-600/30 px-1 py-0.5 rounded hover:bg-slate-600/50 hover:text-blue-300 transition-colors cursor-pointer"
                          title={
                            da
                              ? `Vis ${servitutBilag.length} ${servitutBilag.length === 1 ? 'tilknyttet bilag' : 'tilknyttede bilag'}`
                              : `Show ${servitutBilag.length} ${servitutBilag.length === 1 ? 'attachment' : 'attachments'}`
                          }
                          aria-label={
                            da
                              ? `Vis ${servitutBilag.length} tilknyttede bilag`
                              : `Show ${servitutBilag.length} attachments`
                          }
                        >
                          <Paperclip size={9} />
                          {servitutBilag.length}{' '}
                          {da ? 'bilag' : servitutBilag.length === 1 ? 'attachment' : 'attachments'}
                        </button>
                      )}
                    </span>
                    <span />
                    <span className="text-xs text-slate-500 truncate">
                      {servitutTypeMap[String(s.type)] ?? String(s.type)}
                    </span>
                    <div
                      className="flex items-center gap-1.5"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {(() => {
                        // BIZZ-605: PDF-knappen åbner udelukkende selve
                        // hoveddokumentet (servitutten). Bilag-badgen ved siden af
                        // titlen åbner rækken så hvert bilag kan hentes separat
                        // fra "Tilknyttede bilag"-sektionen. Tidligere fletning af
                        // hoveddok + bilag (BIZZ-474) gjorde det umuligt at skelne
                        // selve servitut-teksten fra bilag i den samlede PDF.
                        //
                        // Når docId mangler (pre-digitale servitutter), skjul
                        // PDF-knappen — bilag tilgås via badgen/detaljesektionen.
                        if (!docId) return null;
                        const pdfUrl = `/api/tinglysning/dokument?uuid=${docId}`;
                        return (
                          <a
                            href={pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap"
                            title={da ? 'Åbn servitut-dokument' : 'Open easement document'}
                          >
                            <FileText size={11} />
                            PDF
                          </a>
                        );
                      })()}
                    </div>
                    {docId ? (
                      <label
                        className="flex items-center cursor-pointer flex-shrink-0"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selectedDocs.has(docId)}
                          onChange={() => toggleDoc(docId)}
                        />
                        <span
                          className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedDocs.has(docId) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                        >
                          {selectedDocs.has(docId) && (
                            <svg
                              viewBox="0 0 10 10"
                              className="w-2 h-2 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                            </svg>
                          )}
                        </span>
                      </label>
                    ) : (
                      <span />
                    )}
                  </div>
                  {isOpen && hasDetails && (
                    <div className="px-4 pb-3 ml-10 border-l-2 border-teal-500/20 text-xs">
                      {s.harBetydningForVaerdi && (
                        <p className="text-amber-400 text-[10px] font-semibold mb-1.5">
                          ⚠ {da ? 'Har betydning for ejendommens værdi' : 'Affects property value'}
                        </p>
                      )}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 mt-1">
                        {s.paataleberettiget && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Påtaleberettiget' : 'Enforcement'}
                            </p>
                            {s.paataleberettigetCvr ? (
                              <button
                                onClick={() =>
                                  router.push(
                                    `/dashboard/companies/${String(s.paataleberettigetCvr)}`
                                  )
                                }
                                className="text-blue-400 hover:text-blue-300"
                              >
                                {String(s.paataleberettiget)} →
                              </button>
                            ) : (
                              <p className="text-slate-300">{String(s.paataleberettiget)}</p>
                            )}
                          </div>
                        )}
                        {s.indholdKoder &&
                          Array.isArray(s.indholdKoder) &&
                          s.indholdKoder.length > 0 && (
                            <div>
                              <p className="text-slate-500 text-[10px] uppercase">
                                {da ? 'Indhold' : 'Content'}
                              </p>
                              <p className="text-slate-300">
                                {(s.indholdKoder as string[]).join(', ')}
                              </p>
                            </div>
                          )}
                        {s.tinglysningsafgift != null && Number(s.tinglysningsafgift) > 0 && (
                          <div>
                            <p className="text-slate-500 text-[10px] uppercase">
                              {da ? 'Afgift' : 'Fee'}
                            </p>
                            <p className="text-slate-300">
                              {Number(s.tinglysningsafgift).toLocaleString('da-DK')} DKK
                            </p>
                          </div>
                        )}
                      </div>
                      {s.tillaegsTekst && (
                        <div className="mt-2 pt-2 border-t border-slate-700/20">
                          <p className="text-slate-500 text-[10px] uppercase mb-0.5">
                            {da ? 'Tillægstekst' : 'Supplementary text'}
                          </p>
                          <div className="text-slate-400 leading-relaxed space-y-1">
                            {String(s.tillaegsTekst)
                              .split('\n')
                              .map((line, li) => (
                                <p key={li}>{line}</p>
                              ))}
                          </div>
                        </div>
                      )}
                      {s.dokumentAlias && (
                        <p className="text-slate-600 text-[10px] mt-2">
                          Dok: {String(s.dokumentAlias)}
                        </p>
                      )}
                      {/*
                        ── Tilknyttede bilag til denne servitut ──
                        BIZZ-474: Bilag har nu læsbar beskrivelse via s.bilag
                        (fx "relaksation", "tillæg til servitutten findes i
                        bilag") fra tingbogsattestens TekstAngivelse-map.
                        Falder tilbage til "Bilag N" for ældre data uden tekst.
                      */}
                      {(() => {
                        const bilagMedTekst =
                          (s.bilag as Array<{ id: string; tekst: string }> | undefined) ?? [];
                        const visBilag =
                          bilagMedTekst.length > 0
                            ? bilagMedTekst
                            : servitutBilag.map((id, i) => ({
                                id,
                                tekst: `${da ? 'Bilag' : 'Attachment'} ${i + 1}`,
                              }));
                        if (visBilag.length === 0) return null;
                        return (
                          <div className="mt-2 pt-2 border-t border-slate-700/20">
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-slate-500 text-[10px] uppercase">
                                {da ? 'Tilknyttede bilag' : 'Attachments'} ({visBilag.length})
                              </p>
                              {/* BIZZ-1056: Bulk download alle bilag som samlet PDF */}
                              {visBilag.length > 1 && (
                                <a
                                  href={`/api/tinglysning/dokument?${docId ? `uuid=${docId}&` : ''}bilag=${visBilag.map((b) => b.id).join(',')}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors"
                                  title={
                                    da
                                      ? 'Download alle bilag som samlet PDF'
                                      : 'Download all attachments as merged PDF'
                                  }
                                >
                                  {da ? 'Download alle' : 'Download all'}
                                </a>
                              )}
                            </div>
                            <div className="space-y-1">
                              {visBilag.map((b, bi) => (
                                <a
                                  key={bi}
                                  href={`/api/tinglysning/dokument?bilag=${b.id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                                >
                                  <FileText size={10} className="flex-shrink-0" />
                                  <span className="truncate">{b.tekst}</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
            {servitutter.length > 5 && (
              <button
                onClick={() => setShowAllServitutter(!showAllServitutter)}
                className="w-full text-center py-2 text-xs text-blue-400 hover:text-blue-300 transition-colors border-t border-slate-700/20"
              >
                {showAllServitutter
                  ? da
                    ? '▲ Vis færre'
                    : '▲ Show less'
                  : da
                    ? `▼ Vis alle ${servitutter.length}`
                    : `▼ Show all ${servitutter.length}`}
              </button>
            )}
          </>
        )}

        {/* ── BILAG (tingbog-/adkomstniveau — bilag der ikke er knyttet til en enkelt servitut) ── */}
        {bilagRefs.length > 0 && (
          <>
            <div className="px-4 py-1.5 bg-blue-500/5 border-b border-slate-700/20">
              <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider">
                {da ? 'Tingbog / Adkomst — bilag' : 'Land register / Deed — attachments'} (
                {bilagRefs.length})
              </span>
            </div>
            {bilagRefs.map((b, i) => (
              <div
                key={`b-${i}`}
                className="grid grid-cols-[24px_36px_90px_1fr_100px_100px_50px_28px] gap-x-2 px-4 py-2 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-center"
              >
                <span />
                <span />
                <span />
                <span className="text-sm text-slate-300 truncate">{b.tekst || 'Bilag'}</span>
                <span />
                <span className="text-xs text-slate-500">PDF</span>
                <div className="flex items-center gap-1.5">
                  <a
                    href={`/api/tinglysning/dokument?bilag=${b.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300"
                  >
                    <FileText size={11} />
                    PDF
                  </a>
                </div>
                <label className="flex items-center cursor-pointer flex-shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={selectedDocs.has(`bilag-${b.id}`)}
                    onChange={() => toggleDoc(`bilag-${b.id}`)}
                  />
                  <span
                    className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center transition-colors ${selectedDocs.has(`bilag-${b.id}`) ? 'bg-blue-500 border-blue-500' : 'bg-[#0a1020] border-slate-400'}`}
                  >
                    {selectedDocs.has(`bilag-${b.id}`) && (
                      <svg
                        viewBox="0 0 10 10"
                        className="w-2 h-2 text-white"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path d="M1.5 5.5l2.5 2.5 4.5-4.5" />
                      </svg>
                    )}
                  </span>
                </label>
              </div>
            ))}
          </>
        )}

        {/* ── INDSKANNEDE AKTER (pre-digitale dokumenter fra EjendomIndskannetAktSamling) ── */}
        {indskannedeAkterNavne.length > 0 && (
          <>
            <div className="px-4 py-1.5 bg-amber-500/5 border-b border-slate-700/20">
              <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">
                {da ? 'Indskannede akter' : 'Scanned acts'} {`(${indskannedeAkterNavne.length})`}
              </span>
            </div>

            {/* Advarsel om potentielt store filer */}
            <div className="px-4 py-2 border-b border-slate-700/10 flex items-start gap-2 bg-amber-500/5">
              <svg
                viewBox="0 0 16 16"
                className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5"
                fill="currentColor"
              >
                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4.5zm0 6.25a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75z" />
              </svg>
              <p className="text-amber-300/80 text-[10px] leading-relaxed">
                {da
                  ? 'Disse akter er indskannede papirdokumenter fra før den digitale tinglysning (ca. 2009). De kan være meget store (hundredvis af sider) og kan tage tid at downloade.'
                  : 'These acts are scanned paper documents from before digital land registration (approx. 2009). They may be very large (hundreds of pages) and may take time to download.'}
              </p>
            </div>

            {indskannedeAkterNavne.map((aktNavn, i) => (
              <div
                key={aktNavn}
                className="grid grid-cols-[24px_1fr_auto] gap-x-2 px-4 py-2.5 border-b border-slate-700/15 hover:bg-slate-700/10 transition-colors items-center"
              >
                <span className="text-slate-500 text-[10px] tabular-nums text-center">{i + 1}</span>
                <span className="text-sm text-slate-200 truncate">{aktNavn}</span>
                <a
                  href={`/api/tinglysning/indskannede-akter/download?aktNavn=${encodeURIComponent(aktNavn)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 transition-colors px-2 py-1 border border-amber-500/30 rounded-md hover:border-amber-400/50"
                  title={
                    da
                      ? 'Download som PDF — kan være stor fil'
                      : 'Download as PDF — may be a large file'
                  }
                >
                  <FileText size={11} />
                  PDF
                </a>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
