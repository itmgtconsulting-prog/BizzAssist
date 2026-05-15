/**
 * TEMP debug endpoint — verify which Datafordeler/Tinglysning env vars are
 * actually present at runtime on Vercel. Returns lengths + first 4 chars
 * (no secrets exposed). Authed via CRON_SECRET.
 *
 * Remove after BIZZ-cron-fix verification.
 */
import { NextRequest, NextResponse } from 'next/server';
import { safeCompare } from '@/lib/safeCompare';

export const runtime = 'nodejs';

const KEYS_TO_CHECK = [
  'DATAFORDELER_OAUTH_CLIENT_ID',
  'DATAFORDELER_OAUTH_CLIENT_SECRET',
  'DATAFORDELER_USER',
  'DATAFORDELER_PASS',
  'DATAFORDELER_API_KEY',
  'DATAFORDELER_CERT_PATH',
  'DATAFORDELER_CERT_PASSWORD',
  'TINGLYSNING_CERT_B64',
  'TINGLYSNING_CERT_PASSWORD',
  'TINGLYSNING_BASE_URL',
  'DF_PROXY_URL',
  'DF_PROXY_SECRET',
  'CRON_SECRET',
  'NODE_ENV',
  'VERCEL_ENV',
  'VERCEL_URL',
];

/** GET — auth + return env presence map. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!safeCompare(auth, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result: Record<string, { length: number; preview: string }> = {};
  for (const key of KEYS_TO_CHECK) {
    const v = process.env[key] ?? '';
    result[key] = {
      length: v.length,
      preview: v.length > 4 ? v.slice(0, 4) + '...' : v,
    };
  }
  return NextResponse.json({ env: result, runtime: 'nodejs' });
}
