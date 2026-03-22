'use client';

/**
 * Ejendomme listeside med live DAWA-adressesøgning.
 *
 * Søger i alle ~2,8 mio. danske adresser via DAWA autocomplete (gratis).
 * Mock-ejendomme vises som "Populære ejendomme" når ingen søgning er aktiv.
 * Rigtige BBR-data hentes via Datafordeler i Fase 2.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Search,
  MapPin,
  Navigation,
  Building2,
  Home,
  Warehouse,
  ChevronRight,
  X,
  Loader2,
  Clock,
  ArrowRight,
} from 'lucide-react';
import { mockEjendomme, formatDKK, type Ejendom } from '@/app/lib/mock/ejendomme';
import { dawaAutocomplete, erDawaId, type DawaAutocompleteResult } from '@/app/lib/dawa';

const RECENT_KEY = 'ba-ejendomme-recent';
const MAX_RECENT = 5;

/** Returnerer farve-klasse baseret på ejendomstype */
const typeColor = (type: string): string => {
  if (type.includes('Parcelhus')) return 'text-green-400 bg-green-400/10';
  if (type.includes('Beboelses')) return 'text-blue-400 bg-blue-400/10';
  if (type.includes('Industri')) return 'text-orange-400 bg-orange-400/10';
  return 'text-purple-400 bg-purple-400/10';
};

/** Type-ikon */
function TypeIkon({ type }: { type: string }) {
  if (type.includes('Parcelhus') || type.includes('Beboelses')) return <Home size={18} />;
  if (type.includes('Industri') || type.includes('lager')) return <Warehouse size={18} />;
  return <Building2 size={18} />;
}

/** Mock ejendomskort til "Populære ejendomme" */
function EjendomCard({ ejendom }: { ejendom: Ejendom }) {
  const color = typeColor(ejendom.ejendomstype);
  return (
    <Link
      href={`/dashboard/ejendomme/${ejendom.id}`}
      className="group bg-slate-800/40 border border-slate-700/40 hover:border-blue-500/40 rounded-2xl p-5 flex flex-col gap-3 transition-all hover:bg-slate-800/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`p-2 rounded-xl ${color}`}>
          <TypeIkon type={ejendom.ejendomstype} />
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>
          {ejendom.ejendomstype.split('(')[0].trim()}
        </span>
      </div>
      <div>
        <p className="text-white font-semibold text-sm leading-snug">{ejendom.adresse}</p>
        <p className="text-slate-400 text-xs mt-0.5">
          {ejendom.postnummer} {ejendom.by} · {ejendom.kommune}
        </p>
      </div>
      <div className="flex items-center justify-between pt-1 border-t border-slate-700/40">
        <div>
          <p className="text-white text-sm font-semibold">
            {formatDKK(ejendom.senesteHandel.pris)}
          </p>
          <p className="text-slate-500 text-xs">{ejendom.grundareal} m² grund</p>
        </div>
        <ChevronRight
          size={16}
          className="text-slate-600 group-hover:text-blue-400 transition-colors"
        />
      </div>
    </Link>
  );
}

/** Et enkelt DAWA-resultat i dropdown */
function DawaResultItem({
  result,
  onVælg,
  aktiv,
}: {
  result: DawaAutocompleteResult;
  onVælg: (r: DawaAutocompleteResult) => void;
  aktiv?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onVælg(result)}
      className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left group ${
        aktiv ? 'bg-blue-600/20' : 'hover:bg-slate-700/50'
      }`}
    >
      <div
        className={`p-1.5 rounded-lg flex-shrink-0 transition-colors ${aktiv ? 'bg-blue-600/30' : 'bg-slate-700 group-hover:bg-blue-600/20'}`}
      >
        {result.type === 'vejnavn' ? (
          <Navigation
            size={13}
            className={aktiv ? 'text-blue-400' : 'text-slate-400 group-hover:text-blue-400'}
          />
        ) : (
          <MapPin
            size={13}
            className={aktiv ? 'text-blue-400' : 'text-slate-400 group-hover:text-blue-400'}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{result.tekst}</p>
        <p className="text-slate-500 text-xs">
          {result.type === 'vejnavn'
            ? 'Vej — tilføj husnummer'
            : result.adresse.postnr
              ? `${result.adresse.postnr} ${result.adresse.postnrnavn}`
              : 'Danmark'}
        </p>
      </div>
      <ArrowRight
        size={13}
        className={aktiv ? 'text-blue-400' : 'text-slate-600 group-hover:text-blue-400'}
      />
    </button>
  );
}

interface DropdownPos {
  top: number;
  left: number;
  width: number;
}

interface DropdownPortalProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  søgning: string;
  resultater: DawaAutocompleteResult[];
  søgerDAWA: boolean;
  søgningFærdig: boolean;
  seneste: DawaAutocompleteResult[];
  markeret: number;
  onVælg: (r: DawaAutocompleteResult) => void;
}

/**
 * Portal-komponent til autocomplete-dropdown.
 *
 * Renderes i document.body for at undgå overflow:hidden klipning fra dashboard.
 * Positionen beregnes i useLayoutEffect (kører synkront efter DOM-mutation, før paint)
 * og gemt i lokal state — overholder React 19-reglen om ingen ref-læsning under render.
 *
 * @param inputRef - Ref til søgeinput — position beregnes relativt hertil
 * @param dropdownRef - Ref til dropdown-div — bruges til klik-uden-for detection
 */
function DropdownPortal({
  inputRef,
  dropdownRef,
  søgning,
  resultater,
  søgerDAWA,
  søgningFærdig,
  seneste,
  markeret,
  onVælg,
}: DropdownPortalProps) {
  const [pos, setPos] = useState<DropdownPos | null>(null);

  /**
   * Beregn og opdater dropdown-position synkront efter DOM-mutation og ved scroll/resize.
   * useLayoutEffect sikrer at positionen er sat før browseren painter — ingen flash.
   */
  useEffect(() => {
    function opdater() {
      if (!inputRef.current) return;
      const r = inputRef.current.getBoundingClientRect();
      if (r.width > 0) setPos({ top: r.bottom + 8, left: r.left, width: r.width });
    }
    opdater();
    window.addEventListener('resize', opdater);
    window.addEventListener('scroll', opdater, true);
    return () => {
      window.removeEventListener('resize', opdater);
      window.removeEventListener('scroll', opdater, true);
    };
  }, [inputRef]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 9999,
      }}
      className="bg-slate-800 border border-slate-700/60 rounded-2xl overflow-hidden shadow-2xl"
    >
      {/* Seneste søgninger */}
      {søgning.length < 2 && seneste.length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700/40">
            <Clock size={12} className="text-slate-500" />
            <span className="text-slate-500 text-xs font-medium uppercase tracking-wide">
              Seneste søgninger
            </span>
          </div>
          {seneste
            .filter((r) => r.adresse?.id)
            .map((r) => (
              <DawaResultItem key={r.adresse.id} result={r} onVælg={onVælg} />
            ))}
        </div>
      )}

      {/* DAWA-resultater */}
      {søgning.length >= 2 && (
        <>
          {søgerDAWA && (
            <div className="flex items-center gap-3 px-4 py-3 text-slate-500 text-sm">
              <Loader2 size={14} className="animate-spin" />
              Søger i alle danske adresser…
            </div>
          )}
          {!søgerDAWA && søgningFærdig && resultater.length === 0 && (
            <div className="px-4 py-4 text-slate-500 text-sm text-center">
              Ingen adresser fundet for &ldquo;{søgning}&rdquo;
            </div>
          )}
          {resultater
            .filter((r) => r.adresse?.id)
            .map((r, i) => (
              <DawaResultItem
                key={r.adresse.id}
                result={r}
                onVælg={onVælg}
                aktiv={i === markeret}
              />
            ))}
          {resultater.length === 8 && (
            <div className="px-4 py-2 border-t border-slate-700/40">
              <p className="text-slate-600 text-xs text-center">
                Viser de 8 bedste resultater — præcisér søgningen for flere
              </p>
            </div>
          )}
        </>
      )}
    </div>,
    document.body
  );
}

/**
 * Ejendomme listeside.
 * Kombinerer DAWA live-søgning med mock-ejendomme som inspiration.
 */
export default function EjendommeListeside() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [søgning, setSøgning] = useState('');
  const [resultater, setResultater] = useState<DawaAutocompleteResult[]>([]);
  const [søgerDAWA, setSøgerDAWA] = useState(false);
  /** True når DAWA-kaldet er afsluttet — holder dropdown åben selv ved 0 resultater */
  const [søgningFærdig, setSøgningFærdig] = useState(false);
  const [åben, setÅben] = useState(false);
  const [markeret, setMarkeret] = useState(-1);
  /** Lazy initialisering fra localStorage — filtrerer evt. korrupt/forældet data fra */
  const [seneste, setSeneste] = useState<DawaAutocompleteResult[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed = raw ? (JSON.parse(raw) as DawaAutocompleteResult[]) : [];
      // Bevar kun elementer med gyldig adresse-struktur
      return Array.isArray(parsed) ? parsed.filter((r) => r?.adresse?.id) : [];
    } catch {
      return [];
    }
  });

  /** Gem nyligt valgt adresse i localStorage */
  const gemSeneste = useCallback((result: DawaAutocompleteResult) => {
    setSeneste((prev) => {
      const filtreret = prev.filter((r) => r.adresse?.id !== result.adresse.id);
      const opdateret = [result, ...filtreret].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(opdateret));
      } catch {
        /* ignorer */
      }
      return opdateret;
    });
  }, []);

  /** Luk dropdown ved klik udenfor */
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setÅben(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Debounced DAWA-søgning.
   * Nulstiller søgningFærdig ved søgningsændring, sætter den til true når svaret modtages.
   * Dropdown forbliver åben via søgningFærdig selvom resultater er tomme (viser "ingen fundet").
   */
  useEffect(() => {
    setSøgningFærdig(false);
    const timer = setTimeout(async () => {
      if (søgning.trim().length < 2) {
        setResultater([]);
        setSøgerDAWA(false);
        return;
      }
      setSøgerDAWA(true);
      const data = await dawaAutocomplete(søgning);
      setResultater(data);
      setSøgerDAWA(false);
      setSøgningFærdig(true);
    }, 220);
    return () => clearTimeout(timer);
  }, [søgning]);

  /**
   * Håndterer valg af et autocomplete-resultat.
   * - vejnavn-type: udfylder søgefeltet med gadenavn + mellemrum så brugeren kan taste husnummer
   * - adresse/adgangsadresse: navigerer til ejendomsdetaljesiden
   */
  function vælgAdresse(result: DawaAutocompleteResult) {
    if (!erDawaId(result.adresse.id)) {
      // Vejnavn — autoudfyld søgefeltet og hold dropdown åben
      setSøgning(result.adresse.vejnavn + ' ');
      setMarkeret(-1);
      inputRef.current?.focus();
      return;
    }
    gemSeneste(result);
    setÅben(false);
    setSøgning('');
    router.push(`/dashboard/ejendomme/${result.adresse.id}`);
  }

  const visDropdown =
    åben &&
    (resultater.length > 0 ||
      søgerDAWA ||
      søgningFærdig || // Behold åben efter DAWA svarer — selvom 0 resultater (viser "ingen fundet")
      (søgning.length < 2 && seneste.length > 0));

  return (
    <div className="flex flex-col h-full bg-[#0a1628]">
      {/* ─── Header ─── */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-700/40">
        <h1 className="text-2xl font-bold text-white mb-1">Ejendomme</h1>
        <p className="text-slate-400 text-sm">Søg på alle ~2,8 mio. danske adresser</p>

        {/* Søgeboks med DAWA autocomplete */}
        <div className="relative mt-5">
          <div className="relative">
            <Search
              size={18}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              ref={inputRef}
              type="text"
              value={søgning}
              onChange={(e) => {
                setSøgning(e.target.value);
                setÅben(true);
                setMarkeret(-1);
              }}
              onFocus={() => setÅben(true)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMarkeret((m) => Math.min(m + 1, resultater.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMarkeret((m) => Math.max(m - 1, -1));
                } else if (e.key === 'Enter') {
                  const valgt = markeret >= 0 ? resultater[markeret] : resultater[0];
                  if (valgt) vælgAdresse(valgt);
                } else if (e.key === 'Escape') {
                  setÅben(false);
                  setMarkeret(-1);
                }
              }}
              placeholder="Søg på adresse, vejnavn eller postnummer…"
              className="w-full bg-slate-800/60 border border-slate-600/50 focus:border-blue-500/60 rounded-2xl pl-11 pr-12 py-4 text-white placeholder:text-slate-500 outline-none transition-all text-base shadow-lg"
            />
            {/* Loader / Ryd-knap */}
            <div className="absolute right-4 top-1/2 -translate-y-1/2">
              {søgerDAWA ? (
                <Loader2 size={18} className="text-blue-400 animate-spin" />
              ) : søgning.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setSøgning('');
                    setResultater([]);
                    setÅben(false);
                    inputRef.current?.focus();
                  }}
                  className="text-slate-500 hover:text-slate-300 transition-colors"
                >
                  <X size={18} />
                </button>
              ) : null}
            </div>
          </div>

          {/* Dropdown via Portal — undgår overflow:hidden klipning fra dashboard layout */}
          {visDropdown && typeof document !== 'undefined' && (
            <DropdownPortal
              inputRef={inputRef}
              dropdownRef={dropdownRef}
              søgning={søgning}
              resultater={resultater}
              søgerDAWA={søgerDAWA}
              søgningFærdig={søgningFærdig}
              seneste={seneste}
              markeret={markeret}
              onVælg={vælgAdresse}
            />
          )}
        </div>
      </div>

      {/* ─── Indhold ─── */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {/* Eksempel-søgninger */}
        <div className="flex flex-wrap gap-2 mb-8">
          {[
            'Bredgade 1, København',
            'Rådhuspladsen, København',
            'Vesterbrogade 100',
            'Nørreport Station',
            'Kongens Nytorv',
          ].map((eksempel) => (
            <button
              key={eksempel}
              type="button"
              onClick={() => {
                setSøgning(eksempel);
                setÅben(true);
                inputRef.current?.focus();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800/40 hover:bg-slate-700/60 border border-slate-700/40 hover:border-slate-600 rounded-full text-xs text-slate-400 hover:text-slate-200 transition-all"
            >
              <Search size={11} />
              {eksempel}
            </button>
          ))}
        </div>

        {/* Populære ejendomme (mock) */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-semibold text-base">Populære ejendomme</h2>
            <span className="text-slate-500 text-xs bg-slate-800/60 px-2.5 py-1 rounded-full">
              Demo-data
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {mockEjendomme.map((e) => (
              <EjendomCard key={e.id} ejendom={e} />
            ))}
          </div>
        </div>

        {/* Info-banner */}
        <div className="mt-8 flex items-start gap-3 bg-blue-600/8 border border-blue-500/20 rounded-2xl px-5 py-4">
          <Building2 size={18} className="text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-blue-300 text-sm font-medium">~2,8 mio. adresser tilgængelige</p>
            <p className="text-slate-400 text-xs mt-0.5 leading-relaxed">
              Søg på enhver dansk adresse for at se placering og matrikelgrænser på kortet. Fuld
              BBR- og ejerdata kobles på via Datafordeler i næste fase.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
