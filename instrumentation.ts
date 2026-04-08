/**
 * Next.js instrumentation hook — runs once on server startup.
 *
 * @sentry/nextjs v8+ uses this hook to initialise Sentry on the server and
 * edge runtimes. This replaces the old `_app.tsx` / manual `Sentry.init()`
 * approach and ensures Sentry is ready before any API route handles a request.
 *
 * The runtime guard (`NEXT_RUNTIME`) ensures the correct Sentry config is
 * loaded for each environment:
 *   - 'nodejs'  → sentry.server.config.ts (Node.js API routes)
 *   - 'edge'    → sentry.edge.config.ts   (Middleware / edge functions)
 *
 * @see https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}
