/**
 * GET /api/public/linkedin-posts
 *
 * BIZZ-2041: Public endpoint for aktive LinkedIn-posts.
 * Ingen auth — bruges af marketing-hjemmeside.
 * Returnerer max 6 aktive posts sorteret efter sort_order.
 *
 * @returns { posts: LinkedInPost[] }
 */

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = createAdminClient() as any;
    const { data, error } = await admin
      .from('linkedin_featured_posts')
      .select('id, post_url, image_url, excerpt_da, excerpt_en, published_at')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('published_at', { ascending: false })
      .limit(6);

    if (error) {
      logger.error('[public/linkedin-posts] query fejl:', error.message);
      return NextResponse.json({ posts: [] });
    }

    return NextResponse.json({ posts: data ?? [] });
  } catch (err) {
    logger.error(
      '[public/linkedin-posts] uventet fejl:',
      err instanceof Error ? err.message : 'unknown'
    );
    return NextResponse.json({ posts: [] });
  }
}
