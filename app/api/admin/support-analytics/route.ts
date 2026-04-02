/**
 * Admin support analytics API — /api/admin/support-analytics
 *
 * Returns aggregated statistics from the support_questions table.
 * Used by the admin analytics page to identify FAQ gaps.
 *
 * GET — returns question stats: total, matched/unmatched, top questions, daily counts
 *
 * Only accessible by the admin user (verified via Supabase session).
 *
 * @module api/admin/support-analytics
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/** Row shape from the support_questions table. */
interface SupportQuestion {
  question: string;
  answer: string | null;
  matched: boolean;
  lang: string;
  page: string | null;
  created_at: string;
}

export async function GET() {
  // ── Auth check ──
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  const admin = createAdminClient();

  // Check admin role in app_metadata
  const { data: freshUser } = await admin.auth.admin.getUserById(user.id);
  if (!freshUser?.user?.app_metadata?.isAdmin) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  // ── Fetch all questions (last 30 days) ──
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: questions, error } = (await admin
    .from('support_questions')
    .select('question, answer, matched, lang, page, created_at')
    .gte('created_at', thirtyDaysAgo)
    .order('created_at', { ascending: false })
    .limit(500)) as { data: SupportQuestion[] | null; error: { message: string } | null };

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = questions ?? [];

  // ── Aggregate stats ──
  const total = rows.length;
  const matched = rows.filter((q) => q.matched).length;
  const unmatched = total - matched;

  // Top unmatched questions (grouped by similarity — simple lowercase dedup)
  const unmatchedMap = new Map<string, number>();
  for (const q of rows) {
    if (!q.matched) {
      const key = q.question.toLowerCase().trim();
      unmatchedMap.set(key, (unmatchedMap.get(key) ?? 0) + 1);
    }
  }
  const topUnmatched = [...unmatchedMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([question, count]) => ({ question, count }));

  // Daily counts (last 14 days)
  const dailyCounts: Record<string, { total: number; matched: number }> = {};
  for (const q of rows) {
    const day = q.created_at.slice(0, 10);
    if (!dailyCounts[day]) dailyCounts[day] = { total: 0, matched: 0 };
    dailyCounts[day].total++;
    if (q.matched) dailyCounts[day].matched++;
  }

  // Language split
  const langSplit = { da: 0, en: 0 };
  for (const q of rows) {
    if (q.lang === 'en') langSplit.en++;
    else langSplit.da++;
  }

  // Top pages
  const pageMap = new Map<string, number>();
  for (const q of rows) {
    if (q.page) pageMap.set(q.page, (pageMap.get(q.page) ?? 0) + 1);
  }
  const topPages = [...pageMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([page, count]) => ({ page, count }));

  // Recent unmatched (for quick review)
  const recentUnmatched = rows
    .filter((q) => !q.matched)
    .slice(0, 10)
    .map((q) => ({
      question: q.question,
      lang: q.lang,
      page: q.page,
      createdAt: q.created_at,
    }));

  return NextResponse.json({
    total,
    matched,
    unmatched,
    matchRate: total > 0 ? Math.round((matched / total) * 100) : 0,
    langSplit,
    dailyCounts,
    topUnmatched,
    topPages,
    recentUnmatched,
  });
}
