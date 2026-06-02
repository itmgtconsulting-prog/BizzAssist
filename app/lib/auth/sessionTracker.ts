/**
 * Session Tracker — device fingerprint + session registration (BIZZ-1875).
 *
 * Server-side utility that registers a user session in `user_sessions`
 * and terminates sessions from other devices. Called after successful login.
 *
 * Device fingerprint = SHA256(User-Agent + IP). Not perfect — but combined
 * with the existing IP-based auth.sessions cleanup it provides a reasonable
 * single-session-per-device guarantee.
 *
 * @module app/lib/auth/sessionTracker
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

/**
 * Parse User-Agent to a human-readable device label.
 *
 * @param ua - Raw User-Agent string
 * @returns Short label like "Chrome 120 on Windows"
 */
export function parseDeviceLabel(ua: string): string {
  if (!ua) return 'Ukendt enhed';

  let browser = 'Ukendt browser';
  if (ua.includes('Edg/')) {
    const m = ua.match(/Edg\/([\d.]+)/);
    browser = `Edge ${m?.[1]?.split('.')[0] ?? ''}`;
  } else if (ua.includes('Chrome/')) {
    const m = ua.match(/Chrome\/([\d.]+)/);
    browser = `Chrome ${m?.[1]?.split('.')[0] ?? ''}`;
  } else if (ua.includes('Firefox/')) {
    const m = ua.match(/Firefox\/([\d.]+)/);
    browser = `Firefox ${m?.[1]?.split('.')[0] ?? ''}`;
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    const m = ua.match(/Version\/([\d.]+)/);
    browser = `Safari ${m?.[1]?.split('.')[0] ?? ''}`;
  }

  let os = '';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  return os ? `${browser} on ${os}` : browser;
}

/**
 * Generate a device fingerprint from User-Agent + IP.
 * Uses a simple hash — not cryptographically perfect but sufficient
 * for session grouping.
 *
 * @param userAgent - User-Agent header
 * @param ip - Client IP address
 * @returns Hex fingerprint string
 */
export async function generateFingerprint(userAgent: string, ip: string): Promise<string> {
  const raw = `${userAgent}|${ip}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Register a session for the current user+device.
 * If sessions from other devices exist, revoke them.
 *
 * @param userId - Authenticated user ID
 * @param tenantId - Optional tenant ID
 * @param userAgent - User-Agent header
 * @param ip - Client IP address
 * @returns Number of other-device sessions revoked
 */
export async function registerSession(
  userId: string,
  tenantId: string | null,
  userAgent: string,
  ip: string
): Promise<{ revokedCount: number }> {
  const fingerprint = await generateFingerprint(userAgent, ip);
  const deviceLabel = parseDeviceLabel(userAgent);
  const admin = createAdminClient();
  let revokedCount = 0;

  try {
    // Upsert current session (ON CONFLICT updates last_active + ip)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from('user_sessions').upsert(
      {
        user_id: userId,
        tenant_id: tenantId,
        device_fingerprint: fingerprint,
        device_label: deviceLabel,
        ip_address: ip,
        last_active: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: 'user_id,device_fingerprint' }
    );

    // Revoke sessions from OTHER devices
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: otherSessions } = await (admin as any)
      .from('user_sessions')
      .select('id, device_fingerprint')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .neq('device_fingerprint', fingerprint);

    if (otherSessions && otherSessions.length > 0) {
      const otherIds = (otherSessions as Array<{ id: string }>).map((s) => s.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from('user_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .in('id', otherIds);

      revokedCount = otherIds.length;
      logger.log(`[sessionTracker] Revoked ${revokedCount} sessions from other devices`, {
        userId,
        fingerprint: fingerprint.slice(0, 8),
      });
    }
  } catch (err) {
    // Non-fatal — login should still work
    logger.warn('[sessionTracker] Error registering session', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }

  return { revokedCount };
}
