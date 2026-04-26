# Environment Variables — per target

> **BIZZ-727 lesson:** `NEXT_PUBLIC_*` variables are inlined at **build time**.
> Setting them locally does NOT propagate to Vercel Preview/Production — they
> must be added to each Vercel environment **before** deployment, otherwise the
> next build will still be missing them. Verify all three targets when adding a
> secret.

Source of truth for variable names: `.env.local.example` (always kept current
with the canonical list). This document maps which targets each variable must
be present in.

## Legend

| Target       | Scope                                                         |
| ------------ | ------------------------------------------------------------- |
| `dev`        | Local `.env.local` — your laptop                              |
| `preview`    | Vercel Preview (feature branches, including `develop` → test) |
| `production` | Vercel Production (`main` branch → bizzassist.dk)             |

## Required variables per target

| Variable                             | dev | preview | production | Notes                                                                |
| ------------------------------------ | :-: | :-----: | :--------: | -------------------------------------------------------------------- |
| **App**                              |     |         |            |                                                                      |
| `NEXT_PUBLIC_APP_URL`                |  ✓  |    ✓    |     ✓      | Target-specific URL (localhost / test.bizzassist.dk / bizzassist.dk) |
| **Supabase**                         |     |         |            |                                                                      |
| `NEXT_PUBLIC_SUPABASE_URL`           |  ✓  |    ✓    |     ✓      | Each target is a separate Supabase project                           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`      |  ✓  |    ✓    |     ✓      | "                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`          |  ✓  |    ✓    |     ✓      | Restricted — never expose client-side                                |
| `SUPABASE_ACCESS_TOKEN`              |  ✓  |    ✓    |     ✓      | Management API for schema operations                                 |
| **Auth / Sentry**                    |     |         |            |                                                                      |
| `NEXT_PUBLIC_SENTRY_DSN`             |  ✓  |    ✓    |     ✓      | Can point to the same Sentry project per env tag                     |
| **AI**                               |     |         |            |                                                                      |
| `BIZZASSIST_CLAUDE_KEY`              |  ✓  |    ✓    |     ✓      | Anthropic API key                                                    |
| `BRAVE_SEARCH_API_KEY`               |  ✓  |    ✓    |     ✓      | Brave web search for AI tools                                        |
| **Maps (critical for BIZZ-727)**     |     |         |            |                                                                      |
| `NEXT_PUBLIC_MAPBOX_TOKEN`           |  ✓  |    ✓    |     ✓      | **Build-time inlined — set in ALL 3 targets before deploy**          |
| **External data (Datafordeler)**     |     |         |            |                                                                      |
| `DATAFORDELER_USER`                  |  ✓  |    ✓    |     ✓      | BBR/MAT/DAR/VUR access                                               |
| `DATAFORDELER_PASS`                  |  ✓  |    ✓    |     ✓      | "                                                                    |
| **External data (CVR)**              |     |         |            |                                                                      |
| `CVR_ES_USER`                        |  ✓  |    ✓    |     ✓      | Erhvervsstyrelsen system-to-system                                   |
| `CVR_ES_PASS`                        |  ✓  |    ✓    |     ✓      | "                                                                    |
| **Stripe**                           |     |         |            |                                                                      |
| `STRIPE_SECRET_KEY`                  |  ✓  |    ✓    |     ✓      | `sk_test_*` in dev/preview, `sk_live_*` in prod                      |
| `STRIPE_WEBHOOK_SECRET`              |  ✓  |    ✓    |     ✓      | Per-env; webhooks have separate endpoints                            |
| **Email (Resend)**                   |     |         |            |                                                                      |
| `RESEND_API_KEY`                     |  ✓  |    ✓    |     ✓      | Optional in dev — logs instead when unset                            |
| **SMS (Twilio)**                     |     |         |            |                                                                      |
| `TWILIO_ACCOUNT_SID`                 |  ✓  |    ✓    |     ✓      |                                                                      |
| `TWILIO_AUTH_TOKEN`                  |  ✓  |    ✓    |     ✓      |                                                                      |
| **Rate limiting (Upstash)**          |     |         |            |                                                                      |
| `UPSTASH_REDIS_REST_URL`             |  ✓  |    ✓    |     ✓      |                                                                      |
| `UPSTASH_REDIS_REST_TOKEN`           |  ✓  |    ✓    |     ✓      |                                                                      |
| **Cron**                             |     |         |            |                                                                      |
| `CRON_SECRET`                        |  ✓  |    ✓    |     ✓      | Bearer token for `/api/cron/*` endpoints                             |
| **Domain feature (BIZZ-696+)**       |     |         |            |                                                                      |
| `NEXT_PUBLIC_DOMAIN_FEATURE_ENABLED` |  ✓  |    ✓    |     —      | `true` in dev/preview; unset in prod until launch                    |
| `DOMAIN_FEATURE_KILL_SWITCH`         |  —  |    —    |     —      | Set to `1` for emergency off-switch (no redeploy needed)             |
| `DOMAIN_ANOMALY_ALERT_EMAIL`         |  —  |    —    |     ✓      | Super-admin recipient for `/api/cron/domain-anomalies`               |
| **Misc**                             |     |         |            |                                                                      |
| `EMAIL_FROM_ADDRESS`                 |  —  |    ✓    |     ✓      | Defaults to `noreply@bizzassist.dk`                                  |
| `JIRA_API_TOKEN`                     |  ✓  |    —    |     —      | Only for local ops scripts; not needed server-side                   |

## How to add/update a Vercel env var

1. Go to https://vercel.com/itmgtconsulting/bizzassist/settings/environment-variables
2. Click **Add New** — enter the name exactly, select the target(s) you want.
3. **Important for `NEXT_PUBLIC_*` vars:** After saving, **trigger a new deployment**
   — build-time inlining means the value only appears in bundles built **after**
   the env var existed. Saving the variable alone is not sufficient.
4. Verify on the deployed URL that the new value is present.

## Cross-environment gotchas (from real incidents)

- **BIZZ-727 (2026-04-22):** `NEXT_PUBLIC_MAPBOX_TOKEN` was only set in Production,
  not Preview. Result: maps entirely broken on test.bizzassist.dk. Fix: add to
  Preview + redeploy `develop`.
- **`.env.local` ≠ Vercel:** The local file is only for `next dev`. It never
  propagates. Treat the three environments as three separate secret stores.
- **Session replays (Sentry):** PII masking config must be identical across all
  three targets — divergence leaks PII to Sentry in only some environments.
