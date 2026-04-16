# BizzAssist — Database Restore Runbook

## Overview

| Parameter       | Value                                                 |
| --------------- | ----------------------------------------------------- |
| **Database**    | Supabase PostgreSQL (EU West — Frankfurt)             |
| **Backup Type** | Automated daily + 7-day Point-in-Time Recovery (PITR) |
| **RTO Target**  | 4 hours                                               |
| **RPO Target**  | 24 hours                                              |
| **Responsible** | Jakob Juul Rasmussen (CTO)                            |

## 1. Full Database Restore (from daily backup)

### When to use

- Complete data loss or corruption
- Catastrophic failure affecting all tenants

### Steps

1. **Login** to Supabase Dashboard: https://supabase.com/dashboard
2. **Navigate** to the project (EU West region)
3. **Go to** Settings → Database → Backups
4. **Select** the backup closest to the desired restore point
5. **Click** "Restore" and confirm
6. **Wait** for restore to complete (typically 15-60 minutes)
7. **Verify** by querying `public.tenants` table
8. **Test** login flow on test.bizzassist.dk
9. **Verify** a sample property search returns data
10. **Document** actual RTO achieved

### Verification queries

```sql
-- Check tenant count
SELECT count(*) FROM public.tenants;

-- Check recent activity
SELECT max(created_at) FROM public.audit_log;

-- Check auth users
SELECT count(*) FROM auth.users;
```

## 2. Point-in-Time Recovery (PITR)

### When to use

- Need to recover to a specific timestamp (e.g., before a bad migration)
- Data corruption discovered within the last 7 days

### Steps

1. **Determine** the exact timestamp to recover to (check audit_log, git log)
2. **Login** to Supabase Dashboard
3. **Go to** Settings → Database → Point-in-Time Recovery
4. **Select** the target timestamp (UTC)
5. **Click** "Restore to point in time" and confirm
6. **Wait** for PITR to complete
7. **Verify** data integrity with queries above
8. **Check** that tenant schemas are intact:
   ```sql
   SELECT schema_name FROM public.tenants WHERE is_active = true;
   ```

## 3. Tenant-Specific Recovery

### When to use

- Single tenant's data is corrupted/lost
- Need to restore one tenant without affecting others

### Steps

1. **Identify** the affected tenant: `SELECT * FROM public.tenants WHERE slug = '<tenant-slug>';`
2. **Option A**: If tenant schema exists but has bad data:
   - Export good data from backup using pg_dump (Supabase CLI)
   - Import into the specific schema
3. **Option B**: If tenant schema is completely lost:
   - Run tenant provisioning function to recreate schema
   - User will need to re-enter company data

## 4. Emergency Contacts

| Role             | Name                 | Contact             |
| ---------------- | -------------------- | ------------------- |
| CTO / DB Owner   | Jakob Juul Rasmussen | jajr@pharmait.dk    |
| Supabase Support | Supabase Team        | support@supabase.io |
| Vercel Support   | Vercel Team          | Via dashboard       |

## 5. Post-Recovery Checklist

- [ ] Verify all tenant schemas exist (`SELECT schema_name FROM public.tenants`)
- [ ] Test login flow (email + Google OAuth)
- [ ] Test property search returns results
- [ ] Test AI chat responds
- [ ] Check Sentry for new errors post-restore
- [ ] Verify cron jobs are running (check `cron_heartbeats` table)
- [ ] Send status update to affected users if applicable
- [ ] Document incident in `docs/security/INCIDENT_RESPONSE.md`

## 6. Prevention

- **Daily backups**: Automated by Supabase
- **PITR**: Enabled with 7-day retention
- **Migration safety**: All migrations are reversible (per DBA checklist)
- **Pre-deploy testing**: CI runs tests before merge to main
- **Monitoring**: daily-status cron checks DB connectivity + cert expiry
