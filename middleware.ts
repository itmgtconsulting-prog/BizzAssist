import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Global auth middleware — enforces Supabase session on dashboard and API routes.
 * BIZZ-191: missing middleware was a critical security gap (2026-04-08 audit).
 *
 * Public paths are explicitly allowlisted below — everything else requires
 * an authenticated Supabase session. Unauthenticated API calls get 401;
 * unauthenticated page visits are redirected to /login with a redirect param.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Public allowlist — no auth required ──
  const publicPaths = [
    '/',
    '/login',
    '/signup',
    '/api/auth',
    '/api/stripe/webhook', // Stripe needs raw body — exempt
    '/api/cron', // Protected by CRON_SECRET header separately
    '/manifest.json',
    '/sw.js',
    '/_next',
    '/favicon',
    '/icons',
    '/robots.txt',
  ];

  const isPublic = publicPaths.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (isPublic) return NextResponse.next();

  // ── Verify Supabase session ──
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const response = NextResponse.next();

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  // ── Unauthenticated: redirect or 401 ──
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except static files and Next.js internals.
     */
    '/((?!_next/static|_next/image|favicon\\.ico).*)',
  ],
};
