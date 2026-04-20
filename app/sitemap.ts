/**
 * Pagineret XML sitemap for BizzAssist offentlige SEO-sider.
 *
 * Læser pre-genererede slug + entity_id-par fra `public.sitemap_entries`
 * (befolket af /api/cron/generate-sitemap) og serverer dem som Next.js
 * App Router paginerede sitemaps (max 50.000 URLs pr. fil).
 *
 * generateSitemaps() returnerer én entry pr. side baseret på det totale
 * antal rækker i sitemap_entries — Next.js genererer automatisk
 * /sitemap/0.xml, /sitemap/1.xml, etc.
 *
 * Statiske sider (forside, login, privacy etc.) er hardkodet som side 0
 * udover DB-rækkerne.
 *
 * ISR: Ingen revalidate her — data opdateres via cron, ikke ISR.
 *
 * @module app/sitemap
 */

import type { MetadataRoute } from 'next';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

// BIZZ-645: Dynamic rendering er nødvendigt — ellers statisk-genereres
// sitemap'et ved build-time mod et tomt sitemap_entries og serveres som
// <urlset></urlset> for altid indtil næste deploy. force-dynamic sikrer
// at data hentes fra Supabase på hver request. Traffik er lav (Googlebot
// + Bingbot primært) så Supabase-belastning er negligibel.
export const dynamic = 'force-dynamic';

// ─── Konstanter ────────────────────────────────────────────────────────────────

/** Antal URL-entries pr. sitemap-fil (Next.js max er 50.000) */
const PAGE_SIZE = 50_000;

/** Basis-URL til alle sitemap-entries — bruger env var med production fallback. */
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://bizzassist.dk').replace(/\/$/, '');

// ─── Statiske sider ────────────────────────────────────────────────────────────

/**
 * Hardkodet liste over statiske sider der altid medtages i sitemap.
 * Tilføjes på den første paginerede side (id=0) før DB-data.
 */
const STATIC_PAGES: MetadataRoute.Sitemap = [
  {
    url: BASE_URL,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 1.0,
  },
  {
    url: `${BASE_URL}/login`,
    lastModified: new Date(),
    changeFrequency: 'monthly',
    priority: 0.5,
  },
  {
    url: `${BASE_URL}/login/signup`,
    lastModified: new Date(),
    changeFrequency: 'monthly',
    priority: 0.6,
  },
  {
    url: `${BASE_URL}/privacy`,
    lastModified: new Date(),
    changeFrequency: 'yearly',
    priority: 0.2,
  },
  {
    url: `${BASE_URL}/terms`,
    lastModified: new Date(),
    changeFrequency: 'yearly',
    priority: 0.2,
  },
  {
    url: `${BASE_URL}/cookies`,
    lastModified: new Date(),
    changeFrequency: 'yearly',
    priority: 0.1,
  },
];

// ─── generateSitemaps ──────────────────────────────────────────────────────────

/**
 * Fortæller Next.js hvor mange paginerede sitemap-filer der skal genereres.
 * Kalder Supabase for at tælle det totale antal sitemap_entries.
 *
 * Returnerer altid mindst ét element ({ id: 0 }) så der altid er et sitemap
 * (indeholdende de statiske sider) selv når tabellen er tom.
 *
 * @returns Array af { id: number } objekter — ét pr. sitemap-fil
 */
export async function generateSitemaps(): Promise<Array<{ id: number }>> {
  try {
    const admin = createAdminClient();
    const { count, error } = await admin.from('sitemap_entries').select('*', {
      count: 'exact',
      head: true,
    });

    if (error) {
      logger.error('[sitemap] Kunne ikke tælle sitemap_entries:', error.message);
      return [{ id: 0 }];
    }

    const total = (count ?? 0) + STATIC_PAGES.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    return Array.from({ length: Math.max(pages, 1) }, (_, i) => ({ id: i }));
  } catch (err) {
    logger.error('[sitemap] generateSitemaps fejl:', err);
    return [{ id: 0 }];
  }
}

// ─── Default export ────────────────────────────────────────────────────────────

/**
 * Genererer én pagineret sitemap-fil.
 *
 * Side 0 indeholder de statiske sider efterfulgt af de første DB-entries.
 * Efterfølgende sider (id >= 1) indeholder udelukkende DB-entries.
 *
 * @param params - { id: number } — sidenummer (0-indekseret)
 * @returns MetadataRoute.Sitemap array med alle URL-entries for denne side
 */
export default async function sitemap({
  id,
}: {
  id: number | string;
}): Promise<MetadataRoute.Sitemap> {
  // BIZZ-645: Next.js leverer metadata-route id som string fra URL-segment
  // (fx "0" fra /sitemap/0.xml). Strict equality `id === 0` var derfor
  // altid false og staticEntries endte tom — selv på side 0. Coerce til
  // number før sammenligning.
  const pageId = typeof id === 'string' ? parseInt(id, 10) : id;
  // BIZZ-645: Log så vi kan se hvad der sker i prod logs hvis responset
  // er tomt. Fjernes når sitemap er bekræftet fungerende.
  logger.log(`[sitemap] called id=${id} pageId=${pageId}`);
  // Statiske sider injiceres kun på første side
  const staticEntries: MetadataRoute.Sitemap = pageId === 0 ? STATIC_PAGES : [];
  const staticCount = staticEntries.length;

  // DB-entries: beregn range med offset for statiske sider på side 0
  const dbOffset = pageId === 0 ? 0 : pageId * PAGE_SIZE - staticCount;
  const dbLimit = PAGE_SIZE - staticCount;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('sitemap_entries')
      .select('type, slug, entity_id, updated_at')
      .order('updated_at', { ascending: false })
      .range(dbOffset, dbOffset + dbLimit - 1);

    if (error) {
      logger.error('[sitemap] Kunne ikke hente sitemap_entries:', error.message);
      return staticEntries;
    }

    const dbEntries: MetadataRoute.Sitemap = (data ?? []).map((entry) => ({
      url:
        entry.type === 'ejendom'
          ? `${BASE_URL}/ejendom/${entry.slug}/${entry.entity_id}`
          : `${BASE_URL}/virksomhed/${entry.slug}/${entry.entity_id}`,
      lastModified: new Date(entry.updated_at),
      changeFrequency: 'monthly' as const,
      priority: entry.type === 'virksomhed' ? 0.8 : 0.7,
    }));

    logger.log(
      `[sitemap] id=${pageId} static=${staticCount} db=${dbEntries.length} total=${staticEntries.length + dbEntries.length}`
    );
    return [...staticEntries, ...dbEntries];
  } catch (err) {
    logger.error('[sitemap] sitemap() fejl:', err);
    return staticEntries;
  }
}
