# Runbook — Stripe Webhook Delivery

**Audience:** Oncall engineer investigating why a customer's payment or subscription change was not reflected in BizzAssist.

**Related:**

- `docs/runbooks/STRIPE_PAYMENT_FAILURES.md` — what happens _after_ a payment fails (grace, dunning, emails)
- `docs/adr/0002-stripe-dunning-strategy.md` — design rationale
- `app/api/stripe/webhook/route.ts` — handler code (1142 lines, well-documented JSDoc)

---

## 1. Symptom check — is the customer actually affected?

Before diving into webhook delivery, verify the actual state:

| Check                           | How                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Stripe invoice status**       | Stripe Dashboard > Customers > find by email > Invoices. Is the invoice `paid`?                                       |
| **Supabase subscription state** | Supabase > Authentication > find user > `app_metadata.subscription`. Check `status`, `planId`, `isPaid`.              |
| **Email sent?**                 | Resend dashboard (resend.com) > search by customer email. Look for "Payment confirmation" or "Payment failed" emails. |

If Stripe says `paid` but Supabase still shows `pending` or `payment_failed`, the webhook was likely not delivered or not processed correctly.

---

## 2. Stripe event lookup

1. Go to **Stripe Dashboard > Developers > Events**
2. Filter by customer email or event type (e.g. `invoice.payment_succeeded`)
3. Click the event to see:
   - **Webhook attempts** — how many delivery attempts, response codes
   - **Pending webhooks** — count of events still being retried
   - **Response body** — what our endpoint returned

### What to look for

| Symptom                                 | Likely cause                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `200 OK` response but state not updated | Handler processed but `resolveUserId` returned null (user not found). Check Sentry.                   |
| `400` response                          | Signature verification failed. Wrong `STRIPE_WEBHOOK_SECRET` for this environment.                    |
| `500` response                          | Handler threw an unhandled error. This should NOT happen (see invariant below) but check Sentry.      |
| `0` attempts, no delivery               | Webhook endpoint not enabled for this event type, or endpoint is disabled.                            |
| Delivery to wrong environment           | Event went to `test.bizzassist.dk` instead of `bizzassist.dk` (or vice versa). Check endpoint config. |

---

## 3. Webhook endpoints

BizzAssist has two Stripe webhook endpoints:

| Environment    | URL                                             | Events                    |
| -------------- | ----------------------------------------------- | ------------------------- |
| **Production** | `https://bizzassist.dk/api/stripe/webhook`      | All 6 handled event types |
| **Preview**    | `https://test.bizzassist.dk/api/stripe/webhook` | All 6 handled event types |

Each has its own `STRIPE_WEBHOOK_SECRET` (signing key). The secret must match the endpoint — using the wrong one causes `400 Signature verification failed`.

### Handled event types

```
checkout.session.completed
customer.subscription.updated
customer.subscription.deleted
invoice.payment_succeeded
invoice.payment_failed
charge.failed
```

To verify: Stripe Dashboard > Developers > Webhooks > click endpoint > "Listening for events".

---

## 4. User resolution (3-step fallback)

Every handler uses `resolveUserId()` to find the Supabase user:

1. **Direct lookup** by `supabase_user_id` from Stripe metadata
2. **Scan** `auth.users` for matching `app_metadata.stripe_customer_id`
3. **Scan** `auth.users` for matching email

If all 3 fail, the handler:

- Captures a Sentry message: `[stripe/webhook] Unmatched <event_type>`
- Returns `200` (never 500 — see invariant)
- The event is NOT retried (200 = acknowledged)

### Debugging unmatched events

Search Sentry for `Unmatched` with tag `webhook_event=<event_type>`. The `extra` context includes:

- `attempted_user_id` — the metadata value Stripe sent
- `attempted_customer_id` — the Stripe customer ID
- `attempted_email` — the customer's email

Common causes:

- User was deleted from Supabase after subscribing (test cleanup)
- Stripe metadata has stale `supabase_user_id` from a previous environment
- Customer email changed in Stripe but not in Supabase

---

## 5. Replaying a failed event

If a webhook was delivered but processing failed (visible in Sentry), you can replay it:

1. Stripe Dashboard > Developers > Events
2. Find the specific event
3. Click **"Resend"** on the webhook endpoint delivery
4. Stripe will re-deliver with the same payload and a new signature

The handler is idempotent for all event types — safe to replay.

---

## 6. Sentry signals

Search Sentry with these tags:

| Tag             | Values                                                                       | Meaning                                           |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `webhook_event` | `checkout.session.completed`, `customer.subscription.updated`, etc.          | Which handler ran                                 |
| `step`          | `planTokensUsed_reset`, `status_reset`, `email_dispatch`, `invoice_retrieve` | Which step within a handler failed                |
| `failure_code`  | `card_declined`, `insufficient_funds`, etc.                                  | Stripe charge failure reason (charge.failed only) |

### Common Sentry searches

- `Unmatched` — webhook couldn't find a Supabase user
- `webhook_event:invoice.payment_failed` — payment failure processed
- `webhook_event:charge.failed step:invoice_retrieve` — charge.failed couldn't find parent invoice

---

## 7. Never-return-500 invariant

**Critical:** The webhook handler must NEVER return HTTP 500.

Returning 500 causes Stripe to retry the event with exponential backoff for up to 3 days. This can create:

- Duplicate processing if the issue was transient
- Alert fatigue from repeated Sentry errors
- Delayed processing of subsequent events (Stripe serializes retries per endpoint)

Instead, all handlers catch errors internally, report to Sentry, and return `200 { received: true }`. If you see a 500 in Stripe delivery logs, it's a bug that must be fixed immediately.

---

## 8. Quick reference: manual state fix

If a webhook was permanently lost and needs manual correction:

```sql
-- Find user in Supabase
SELECT id, email, raw_app_meta_data->'subscription' as sub
FROM auth.users
WHERE email = 'customer@example.com';

-- Fix subscription state (use admin API, not direct SQL)
-- POST /api/admin/subscription
-- { "email": "customer@example.com", "action": "set", "planId": "basis", "status": "active" }
```

Always use the admin API (`/api/admin/subscription`) rather than direct SQL to ensure audit logging and consistent state transitions.

---

## 9. Escalation

If you cannot resolve the issue:

1. Check `docs/runbooks/STRIPE_PAYMENT_FAILURES.md` for payment-specific scenarios
2. Review `app/api/stripe/webhook/route.ts` JSDoc for handler-specific logic
3. Search Sentry for the event ID (Stripe event IDs start with `evt_`)
