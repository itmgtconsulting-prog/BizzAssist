/**
 * Notification generation helper.
 *
 * Creates notifications in the tenant's notifications table.
 * Used by cron jobs and API routes to notify users about events:
 * - Property valuation changes (poll-properties cron)
 * - Ownership changes (pull-bbr-events cron)
 * - Subscription events (Stripe webhook)
 * - Team membership changes (future)
 *
 * BIZZ-273: Centralized notification creation.
 *
 * @module app/lib/notifications
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

export type NotificationType =
  | 'property_valuation_changed'
  | 'property_owner_changed'
  | 'subscription_renewed'
  | 'subscription_expiring'
  | 'team_member_joined'
  | 'system_alert'
  | 'info';

export interface CreateNotificationParams {
  /** Tenant ID — notification is scoped to this tenant */
  tenantId: string;
  /** User ID — who should see this notification (null = all tenant members) */
  userId: string | null;
  /** Notification type for filtering/categorization */
  type: NotificationType;
  /** Short title (displayed as heading in dropdown) */
  title: string;
  /** Optional longer description */
  body?: string;
  /** Optional link to navigate to when clicked */
  link?: string;
  /** Optional metadata for programmatic use */
  metadata?: Record<string, unknown>;
}

/**
 * Creates a notification in the tenant's notifications table.
 * Fire-and-forget — errors are logged but never thrown.
 *
 * @param params - Notification parameters
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  try {
    const admin = createAdminClient();
    const schemaName = `tenant_${params.tenantId.replace(/-/g, '_')}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .schema(schemaName)
      .from('notifications')
      .insert({
        tenant_id: params.tenantId,
        user_id: params.userId,
        type: params.type,
        title: params.title,
        body: params.body ?? null,
        link: params.link ?? null,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        is_read: false,
      });
  } catch (e) {
    logger.error('[notifications] Failed to create notification:', e);
  }
}

/**
 * Creates notifications for all members of a tenant.
 * Useful for system-wide announcements or property change alerts.
 *
 * @param params - Notification parameters (userId ignored, sent to all members)
 */
export async function notifyAllTenantMembers(
  params: Omit<CreateNotificationParams, 'userId'>
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: members } = await admin
      .from('tenant_memberships')
      .select('user_id')
      .eq('tenant_id', params.tenantId);

    if (!members || members.length === 0) return;

    for (const member of members) {
      await createNotification({
        ...params,
        userId: member.user_id,
      });
    }
  } catch (e) {
    logger.error('[notifications] Failed to notify tenant members:', e);
  }
}
