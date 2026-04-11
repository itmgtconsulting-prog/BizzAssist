/**
 * GET /api/user/export-data
 *
 * GDPR Article 20 — Personal data portability export.
 *
 * Collects all personal data stored for the authenticated user and returns it
 * as a downloadable JSON file. Data is scoped strictly to the requesting user;
 * the admin (service-role) client is used only to query tenant-schema tables
 * that RLS cannot directly expose cross-schema.
 *
 * Data included:
 *   - User profile (email, full_name, created_at)
 *   - Recent entities (recent_entities table in tenant schema)
 *   - Saved / tracked entities (saved_entities table in tenant schema)
 *   - Notifications (notifications table in tenant schema)
 *   - AI conversations + messages (ai_conversations + ai_messages in tenant schema)
 *
 * ISO 27001 A.18.1 — Compliance with legal requirements (GDPR).
 * No PII is logged; the export file is streamed directly to the client.
 *
 * @returns JSON attachment  mine-data-YYYY-MM-DD.json
 */

import { NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient, tenantDb } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the exported JSON file */
interface UserDataExport {
  exportedAt: string;
  gdprArticle: '20';
  profile: {
    id: string;
    email: string | undefined;
    fullName: string | undefined;
    createdAt: string | undefined;
  };
  recentEntities: unknown[];
  savedEntities: unknown[];
  notifications: unknown[];
  aiConversations: AiConversationExport[];
}

/** AI conversation with its messages bundled together */
interface AiConversationExport {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messages: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the tenant schema name from a tenant ID.
 *
 * @param tenantId - UUID of the tenant
 * @returns Schema name string, or null if not found
 */
async function getTenantSchema(tenantId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('tenants').select('schema_name').eq('id', tenantId).single();
  return data?.schema_name ?? null;
}

/**
 * Fetches all rows from a tenant-schema table for a given user.
 *
 * The admin client bypasses RLS; the user_id filter ensures data isolation.
 *
 * @param schemaName - Tenant-specific PostgreSQL schema (e.g. "tenant_abc123")
 * @param tableName  - Table within that schema
 * @param userId     - The authenticated user's UUID
 * @returns Array of rows, or empty array on error
 */
async function fetchUserRows(
  schemaName: string,
  tableName: string,
  userId: string
): Promise<unknown[]> {
  try {
    // Use the typed tenantDb helper — runtime schema name is cast via the helper
    // tableName is a runtime string; cast to a known table name to satisfy TypeScript.
    // The value is always one of: 'recent_entities', 'saved_entities', 'notifications'.
    type ExportTable = 'saved_entities' | 'notifications';
    const db = tenantDb(schemaName);
    const { data, error } = await db
      .from(tableName as ExportTable)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      // Table may not exist on older tenants — treat as empty rather than failing
      logger.warn(
        `[export-data] ${tableName} fetch skipped:`,
        (error as { message: string }).message
      );
      return [];
    }
    return (data as unknown[]) ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetches all AI conversations created by the user, then attaches messages
 * for each conversation. Returns bundled conversation+message objects.
 *
 * @param schemaName - Tenant PostgreSQL schema
 * @param userId     - Authenticated user UUID
 * @returns Array of conversations, each with a nested messages array
 */
async function fetchAiConversations(
  schemaName: string,
  userId: string
): Promise<AiConversationExport[]> {
  try {
    // Fetch conversations created by this user
    const db = tenantDb(schemaName);
    const { data: convos, error: convoErr } = await db
      .from('ai_conversations')
      .select('id, title, created_at, updated_at')
      .eq('created_by', userId)
      .order('created_at', { ascending: false });

    if (convoErr || !convos) {
      logger.warn('[export-data] ai_conversations fetch skipped:', convoErr?.message);
      return [];
    }

    const result: AiConversationExport[] = [];

    for (const convo of convos as Array<{
      id: string;
      title: string | null;
      created_at: string;
      updated_at: string;
    }>) {
      // Fetch messages for this conversation
      const { data: msgs } = await db
        .from('ai_messages')
        .select('role, content, tokens_used, created_at')
        .eq('conversation_id', convo.id)
        .order('created_at', { ascending: true });

      result.push({
        id: convo.id,
        title: convo.title,
        createdAt: convo.created_at,
        updatedAt: convo.updated_at,
        messages: (msgs as unknown[]) ?? [],
      });
    }

    return result;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/user/export-data
 *
 * Authenticates the user via Supabase session, collects all personal data
 * scoped to that user, and returns a downloadable JSON file.
 *
 * @returns 200 JSON attachment | 401 Unauthorized | 500 Server error
 */
export async function GET(): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ── User profile ─────────────────────────────────────────────────────
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const profile = {
      id: auth.userId,
      email: user?.email,
      fullName: (user?.user_metadata?.full_name as string | undefined) ?? undefined,
      createdAt: user?.created_at,
    };

    // ── Tenant schema ─────────────────────────────────────────────────────
    const schema = await getTenantSchema(auth.tenantId);

    // ── Parallel data collection ──────────────────────────────────────────
    const [recentEntities, savedEntities, notifications, aiConversations] = await Promise.all([
      schema ? fetchUserRows(schema, 'recent_entities', auth.userId) : Promise.resolve([]),
      schema ? fetchUserRows(schema, 'saved_entities', auth.userId) : Promise.resolve([]),
      schema ? fetchUserRows(schema, 'notifications', auth.userId) : Promise.resolve([]),
      schema ? fetchAiConversations(schema, auth.userId) : Promise.resolve([]),
    ]);

    // ── Assemble export payload ───────────────────────────────────────────
    const exportDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    const payload: UserDataExport = {
      exportedAt: new Date().toISOString(),
      gdprArticle: '20',
      profile,
      recentEntities,
      savedEntities,
      notifications,
      aiConversations,
    };

    const json = JSON.stringify(payload, null, 2);

    // ── Return as downloadable attachment ─────────────────────────────────
    return new NextResponse(json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="mine-data-${exportDate}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    logger.error('[export-data GET]', err);
    return NextResponse.json({ error: 'Serverfejl' }, { status: 500 });
  }
}
