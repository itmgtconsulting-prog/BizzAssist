'use client';

/**
 * VerifiedLinks — Viser sociale/web links med verificér/afvis/alternativ-funktionalitet.
 *
 * Tabel-layout med kolonner: Platform | Link | 👍 count | 👎 count | Alt.
 * Henter aggregerede verdicts fra /api/link-verification og opdaterer optimistisk.
 * Brugere kan verificere (👍) eller afvise (👎) links — klik igen fjerner stemmen.
 * Alt.-knap åbner popup med alternative URLs — brugeren kan vælge et alternativ.
 * Kræver Supabase-login for at stemme.
 *
 * @param entityType - 'company' eller 'person'
 * @param entityId - CVR-nummer eller enhedsNummer
 * @param entityName - Visningsnavn
 * @param lang - Sprogkode 'da' eller 'en'
 * @param aiSocials - AI-fundne sociale medier-URLs (primære) — overstyrer auto-genererede søgelinks
 * @param aiAlternatives - AI-fundne alternative URLs per platform
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { ExternalLink, Loader2, ThumbsUp, ThumbsDown, ChevronDown } from 'lucide-react';
import { useAuth } from '@/app/hooks/useAuth';

// ─── Platform SVG ikoner ────────────────────────────────────────────────────

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} width={14} height={14}>
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} width={14} height={14}>
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} width={14} height={14}>
      <path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678a6.162 6.162 0 100 12.324 6.162 6.162 0 100-12.324zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405a1.441 1.441 0 11-2.882 0 1.441 1.441 0 012.882 0z" />
    </svg>
  );
}

function XTwitterIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} width={14} height={14}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function WebsiteIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      width={14}
      height={14}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function VirkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} width={14} height={14}>
      <path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18l7.2 3.6L12 11.38 4.8 7.78 12 4.18zM4 8.82l7 3.5v7.36l-7-3.5V8.82zm9 10.86v-7.36l7-3.5v7.36l-7 3.5z" />
    </svg>
  );
}

/** Returnerer ikon-komponent for en platform */
function PlatformIcon({ icon, className }: { icon: string; className?: string }) {
  switch (icon) {
    case 'linkedin':
      return <LinkedInIcon className={className} />;
    case 'facebook':
      return <FacebookIcon className={className} />;
    case 'instagram':
      return <InstagramIcon className={className} />;
    case 'twitter':
      return <XTwitterIcon className={className} />;
    case 'virk':
      return <VirkIcon className={className} />;
    default:
      return <WebsiteIcon className={className} />;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface LinkItem {
  platform: string;
  label: string;
  icon: string;
  color: string;
  url: string;
  /** Totalt antal verificeringer fra alle brugere */
  verifiedCount: number;
  /** Totalt antal afvisninger fra alle brugere */
  rejectedCount: number;
  /** Brugerens eget valg — null = ingen stemme endnu */
  userVerdict: 'verified' | 'rejected' | null;
  isAutoGenerated: boolean;
  /** Alternative URLs for denne platform */
  alternatives: string[];
}

/** Sociale medier-links fundet af AI-søgning (primære URLs) */
interface AISocials {
  website?: string;
  facebook?: string;
  linkedin?: string;
  instagram?: string;
  twitter?: string;
  youtube?: string;
}

interface VerifiedLinksProps {
  entityType: 'company' | 'person';
  entityId: string;
  entityName: string;
  lang: 'da' | 'en';
  /** AI-fundne sociale medier-URLs — overstyrer auto-genererede søgelinks */
  aiSocials?: AISocials;
  /** AI-fundne alternative links per platform */
  aiAlternatives?: Record<string, string[]>;
}

/** State for åben Alt.-popup */
interface AltPopupState {
  platform: string;
  alternatives: string[];
}

// ─── Platform metadata ───────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { label: string; icon: string; color: string }> = {
  website: { label: 'Hjemmeside', icon: 'website', color: 'text-slate-400' },
  linkedin: { label: 'LinkedIn', icon: 'linkedin', color: 'text-blue-400' },
  facebook: { label: 'Facebook', icon: 'facebook', color: 'text-blue-500' },
  instagram: { label: 'Instagram', icon: 'instagram', color: 'text-pink-400' },
  twitter: { label: 'Twitter / X', icon: 'twitter', color: 'text-slate-300' },
  youtube: { label: 'YouTube', icon: 'website', color: 'text-red-400' },
};

// ─── Alt Popup ───────────────────────────────────────────────────────────────

/**
 * AlternativesPopup — Viser en liste af alternative URLs for en platform.
 * Lukker ved klik udenfor. Brugeren kan vælge et alternativ der erstatter primær-URL.
 *
 * @param popup - Popup state med platform og alternativer
 * @param onSelect - Callback med valgt URL
 * @param onClose - Callback der lukker popup
 * @param lang - Sprogkode
 */
function AlternativesPopup({
  popup,
  onSelect,
  onClose,
  lang,
}: {
  popup: AltPopupState;
  onSelect: (platform: string, url: string) => void;
  onClose: () => void;
  lang: 'da' | 'en';
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Luk popup ved klik udenfor
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-slate-600/60 bg-slate-800 shadow-xl"
    >
      <div className="px-3 py-2 border-b border-slate-700/50">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          {lang === 'da' ? 'Alternative links' : 'Alternative links'}
        </p>
      </div>
      <div className="divide-y divide-slate-700/30 max-h-60 overflow-y-auto">
        {popup.alternatives.map((url, i) => {
          let hostname = url;
          try {
            hostname = new URL(url).hostname.replace(/^www\./, '');
          } catch {
            /* ignore */
          }
          return (
            <div
              key={i}
              className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-slate-700/30"
            >
              <div className="flex flex-col min-w-0">
                <span className="text-[11px] text-slate-300 truncate">{hostname}</span>
                <span className="text-[9px] text-slate-500 truncate">{url}</span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1 rounded text-slate-500 hover:text-blue-400 transition-colors"
                  title={lang === 'da' ? 'Åbn link' : 'Open link'}
                >
                  <ExternalLink size={11} />
                </a>
                <button
                  onClick={() => {
                    onSelect(popup.platform, url);
                    onClose();
                  }}
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-600/20 border border-blue-600/40 text-blue-400 hover:bg-blue-600/30 transition-colors"
                >
                  {lang === 'da' ? 'Vælg' : 'Select'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * VerifiedLinks — Tabel med sociale medier-links, verificeringer og alternativer.
 * Henter data fra /api/link-verification og /api/link-alternatives.
 * Understøtter optimistisk UI-opdatering for stemmer og alternativ-valg.
 */
export default function VerifiedLinks({
  entityType,
  entityId,
  entityName,
  lang,
  aiSocials,
  aiAlternatives,
}: VerifiedLinksProps) {
  const { isAuthenticated, userId } = useAuth();
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  /** URL der aktuelt undergår et API-kald (optimistisk lock) */
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  /** Åben Alt.-popup: platform + alternativer */
  const [altPopup, setAltPopup] = useState<AltPopupState | null>(null);
  /** Platform med åben popup (til positionering) */
  const [popupPlatform, setPopupPlatform] = useState<string | null>(null);

  /**
   * Henter links fra /api/links og merger med:
   *  - AI-fundne URLs (erstatter auto-genererede søgelinks)
   *  - Verificeringer fra /api/link-verification (aggregerede counts + brugerens verdict)
   *  - Alternativer fra /api/link-alternatives og aiAlternatives prop
   * Re-kører når aiSocials eller aiAlternatives ankommer.
   */
  const fetchLinks = useCallback(async () => {
    if (!entityId) return;
    try {
      // Hent platform-liste fra eksisterende /api/links
      const params = new URLSearchParams({
        type: entityType,
        id: entityId,
        name: entityName,
        userId: userId ?? '',
      });
      const [linksRes, verificationsRes, alternativesRes] = await Promise.all([
        fetch(`/api/links?${params}`),
        fetch(`/api/link-verification?cvr=${encodeURIComponent(entityId)}`),
        fetch(`/api/link-alternatives?cvr=${encodeURIComponent(entityId)}`),
      ]);

      if (!linksRes.ok) return;

      type RawLink = {
        id: string | null;
        platform: string;
        label: string;
        icon: string;
        color: string;
        url: string;
        verifyCount: number;
        userVerified: boolean;
        isAutoGenerated: boolean;
      };

      type VerificationSummary = {
        link_url: string;
        platform: string | null;
        link_type: string | null;
        verified_count: number;
        rejected_count: number;
        user_verdict: 'verified' | 'rejected' | null;
      };

      const rawLinks: RawLink[] = await linksRes.json();
      const verifications: VerificationSummary[] = verificationsRes.ok
        ? await verificationsRes.json()
        : [];

      // Gem Supabase-alternativer og merge med prop-alternativer
      const supabaseAlts: Record<string, string[]> = alternativesRes.ok
        ? await alternativesRes.json()
        : {};
      const mergedAlts: Record<string, string[]> = { ...supabaseAlts };
      if (aiAlternatives) {
        for (const [platform, alts] of Object.entries(aiAlternatives)) {
          if (alts.length > 0) {
            mergedAlts[platform] = alts;
          }
        }
      }

      // Byg opslag: link_url → verification summary
      const verMap = new Map<string, VerificationSummary>(
        verifications.map((v) => [v.link_url, v])
      );

      // Byg opslag: platform → verificeret URL fra Supabase-historik.
      const platformVerifiedUrl = new Map<string, string>();
      for (const ver of verifications) {
        if (!ver.platform || !ver.link_url) continue;
        if (ver.verified_count > 0 || ver.rejected_count > 0 || ver.user_verdict) {
          if (!platformVerifiedUrl.has(ver.platform)) {
            platformVerifiedUrl.set(ver.platform, ver.link_url);
          }
        }
      }

      const merged: LinkItem[] = Array.isArray(rawLinks)
        ? rawLinks
            .filter((raw) => {
              if (!raw.isAutoGenerated) return true;
              if (raw.platform === 'virk') return true;
              const aiUrl = aiSocials?.[raw.platform as keyof AISocials];
              if (aiUrl) return true;
              return platformVerifiedUrl.has(raw.platform);
            })
            .map((raw) => {
              const aiUrl = aiSocials?.[raw.platform as keyof AISocials];
              const supabaseUrl = platformVerifiedUrl.get(raw.platform);
              const resolvedUrl = raw.isAutoGenerated ? (aiUrl ?? supabaseUrl ?? raw.url) : raw.url;
              const isResolved = raw.isAutoGenerated && !!(aiUrl ?? supabaseUrl);
              const ver = verMap.get(resolvedUrl);
              return {
                platform: raw.platform,
                label: raw.label,
                icon: raw.icon,
                color: raw.color,
                url: resolvedUrl,
                verifiedCount: ver?.verified_count ?? 0,
                rejectedCount: ver?.rejected_count ?? 0,
                userVerdict: ver?.user_verdict ?? null,
                isAutoGenerated: isResolved ? false : raw.isAutoGenerated,
                alternatives: mergedAlts[raw.platform] ?? [],
              };
            })
        : [];

      // Tilføj AI-fundne platforme der ikke allerede er i listen
      if (aiSocials) {
        for (const [platform, url] of Object.entries(aiSocials)) {
          if (!url || typeof url !== 'string') continue;
          if (merged.some((l) => l.platform === platform)) continue;
          const meta = PLATFORM_META[platform];
          if (!meta) continue;
          const ver = verMap.get(url);
          merged.push({
            platform,
            label: meta.label,
            icon: meta.icon,
            color: meta.color,
            url,
            verifiedCount: ver?.verified_count ?? 0,
            rejectedCount: ver?.rejected_count ?? 0,
            userVerdict: ver?.user_verdict ?? null,
            isAutoGenerated: false,
            alternatives: mergedAlts[platform] ?? [],
          });
        }
      }

      setLinks(merged);
    } catch {
      /* ignore network errors */
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, entityName, userId, aiSocials, aiAlternatives]);

  // Re-fetch når aiSocials eller aiAlternatives ankommer
  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  /**
   * Håndterer 👍/👎 klik.
   * - Første klik: POST verdict
   * - Klik på samme knap igen: DELETE (toggle off)
   * - Klik på modsat knap: POST ny verdict (overskriver via upsert)
   * Opdaterer UI optimistisk og synkroniserer med API i baggrunden.
   *
   * @param link - Linket der stemmes på
   * @param verdict - 'verified' eller 'rejected'
   */
  const handleVote = async (link: LinkItem, verdict: 'verified' | 'rejected') => {
    if (!isAuthenticated) return;
    if (pendingUrl === link.url) return;

    const isToggleOff = link.userVerdict === verdict;
    setPendingUrl(link.url);

    // ── Optimistisk opdatering ──
    setLinks((prev) =>
      prev.map((l) => {
        if (l.url !== link.url) return l;
        if (isToggleOff) {
          return {
            ...l,
            userVerdict: null,
            verifiedCount:
              verdict === 'verified' ? Math.max(0, l.verifiedCount - 1) : l.verifiedCount,
            rejectedCount:
              verdict === 'rejected' ? Math.max(0, l.rejectedCount - 1) : l.rejectedCount,
          };
        }
        const wasVerified = l.userVerdict === 'verified';
        const wasRejected = l.userVerdict === 'rejected';
        return {
          ...l,
          userVerdict: verdict,
          verifiedCount:
            verdict === 'verified'
              ? l.verifiedCount + 1
              : wasVerified
                ? Math.max(0, l.verifiedCount - 1)
                : l.verifiedCount,
          rejectedCount:
            verdict === 'rejected'
              ? l.rejectedCount + 1
              : wasRejected
                ? Math.max(0, l.rejectedCount - 1)
                : l.rejectedCount,
        };
      })
    );

    // ── API-kald i baggrunden ──
    try {
      if (isToggleOff) {
        await fetch(
          `/api/link-verification?cvr=${encodeURIComponent(entityId)}&link_url=${encodeURIComponent(link.url)}`,
          { method: 'DELETE' }
        );
      } else {
        await fetch('/api/link-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cvr: entityId,
            link_url: link.url,
            link_type: 'social',
            platform: link.platform,
            verdict,
          }),
        });
      }
    } catch {
      // Rever optimistisk opdatering ved fejl
      fetchLinks();
    } finally {
      setPendingUrl(null);
    }
  };

  /**
   * Håndterer valg af alternativt link.
   * Erstatter primær-URL for platformen i lokal state.
   *
   * @param platform - Platform-nøgle (f.eks. 'linkedin')
   * @param newUrl - Den valgte alternative URL
   */
  const handleSelectAlternative = (platform: string, newUrl: string) => {
    setLinks((prev) =>
      prev.map((l) => {
        if (l.platform !== platform) return l;
        return { ...l, url: newUrl, isAutoGenerated: false };
      })
    );
  };

  /**
   * Åbner Alt.-popup for en platform.
   * Lukker anden popup hvis åben.
   *
   * @param platform - Platform-nøgle
   * @param alternatives - Alternative URLs for platformen
   */
  const handleOpenAltPopup = (platform: string, alternatives: string[]) => {
    if (popupPlatform === platform) {
      setAltPopup(null);
      setPopupPlatform(null);
    } else {
      setAltPopup({ platform, alternatives });
      setPopupPlatform(platform);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-xs">
        <Loader2 size={12} className="animate-spin" />
        {lang === 'da' ? 'Henter links…' : 'Loading links…'}
      </div>
    );
  }

  if (links.length === 0) return null;

  return (
    <div className="w-full overflow-hidden rounded-lg border border-slate-700/50">
      {/* Tabel-header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] text-[10px] font-semibold uppercase tracking-wide bg-slate-800/50 px-3 py-2 border-b border-slate-700/50">
        <span className="text-slate-500">
          {lang === 'da' ? 'Platform / Link' : 'Platform / Link'}
        </span>
        <span className="text-center px-3 text-emerald-400">
          {lang === 'da' ? 'Verificér' : 'Verify'}
        </span>
        <span className="text-center px-2 text-red-400">{lang === 'da' ? 'Afvis' : 'Reject'}</span>
        <span className="text-center px-2 text-blue-400">Alt.</span>
      </div>

      {/* Rækker */}
      <div className="divide-y divide-slate-700/30">
        {links.map((link, i) => {
          const isPending = pendingUrl === link.url;
          const isAiFound =
            !link.isAutoGenerated && link.verifiedCount === 0 && link.rejectedCount === 0;
          const isUserVerified = link.userVerdict === 'verified';
          const isUserRejected = link.userVerdict === 'rejected';
          const hasAlts = link.alternatives.length > 0;
          const isPopupOpen = popupPlatform === link.platform;

          // Vis hostname for AI-fundne links der ikke er søgelinks
          let displayUrl: string | undefined;
          if (!link.isAutoGenerated) {
            try {
              displayUrl = new URL(link.url).hostname.replace(/^www\./, '');
            } catch {
              /* ignore */
            }
          }

          const rowBg = isUserVerified
            ? 'bg-emerald-500/8 hover:bg-emerald-500/12'
            : isUserRejected
              ? 'bg-red-500/8 hover:bg-red-500/12'
              : 'hover:bg-slate-700/20';

          return (
            <div
              key={`${link.platform}-${i}`}
              className={`relative grid grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 transition-colors ${rowBg} ${isUserRejected ? 'opacity-60' : ''}`}
            >
              {/* Platform + link */}
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 min-w-0 text-slate-400 hover:text-blue-300 transition-colors text-xs group"
              >
                <PlatformIcon icon={link.icon} className={`flex-shrink-0 ${link.color}`} />
                <span className={`flex flex-col min-w-0 ${isUserRejected ? 'line-through' : ''}`}>
                  <span className="truncate leading-tight">{link.label}</span>
                  {displayUrl && (
                    <span className="text-[9px] text-slate-500 truncate leading-tight">
                      {displayUrl}
                    </span>
                  )}
                </span>
                {isAiFound && (
                  <span className="flex-shrink-0 px-1 py-0.5 rounded text-[8px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                    AI
                  </span>
                )}
                {link.isAutoGenerated && (
                  <span className="text-[8px] text-slate-600 flex-shrink-0">
                    ({lang === 'da' ? 'søg' : 'search'})
                  </span>
                )}
                <ExternalLink
                  size={9}
                  className="text-slate-700 group-hover:text-blue-400 flex-shrink-0 ml-0.5"
                />
              </a>

              {/* 👍 Verificér-kolonne */}
              <div className="flex items-center justify-center px-3">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    handleVote(link, 'verified');
                  }}
                  disabled={isPending || !isAuthenticated}
                  title={
                    !isAuthenticated
                      ? lang === 'da'
                        ? 'Log ind for at stemme'
                        : 'Log in to vote'
                      : isUserVerified
                        ? lang === 'da'
                          ? 'Fjern verificering'
                          : 'Remove verification'
                        : lang === 'da'
                          ? 'Bekræft dette link er korrekt'
                          : 'Verify this link is correct'
                  }
                  className={`flex items-center gap-1 min-w-[36px] min-h-[28px] px-1.5 rounded-md border transition-all text-xs font-medium
                    ${isPending ? 'opacity-50 cursor-wait' : ''}
                    ${!isAuthenticated ? 'opacity-30 cursor-not-allowed border-transparent text-slate-600' : ''}
                    ${
                      isUserVerified && isAuthenticated
                        ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                        : isAuthenticated
                          ? 'border-transparent text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/15 hover:border-emerald-500/30'
                          : ''
                    }`}
                >
                  {isPending && link.userVerdict !== 'rejected' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <ThumbsUp size={12} className={isUserVerified ? 'fill-emerald-400' : ''} />
                  )}
                  {(link.verifiedCount > 0 || isUserVerified) && (
                    <span className="text-[10px]">{link.verifiedCount}</span>
                  )}
                </button>
              </div>

              {/* 👎 Afvis-kolonne */}
              <div className="flex items-center justify-center px-2">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    handleVote(link, 'rejected');
                  }}
                  disabled={isPending || !isAuthenticated}
                  title={
                    !isAuthenticated
                      ? lang === 'da'
                        ? 'Log ind for at stemme'
                        : 'Log in to vote'
                      : isUserRejected
                        ? lang === 'da'
                          ? 'Fjern afvisning'
                          : 'Remove rejection'
                        : lang === 'da'
                          ? 'Markér dette link som forkert'
                          : 'Mark this link as incorrect'
                  }
                  className={`flex items-center gap-1 min-w-[36px] min-h-[28px] px-1.5 rounded-md border transition-all text-xs font-medium
                    ${isPending ? 'opacity-50 cursor-wait' : ''}
                    ${!isAuthenticated ? 'opacity-30 cursor-not-allowed border-transparent text-slate-600' : ''}
                    ${
                      isUserRejected && isAuthenticated
                        ? 'bg-red-500/20 border-red-500/40 text-red-400'
                        : isAuthenticated
                          ? 'border-transparent text-slate-500 hover:text-red-400 hover:bg-red-500/15 hover:border-red-500/30'
                          : ''
                    }`}
                >
                  {isPending && link.userVerdict !== 'verified' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <ThumbsDown size={12} className={isUserRejected ? 'fill-red-400' : ''} />
                  )}
                  {(link.rejectedCount > 0 || isUserRejected) && (
                    <span className="text-[10px]">{link.rejectedCount}</span>
                  )}
                </button>
              </div>

              {/* Alt.-kolonne */}
              <div className="relative flex items-center justify-center px-2">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (hasAlts) {
                      handleOpenAltPopup(link.platform, link.alternatives);
                    }
                  }}
                  disabled={!hasAlts}
                  title={
                    hasAlts
                      ? lang === 'da'
                        ? `${link.alternatives.length} alternative links`
                        : `${link.alternatives.length} alternative links`
                      : lang === 'da'
                        ? 'Ingen alternativer — kør AI-søgning for at finde alternativer'
                        : 'No alternatives — run AI search to find alternatives'
                  }
                  className={`flex items-center gap-0.5 min-w-[32px] min-h-[28px] px-1.5 rounded-md border transition-all text-[10px] font-medium
                    ${!hasAlts ? 'opacity-20 cursor-not-allowed border-transparent text-slate-600' : ''}
                    ${
                      hasAlts && isPopupOpen
                        ? 'bg-blue-600/20 border-blue-600/40 text-blue-400'
                        : hasAlts
                          ? 'border-transparent text-slate-500 hover:text-blue-400 hover:bg-blue-500/15 hover:border-blue-500/30'
                          : ''
                    }`}
                >
                  Alt.
                  {hasAlts && <ChevronDown size={9} className={isPopupOpen ? 'rotate-180' : ''} />}
                </button>

                {/* Popup med alternativer */}
                {isPopupOpen && altPopup && altPopup.platform === link.platform && (
                  <AlternativesPopup
                    popup={altPopup}
                    onSelect={handleSelectAlternative}
                    onClose={() => {
                      setAltPopup(null);
                      setPopupPlatform(null);
                    }}
                    lang={lang}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Login-prompt hvis ikke autentificeret */}
      {!isAuthenticated && (
        <div className="px-3 py-2 bg-slate-800/30 border-t border-slate-700/30 text-[10px] text-slate-600 text-center">
          {lang === 'da' ? 'Log ind for at verificere links' : 'Log in to verify links'}
        </div>
      )}
    </div>
  );
}
