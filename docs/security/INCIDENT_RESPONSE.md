# BizzAssist — Incident Response Procedure

**ISO 27001 A.16 — Information Security Incident Management**
Last updated: 2026-03-20

---

## Incident Classification

| Severity          | Definition                     | Examples                                                                                    |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| **P1 — Critical** | Active breach or data exposure | Cross-tenant data leak, credentials exposed, production DB accessible publicly              |
| **P2 — High**     | Security control failure       | Auth bypass, RLS policy broken, API returning wrong tenant's data                           |
| **P3 — Medium**   | Potential vulnerability        | Unvalidated input on internal route, missing rate limit, outdated dependency with known CVE |
| **P4 — Low**      | Minor or theoretical issue     | Verbose error message, non-critical dependency warning                                      |

---

## Detection Sources

1. **Sentry** — automatic error detection → JIRA ticket auto-created
2. **User report** — via BugReportModal on any page → JIRA ticket created
3. **Developer discovery** — during code review or testing
4. **Third-party notification** — Sentry smart alerts, Supabase anomaly alerts
5. **External researcher** — responsible disclosure (email: security@bizzassist.dk)

---

## Response Procedure

### Phase 1 — Identification (Target: within 1 hour)

- [ ] Confirm the incident is real (not a false positive)
- [ ] Classify severity (P1–P4)
- [ ] Assign owner in JIRA (label: `security-incident`, priority matches severity)
- [ ] Notify Jakob Juul Rasmussen immediately for P1 or P2

### Phase 2 — Containment (Target: P1=1h, P2=4h, P3=24h, P4=next sprint)

**P1 — Critical:**

- [ ] Take affected system offline or restrict access if possible
- [ ] Revoke exposed credentials immediately (rotate all secrets as precaution)
- [ ] Disable affected API endpoint if data is leaking
- [ ] Preserve logs for forensic analysis — do not clear or restart without preserving

**P2 — High:**

- [ ] Identify the specific broken control
- [ ] Apply hotfix or disable feature until fix is deployed
- [ ] Verify RLS policies are still effective for unaffected tenants

**P3/P4:**

- [ ] Create fix PR with label `security-fix`
- [ ] Fast-track through CODE REVIEWER
- [ ] Deploy in next available release window

### Phase 3 — Eradication

- [ ] Root cause identified and documented in JIRA
- [ ] Fix tested in staging before production deployment
- [ ] Security header and middleware checks verify the fix
- [ ] `npm audit` run to check for related vulnerabilities

### Phase 4 — Recovery

- [ ] Fix deployed to production
- [ ] Monitoring increased for 48 hours post-deployment
- [ ] Verify no data integrity issues (spot-check audit logs)
- [ ] Confirm Sentry is not still alerting on the same issue

### Phase 5 — Customer Notification (if data was affected)

Under GDPR Article 33 — if personal data was breached:

- [ ] Danish Data Protection Agency (Datatilsynet) notified within **72 hours**
- [ ] Affected customers notified without undue delay
- [ ] Notification includes: what happened, what data, what we've done, what they should do
- [ ] Communication drafted by Jakob Juul Rasmussen — not auto-generated

### Phase 6 — Post-Incident Review (within 5 days)

- [ ] Timeline reconstructed from logs and Sentry events
- [ ] Root cause documented in JIRA
- [ ] Contributing factors identified
- [ ] Remediation actions assigned and tracked
- [ ] ISMS and security guidelines updated if gaps found
- [ ] Review meeting with all relevant team members

---

## Contact Information

| Role             | Contact              | When to contact             |
| ---------------- | -------------------- | --------------------------- |
| Incident Owner   | Jakob Juul Rasmussen | All P1 and P2 incidents     |
| Supabase Support | support.supabase.com | DB-level incidents          |
| Sentry Support   | sentry.io/support    | Monitoring issues           |
| Danish DPA       | Datatilsynet.dk      | Data breach within 72 hours |

---

## Security Incident Log

All incidents are tracked in JIRA project `BIZZ` with:

- Label: `security-incident`
- Priority: Blocker (P1), Critical (P2), Major (P3), Minor (P4)
- Linked to: Root cause analysis comment, fix PR, post-mortem document

---

## Lessons Learned Template

After each P1 or P2 incident, add a comment to the JIRA ticket:

```
## Post-Incident Review — [Date]

**What happened:**
[Timeline]

**Root cause:**
[Technical explanation]

**Impact:**
[Data affected, tenants affected, duration]

**What worked well:**
[Detection speed, response actions]

**What needs improvement:**
[Gaps in monitoring, controls, process]

**Action items:**
- [ ] [Action] — Owner: [Name] — Due: [Date]
```
