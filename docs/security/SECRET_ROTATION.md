# BizzAssist — Secret Rotation Policy

## Rotation Schedule

| Secret Type       | Service               | Rotation Interval | Key Env Vars                       |
| ----------------- | --------------------- | ----------------- | ---------------------------------- |
| API Keys          | Anthropic Claude      | 90 days           | `BIZZASSIST_CLAUDE_KEY`            |
| API Keys          | Brave Search          | 90 days           | `BRAVE_SEARCH_API_KEY`             |
| API Keys          | Mapbox                | 90 days           | `NEXT_PUBLIC_MAPBOX_TOKEN`         |
| API Keys          | Resend                | 90 days           | `RESEND_API_KEY`                   |
| API Keys          | Mediastack            | 90 days           | `MEDIASTACK_API_KEY`               |
| OAuth Secrets     | Datafordeler          | 180 days          | `DATAFORDELER_OAUTH_CLIENT_SECRET` |
| OAuth Secrets     | Google                | 180 days          | `GOOGLE_CLIENT_SECRET`             |
| OAuth Secrets     | LinkedIn              | 180 days          | `LINKEDIN_CLIENT_SECRET`           |
| Database          | Supabase Service Role | 90 days           | `SUPABASE_SERVICE_ROLE_KEY`        |
| mTLS Certificates | Tinglysning           | Expiry-based      | `TINGLYSNING_CERT_B64`             |
| mTLS Certificates | Datafordeler          | Expiry-based      | `DATAFORDELER_CERT_PFX_BASE64`     |
| Webhook Secrets   | Stripe                | 90 days           | `STRIPE_WEBHOOK_SECRET`            |
| Webhook Secrets   | Cron                  | 90 days           | `CRON_SECRET`                      |
| Infrastructure    | Upstash Redis         | 90 days           | `UPSTASH_REDIS_REST_TOKEN`         |
| Infrastructure    | Vercel                | 90 days           | `VERCEL_API_TOKEN`                 |
| Infrastructure    | GitHub                | 90 days           | `GITHUB_TOKEN`                     |
| SMS               | Twilio                | 90 days           | `TWILIO_AUTH_TOKEN`                |

## Rotation Procedure

### 1. API Keys (Anthropic, Brave, Mapbox, etc.)

1. Generate new key in the service's dashboard
2. Update `.env.local` and Vercel Environment Variables
3. Deploy and verify
4. Revoke old key after 24h buffer

### 2. OAuth Secrets (Datafordeler, Google, LinkedIn)

1. Create new client secret in the provider's dashboard
2. Update `.env.local` and Vercel
3. Deploy — existing sessions remain valid
4. Delete old secret after 48h buffer

### 3. mTLS Certificates (Tinglysning, Datafordeler)

- Monitored automatically by `checkAllCertificates()` in daily-status cron
- Alerts at 60d (INFO), 30d (WARNING), 14d (CRITICAL), 7d (BLOCKER)
- Renewal requires contacting the certificate issuer

### 4. Emergency Rotation (Secret Leaked)

1. **Immediately**: Generate new key and update Vercel
2. **Deploy**: Push to production within 30 minutes
3. **Revoke**: Delete the compromised key immediately after deploy
4. **Audit**: Check `audit_log` for unauthorized usage during exposure window
5. **Report**: Document in `docs/security/INCIDENT_RESPONSE.md`

## Monitoring

- Certificate expiry: Checked daily by `daily-status` cron (BIZZ-304)
- All secrets: Listed in `.env.local.example` (BIZZ-295)
- Pre-commit: gitleaks scans for accidentally committed secrets (BIZZ-291)
