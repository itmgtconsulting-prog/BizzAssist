'use client';

/**
 * Virksomhedsdetaljeside — viser fuld information om en dansk virksomhed.
 *
 * Henter data fra den gratis cvrapi.dk via /api/cvr-public.
 * Viser virksomhedsinfo, kontaktoplysninger, ejere og produktionsenheder
 * i et mørkt tema med sticky header og tab-navigation der matcher
 * ejendomsdetaljesiden.
 *
 * @param params.cvr - 8-cifret CVR-nummer fra URL
 */

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Briefcase,
  Calendar,
  Users,
  CreditCard,
  MapPin,
  Phone,
  Mail,
  Factory,
  Loader2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ExternalLink,
  Bell,
  BarChart3,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import type { CVRPublicData } from '@/app/api/cvr-public/route';

// ─── Tracked Companies (localStorage) ────────────────────────────────────────

const TRACKED_COMPANIES_KEY = 'ba-tracked-companies';

/** En fulgt virksomhed i localStorage */
interface TrackedCompany {
  /** CVR-nummer */
  cvr: string;
  /** Virksomhedsnavn */
  navn: string;
  /** Unix timestamp (ms) */
  trackedSiden: number;
}

/**
 * Henter alle fulgte virksomheder fra localStorage.
 *
 * @returns Liste af fulgte virksomheder
 */
function hentTrackedCompanies(): TrackedCompany[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TRACKED_COMPANIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TrackedCompany[];
  } catch {
    return [];
  }
}

/**
 * Tjekker om en virksomhed er fulgt.
 *
 * @param cvr - CVR-nummer
 * @returns true hvis virksomheden følges
 */
function erTrackedCompany(cvr: string): boolean {
  return hentTrackedCompanies().some((c) => c.cvr === cvr);
}

/**
 * Toggler tracking af en virksomhed — returnerer ny tilstand.
 *
 * @param cvr - CVR-nummer
 * @param navn - Virksomhedsnavn
 * @returns true hvis virksomheden nu følges, false hvis unfølget
 */
function toggleTrackCompany(cvr: string, navn: string): boolean {
  if (typeof window === 'undefined') return false;
  const liste = hentTrackedCompanies();
  const alleredeFulgt = liste.some((c) => c.cvr === cvr);
  try {
    if (alleredeFulgt) {
      const opdateret = liste.filter((c) => c.cvr !== cvr);
      window.localStorage.setItem(TRACKED_COMPANIES_KEY, JSON.stringify(opdateret));
      return false;
    } else {
      const opdateret: TrackedCompany[] = [{ cvr, navn, trackedSiden: Date.now() }, ...liste].slice(
        0,
        50
      );
      window.localStorage.setItem(TRACKED_COMPANIES_KEY, JSON.stringify(opdateret));
      return true;
    }
  } catch {
    return alleredeFulgt;
  }
}

// ─── Tab Definitions ─────────────────────────────────────────────────────────

/** Tab-identifikatorer for virksomhedsdetaljesiden */
type TabId = 'oversigt' | 'ejere' | 'penheder' | 'oekonomi';

/** DA/EN labels for tabs */
const tabLabels: Record<TabId, { da: string; en: string }> = {
  oversigt: { da: 'Oversigt', en: 'Overview' },
  ejere: { da: 'Ejere', en: 'Owners' },
  penheder: { da: 'P-enheder', en: 'Units' },
  oekonomi: { da: 'Økonomi', en: 'Financials' },
};

/** Tab-ikoner */
const tabIcons: Record<TabId, React.ReactNode> = {
  oversigt: <Building2 size={14} />,
  ejere: <Users size={14} />,
  penheder: <MapPin size={14} />,
  oekonomi: <BarChart3 size={14} />,
};

/** Rækkefølge af tabs */
const tabOrder: TabId[] = ['oversigt', 'ejere', 'penheder', 'oekonomi'];

// ─── Types ────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ cvr: string }>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * VirksomhedDetalje — Hovedkomponent for virksomhedsdetaljesiden.
 *
 * Fetcher virksomhedsdata fra /api/cvr-public ved mount og viser
 * loading/error/data states med sticky header og tab-navigation.
 *
 * @param props.params - Route params med CVR-nummer
 */
export default function VirksomhedDetalje({ params }: PageProps) {
  const { cvr } = use(params);
  const router = useRouter();
  const { lang } = useLanguage();

  const [data, setData] = useState<CVRPublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aktivTab, setAktivTab] = useState<TabId>('oversigt');
  const [erFulgt, setErFulgt] = useState(false);

  /** Synkroniserer følg-status fra localStorage ved mount */
  useEffect(() => {
    setErFulgt(erTrackedCompany(cvr));
  }, [cvr]);

  /** Henter virksomhedsdata fra /api/cvr-public ved mount */
  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/cvr-public?vat=${encodeURIComponent(cvr)}`);
        const json = await res.json();

        if (cancelled) return;

        if (!res.ok || json.error) {
          setError(
            json.error ??
              (lang === 'da' ? 'Kunne ikke hente virksomhedsdata' : 'Could not fetch company data')
          );
          return;
        }

        setData(json as CVRPublicData);
      } catch {
        if (!cancelled) {
          setError(
            lang === 'da'
              ? 'Netværksfejl — kunne ikke kontakte CVR-API'
              : 'Network error — could not contact CVR API'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [cvr, lang]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-slate-400 text-sm">
            {lang === 'da' ? 'Henter virksomhedsdata...' : 'Loading company data...'}
          </p>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500" />
          <h2 className="text-white text-lg font-semibold">
            {lang === 'da' ? 'Fejl ved CVR-opslag' : 'CVR Lookup Error'}
          </h2>
          <p className="text-slate-400 text-sm">
            {error ?? (lang === 'da' ? 'Ukendt fejl' : 'Unknown error')}
          </p>
          <button
            onClick={() => router.back()}
            className="mt-2 px-4 py-2 bg-slate-800 text-slate-300 rounded-lg hover:bg-slate-700 transition text-sm"
          >
            {lang === 'da' ? 'Gå tilbage' : 'Go back'}
          </button>
        </div>
      </div>
    );
  }

  /** Om virksomheden stadig er aktiv (ingen slutdato) */
  const erAktiv = !data.enddate;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ─── Sticky Header ─── */}
      <div className="px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30">
        {/* Top row: back button + actions */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => router.push('/dashboard/companies')}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <ArrowLeft size={16} />
            {lang === 'da' ? 'Virksomheder' : 'Companies'}
          </button>
          <div className="flex items-center gap-2">
            {/* Virk.dk link */}
            <a
              href={`https://datacvr.virk.dk/enhed/virksomhed/${data.vat}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800/60 border border-slate-700/40 rounded-lg text-slate-400 hover:text-white hover:border-slate-600 transition text-sm"
            >
              <ExternalLink size={14} />
              Virk.dk
            </a>
            {/* Følg button */}
            <button
              onClick={async () => {
                const nyTilstand = toggleTrackCompany(cvr, data.name);
                setErFulgt(nyTilstand);
                window.dispatchEvent(new Event('ba-tracked-changed'));
                try {
                  if (nyTilstand) {
                    await fetch('/api/tracked', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        entity_id: cvr,
                        label: data.name,
                        entity_data: { type: 'company', companydesc: data.companydesc },
                      }),
                    });
                  } else {
                    await fetch(`/api/tracked?id=${encodeURIComponent(cvr)}`, { method: 'DELETE' });
                  }
                } catch {
                  /* Supabase ikke tilgængelig */
                }
              }}
              className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all ${
                erFulgt
                  ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
              }`}
            >
              <Bell size={14} className={erFulgt ? 'fill-blue-400 text-blue-400' : ''} />
              {erFulgt
                ? lang === 'da'
                  ? 'Følger'
                  : 'Following'
                : lang === 'da'
                  ? 'Følg'
                  : 'Follow'}
            </button>
          </div>
        </div>

        {/* Company name + badges */}
        <div className="mb-3">
          <h1 className="text-white text-xl font-bold truncate">{data.name}</h1>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-blue-600/20 text-blue-400 text-xs font-medium">
              CVR {data.vat}
            </span>
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium ${
                erAktiv ? 'bg-emerald-600/20 text-emerald-400' : 'bg-red-600/20 text-red-400'
              }`}
            >
              {erAktiv ? (
                <>
                  <CheckCircle size={12} />
                  {lang === 'da' ? 'Aktiv' : 'Active'}
                </>
              ) : (
                <>
                  <XCircle size={12} />
                  {lang === 'da' ? 'Ophørt' : 'Ceased'}
                </>
              )}
            </span>
            {data.companydesc && (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-slate-800 border border-slate-700/50 text-xs text-slate-300">
                <Briefcase size={11} />
                {data.companydesc}
              </span>
            )}
            {data.employees && (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-slate-800 border border-slate-700/50 text-xs text-slate-300">
                <Users size={11} />
                {data.employees} {lang === 'da' ? 'ansatte' : 'employees'}
              </span>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 -mb-px overflow-x-auto scrollbar-hide">
          {tabOrder.map((tabId) => (
            <button
              key={tabId}
              onClick={() => setAktivTab(tabId)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap ${
                aktivTab === tabId
                  ? 'border-blue-500 text-blue-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              {tabIcons[tabId]}
              {tabLabels[tabId][lang]}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Scrollable Content Area ─── */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-5">
        {/* ══ OVERSIGT ══ */}
        {aktivTab === 'oversigt' && (
          <div className="space-y-6">
            {/* Info cards grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <InfoKort
                ikon={<Briefcase size={16} className="text-blue-400" />}
                label={lang === 'da' ? 'Virksomhedsform' : 'Company type'}
                vaerdi={data.companydesc ?? '—'}
              />
              <InfoKort
                ikon={<Factory size={16} className="text-blue-400" />}
                label={lang === 'da' ? 'Branche' : 'Industry'}
                vaerdi={
                  data.industrydesc
                    ? `${data.industrydesc}${data.industrycode ? ` (${data.industrycode})` : ''}`
                    : '—'
                }
              />
              <InfoKort
                ikon={<Calendar size={16} className="text-blue-400" />}
                label={lang === 'da' ? 'Startdato' : 'Start date'}
                vaerdi={data.startdate ?? '—'}
              />
              <InfoKort
                ikon={<Users size={16} className="text-blue-400" />}
                label={lang === 'da' ? 'Antal ansatte' : 'Employees'}
                vaerdi={data.employees ?? '—'}
              />
              <InfoKort
                ikon={<CreditCard size={16} className="text-blue-400" />}
                label={lang === 'da' ? 'Kreditstatus' : 'Credit status'}
                vaerdi={data.creditstatus ?? '—'}
                ekstra={
                  data.creditstatus ? (
                    <span
                      className={`inline-block w-2 h-2 rounded-full ml-2 ${
                        data.creditstatus === 'NORMAL' ? 'bg-emerald-400' : 'bg-red-400'
                      }`}
                    />
                  ) : null
                }
              />
              {data.creditstartdate && (
                <InfoKort
                  ikon={<Calendar size={16} className="text-blue-400" />}
                  label={lang === 'da' ? 'Kreditopl. siden' : 'Credit info since'}
                  vaerdi={data.creditstartdate}
                />
              )}
              {data.enddate && (
                <InfoKort
                  ikon={<XCircle size={16} className="text-red-400" />}
                  label={lang === 'da' ? 'Ophørsdato' : 'End date'}
                  vaerdi={data.enddate}
                />
              )}
            </div>

            {/* Contact information */}
            <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
              <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                <MapPin size={16} className="text-blue-400" />
                {lang === 'da' ? 'Kontaktoplysninger' : 'Contact Information'}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                    {lang === 'da' ? 'Adresse' : 'Address'}
                  </p>
                  <p className="text-white text-sm">
                    {data.address}
                    {data.addressco ? `, ${data.addressco}` : ''}
                  </p>
                  <p className="text-slate-400 text-sm">
                    {data.zipcode} {data.city}
                  </p>
                </div>
                {data.phone && (
                  <div>
                    <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                      {lang === 'da' ? 'Telefon' : 'Phone'}
                    </p>
                    <p className="text-white text-sm flex items-center gap-1.5">
                      <Phone size={14} className="text-slate-500" />
                      {data.phone}
                    </p>
                  </div>
                )}
                {data.email && (
                  <div>
                    <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Email</p>
                    <p className="text-white text-sm flex items-center gap-1.5">
                      <Mail size={14} className="text-slate-500" />
                      {data.email}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* ══ EJERE ══ */}
        {aktivTab === 'ejere' && (
          <div className="space-y-4">
            {data.owners && data.owners.length > 0 ? (
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
                <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                  <Users size={16} className="text-blue-400" />
                  {lang === 'da' ? 'Ejere' : 'Owners'} ({data.owners.length})
                </h2>
                <ul className="space-y-2">
                  {data.owners.map((ejer, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2 text-sm text-white bg-slate-700/30 rounded-lg px-4 py-2.5"
                    >
                      <span className="w-6 h-6 rounded-full bg-blue-600/30 text-blue-400 text-xs font-medium flex items-center justify-center">
                        {i + 1}
                      </span>
                      {ejer.name}
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <div className="text-center py-12">
                <Users size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">
                  {lang === 'da' ? 'Ingen ejere registreret' : 'No owners registered'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ══ P-ENHEDER ══ */}
        {aktivTab === 'penheder' && (
          <div className="space-y-4">
            {data.productionunits && data.productionunits.length > 0 ? (
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
                <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                  <Building2 size={16} className="text-blue-400" />
                  {lang === 'da' ? 'Produktionsenheder' : 'Production Units'} (
                  {data.productionunits.length})
                </h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-500 text-xs uppercase tracking-wide border-b border-slate-700/40">
                        <th className="pb-2 pr-4">{lang === 'da' ? 'P-nummer' : 'P-number'}</th>
                        <th className="pb-2 pr-4">{lang === 'da' ? 'Navn' : 'Name'}</th>
                        <th className="pb-2 pr-4">{lang === 'da' ? 'Adresse' : 'Address'}</th>
                        <th className="pb-2 pr-4">{lang === 'da' ? 'Branche' : 'Industry'}</th>
                        <th className="pb-2">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.productionunits.map((pu) => (
                        <tr key={pu.pno} className="border-b border-slate-700/20 text-white">
                          <td className="py-2.5 pr-4 text-slate-400 font-mono text-xs">{pu.pno}</td>
                          <td className="py-2.5 pr-4">{pu.name}</td>
                          <td className="py-2.5 pr-4 text-slate-300">
                            {pu.address}, {pu.zipcode} {pu.city}
                          </td>
                          <td className="py-2.5 pr-4 text-slate-400">{pu.industrydesc ?? '—'}</td>
                          <td className="py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-xs font-medium ${
                                pu.main
                                  ? 'bg-blue-600/20 text-blue-400'
                                  : 'bg-slate-700/50 text-slate-400'
                              }`}
                            >
                              {pu.main
                                ? lang === 'da'
                                  ? 'Hoved'
                                  : 'Main'
                                : lang === 'da'
                                  ? 'Sekundær'
                                  : 'Secondary'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : (
              <div className="text-center py-12">
                <MapPin size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-400 text-sm">
                  {lang === 'da'
                    ? 'Ingen produktionsenheder registreret'
                    : 'No production units registered'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ══ ØKONOMI ══ */}
        {aktivTab === 'oekonomi' && (
          <div className="space-y-6">
            {/* Tilgængelige kreditoplysninger */}
            {(data.creditstatus || data.creditstartdate || data.employees) && (
              <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
                <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                  <CreditCard size={16} className="text-blue-400" />
                  {lang === 'da' ? 'Kreditoplysninger' : 'Credit Information'}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {data.creditstatus && (
                    <div className="bg-slate-900/40 rounded-lg p-3">
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                        {lang === 'da' ? 'Kreditstatus' : 'Credit status'}
                      </p>
                      <p className="text-white text-sm font-medium flex items-center gap-2">
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${
                            data.creditstatus === 'NORMAL' ? 'bg-emerald-400' : 'bg-red-400'
                          }`}
                        />
                        {data.creditstatus}
                      </p>
                    </div>
                  )}
                  {data.creditstartdate && (
                    <div className="bg-slate-900/40 rounded-lg p-3">
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                        {lang === 'da' ? 'Kreditoplysninger siden' : 'Credit info since'}
                      </p>
                      <p className="text-white text-sm font-medium">{data.creditstartdate}</p>
                    </div>
                  )}
                  {data.employees && (
                    <div className="bg-slate-900/40 rounded-lg p-3">
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                        {lang === 'da' ? 'Antal ansatte' : 'Employees'}
                      </p>
                      <p className="text-white text-sm font-medium">{data.employees}</p>
                    </div>
                  )}
                  {data.companydesc && (
                    <div className="bg-slate-900/40 rounded-lg p-3">
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                        {lang === 'da' ? 'Virksomhedsform' : 'Company type'}
                      </p>
                      <p className="text-white text-sm font-medium">{data.companydesc}</p>
                    </div>
                  )}
                  {data.industrycode && (
                    <div className="bg-slate-900/40 rounded-lg p-3">
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                        {lang === 'da' ? 'Branchekode (DB07)' : 'Industry code (DB07)'}
                      </p>
                      <p className="text-white text-sm font-medium">
                        {data.industrycode} — {data.industrydesc ?? ''}
                      </p>
                    </div>
                  )}
                  {data.startdate && (
                    <div className="bg-slate-900/40 rounded-lg p-3">
                      <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">
                        {lang === 'da' ? 'Stiftet' : 'Founded'}
                      </p>
                      <p className="text-white text-sm font-medium">{data.startdate}</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Link til regnskab på virk.dk */}
            <section className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6">
              <h2 className="text-white font-semibold text-base mb-4 flex items-center gap-2">
                <BarChart3 size={16} className="text-blue-400" />
                {lang === 'da' ? 'Regnskabsdata' : 'Financial Statements'}
              </h2>
              <div className="space-y-4">
                <a
                  href={`https://datacvr.virk.dk/enhed/virksomhed/${data.vat}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 bg-slate-900/40 rounded-lg p-4 hover:bg-slate-700/30 transition-colors group"
                >
                  <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                    <ExternalLink size={18} className="text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium group-hover:text-blue-300 transition-colors">
                      {lang === 'da' ? 'Se på Virk.dk' : 'View on Virk.dk'}
                    </p>
                    <p className="text-slate-500 text-xs mt-0.5">
                      {lang === 'da'
                        ? 'Årsrapporter, regnskaber og nøgletal fra Erhvervsstyrelsen'
                        : 'Annual reports, accounts and key figures from Danish Business Authority'}
                    </p>
                  </div>
                </a>

                <div className="px-4 py-3 bg-blue-500/5 border border-blue-500/10 rounded-lg">
                  <p className="text-slate-400 text-xs">
                    {lang === 'da'
                      ? 'Regnskabsdata (omsætning, resultat, egenkapital, årsrapporter) kræver system-til-system adgang til Virk.dk. Vi afventer godkendelse fra Erhvervsstyrelsen.'
                      : 'Financial data (revenue, profit, equity, annual reports) requires system-to-system access to Virk.dk. We are awaiting approval from the Danish Business Authority.'}
                  </p>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Hjælpekomponenter ────────────────────────────────────────────────────────

interface InfoKortProps {
  /** Ikon vist til venstre for label */
  ikon: React.ReactNode;
  /** Label-tekst (grå, lille) */
  label: string;
  /** Værdi-tekst (hvid, fed) */
  vaerdi: string;
  /** Ekstra element efter værdien (valgfrit) */
  ekstra?: React.ReactNode;
}

/**
 * InfoKort — Lille informationskort med ikon, label og værdi.
 * Bruges i grid-layout til at vise virksomhedsnøgletal.
 *
 * @param props - Se InfoKortProps
 */
function InfoKort({ ikon, label, vaerdi, ekstra }: InfoKortProps) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        {ikon}
        <span className="text-slate-500 text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex items-center">
        <p className="text-white font-medium text-sm">{vaerdi}</p>
        {ekstra}
      </div>
    </div>
  );
}
