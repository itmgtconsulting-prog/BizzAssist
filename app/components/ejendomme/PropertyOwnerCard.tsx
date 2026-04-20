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
import {
  Home,
  ExternalLink,
  Building2,
  TrendingUp,
  User,
  ShoppingCart,
  Map as MapIcon,
} from 'lucide-react';
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
 * BIZZ-577: Tilføjet etage-fallback — når VP returnerer juridiskKategori
 * "Ejerbolig til vurdering i lige år" men ejendommen har etage/dør, er
 * det reelt en ejerlejlighed. Etage-tilstedeværelse er stærkere signal end
 * juridiskKategori-string for sub-BFE'er.
 *
 * @param type  - Rå ejendomstype fra DAWA / VP juridiskKategori
 * @param etage - DAWA etage (når sat = ejerlejlighed)
 */
function mapEjendomstype(
  type: string | null,
  etage?: string | null
): { label: string; color: string } {
  if (etage && etage.length > 0)
    return { label: 'Ejerlejlighed', color: 'text-purple-300 bg-purple-900/40' };
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
  /**
   * BIZZ-569: Pre-enriched data fra parent (typisk via batch-enrich endpoint).
   * Hvis sat, skipper kortet sin egen per-card fetch — eliminerer N round-trips
   * når mange kort renderes samtidigt på fx virksomhedssidens Ejendomme-tab.
   */
  preEnriched?: {
    areal: number | null;
    vurdering: number | null;
    vurderingsaar: number | null;
    /** BIZZ-575: True når 'vurdering' er grundværdi (ejendomsværdi var 0) */
    erGrundvaerdi?: boolean;
    ejerNavn: string | null;
    koebesum: number | null;
    koebsdato: string | null;
    boligAreal: number | null;
    erhvervsAreal: number | null;
    matrikelAreal: number | null;
  } | null;
}

/**
 * PropertyOwnerCard — Redesigned med progressiv berigelse.
 * Viser adresse + badges straks, beriger med areal/vurdering/ejer i baggrunden.
 */
export default function PropertyOwnerCard({
  ejendom,
  showOwner = false,
  lang,
  preEnriched,
}: PropertyOwnerCardProps) {
  const { label: typeLabel, color: typeColor } = mapEjendomstype(
    ejendom.ejendomstype,
    ejendom.etage
  );
  const da = lang === 'da';

  // Progressive enrichment state. BIZZ-465 extends with koebesum + koebsdato
  // så nuværende kort kan vise seneste handel uden ekstra UI-kald.
  const [enriched, setEnriched] = useState<{
    areal: number | null;
    vurdering: number | null;
    vurderingsaar: number | null;
    erGrundvaerdi?: boolean;
    ejerNavn: string | null;
    koebesum: number | null;
    koebsdato: string | null;
    boligAreal: number | null;
    erhvervsAreal: number | null;
    matrikelAreal: number | null;
  } | null>(
    // BIZZ-569: Brug preEnriched fra parent hvis sat — undgår per-card fetch.
    preEnriched
      ? preEnriched
      : ejendom.areal != null
        ? {
            areal: ejendom.areal,
            vurdering: ejendom.vurdering ?? null,
            vurderingsaar: ejendom.vurderingsaar ?? null,
            ejerNavn: ejendom.ejerNavn ?? null,
            koebesum: ejendom.koebesum ?? null,
            koebsdato: ejendom.koebsdato ?? null,
            boligAreal: ejendom.boligAreal ?? null,
            erhvervsAreal: ejendom.erhvervsAreal ?? null,
            matrikelAreal: ejendom.matrikelAreal ?? null,
          }
        : null
  );

  // Sync preEnriched-prop til state hvis den dukker op senere (parent kan
  // levere data asynkront efter første render).
  useEffect(() => {
    if (preEnriched && !enriched) setEnriched(preEnriched);
  }, [preEnriched, enriched]);

  useEffect(() => {
    if (enriched) return; // Already have data
    if (preEnriched !== undefined) return; // Parent håndterer enrichment
    let ignore = false;
    // BIZZ-569: Send dawaId med så enrich-endpoint kan slå BBR-areal op
    // direkte (uden dawaId returneres null for bolig/erhverv m²).
    const url = ejendom.dawaId
      ? `/api/ejendomme-by-owner/enrich?bfe=${ejendom.bfeNummer}&dawaId=${ejendom.dawaId}`
      : `/api/ejendomme-by-owner/enrich?bfe=${ejendom.bfeNummer}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!ignore && d) setEnriched(d);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [ejendom.bfeNummer, ejendom.dawaId, enriched, preEnriched]);

  const detailHref = ejendom.dawaId ? `/dashboard/ejendomme/${ejendom.dawaId}` : null;
  /* BIZZ-551: Append etage + dør for ejerlejligheder (e.g. "Vej 10A, 3. tv") */
  const adresselinje = ejendom.adresse
    ? ejendom.etage
      ? `${ejendom.adresse}, ${ejendom.etage}.${ejendom.doer ? ` ${ejendom.doer}` : ''}`
      : ejendom.adresse
    : `BFE ${formatBfe(ejendom.bfeNummer)}`;
  const postalLinje =
    ejendom.postnr && ejendom.by ? `${ejendom.postnr} ${ejendom.by}` : (ejendom.kommune ?? null);

  // BIZZ-455: Dim sold properties
  const aktiv = ejendom.aktiv !== false;
  // BIZZ-454: Green accent for property cards (matches diagram property color)
  const CardContent = (
    <div
      className={`group relative flex flex-col bg-slate-800/60 border rounded-xl overflow-hidden transition-all duration-150 ${
        aktiv
          ? 'border-slate-700/50 hover:border-emerald-500/40 hover:bg-slate-800/80'
          : 'border-slate-700/30 bg-slate-800/30 opacity-60 hover:opacity-80 hover:border-slate-600/40'
      }`}
    >
      {/* Top stripe — green for active, slate for sold */}
      <div
        className={`h-1 flex-shrink-0 ${
          aktiv
            ? 'bg-gradient-to-r from-emerald-600/60 to-emerald-500/20'
            : 'bg-gradient-to-r from-slate-600/40 to-slate-500/10'
        }`}
      />

      <div className="p-4 flex flex-col gap-2.5 flex-1">
        {/* Adresse — hovedtekst. BIZZ-465: Home-ikon (ejendoms-kontekst) */}
        <div className="flex items-start gap-2">
          <Home
            size={14}
            className={`mt-0.5 flex-shrink-0 ${aktiv ? 'text-emerald-500' : 'text-slate-500'}`}
          />
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
          {/* BIZZ-596: Vis ejerandel når den IKKE er 100% — signalerer
              medejerskab (fx 50% delt med ægtefælle). Skjult når 100% for
              at holde kortet visuelt roligt (standard tilfælde). */}
          {ejendom.ejerandel && ejendom.ejerandel !== '100%' && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold text-purple-300 bg-purple-500/15 border border-purple-500/30"
              title={da ? 'Din andel af ejendommen' : 'Your share of the property'}
            >
              {ejendom.ejerandel}
            </span>
          )}
          {ejendom.kommune && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-slate-500 bg-slate-900/40">
              {ejendom.kommune}
            </span>
          )}
        </div>

        {/* BIZZ-397/465/569/575: Enriched data — areal, vurdering, køb, ejer, m²-felter */}
        {enriched && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 border-t border-slate-700/30">
            {/* BIZZ-575 v3: Vis ALTID Bolig, Erhverv og Matrikel rækker så
                kortene har konsistent layout — værdien er "0 m²" når data
                mangler. Det gør det nemt at sammenligne på tværs af kort. */}
            <div
              className="flex items-center gap-1.5"
              title={da ? 'Bolig-areal fra BBR' : 'Residential area from BBR'}
            >
              <Home size={10} className="text-slate-500" />
              <span className="text-slate-300 text-[11px]">
                <span className="text-slate-500">{da ? 'Bolig:' : 'Resi:'}</span>{' '}
                {(enriched.boligAreal ?? 0).toLocaleString('da-DK')} m²
              </span>
            </div>
            <div
              className="flex items-center gap-1.5"
              title={da ? 'Erhvervs-areal fra BBR' : 'Commercial area from BBR'}
            >
              <Building2 size={10} className="text-slate-500" />
              <span className="text-slate-300 text-[11px]">
                <span className="text-slate-500">{da ? 'Erhv:' : 'Comm:'}</span>{' '}
                {(enriched.erhvervsAreal ?? 0).toLocaleString('da-DK')} m²
              </span>
            </div>
            <div
              className="flex items-center gap-1.5"
              title={da ? 'Matrikel-areal fra DAWA' : 'Cadastral area from DAWA'}
            >
              <MapIcon size={10} className="text-slate-500" />
              <span className="text-slate-300 text-[11px]">
                <span className="text-slate-500">{da ? 'Matr:' : 'Cad:'}</span>{' '}
                {(enriched.matrikelAreal ?? 0).toLocaleString('da-DK')} m²
              </span>
            </div>
            {/* BIZZ-556: Eksplicit "Vurdering"-label så brugeren ved om tallet er vurdering, købesum eller grundværdi */}
            {/* BIZZ-569: Foreløbig vurdering fremhæves med GUL tekst-farve så
                  brugeren straks kan se at det er en ikke-endelig vurdering.
                  BIZZ-575: Vis "Grundv." label når vi viser grundværdi i
                  stedet for ejendomsværdi (typisk for erhverv hvor
                  ejendomsværdi=0). */}
            {enriched.vurdering && (
              <div
                className="flex items-center gap-1.5"
                title={
                  enriched.erGrundvaerdi
                    ? da
                      ? 'Foreløbig grundværdi (ejendomsværdi er 0 — typisk erhverv)'
                      : 'Preliminary land value (property value is 0 — typically commercial)'
                    : da
                      ? 'Foreløbig ejendomsvurdering fra Vurderingsstyrelsen'
                      : 'Preliminary property valuation'
                }
              >
                <TrendingUp size={10} className="text-amber-400" aria-hidden="true" />
                <span className="text-amber-300 text-[11px]">
                  <span className="text-amber-500/80">
                    {enriched.erGrundvaerdi ? (da ? 'Grundv.' : 'Land:') : da ? 'Vurd.' : 'Val.'}:
                  </span>{' '}
                  {formatDkkShort(enriched.vurdering)} DKK
                  {enriched.vurderingsaar && (
                    <span className="text-amber-500/70 ml-0.5">({enriched.vurderingsaar})</span>
                  )}
                </span>
              </div>
            )}
            {/* BIZZ-465: Købspris + -dato fra seneste handel (EJF Ejerskifte).
                BIZZ-575 v4: Vis ALTID rækken — "—" når ingen handel er
                registreret, så layoutet er konsistent på tværs af kort. */}
            <div
              className="flex items-center gap-1.5 col-span-2"
              title={
                da
                  ? 'Seneste købesum fra tinglysning (EJF Ejerskifte)'
                  : 'Latest purchase price from land registry (EJF Ejerskifte)'
              }
            >
              <ShoppingCart size={10} className="text-slate-500" aria-hidden="true" />
              <span className="text-slate-300 text-[11px]">
                <span className="text-slate-500">{da ? 'Købt' : 'Purchased'}:</span>{' '}
                {enriched.koebesum != null && enriched.koebesum > 0 ? (
                  <>
                    {formatDkkShort(enriched.koebesum)} DKK
                    {enriched.koebsdato && (
                      <span className="text-slate-500 ml-0.5">
                        (
                        {new Date(enriched.koebsdato).toLocaleDateString('da-DK', {
                          year: 'numeric',
                          month: 'short',
                        })}
                        )
                      </span>
                    )}
                  </>
                ) : enriched.koebsdato ? (
                  // BIZZ-575 v5: Handel registreret men uden pris-oplysning
                  // (typisk arv/gave/tvangsauktion eller ældre handel uden
                  // tinglyst købspris). Vis dato så brugeren ved at der HAR
                  // været en transaktion.
                  <span className="text-slate-400">
                    {da ? 'Overtaget' : 'Acquired'}{' '}
                    {new Date(enriched.koebsdato).toLocaleDateString('da-DK', {
                      year: 'numeric',
                      month: 'short',
                    })}{' '}
                    <span className="text-slate-600">
                      ({da ? 'pris ej oplyst' : 'price not disclosed'})
                    </span>
                  </span>
                ) : (
                  <span className="text-slate-600">{da ? '— ingen handel' : '— no sale'}</span>
                )}
              </span>
            </div>
            {/* BIZZ-556: Eksplicit "Ejer"-label så brugeren ikke er i tvivl om navnet er ejer, administrator eller bygherre */}
            {enriched.ejerNavn && (
              <div
                className="flex items-center gap-1.5 col-span-2"
                title={da ? 'Tinglyst ejer' : 'Registered owner'}
              >
                <User size={10} className="text-slate-500" aria-hidden="true" />
                <span className="text-slate-400 text-[11px] truncate">
                  <span className="text-slate-500">{da ? 'Ejer' : 'Owner'}:</span>{' '}
                  {enriched.ejerNavn}
                </span>
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

      {/*
        BIZZ-464: "Se detaljer"-pillen er fjernet — hele kortet er allerede
        klikbart via den ydre Link-wrapper. Solgt-badge og "DAWA-id mangler"
        beholdes da de bærer ekstra information. En subtil ExternalLink-ikon
        i øverste højre hjørne (fader ind på hover) signalerer stadig at
        kortet kan klikkes.
      */}
      {!aktiv ? (
        <div className="px-4 pb-3 pt-0">
          <span className="flex items-center justify-between w-full px-3 py-1.5 rounded-lg bg-slate-700/30 text-slate-400 text-[10px] font-medium">
            <span>{da ? 'Solgt' : 'Sold'}</span>
            {ejendom.solgtDato && (
              <span className="text-slate-500 text-[9px]">
                {new Date(ejendom.solgtDato).toLocaleDateString('da-DK', {
                  year: 'numeric',
                  month: 'short',
                })}
              </span>
            )}
          </span>
        </div>
      ) : !detailHref ? (
        <div className="px-4 pb-3 pt-0">
          <span className="flex items-center w-full px-3 py-1.5 rounded-lg bg-slate-900/40 text-slate-500 text-[10px]">
            {da ? 'DAWA-id mangler' : 'DAWA id missing'}
          </span>
        </div>
      ) : null}

      {/* Hover affordance — kun på aktive, klikbare kort */}
      {aktiv && detailHref && (
        <ExternalLink
          size={11}
          className="absolute top-3 right-3 text-slate-600 opacity-0 group-hover:opacity-100 group-hover:text-emerald-400 transition-opacity pointer-events-none"
          aria-hidden="true"
        />
      )}
    </div>
  );

  // Wrap in Link if detail page available
  if (detailHref) {
    const ariaLabel = da
      ? `Se detaljer for ${ejendom.adresse ?? `BFE ${ejendom.bfeNummer}`}`
      : `View details for ${ejendom.adresse ?? `BFE ${ejendom.bfeNummer}`}`;
    return (
      <Link href={detailHref} className="block" aria-label={ariaLabel}>
        {CardContent}
      </Link>
    );
  }
  return CardContent;
}
