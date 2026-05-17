/**
 * AI token-usage tracking helper (BIZZ-1594).
 *
 * Modparten til aiGate.ts: hvor `assertAiAllowed` BLOKERER kald før de
 * sker, PERSISTERER `recordAiUsage` token-forbrug efter Anthropic-kald
 * er færdige. Uden denne helper undgår AI-routes quota-tælleren —
 * gate'en blokerer aldrig, og brugere kan overskride deres månedlige
 * token-cap.
 *
 * Pipeline:
 *   1. Læs nuværende app_metadata.subscription.tokensUsedThisMonth fra Supabase auth
 *   2. Increment med summen af input+output tokens
 *   3. updateUserById opdaterer app_metadata for quota-gate
 *   4. INSERT audit-row i tenant.ai_token_usage (hvis tenant_id kendt) for per-route analyse
 *
 * Begge skridt er fail-soft (logger.warn + Sentry.captureException), så
 * en DB-fejl ikke break'r AI-svaret til brugeren. Token-tab er bedre end
 * en hængende response.
 *
 * Skal kaldes som SIDSTE skridt på AI-route handlers (typisk i en finally-
 * eller try-block efter `anthropic.messages.create`). Aldrig kald hvis
 * Claude-kaldet selv fejlede — vi vil ikke logge tokens for fejlende kald.
 *
 * @module app/lib/aiTracking
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import * as Sentry from '@sentry/nextjs';

/** Et single AI-token-forbrugsregistrering. */
export interface AiUsageRecord {
  /** Bruger-UUID fra resolveTenantId/auth */
  userId: string;
  /** Tenant-UUID (null hvis routen ikke er tenant-scoped — fx public AI-tools) */
  tenantId: string | null;
  /**
   * Route-identifier til per-tool rapportering. Anbefalet format:
   * `ai.<sub-tool>` fx `ai.chat`, `ai.article-search`,
   * `ai.generate-listing`. Stable strings — brug konstanter hvis muligt.
   */
  route: string;
  /** Input tokens fra response.usage.input_tokens */
  inputTokens: number;
  /** Output tokens fra response.usage.output_tokens */
  outputTokens: number;
  /** Claude model — fx 'claude-sonnet-4-6' (anbefalet at altid sætte) */
  model?: string;
}

/**
 * Persisterer AI-token-forbrug. Returnerer void — fail-soft og logger
 * fejl uden at kaste.
 *
 * @param record - { userId, tenantId, route, inputTokens, outputTokens, model? }
 */
export async function recordAiUsage(record: AiUsageRecord): Promise<void> {
  const total = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
  if (total <= 0) return;
  if (!record.userId) {
    logger.warn('[aiTracking] recordAiUsage: userId mangler — skipper', {
      route: record.route,
    });
    return;
  }

  const admin = createAdminClient();

  // ─── 1) Opdater app_metadata for quota-gate ─────────────────────────
  try {
    const { data: fresh, error: fetchErr } = await admin.auth.admin.getUserById(record.userId);
    if (fetchErr || !fresh?.user) {
      logger.warn('[aiTracking] getUserById failed', {
        route: record.route,
        userId: record.userId,
        err: fetchErr?.message,
      });
    } else {
      const meta = (fresh.user.app_metadata ?? {}) as Record<string, unknown>;
      const sub = ((meta.subscription as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      const currentUsed = typeof sub.tokensUsedThisMonth === 'number' ? sub.tokensUsedThisMonth : 0;
      const { error: updateErr } = await admin.auth.admin.updateUserById(record.userId, {
        app_metadata: {
          ...meta,
          subscription: { ...sub, tokensUsedThisMonth: currentUsed + total },
        },
      });
      if (updateErr) {
        logger.warn('[aiTracking] updateUserById failed', {
          route: record.route,
          userId: record.userId,
          err: updateErr.message,
        });
        Sentry.captureException(updateErr, { tags: { aiRoute: record.route } });
      }
    }
  } catch (err) {
    logger.warn('[aiTracking] updateUserById unexpected error', {
      route: record.route,
      err,
    });
    Sentry.captureException(err, { tags: { aiRoute: record.route } });
  }

  // ─── 2) INSERT audit-row i tenant.ai_token_usage ────────────────────
  // Kun hvis tenant_id kendt (public AI-tools uden tenant-scope skipper).
  if (record.tenantId) {
    try {
      const row = {
        tenant_id: record.tenantId,
        user_id: record.userId,
        route: record.route,
        tokens_in: record.inputTokens,
        tokens_out: record.outputTokens,
        model: record.model ?? 'unknown',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: insertErr } = await (admin.schema('tenant') as any)
        .from('ai_token_usage')
        .insert(row);
      if (insertErr) {
        logger.warn('[aiTracking] ai_token_usage insert failed', {
          route: record.route,
          tenantId: record.tenantId,
          err: insertErr.message,
        });
        Sentry.captureException(insertErr, { tags: { aiRoute: record.route } });
      }
    } catch (err) {
      logger.warn('[aiTracking] ai_token_usage insert unexpected error', {
        route: record.route,
        err,
      });
      Sentry.captureException(err, { tags: { aiRoute: record.route } });
    }
  }
}

/** Convenience: trække input/output tokens fra et Anthropic message response. */
export function extractTokenUsage(response: {
  usage?: { input_tokens?: number; output_tokens?: number };
}): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}
