/**
 * EjendomEjerforeningFinder — AI-baseret ejerforenings-lookup for ejerlejligheder.
 *
 * Vises på ejerskabs-fanen når ingen administrator er registreret i EJF.
 * Brugeren klikker "Find ejerforening via AI" → API finder kandidater baseret
 * på nabo-ejendommes administratorer + Claude-evaluering.
 *
 * Resultater kan crowdsource-verificeres med 👍/👎 (samme mønster som
 * VerifiedLinks.tsx). Alle brugere ser aggregerede counts.
 *
 * AI token-forbrug tilskrives brugeren via assertAiAllowed + recordAiUsage.
 *
 * @module app/components/ejendomme/EjendomEjerforeningFinder
 */

'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import {
  Search,
  Loader2,
  Building2,
  ThumbsUp,
  ThumbsDown,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { logger } from '@/app/lib/logger';

/** Kandidat fra /api/ai/find-ejerforening */
interface Kandidat {
  cvr: string;
  navn: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  administeredCount: number;
}

/** Verificerings-state per kandidat */
interface VerificationState {
  verified_count: number;
  rejected_count: number;
  user_verdict: 'verified' | 'rejected' | null;
}

/** Community-verificeret ejerforening fra nabo-BFE'er */
interface CommunityVerified {
  cvr: string;
  navn: string;
  verified_count: number;
  rejected_count: number;
  nameCoversAddress: boolean;
  verifiedByBfes: number;
}

interface Props {
  /** BFE-nummer for den ejendom der søges ejerforening til */
  bfeNummer: number;
  /** 'da' | 'en' — bilingual */
  lang: 'da' | 'en';
  /** Fallback-adresse når bfe_adresse_cache er tom */
  adresse?: string;
  /** Fallback-postnr */
  postnr?: string;
  /** Matrikelnr for filtrering af ejerforenings-kandidater */
  matrikelnr?: string;
}

/**
 * Confidence-badge farver.
 *
 * @param confidence - 'high' | 'medium' | 'low'
 * @returns Tailwind klasser for badge
 */
function confidenceStyle(confidence: 'high' | 'medium' | 'low'): {
  bg: string;
  text: string;
  label: string;
  labelEn: string;
} {
  switch (confidence) {
    case 'high':
      return {
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-400',
        label: 'Høj sikkerhed',
        labelEn: 'High confidence',
      };
    case 'medium':
      return {
        bg: 'bg-amber-500/10',
        text: 'text-amber-400',
        label: 'Medium sikkerhed',
        labelEn: 'Medium confidence',
      };
    case 'low':
      return {
        bg: 'bg-red-500/10',
        text: 'text-red-400',
        label: 'Lav sikkerhed',
        labelEn: 'Low confidence',
      };
  }
}

/**
 * AI-baseret ejerforenings-finder med crowdsourced verificering.
 *
 * @param props - BFE-nummer og sprog
 * @returns React komponent
 */
export default function EjendomEjerforeningFinder({
  bfeNummer,
  lang,
  adresse,
  postnr,
  matrikelnr,
}: Props) {
  const da = lang === 'da';

  const [candidates, setCandidates] = useState<Kandidat[]>([]);
  const [verifications, setVerifications] = useState<Map<string, VerificationState>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [pendingCvr, setPendingCvr] = useState<string | null>(null);

  /** Community-verificerede ejerforeninger fra nabo-BFE'er */
  const [communityResults, setCommunityResults] = useState<CommunityVerified[]>([]);
  const [communityLoading, setCommunityLoading] = useState(true);

  /**
   * Auto-check community-verificeringer ved mount.
   * Finder ejerforeninger der er verificeret af andre brugere på nabo-ejendomme.
   */
  useEffect(() => {
    if (!adresse || !postnr) {
      setCommunityLoading(false);
      return;
    }
    // Ekstrahér gadenavn (fjern husnummer) og husnr
    const gadenavn = adresse.replace(/\s+\d+\w*$/, '').trim();
    const husnrMatch = adresse.match(/\s+(\d+)/);
    const husnr = husnrMatch ? husnrMatch[1] : '';
    if (!gadenavn) {
      setCommunityLoading(false);
      return;
    }

    let active = true;
    (async () => {
      try {
        const params = new URLSearchParams({ gadenavn, postnr });
        if (husnr) params.set('husnr', husnr);
        params.set('bfeNummer', String(bfeNummer));
        if (matrikelnr) params.set('matrikelnr', matrikelnr);
        const res = await fetch(`/api/ejerforening-verification/community?${params.toString()}`, {
          credentials: 'include',
        });
        if (!res.ok || !active) return;
        const data = (await res.json()) as CommunityVerified[];
        if (active && data.length > 0) {
          setCommunityResults(data);
          // BIZZ-1857: Hent også user_verdict for community-kandidater så
          // brugerens egen stemme er synlig — uden dette ved bruger ikke
          // om de selv har voteret eller om de kan vote
          const verifRes = await fetch(`/api/ejerforening-verification?bfeNummer=${bfeNummer}`, {
            credentials: 'include',
          });
          if (verifRes.ok && active) {
            const verifData = (await verifRes.json()) as Array<{
              candidate_cvr: string;
              verified_count: number;
              rejected_count: number;
              user_verdict: 'verified' | 'rejected' | null;
            }>;
            const map = new Map<string, VerificationState>();
            for (const row of verifData) {
              map.set(row.candidate_cvr, {
                verified_count: row.verified_count,
                rejected_count: row.rejected_count,
                user_verdict: row.user_verdict,
              });
            }
            setVerifications(map);
          }
        }
      } catch {
        // Fail-soft — community check er ikke kritisk
      } finally {
        if (active) setCommunityLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [adresse, postnr, bfeNummer, matrikelnr]);

  /**
   * Hent verificeringer for alle kandidater.
   * Kaldes efter AI-søgning returnerer resultater.
   */
  const fetchVerifications = useCallback(async () => {
    try {
      const res = await fetch(`/api/ejerforening-verification?bfeNummer=${bfeNummer}`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = (await res.json()) as Array<{
        candidate_cvr: string;
        verified_count: number;
        rejected_count: number;
        user_verdict: 'verified' | 'rejected' | null;
      }>;
      const map = new Map<string, VerificationState>();
      for (const row of data) {
        map.set(row.candidate_cvr, {
          verified_count: row.verified_count,
          rejected_count: row.rejected_count,
          user_verdict: row.user_verdict,
        });
      }
      setVerifications(map);
    } catch {
      // Fail-soft: verificeringer er ikke kritiske
    }
  }, [bfeNummer]);

  /**
   * Kør AI-søgning efter ejerforening.
   * Kalder /api/ai/find-ejerforening og henter efterfølgende verificeringer.
   */
  const handleSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ bfeNummer: String(bfeNummer) });
      if (adresse) params.set('adresse', adresse);
      if (postnr) params.set('postnr', postnr);
      if (matrikelnr) params.set('matrikelnr', matrikelnr);
      const res = await fetch(`/api/ai/find-ejerforening?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 402) {
          setError(
            da ? 'AI-forbrug kræver aktivt abonnement' : 'AI usage requires active subscription'
          );
        } else if (res.status === 429) {
          setError(
            da
              ? 'For mange forespørgsler — prøv igen om lidt'
              : 'Too many requests — try again shortly'
          );
        } else {
          setError(err.error ?? (da ? 'Ukendt fejl' : 'Unknown error'));
        }
        return;
      }
      const json = (await res.json()) as { candidates: Kandidat[]; cachedAt?: string };
      setCandidates(json.candidates ?? []);
      setHasSearched(true);

      // Hent verificeringer for resultaterne
      if ((json.candidates ?? []).length > 0) {
        await fetchVerifications();
      }
    } catch {
      setError(da ? 'Netværksfejl' : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [bfeNummer, da, fetchVerifications, adresse, postnr, matrikelnr]);

  /**
   * Stem på en kandidat-ejerforening (verificer/afvis).
   * Optimistisk UI-opdatering med API-synk i baggrunden.
   *
   * @param candidateCvr - CVR for kandidaten
   * @param verdict - 'verified' eller 'rejected'
   */
  const handleVote = useCallback(
    async (candidateCvr: string, verdict: 'verified' | 'rejected') => {
      if (pendingCvr === candidateCvr) return;

      const current = verifications.get(candidateCvr) ?? {
        verified_count: 0,
        rejected_count: 0,
        user_verdict: null,
      };
      const isToggleOff = current.user_verdict === verdict;
      setPendingCvr(candidateCvr);

      // Optimistisk opdatering
      setVerifications((prev) => {
        const next = new Map(prev);
        if (isToggleOff) {
          next.set(candidateCvr, {
            ...current,
            user_verdict: null,
            verified_count:
              verdict === 'verified'
                ? Math.max(0, current.verified_count - 1)
                : current.verified_count,
            rejected_count:
              verdict === 'rejected'
                ? Math.max(0, current.rejected_count - 1)
                : current.rejected_count,
          });
        } else {
          const wasVerified = current.user_verdict === 'verified';
          const wasRejected = current.user_verdict === 'rejected';
          next.set(candidateCvr, {
            user_verdict: verdict,
            verified_count:
              verdict === 'verified'
                ? current.verified_count + 1
                : wasVerified
                  ? Math.max(0, current.verified_count - 1)
                  : current.verified_count,
            rejected_count:
              verdict === 'rejected'
                ? current.rejected_count + 1
                : wasRejected
                  ? Math.max(0, current.rejected_count - 1)
                  : current.rejected_count,
          });
        }
        return next;
      });

      // API-kald i baggrunden
      try {
        if (isToggleOff) {
          await fetch(
            `/api/ejerforening-verification?bfeNummer=${bfeNummer}&candidateCvr=${encodeURIComponent(candidateCvr)}`,
            { method: 'DELETE', credentials: 'include' }
          );
        } else {
          const verifyParams = new URLSearchParams();
          if (matrikelnr) verifyParams.set('matrikelnr', matrikelnr);
          if (postnr) verifyParams.set('postnr', postnr);
          const verifyUrl = `/api/ejerforening-verification${verifyParams.toString() ? `?${verifyParams}` : ''}`;
          await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              bfe_nummer: bfeNummer,
              candidate_cvr: candidateCvr,
              verdict,
            }),
          });
        }
      } catch (err) {
        logger.warn('[EjendomEjerforeningFinder] vote error:', err);
        // Rollback: re-fetch fra server
        await fetchVerifications();
      } finally {
        setPendingCvr(null);
      }
    },
    [bfeNummer, pendingCvr, verifications, fetchVerifications, matrikelnr, postnr]
  );

  // Vis community-resultater som primær visning (ingen AI-knap nødvendig)
  const showCommunity = communityResults.length > 0 && !hasSearched;

  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-700/50 p-5">
      <div className="flex items-center gap-2 mb-3">
        {showCommunity ? (
          <CheckCircle2 size={16} className="text-emerald-400" />
        ) : (
          <Search size={16} className="text-teal-400" />
        )}
        <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">
          {showCommunity
            ? da
              ? 'Ejerforening'
              : 'Housing association'
            : da
              ? 'Find ejerforening'
              : 'Find housing association'}
        </h3>
      </div>

      {/* Community-loading state */}
      {communityLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-500 py-1">
          <Loader2 size={12} className="animate-spin" />
          {da ? 'Checker verificeringer...' : 'Checking verifications...'}
        </div>
      )}

      {/* Community-verificerede resultater — vises automatisk for alle brugere */}
      {showCommunity && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            {da
              ? 'Foreslået af andre brugere. Du kan bekræfte, afvise eller starte en ny AI-søgning hvis du ikke er enig.'
              : 'Suggested by other users. You can verify, reject or start a new AI search if you disagree.'}
          </p>

          {communityResults.map((cv) => {
            const userVerdict = verifications.get(cv.cvr)?.user_verdict ?? null;
            return (
              <div
                key={cv.cvr}
                className="rounded-lg bg-slate-800/40 border border-slate-700/40 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <Building2 size={18} className="text-emerald-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/companies/${cv.cvr}`}
                        className="text-sm text-white font-medium hover:text-blue-300 transition-colors truncate block"
                      >
                        {cv.navn}
                      </Link>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs text-slate-500">CVR {cv.cvr}</span>
                        {userVerdict && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              userVerdict === 'verified'
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-red-500/10 text-red-400'
                            }`}
                          >
                            {da ? 'Din stemme:' : 'Your vote:'}{' '}
                            {userVerdict === 'verified' ? '👍' : '👎'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* BIZZ-1857: Verificerings-knapper med synlig label, aktiv-state og hover */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleVote(cv.cvr, 'verified')}
                      disabled={pendingCvr === cv.cvr}
                      title={
                        da
                          ? userVerdict === 'verified'
                            ? 'Klik for at fjerne din stemme'
                            : 'Bekræft at dette er den korrekte ejerforening'
                          : userVerdict === 'verified'
                            ? 'Click to remove your vote'
                            : 'Confirm this is the correct association'
                      }
                      className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        userVerdict === 'verified'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : 'bg-slate-700/40 text-slate-300 hover:bg-emerald-500/15 hover:text-emerald-400 border border-slate-600/40'
                      }`}
                      aria-label={da ? 'Bekræft' : 'Verify'}
                    >
                      <ThumbsUp size={12} />
                      <span>{cv.verified_count > 0 ? cv.verified_count : ''}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleVote(cv.cvr, 'rejected')}
                      disabled={pendingCvr === cv.cvr}
                      title={
                        da
                          ? userVerdict === 'rejected'
                            ? 'Klik for at fjerne din stemme'
                            : 'Afvis hvis dette ikke er den rigtige ejerforening'
                          : userVerdict === 'rejected'
                            ? 'Click to remove your vote'
                            : 'Reject if this is not the correct association'
                      }
                      className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                        userVerdict === 'rejected'
                          ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                          : 'bg-slate-700/40 text-slate-300 hover:bg-red-500/15 hover:text-red-400 border border-slate-600/40'
                      }`}
                      aria-label={da ? 'Afvis' : 'Reject'}
                    >
                      <ThumbsDown size={12} />
                      <span>{cv.rejected_count > 0 ? cv.rejected_count : ''}</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {/* BIZZ-1857: "Søg med AI alligevel"-knap mere prominent */}
          <button
            type="button"
            onClick={handleSearch}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-600/15 hover:bg-teal-600/25 border border-teal-500/30 text-teal-300 text-xs font-medium transition-colors mt-2 disabled:opacity-50"
            aria-label={da ? 'Søg ny ejerforening via AI' : 'Search new association via AI'}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            {da ? 'Søg ny via AI' : 'Search new via AI'}
          </button>
        </div>
      )}

      {/* Søge-knap (idle state — kun når ingen community-resultater) */}
      {!showCommunity && !communityLoading && !hasSearched && !loading && (
        <div>
          <p className="text-xs text-slate-400 mb-3">
            {da
              ? 'Ingen registreret administrator fundet. Brug AI til at identificere den sandsynlige ejerforening baseret på nabo-ejendomme.'
              : 'No registered administrator found. Use AI to identify the likely housing association based on neighboring properties.'}
          </p>
          <button
            type="button"
            onClick={handleSearch}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 text-teal-300 text-sm font-medium transition-colors"
            aria-label={da ? 'Find ejerforening via AI' : 'Find housing association via AI'}
          >
            <Search size={14} />
            {da ? 'Find ejerforening via AI' : 'Find housing association via AI'}
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
          <Loader2 size={16} className="animate-spin text-teal-400" />
          {da ? 'Søger efter ejerforening...' : 'Searching for housing association...'}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="flex items-start gap-2 py-2">
          <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-red-400">{error}</p>
            <button
              type="button"
              onClick={handleSearch}
              className="text-xs text-slate-400 hover:text-slate-300 underline mt-1"
            >
              {da ? 'Prøv igen' : 'Try again'}
            </button>
          </div>
        </div>
      )}

      {/* Ingen resultater */}
      {hasSearched && !loading && !error && candidates.length === 0 && (
        <p className="text-xs text-slate-500 py-2">
          {da
            ? 'Ingen kandidat-ejerforeninger fundet i nærområdet.'
            : 'No candidate housing associations found in the area.'}
        </p>
      )}

      {/* Resultater med verificering */}
      {hasSearched && !loading && candidates.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            {da
              ? `${candidates.length} kandidat${candidates.length > 1 ? 'er' : ''} fundet — verificér med 👍 eller afvis med 👎`
              : `${candidates.length} candidate${candidates.length > 1 ? 's' : ''} found — verify with 👍 or reject with 👎`}
          </p>

          {candidates.map((candidate) => {
            const style = confidenceStyle(candidate.confidence);
            const v = verifications.get(candidate.cvr) ?? {
              verified_count: 0,
              rejected_count: 0,
              user_verdict: null,
            };
            const isPending = pendingCvr === candidate.cvr;

            return (
              <div
                key={candidate.cvr}
                className={`rounded-lg border p-3 transition-colors ${
                  v.user_verdict === 'verified'
                    ? 'bg-emerald-900/20 border-emerald-500/30'
                    : v.user_verdict === 'rejected'
                      ? 'bg-red-900/20 border-red-500/30'
                      : 'bg-slate-800/40 border-slate-700/40'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Venstre: info */}
                  <div className="flex items-start gap-3 min-w-0">
                    <Building2 size={18} className="text-slate-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/companies/${candidate.cvr}`}
                        className="text-sm text-white font-medium hover:text-blue-300 transition-colors truncate block"
                      >
                        {candidate.navn}
                      </Link>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs text-slate-500">CVR {candidate.cvr}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}
                        >
                          {da ? style.label : style.labelEn}
                        </span>
                        {candidate.administeredCount > 0 && (
                          <span className="text-[10px] text-slate-500">
                            {candidate.administeredCount}{' '}
                            {da ? 'ejendomme i området' : 'properties in the area'}
                          </span>
                        )}
                      </div>
                      {candidate.reasoning && (
                        <p className="text-xs text-slate-400 mt-1 italic">{candidate.reasoning}</p>
                      )}
                    </div>
                  </div>

                  {/* Højre: verificerings-knapper */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Verificer */}
                    <button
                      type="button"
                      onClick={() => handleVote(candidate.cvr, 'verified')}
                      disabled={isPending}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                        v.user_verdict === 'verified'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-slate-700/30 text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-400'
                      } ${isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
                      aria-label={da ? 'Bekræft ejerforening' : 'Verify association'}
                    >
                      <ThumbsUp size={12} />
                      {v.verified_count > 0 && <span>{v.verified_count}</span>}
                    </button>

                    {/* Afvis */}
                    <button
                      type="button"
                      onClick={() => handleVote(candidate.cvr, 'rejected')}
                      disabled={isPending}
                      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                        v.user_verdict === 'rejected'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-slate-700/30 text-slate-400 hover:bg-red-500/10 hover:text-red-400'
                      } ${isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
                      aria-label={da ? 'Afvis ejerforening' : 'Reject association'}
                    >
                      <ThumbsDown size={12} />
                      {v.rejected_count > 0 && <span>{v.rejected_count}</span>}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          <p className="text-[10px] text-slate-600 mt-2">
            {da
              ? 'AI-resultater er vejledende. Verificeringer hjælper andre brugere.'
              : 'AI results are indicative. Verifications help other users.'}
          </p>
        </div>
      )}
    </div>
  );
}
