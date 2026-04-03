'use client';

/**
 * VerifiedLinks — Viser sociale/web links med verifikations-funktionalitet.
 *
 * Links auto-opdages baseret på virksomheds-/personnavn og vises med
 * platform-specifikke ikoner. Brugere kan verificere links — verifikations-
 * antal vises som social proof.
 *
 * @param entityType - 'company' eller 'person'
 * @param entityId - CVR-nummer eller enhedsNummer
 * @param entityName - Visningsnavn
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, ExternalLink, Loader2, ThumbsUp } from 'lucide-react';

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

// ─── Link data type ─────────────────────────────────────────────────────────

interface LinkItem {
  id: string | null;
  platform: string;
  label: string;
  icon: string;
  color: string;
  url: string;
  verifyCount: number;
  userVerified: boolean;
  isAutoGenerated: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

/** Sociale medier-links fundet af AI-søgning */
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
}

export default function VerifiedLinks({
  entityType,
  entityId,
  entityName,
  lang,
  aiSocials,
}: VerifiedLinksProps) {
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // Simpel user ID — i production bruges Supabase auth
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    // Hent bruger-ID fra localStorage eller generer et midlertidigt
    let uid = localStorage.getItem('ba-user-id');
    if (!uid) {
      uid = crypto.randomUUID();
      localStorage.setItem('ba-user-id', uid);
    }
    setUserId(uid);
  }, []);

  /** Metadata for platform-visning brugt ved tilføjelse af AI-fundne links */
  const PLATFORM_META: Record<string, { label: string; icon: string; color: string }> = {
    website: { label: 'Hjemmeside', icon: 'website', color: 'text-slate-400' },
    linkedin: { label: 'LinkedIn', icon: 'linkedin', color: 'text-blue-400' },
    facebook: { label: 'Facebook', icon: 'facebook', color: 'text-blue-500' },
    instagram: { label: 'Instagram', icon: 'instagram', color: 'text-pink-400' },
    twitter: { label: 'Twitter / X', icon: 'twitter', color: 'text-slate-300' },
    youtube: { label: 'YouTube', icon: 'website', color: 'text-red-400' },
  };

  /** Hent links fra API, erstat auto-genererede med AI-fundne URLs, og tilføj nye AI-fundne platforme */
  const fetchLinks = useCallback(async () => {
    if (!entityId || !userId) return;
    try {
      const params = new URLSearchParams({
        type: entityType,
        id: entityId,
        name: entityName,
        userId,
      });
      const res = await fetch(`/api/links?${params}`);
      if (res.ok) {
        const data: LinkItem[] = await res.json();
        // Overstyr auto-genererede links med AI-fundne URLs når tilgængelige
        const merged: LinkItem[] = Array.isArray(data)
          ? data.map((link) => {
              const aiUrl = aiSocials?.[link.platform as keyof AISocials];
              if (aiUrl && link.isAutoGenerated) {
                return { ...link, url: aiUrl, isAutoGenerated: false };
              }
              return link;
            })
          : [];

        // Tilføj AI-fundne platforme der ikke allerede findes i listen
        if (aiSocials) {
          for (const [platform, url] of Object.entries(aiSocials)) {
            if (!url || typeof url !== 'string') continue;
            const alreadyPresent = merged.some((l) => l.platform === platform);
            if (!alreadyPresent) {
              const meta = PLATFORM_META[platform];
              if (meta) {
                merged.push({
                  id: null,
                  platform,
                  label: meta.label,
                  icon: meta.icon,
                  color: meta.color,
                  url,
                  verifyCount: 0,
                  userVerified: false,
                  isAutoGenerated: false,
                });
              }
            }
          }
        }

        setLinks(merged);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, entityName, userId, aiSocials]);

  useEffect(() => {
    if (!userId) return;
    // Re-fetch when aiSocials arrive so AI-found URLs replace auto-generated ones
    fetchedRef.current = false;
    fetchLinks();
    fetchedRef.current = true;
  }, [fetchLinks, userId, aiSocials]);

  /** Verificer et link */
  const handleVerify = async (link: LinkItem) => {
    if (!userId || link.userVerified) return;
    setVerifyingId(link.id ?? link.platform);

    try {
      if (link.id) {
        // Verificer eksisterende link i DB
        await fetch('/api/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'verify', linkId: link.id, userId }),
        });
      } else {
        // Opret nyt link fra auto-genereret og verificer
        await fetch('/api/links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add',
            entityType,
            entityId,
            entityName,
            platform: link.platform,
            url: link.url,
            userId,
          }),
        });
      }

      // Opdater lokalt
      setLinks((prev) =>
        prev.map((l) =>
          l.id === link.id && l.platform === link.platform
            ? { ...l, verifyCount: l.verifyCount + 1, userVerified: true, isAutoGenerated: false }
            : l
        )
      );
    } catch {
      /* ignore */
    } finally {
      setVerifyingId(null);
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

  return (
    <div className="space-y-1.5">
      {links.map((link, i) => {
        const isVerifying = verifyingId === (link.id ?? link.platform);
        // AI-fundne links: id er null og ikke auto-genereret (erstattet af AI-URL)
        const isAiFound = link.id === null && !link.isAutoGenerated;
        // Vis hostname for AI-fundne links så URL er synlig
        let displayUrl: string | undefined;
        if (isAiFound) {
          try {
            displayUrl = new URL(link.url).hostname.replace(/^www\./, '');
          } catch {
            /* ignore */
          }
        }

        return (
          <div key={`${link.platform}-${i}`} className="flex items-center gap-2 group">
            {/* Platform ikon + link */}
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 flex-1 min-w-0 text-slate-400 hover:text-blue-300 transition-colors text-xs"
            >
              <PlatformIcon icon={link.icon} className={`flex-shrink-0 ${link.color}`} />
              <span className="flex flex-col min-w-0">
                <span className="truncate leading-tight">{link.label}</span>
                {displayUrl && (
                  <span className="text-[9px] text-slate-500 truncate leading-tight">
                    {displayUrl}
                  </span>
                )}
              </span>
              {link.isAutoGenerated && (
                <span className="text-[8px] text-slate-600 flex-shrink-0">
                  ({lang === 'da' ? 'søg' : 'search'})
                </span>
              )}
              {isAiFound && (
                <span className="flex-shrink-0 px-1 py-0.5 rounded text-[8px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                  AI
                </span>
              )}
              <ExternalLink
                size={9}
                className="text-slate-700 group-hover:text-blue-400 flex-shrink-0"
              />
            </a>

            {/* Verifikation */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {link.verifyCount > 0 && (
                <span className="flex items-center gap-0.5 text-[9px] text-emerald-400/80">
                  <CheckCircle size={9} />
                  {link.verifyCount}
                </span>
              )}

              {!link.userVerified ? (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    handleVerify(link);
                  }}
                  disabled={isVerifying}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                  title={
                    lang === 'da' ? 'Bekræft dette link er korrekt' : 'Verify this link is correct'
                  }
                >
                  {isVerifying ? (
                    <Loader2 size={9} className="animate-spin" />
                  ) : (
                    <ThumbsUp size={9} />
                  )}
                </button>
              ) : (
                <span className="text-[9px] text-emerald-500/60 px-1">✓</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
