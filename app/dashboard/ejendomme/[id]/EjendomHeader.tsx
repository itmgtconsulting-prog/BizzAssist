'use client';

/**
 * Header-sektion for ejendomsdetaljesiden.
 * Viser adresse, badges (ejendomstype, zone, BFE, matrikel, beskyttelser),
 * navigation til hovedejendom/SFE, og action-knapper (kort, foelg, opret sag).
 *
 * Ekstraheret fra EjendomDetaljeClient.tsx (BIZZ-1230) for at reducere fil-stoerrelse.
 */

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Bell,
  Building2,
  Home,
  MapPin,
  Map as MapIcon,
  Briefcase,
  RefreshCw,
} from 'lucide-react';
import type { DawaAdresse, DawaJordstykke } from '@/app/lib/dawa';
import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { VurderingData } from '@/app/api/vurdering/route';
import type { MatrikelEjendom } from '@/app/api/matrikel/route';
import { formatBenyttelseOgByggeaar } from '@/app/lib/benyttelseskoder';
import { isUdfasetStatusLabel, isAktivStatusLabel } from '@/app/lib/bbrKoder';
import FoelgTooltip from '@/app/components/FoelgTooltip';
import DataFreshnessBadge from '@/app/components/DataFreshnessBadge';
import FloodRiskBadge from '@/app/components/ejendomme/FloodRiskBadge';
import type { DomainMembership } from '@/app/hooks/useDomainMemberships';

type Tab =
  | 'overblik'
  | 'bbr'
  | 'ejerforhold'
  | 'tinglysning'
  | 'oekonomi'
  | 'skatter'
  | 'dokumenter';

/** Props for EjendomHeader */
export interface EjendomHeaderProps {
  id: string;
  da: boolean;
  lang: 'da' | 'en';
  adresseStreng: string;
  dawaAdresse: DawaAdresse;
  dawaJordstykke: DawaJordstykke | null;
  bbrData: EjendomApiResponse | null;
  vurdering: VurderingData | null;
  matrikelData: MatrikelEjendom | null;
  esrNummer: string | null;
  erKolonihave: boolean;
  strukturTree: import('@/app/api/ejendom-struktur/route').StrukturNode | null;
  /** BIZZ-1333: True mens strukturdata hentes */
  strukturLoader?: boolean;
  erFulgt: boolean;
  foelgToggling: boolean;
  visFoelgTooltip: boolean;
  setVisFoelgTooltip: (v: boolean) => void;
  onToggleFoelg: () => void;
  visKort: boolean;
  kortPanelAaben: boolean;
  onToggleKortPanel: () => void;
  onOpenMobilKort: () => void;
  domainMemberships: DomainMembership[];
  onOpretSag: () => void;
  bbrFromCache: boolean;
  bbrSyncedAt: string | null;
  bbrRefreshing: boolean;
  onBbrRefresh: () => void;
  aktivTab: Tab;
  setAktivTab: (tab: Tab) => void;
  tabs: { id: Tab; label: string; ikon: React.ReactNode }[];
  lejligheder: import('@/app/api/ejerlejligheder/route').Ejerlejlighed[] | null;
  t: {
    back: string;
    following: string;
    follow: string;
    protectedForest: string;
    coastalProtection: string;
    duneProtection: string;
    groundRent: string;
  };
}

/**
 * Header med adresse, badges, action-knapper og tab-bar.
 *
 * @param props - Se EjendomHeaderProps
 * @returns Header JSX
 */
export default function EjendomHeader(props: EjendomHeaderProps) {
  const {
    id: _id,
    da,
    lang,
    adresseStreng,
    dawaAdresse,
    dawaJordstykke,
    bbrData,
    vurdering,
    matrikelData,
    esrNummer,
    erKolonihave,
    strukturTree,
    strukturLoader,
    erFulgt,
    foelgToggling,
    visFoelgTooltip,
    setVisFoelgTooltip,
    onToggleFoelg,
    visKort,
    kortPanelAaben,
    onToggleKortPanel,
    onOpenMobilKort,
    domainMemberships,
    onOpretSag,
    bbrFromCache,
    bbrSyncedAt,
    bbrRefreshing,
    onBbrRefresh,
    aktivTab,
    setAktivTab,
    tabs,
    lejligheder,
    t,
  } = props;

  const router = useRouter();

  return (
    <div className="px-3 sm:px-6 pt-5 pb-0 border-b border-slate-700/50 bg-slate-900/30 relative z-20">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => router.push('/dashboard/ejendomme')}
          className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
        >
          <ArrowLeft size={16} /> {t.back}
        </button>
        <div className="flex items-center gap-2">
          {/* Kort-toggle knap — aabner overlay paa mobil, toggle sidepanel paa desktop */}
          <button
            onClick={() => {
              if (visKort) {
                onToggleKortPanel();
              } else {
                onOpenMobilKort();
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-sm transition-all ${
              visKort && kortPanelAaben
                ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
            }`}
            title={da ? 'Vis/skjul kort' : 'Show/hide map'}
          >
            <MapIcon size={14} />
            {da ? 'Kort' : 'Map'}
          </button>

          <div
            className="relative"
            onMouseEnter={() => !erFulgt && setVisFoelgTooltip(true)}
            onMouseLeave={() => setVisFoelgTooltip(false)}
          >
            <button
              disabled={foelgToggling}
              onClick={onToggleFoelg}
              className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                erFulgt
                  ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                  : 'bg-slate-800 hover:bg-slate-700 border-slate-700/60 text-slate-300'
              }`}
              aria-label={
                erFulgt
                  ? da
                    ? 'Stop med at følge ejendom'
                    : 'Unfollow property'
                  : da
                    ? 'Følg ejendom'
                    : 'Follow property'
              }
              aria-pressed={erFulgt}
            >
              <Bell size={14} className={erFulgt ? 'fill-blue-400 text-blue-400' : ''} />
              {erFulgt ? t.following : t.follow}
            </button>
            <FoelgTooltip lang={da ? 'da' : 'en'} visible={visFoelgTooltip} />
          </div>
          {/* BIZZ-1239: Annonce-knap fjernet — funktionalitet er nu i /dashboard/analyse/annonce */}
          {/* BIZZ-808: Opret sag-knap — kun synlig for domain-brugere */}
          {domainMemberships.length > 0 && (
            <button
              type="button"
              onClick={onOpretSag}
              className="flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-all bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-300"
              aria-label={da ? 'Opret sag for denne ejendom' : 'Create case for this property'}
            >
              <Briefcase size={14} />
              {da ? 'Opret sag' : 'Create case'}
            </button>
          )}
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center gap-3">
          <h1 className="text-white text-xl font-bold">{adresseStreng}</h1>
          {/* BIZZ-728: Child unit — link til hovedejendom */}
          {bbrData?.parentAdgangsadresseId && !!dawaAdresse?.etage && (
            <button
              onClick={async () => {
                if (bbrData.moderBfe) {
                  try {
                    const jsRes = await fetch(`/api/adresse/jordstykke?bfe=${bbrData.moderBfe}`);
                    if (jsRes.ok) {
                      const js = await jsRes.json();
                      if (js?.adgangsadresseId) {
                        router.push(`/dashboard/ejendomme/${js.adgangsadresseId}`);
                        return;
                      }
                    }
                  } catch {
                    /* fall through to adgangsadresse */
                  }
                }
                router.push(`/dashboard/ejendomme/${bbrData.parentAdgangsadresseId}`);
              }}
              className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium hover:bg-amber-500/25 transition-colors flex-shrink-0"
              title={
                lang === 'da'
                  ? bbrData.moderBfe
                    ? `Gå til hovedejendommen (BFE ${bbrData.moderBfe})`
                    : 'Gå til hovedejendommen (bygning/adgangsadresse)'
                  : bbrData.moderBfe
                    ? `Go to parent property (BFE ${bbrData.moderBfe})`
                    : 'Go to parent property (building/address)'
              }
            >
              <Building2 size={12} />
              {da ? 'Gå til hovedejendom' : 'Go to main property'}
            </button>
          )}
          {/* Moderejandom: klikbar SFE-knap eller statisk badge */}
          {bbrData?.ejerlejlighedBfe &&
            !dawaAdresse?.etage &&
            (strukturTree?.niveau === 'sfe' && strukturTree.dawaId ? (
              <button
                onClick={() => {
                  router.push(`/dashboard/ejendomme/${strukturTree.dawaId}`);
                }}
                className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium hover:bg-amber-500/25 transition-colors flex-shrink-0"
                title={
                  da
                    ? `Gå til SFE-ejendommen (BFE ${strukturTree.bfe})`
                    : `Go to SFE property (BFE ${strukturTree.bfe})`
                }
              >
                <Building2 size={12} />
                {da ? 'Gå til SFE ejendom' : 'Go to SFE property'}
              </button>
            ) : (
              <span
                className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-xs font-medium flex-shrink-0"
                title={
                  da
                    ? `Denne ejendom er en hovedejendom (BFE ${bbrData.moderBfe ?? bbrData.ejerlejlighedBfe})`
                    : `This property is a main property (BFE ${bbrData.moderBfe ?? bbrData.ejerlejlighedBfe})`
                }
              >
                <Building2 size={12} />
                {da ? 'Hovedejendom' : 'Main property'}
              </span>
            ))}
          {bbrData?.ejerlejlighedBfe && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-purple-500/15 border border-purple-500/30 rounded-full text-purple-400 text-[10px] font-medium flex-shrink-0">
              {lang === 'da' ? 'Ejerlejlighed' : 'Condominium'}
            </span>
          )}
          {/* BIZZ-550: Ejendomstype-badge */}
          {(() => {
            // 0. BBR kolonihave override (mest specifik + authoritative)
            if (erKolonihave) {
              return (
                <span
                  className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 rounded-full text-emerald-300 text-xs font-medium flex-shrink-0"
                  title={
                    da
                      ? 'Kolonihave/fritidshytte — BBR-anvendelseskode 520 eller 540'
                      : 'Allotment/summer house — BBR use-code 520 or 540'
                  }
                >
                  <Home size={11} />
                  {da ? 'Kolonihave' : 'Allotment'}
                </span>
              );
            }
            // 1. VUR juridiskKategori (nyt vurderingssystem)
            if (vurdering?.juridiskKategori) {
              return (
                <span className="flex items-center gap-1 px-2.5 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded-full text-blue-300 text-xs font-medium flex-shrink-0">
                  <Home size={11} />
                  {vurdering.juridiskKategori}
                </span>
              );
            }
            // 2. Udled fra BBR bygningsanvendelser
            const bygninger = bbrData?.bbr?.filter((b) => isAktivStatusLabel(b.status));
            if (!bygninger?.length) return null;
            let harBolig = false;
            let harErhverv = false;
            for (const b of bygninger) {
              const a = b.anvendelse.toLowerCase();
              if (
                a.includes('bolig') ||
                a.includes('enfamilie') ||
                a.includes('rækkehus') ||
                a.includes('kædehus') ||
                a.includes('dobbelthus') ||
                a.includes('beboelse') ||
                a.includes('kollegium') ||
                a.includes('stuehus') ||
                a.includes('fritliggende')
              ) {
                harBolig = true;
              } else if (
                a.includes('kontor') ||
                a.includes('handel') ||
                a.includes('lager') ||
                a.includes('erhverv') ||
                a.includes('industri') ||
                a.includes('fabrik') ||
                a.includes('værksted') ||
                a.includes('butik') ||
                a.includes('hotel') ||
                a.includes('produktion') ||
                a.includes('transport')
              ) {
                harErhverv = true;
              }
            }
            const kategori =
              harBolig && harErhverv
                ? 'Blandet bolig/erhverv'
                : harErhverv
                  ? 'Erhvervsejendom'
                  : harBolig
                    ? 'Beboelsesejendom'
                    : null;
            if (!kategori) return null;
            return (
              <span className="flex items-center gap-1 px-2.5 py-0.5 bg-blue-500/15 border border-blue-500/30 rounded-full text-blue-300 text-xs font-medium flex-shrink-0">
                <Home size={11} />
                {kategori}
              </span>
            );
          })()}
          {/* BIZZ-457: Benyttelse (VUR) + byggeaar (BBR) */}
          {(() => {
            const nyesteByg = bbrData?.bbr?.reduce<number | null>((latest, b) => {
              if (b.opfoerelsesaar == null) return latest;
              if (latest == null || b.opfoerelsesaar > latest) return b.opfoerelsesaar;
              return latest;
            }, null);
            const label = formatBenyttelseOgByggeaar(
              vurdering?.benyttelseskode ?? null,
              nyesteByg ?? null,
              dawaAdresse?.zone ?? null,
              !!bbrData?.ejerlejlighedBfe
            );
            if (!label) return null;
            return (
              <span className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 rounded-full text-emerald-300 text-xs font-medium flex-shrink-0">
                {label}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {/* BIZZ-854: Ejendomstype-badge */}
          {(() => {
            const erModer = !dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
            const erEjerlej = !!dawaAdresse?.etage && !!bbrData?.ejerlejlighedBfe;
            const currentBfeNum =
              bbrData?.ejerlejlighedBfe ??
              bbrData?.moderBfe ??
              bbrData?.ejendomsrelationer?.[0]?.bfeNummer;
            const erSfe =
              erModer && strukturTree?.niveau === 'sfe' && currentBfeNum === strukturTree.bfe;
            if (erModer)
              return (
                <span
                  className="flex items-center gap-1 px-2.5 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded-full text-amber-300 text-xs font-medium flex-shrink-0"
                  title={
                    da
                      ? erSfe
                        ? 'Samlet Fast Ejendom — matrikel-niveau ejendom'
                        : 'Hovedejendom under en SFE'
                      : erSfe
                        ? 'Collective Real Property — cadastral-level property'
                        : 'Main property under an SFE'
                  }
                >
                  <Building2 size={11} />
                  {erSfe
                    ? da
                      ? 'Hovedejendom (SFE)'
                      : 'Main property (SFE)'
                    : da
                      ? 'Hovedejendom'
                      : 'Main property'}
                </span>
              );
            if (erEjerlej)
              return (
                <span
                  className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-300 text-xs font-medium flex-shrink-0"
                  title={
                    da
                      ? 'Ejerlejlighed under en hovedejendom'
                      : 'Condominium unit under a main property'
                  }
                >
                  <Home size={11} />
                  {da ? 'Ejerlejlighed' : 'Condominium'}
                </span>
              );
            return null;
          })()}
          <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
            <MapPin size={11} />
            {(dawaAdresse.kommunenavn || null) ?? dawaJordstykke?.kommune.navn ?? '–'}
          </span>
          {/* BIZZ-508: Supplerende bynavn */}
          {dawaAdresse.supplerendebynavn && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-400">
              {dawaAdresse.supplerendebynavn}
            </span>
          )}
          {dawaJordstykke && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
              <Building2 size={11} /> {dawaJordstykke.matrikelnr}, {dawaJordstykke.ejerlav.navn}
            </span>
          )}
          {/* BIZZ-498: zone-badge */}
          {dawaAdresse.zone && dawaAdresse.zone !== 'Udfaset' && (
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                dawaAdresse.zone === 'Byzone'
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : dawaAdresse.zone === 'Landzone'
                    ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                    : dawaAdresse.zone === 'Sommerhuszone'
                      ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
                      : 'bg-slate-800 border-slate-700/50 text-slate-300'
              }`}
              title={
                da ? 'Zone-klassifikation fra Plandata.dk' : 'Zone classification from Plandata.dk'
              }
            >
              {dawaAdresse.zone}
            </span>
          )}
          {bbrData?.ejendomsrelationer?.[0]?.bfeNummer && (
            <span className="px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
              BFE: {bbrData.ejendomsrelationer[0].bfeNummer}
            </span>
          )}
          {esrNummer && (
            <span className="px-2 py-0.5 bg-slate-800 border border-slate-700/50 rounded-full text-xs text-slate-300">
              ESR: {esrNummer}
            </span>
          )}
          {/* BIZZ-496: Frednings/beskyttelses-badges fra matrikeldata */}
          {matrikelData?.jordstykker?.some((js) => js.fredskov) && (
            <span className="px-2 py-0.5 bg-green-900/50 border border-green-800/40 rounded-full text-[10px] font-semibold text-green-400">
              {t.protectedForest}
            </span>
          )}
          {matrikelData?.jordstykker?.some((js) => js.strandbeskyttelse) && (
            <span className="px-2 py-0.5 bg-blue-900/50 border border-blue-800/40 rounded-full text-[10px] font-semibold text-blue-400">
              {t.coastalProtection}
            </span>
          )}
          {matrikelData?.jordstykker?.some((js) => js.klitfredning) && (
            <span className="px-2 py-0.5 bg-amber-900/50 border border-amber-800/40 rounded-full text-[10px] font-semibold text-amber-400">
              {t.duneProtection}
            </span>
          )}
          {matrikelData?.jordstykker?.some((js) => js.jordrente) && (
            <span className="px-2 py-0.5 bg-purple-900/50 border border-purple-800/40 rounded-full text-[10px] font-semibold text-purple-400">
              {t.groundRent}
            </span>
          )}
          {/* BIZZ-919: Data freshness badge + refresh */}
          <DataFreshnessBadge fromCache={bbrFromCache} syncedAt={bbrSyncedAt} lang={lang} />
          <button
            onClick={onBbrRefresh}
            disabled={bbrRefreshing}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] text-slate-400 hover:text-blue-400 bg-slate-700/30 border border-slate-700/40 hover:border-blue-500/30 transition-colors disabled:opacity-50"
            aria-label={lang === 'da' ? 'Genindlæs data' : 'Refresh data'}
            title={lang === 'da' ? 'Genindlæs data' : 'Refresh data'}
          >
            <RefreshCw size={9} className={bbrRefreshing ? 'animate-spin' : ''} />
          </button>
          {/* BIZZ-948: Oversvømmelsesrisiko-badge */}
          <FloodRiskBadge lat={dawaAdresse?.y ?? null} lng={dawaAdresse?.x ?? null} lang={lang} />
        </div>
      </div>

      {/* BIZZ-725 / BIZZ-787: Info banner for udfasede ejendomme */}
      <UdfasetBanner da={da} bbrData={bbrData} dawaJordstykke={dawaJordstykke} />

      {/* BIZZ-832: Soester-enheder — skjules naar ejendomsstruktur er tilgaengelig */}
      <SoesterEnheder
        da={da}
        dawaAdresse={dawaAdresse}
        bbrData={bbrData}
        strukturTree={strukturTree}
        strukturLoader={strukturLoader}
        lejligheder={lejligheder}
      />

      {/* Tabs */}
      <div role="tablist" className="flex gap-1 -mb-px overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={aktivTab === tab.id}
            onClick={() => setAktivTab(tab.id)}
            className={`flex items-center gap-1 px-2 py-1.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
              aktivTab === tab.id
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600'
            }`}
          >
            {tab.ikon}
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Udfaset-ejendom info-banner. Vises naar ALLE bygninger er nedrevet/slettet.
 */
function UdfasetBanner({
  da,
  bbrData,
  dawaJordstykke,
}: {
  da: boolean;
  bbrData: EjendomApiResponse | null;
  dawaJordstykke: DawaJordstykke | null;
}) {
  const router = useRouter();
  const bygninger = bbrData?.bbr;
  const erUdfasetEjendom =
    !!bygninger && bygninger.length > 0 && bygninger.every((b) => isUdfasetStatusLabel(b.status));

  if (!erUdfasetEjendom) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 px-4 py-3 bg-amber-900/20 border border-amber-700/40 rounded-lg"
    >
      <Building2 size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-amber-200 text-sm font-medium">
          {da ? 'Udfaset ejendom' : 'Retired property'}
        </p>
        <p className="text-amber-100/70 text-xs mt-1 leading-relaxed">
          {da
            ? 'Alle bygninger på denne ejendom er registreret som nedrevet eller bortfaldet i BBR. Matriklen kan være sammenlagt eller ejendommen genopført under et nyt BFE-nummer.'
            : 'All buildings on this property are registered as demolished or withdrawn in BBR. The matrikel may have been merged or the property rebuilt under a new BFE number.'}
        </p>
        {dawaJordstykke && (
          <button
            onClick={() => {
              const params = new URLSearchParams({
                type: 'matrikel',
                ejerlavKode: String(dawaJordstykke.ejerlav.kode ?? ''),
                matrikelnr: String(dawaJordstykke.matrikelnr ?? ''),
              });
              if (dawaJordstykke.ejerlav.navn) {
                params.set('ejerlavNavn', dawaJordstykke.ejerlav.navn);
              }
              router.push(`/dashboard/search?${params.toString()}`);
            }}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-md text-amber-300 text-xs font-medium hover:bg-amber-500/25 transition-colors"
          >
            <Building2 size={11} />
            {da ? 'Find andre ejendomme på matriklen' : 'Find other properties on matrikel'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Soester-enheder sektion — viser sibling ejerlejligheder for child-units.
 * Skjules naar strukturTree er tilgaengeligt (redundant info).
 */
function SoesterEnheder({
  da,
  dawaAdresse,
  bbrData,
  strukturTree,
  strukturLoader,
  lejligheder,
}: {
  da: boolean;
  dawaAdresse: DawaAdresse;
  bbrData: EjendomApiResponse | null;
  strukturTree: import('@/app/api/ejendom-struktur/route').StrukturNode | null;
  strukturLoader?: boolean;
  lejligheder: import('@/app/api/ejerlejligheder/route').Ejerlejlighed[] | null;
}) {
  // BIZZ-1333: Skjul også mens strukturtræ loader — forhindrer flash
  if (strukturTree || strukturLoader) return null;
  if (!dawaAdresse?.etage) return null;
  if (!lejligheder || lejligheder.length <= 1) return null;

  const siblings = lejligheder.filter(
    (l) =>
      l.adresse !==
      `${dawaAdresse?.vejnavn} ${dawaAdresse?.husnr}, ${dawaAdresse?.etage ?? ''}${dawaAdresse?.dør ? `. ${dawaAdresse.dør}` : ''}`
  );
  if (siblings.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-700/50 bg-[#0f172a] p-3 space-y-2">
      <h3 className="text-slate-400 text-xs font-medium uppercase tracking-wide flex items-center gap-1.5">
        <Building2 size={12} />
        {da ? 'Søster-enheder' : 'Sibling units'}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {siblings.slice(0, 20).map((sib) => {
          const sibHref = sib.dawaId
            ? `/dashboard/ejendomme/${sib.dawaId}`
            : `/dashboard/ejendomme/${sib.bfe}`;
          const husnr = dawaAdresse?.husnr ?? '';
          const label = [husnr, sib.etage, sib.doer].filter(Boolean).join(', ');
          return (
            <Link
              key={sib.bfe}
              href={sibHref}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800/80 border border-slate-700/40 text-slate-300 text-xs hover:border-blue-500/40 hover:text-white transition-colors"
            >
              {label || `BFE ${sib.bfe}`}
            </Link>
          );
        })}
        {siblings.length > 20 && bbrData?.parentAdgangsadresseId && (
          <Link
            href={`/dashboard/ejendomme/${bbrData.parentAdgangsadresseId}`}
            className="text-blue-400 hover:text-blue-300 text-xs self-center"
          >
            +{siblings.length - 20}{' '}
            {da ? 'mere — gå til hovedejendom' : 'more — go to main property'}
          </Link>
        )}
        {siblings.length > 20 && !bbrData?.parentAdgangsadresseId && (
          <span className="text-slate-400 text-xs self-center">
            +{siblings.length - 20} {da ? 'mere' : 'more'}
          </span>
        )}
      </div>
    </div>
  );
}
