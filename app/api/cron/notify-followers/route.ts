/**
 * Cron/endpoint: E-mail-notifikation til følgere — /api/cron/notify-followers
 *
 * Sender e-mail til brugere når en ejendom/virksomhed/person, de følger, er
 * blevet ændret. Selve logikken ligger i app/lib/notifyFollowers.ts og deles
 * med poll-properties-cronen (tail-kald), så daglig afsendelse sker uden en
 * ekstra Vercel-cron (hård grænse ≤39 crons).
 *
 * Denne route er primært til MANUEL/EKSTERN trigger og til simulation/test.
 *
 * Sikring:
 *   - Kræver CRON_SECRET som Bearer token (+ x-vercel-cron i produktion)
 *   - Logikken bruger admin client (service_role)
 *
 * Trigger: GET med Authorization: Bearer <CRON_SECRET>
 *
 * @module api/cron/notify-followers
 */
import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';
import { withCronMonitor } from '@/app/lib/cronMonitor';
import { dispatchFollowerEmails } from '@/app/lib/notifyFollowers';

export const maxDuration = 300;

/** Vercel Cron — kræver CRON_SECRET som Bearer token i Authorization-header */
function verifyCronSecret(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV === 'production' && request.headers.get('x-vercel-cron') !== '1') {
    return false;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = request.headers.get('authorization') ?? '';
  return safeCompare(auth, `Bearer ${secret}`);
}

/**
 * GET /api/cron/notify-followers
 *
 * Afsender e-mails for alle ikke-afsendte change-notifikationer på tværs af
 * alle tenants. Returnerer antal afsendte og fejlede.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return withCronMonitor(
    { jobName: 'notify-followers', schedule: 'manual', intervalMinutes: 1440 },
    async () => {
      const result = await dispatchFollowerEmails();
      return NextResponse.json({ ok: true, ...result });
    }
  );
}
