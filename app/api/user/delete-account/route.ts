/**
 * GDPR Article 17 — Right to Erasure / Account deletion.
 *
 * DELETE /api/user/delete-account
 *
 * Permanently deletes ALL personal data for the authenticated user and
 * removes their Supabase Auth account. This action is irreversible.
 *
 * Flow:
 *   1. Authenticate via Supabase session
 *   2. Require body: { confirm: "SLET MIN KONTO" } to prevent accidental deletion
 *   3. Resolve the user's tenant and schema
 *   4. Delete tenant-scoped personal data:
 *      - recent_entities, saved_entities, notifications, recent_searches, activity_log
 *      - ai_messages, ai_conversations (BIZZ-288: GDPR Art. 17 immediate erasure)
 *      - document_embeddings, ai_token_usage, support_chat_sessions
 *   5. Write an audit log entry before account is removed
 *   6. Delete the Supabase Auth user (cascades sessions, MFA factors)
 *
 * @returns 200 { ok: true } on success
 * @returns 400 if confirmation phrase is missing or wrong
 * @returns 401 if user is not authenticated
 * @returns 500 on unexpected server errors
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';
import { sendAccountDeletionEmail } from '@/app/lib/email';

/** The exact phrase the user must type to confirm account deletion. */
const CONFIRM_PHRASE = 'SLET MIN KONTO';

/**
 * Inserts a row into audit_log using an untyped client cast.
 * The audit_log table is not in the generated Supabase types.
 * Fire-and-forget — errors are only logged, never re-thrown.
 *
 * @param admin - Admin Supabase client
 * @param entry - Audit log entry fields
 */
async function insertAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  entry: { action: string; resource_type: string; resource_id: string; metadata: string }
): Promise<void> {
  try {
    await admin.from('audit_log').insert(entry);
  } catch (e: unknown) {
    logger.error('[audit] Failed to insert audit log:', e);
  }
}

/**
 * DELETE /api/user/delete-account
 *
 * Self-service GDPR erasure endpoint. Requires the confirmation phrase
 * "SLET MIN KONTO" in the request body to prevent accidental deletion.
 *
 * @param request - Incoming DELETE request with JSON body { confirm: string }
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  // ── Step 1: Authenticate ────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Ikke logget ind' }, { status: 401 });
  }

  // ── Step 2: Require confirmation phrase ────────────────────────────────
  let body: { confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldigt request body' }, { status: 400 });
  }

  if (body?.confirm !== CONFIRM_PHRASE) {
    return NextResponse.json(
      { error: `Bekræftelsesfrasen er forkert. Skriv "${CONFIRM_PHRASE}" for at bekræfte.` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  try {
    // ── Step 3: Resolve tenant membership and schema ──────────────────────
    const { data: membership } = await admin
      .from('tenant_memberships')
      .select('tenant_id')
      .eq('user_id', user.id)
      .limit(1)
      .single();

    const tenantId: string | null = membership?.tenant_id ?? null;

    // ── Step 4: Cascade-delete tenant-scoped personal data ────────────────
    if (tenantId) {
      const { data: tenantRow } = await admin
        .from('tenants')
        .select('schema_name')
        .eq('id', tenantId)
        .single();

      const schemaName: string | null = tenantRow?.schema_name ?? null;

      if (schemaName) {
        const db = tenantDb(schemaName);

        // Delete personal data from all tenant-schema tables.
        // Errors are non-fatal: the auth deletion below is the definitive erasure.
        // BIZZ-128/BIZZ-288: all tables must be covered to satisfy GDPR Art. 17.
        await db.from('recent_entities').delete().eq('user_id', user.id);
        await db.from('saved_entities').delete().eq('user_id', user.id);
        await db.from('notifications').delete().eq('user_id', user.id);
        await db.from('recent_searches').delete().eq('user_id', user.id);
        await db.from('activity_log').delete().eq('user_id', user.id);

        // BIZZ-288: Delete AI conversation history (messages first, then conversations)
        const { data: convos } = await db
          .from('ai_conversations')
          .select('id')
          .eq('user_id', user.id);
        if (convos && convos.length > 0) {
          const convoIds = convos.map((c: { id: string }) => c.id);
          await db.from('ai_messages').delete().in('conversation_id', convoIds);
          await db.from('ai_conversations').delete().eq('user_id', user.id);
        }

        // BIZZ-288: Delete user-uploaded knowledge embeddings
        await db.from('document_embeddings').delete().eq('uploaded_by', user.id);

        // BIZZ-288: Delete AI token usage records
        await db.from('ai_token_usage').delete().eq('user_id', user.id);

        // BIZZ-288: Delete support chat sessions
        await db.from('support_chat_sessions').delete().eq('user_id', user.id);

        // Drop the now-empty schema so re-registration with the same email is clean.
        try {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
          if (supabaseUrl && accessToken) {
            const projectRef = supabaseUrl.replace('https://', '').split('.')[0];
            await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ query: `DROP SCHEMA IF EXISTS ${schemaName} CASCADE` }),
              signal: AbortSignal.timeout(10000),
            });
          }
        } catch (dropErr) {
          logger.error('[delete-account] Schema drop error (non-fatal):', dropErr);
        }

        // Remove membership and tenant record — re-registration must start clean.
        await admin.from('tenant_memberships').delete().eq('tenant_id', tenantId);
        await admin.from('tenants').delete().eq('id', tenantId);
      }
    }

    // ── Step 5: Audit log BEFORE auth deletion (row disappears after) ─────
    await insertAuditLog(admin, {
      action: 'user.self_deleted',
      resource_type: 'user',
      resource_id: user.id,
      metadata: JSON.stringify({ tenantId }),
    });

    // ── Step 6: Send deletion confirmation BEFORE auth deletion ────────────
    // BIZZ-272: Email must be sent while user record still exists
    if (user.email) {
      sendAccountDeletionEmail(user.email);
    }

    // ── Step 7: Delete auth user (cascades sessions, MFA, tokens) ─────────
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) {
      logger.error('[delete-account] Auth deletion error:', deleteError.code ?? '[DB error]');
      return NextResponse.json({ error: 'Kontosletning mislykkedes' }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[delete-account] Unexpected error:', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
