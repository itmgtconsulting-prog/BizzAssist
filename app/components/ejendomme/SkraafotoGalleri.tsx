/**
 * SkraafotoGalleri — viser skråfotos af en ejendom i 4 retninger.
 *
 * BIZZ-964: Henter oblique aerial photos fra Dataforsyningen og viser
 * dem i et 2x2 grid med retningslabels. Klikbart for fuld størrelse.
 *
 * @param lat - Breddegrad
 * @param lng - Længdegrad
 * @param lang - 'da' | 'en'
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { Camera, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { SkraafotoRetning } from '@/app/api/skraafoto/route';

interface Props {
  /** Breddegrad (WGS84) */
  lat: number | null;
  /** Længdegrad (WGS84) */
  lng: number | null;
  /** Sprogvalg */
  lang: 'da' | 'en';
}

/** Retningslabels */
const DIR_LABELS: Record<string, { da: string; en: string }> = {
  north: { da: 'Nord', en: 'North' },
  east: { da: 'Øst', en: 'East' },
  south: { da: 'Syd', en: 'South' },
  west: { da: 'Vest', en: 'West' },
};

/**
 * 2x2 grid med skråfotos i 4 retninger.
 * Håndterer sin egen data-fetching (samme mønster som StoejBadge/OmraadeProfilSektion).
 */
export default function SkraafotoGalleri({ lat, lng, lang }: Props) {
  const da = lang === 'da';
  const [fotos, setFotos] = useState<SkraafotoRetning[]>([]);
  const [loading, setLoading] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    if (lat == null || lng == null) return;
    let cancelled = false;
    setLoading(true);

    fetch(`/api/skraafoto?lat=${lat}&lng=${lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.fotos) setFotos(d.fotos as SkraafotoRetning[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  /** Lightbox navigation */
  const handlePrev = useCallback(() => {
    setLightboxIdx((i) => (i != null && i > 0 ? i - 1 : i));
  }, []);

  const handleNext = useCallback(() => {
    setLightboxIdx((i) => (i != null && i < fotos.length - 1 ? i + 1 : i));
  }, [fotos.length]);

  /** Keyboard navigation i lightbox */
  useEffect(() => {
    if (lightboxIdx == null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIdx(null);
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'ArrowRight') handleNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxIdx, handlePrev, handleNext]);

  if (loading) {
    return (
      <div className="bg-slate-800/40 rounded-xl p-4 mt-4 animate-pulse">
        <div className="flex items-center gap-2 mb-3">
          <Camera className="w-4 h-4 text-slate-500" />
          <span className="text-slate-500 text-sm">
            {da ? 'Henter luftfotos...' : 'Loading aerial photos...'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-slate-700/50 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (fotos.length === 0) return null;

  const year = fotos[0]?.year;

  return (
    <>
      <div className="bg-slate-800/40 rounded-xl p-4 mt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-medium text-slate-300">
              {da ? 'Luftfotos' : 'Aerial Photos'}
            </h3>
          </div>
          {year && (
            <span className="text-xs text-slate-500">
              {da ? `Foto: ${year}` : `Photo: ${year}`}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {fotos.map((foto, idx) => (
            <button
              key={foto.direction}
              type="button"
              className="relative group rounded-lg overflow-hidden cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
              onClick={() => setLightboxIdx(idx)}
              aria-label={`${da ? 'Vis luftfoto' : 'View aerial photo'} ${DIR_LABELS[foto.direction]?.[lang] ?? foto.direction}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={foto.thumbnail}
                alt={`${da ? 'Skråfoto' : 'Oblique photo'} ${DIR_LABELS[foto.direction]?.[lang] ?? foto.direction}`}
                className="w-full h-32 object-cover transition-transform group-hover:scale-105"
                loading="lazy"
                onError={(e) => {
                  /* BIZZ-1050: Vis placeholder ved broken image */
                  const target = e.currentTarget;
                  target.style.display = 'none';
                  const parent = target.parentElement;
                  if (parent && !parent.querySelector('.skraafoto-fallback')) {
                    const div = document.createElement('div');
                    div.className =
                      'skraafoto-fallback w-full h-32 bg-slate-700/50 flex items-center justify-center text-slate-500 text-xs';
                    div.textContent = da ? 'Foto utilgængeligt' : 'Photo unavailable';
                    parent.insertBefore(div, target);
                  }
                }}
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
                <span className="text-xs text-white font-medium">
                  {DIR_LABELS[foto.direction]?.[lang] ?? foto.direction}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxIdx != null && fotos[lightboxIdx] && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="skraafoto-lightbox-title"
          onClick={() => setLightboxIdx(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="skraafoto-lightbox-title" className="sr-only">
              {da ? 'Skråfoto' : 'Oblique photo'} {DIR_LABELS[fotos[lightboxIdx].direction]?.[lang]}
            </h2>

            {/* Luk-knap */}
            <button
              type="button"
              onClick={() => setLightboxIdx(null)}
              className="absolute -top-10 right-0 text-white hover:text-slate-300"
              aria-label={da ? 'Luk' : 'Close'}
            >
              <X className="w-6 h-6" />
            </button>

            {/* Navigation */}
            {lightboxIdx > 0 && (
              <button
                type="button"
                onClick={handlePrev}
                className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 rounded-full p-2 text-white hover:bg-black/70"
                aria-label={da ? 'Forrige' : 'Previous'}
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
            )}
            {lightboxIdx < fotos.length - 1 && (
              <button
                type="button"
                onClick={handleNext}
                className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 rounded-full p-2 text-white hover:bg-black/70"
                aria-label={da ? 'Næste' : 'Next'}
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            )}

            {/* Billede */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fotos[lightboxIdx].thumbnail}
              alt={`${da ? 'Skråfoto' : 'Oblique photo'} ${DIR_LABELS[fotos[lightboxIdx].direction]?.[lang]}`}
              className="w-full h-auto max-h-[85vh] object-contain rounded-lg"
            />

            {/* Retningslabel */}
            <div className="text-center mt-2 text-slate-400 text-sm">
              {DIR_LABELS[fotos[lightboxIdx].direction]?.[lang] ?? fotos[lightboxIdx].direction}
              {year && ` (${year})`}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
