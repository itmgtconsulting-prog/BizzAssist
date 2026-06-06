/**
 * LinkedInPosts — marketing-hjemmeside sektion med kuraterede LinkedIn posts.
 *
 * BIZZ-2041: Henter aktive posts fra /api/public/linkedin-posts.
 * Viser 3 cards (desktop) / 1 (mobil) med screenshot, uddrag, dato.
 * Bilingual via LanguageContext.
 *
 * @module app/components/LinkedInPosts
 */

'use client';

import { useState, useEffect } from 'react';
import { Linkedin, ExternalLink } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

/** LinkedIn post fra public API. */
interface LinkedInPost {
  id: string;
  post_url: string;
  image_url: string | null;
  excerpt_da: string;
  excerpt_en: string;
  published_at: string;
}

const LABELS = {
  da: {
    title: 'Fra vores LinkedIn',
    subtitle: 'Se hvad vi deler om ejendomsdata, AI-analyse og nye funktioner',
    readMore: 'Læs på LinkedIn',
  },
  en: {
    title: 'From our LinkedIn',
    subtitle: 'See what we share about property data, AI analysis and new features',
    readMore: 'Read on LinkedIn',
  },
};

/**
 * LinkedInPosts — responsivt grid med post-cards.
 */
export default function LinkedInPosts() {
  const { lang } = useLanguage();
  const labels = LABELS[lang] ?? LABELS.da;
  const [posts, setPosts] = useState<LinkedInPost[]>([]);

  useEffect(() => {
    fetch('/api/public/linkedin-posts')
      .then((r) => (r.ok ? r.json() : { posts: [] }))
      .then((d) => setPosts(d.posts ?? []))
      .catch(() => {});
  }, []);

  /* Vis ikke sektionen hvis ingen posts */
  if (posts.length === 0) return null;

  return (
    <section className="py-20 bg-[#0a1020]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-blue-500/10 text-blue-400 px-4 py-1.5 rounded-full text-sm font-medium mb-4">
            <Linkedin className="w-4 h-4" />
            LinkedIn
          </div>
          <h2 className="text-3xl font-bold text-white mb-3">{labels.title}</h2>
          <p className="text-slate-400 max-w-xl mx-auto">{labels.subtitle}</p>
        </div>

        {/* Posts grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {posts.slice(0, 3).map((post) => (
            <a
              key={post.id}
              href={post.post_url}
              target="_blank"
              rel="noopener noreferrer"
              className="group bg-slate-800/40 border border-slate-700/50 rounded-xl overflow-hidden hover:border-blue-500/30 transition-all"
            >
              {/* Image */}
              {post.image_url && (
                <div className="aspect-video overflow-hidden bg-slate-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={post.image_url}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
              )}

              {/* Content */}
              <div className="p-5">
                <p className="text-slate-200 text-sm line-clamp-2 mb-3">
                  {lang === 'en' ? post.excerpt_en : post.excerpt_da}
                </p>
                <div className="flex items-center justify-between">
                  <time className="text-xs text-slate-400">
                    {new Date(post.published_at).toLocaleDateString(
                      lang === 'en' ? 'en-GB' : 'da-DK',
                      { year: 'numeric', month: 'short', day: 'numeric' }
                    )}
                  </time>
                  <span className="text-blue-400 text-xs font-medium flex items-center gap-1 group-hover:text-blue-300">
                    {labels.readMore}
                    <ExternalLink className="w-3 h-3" />
                  </span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
