# Runbook — Stripe Payment Failures

**Audience:** Support + operations. Anyone responding to a user complaint about lost access or a stuck subscription.
**Related:** `docs/adr/0002-stripe-dunning-strategy.md` (the design), `app/api/stripe/webhook/route.ts` (the code).
**Tickets:** BIZZ-540, BIZZ-541, BIZZ-542, BIZZ-543.

---

## 1. Lifecycle at a glance

```
 Stripe charge                  BizzAssist state
 ─────────────                  ────────────────
 renewal attempt                subscription.status = 'active', isPaid=true
        │
        ▼ fails
 charge.failed                  audit_log 'stripe.charge_failed' (failure_code)
 invoice.payment_failed         → past_due (if plan grace > 0 AND next_payment_attempt)
                                → payment_failed (otherwise)
                                nextPaymentAttempt + graceExpiresAt set on user
                                Email + in-app banner dispatched
        │
        ▼ Stripe Smart Retries (model-driven, ~3 weeks)
 retry succeeds                 invoice.payment_succeeded
 customer.subscription.updated  → active, grace fields cleared
                                Banner disappears on next page load
        │
        ▼ all retries fail
 subscription.updated (unpaid)  → payment_failed (hard block)
  OR
 subscription.deleted           → cancelled, stripe_subscription_id = null
                                Subscription row retained (GDPR + history)
```

---

## 2. Where state lives

| What                     | Where                                                     | Who writes it                                           |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------- |
| Subscription status      | `auth.users.app_metadata.subscription.status`             | Webhook handlers                                        |
| Next retry timestamp     | `auth.users.app_metadata.subscription.nextPaymentAttempt` | `handlePaymentFailed`                                   |
| Grace deadline           | `auth.users.app_metadata.subscription.graceExpiresAt`     | `handlePaymentFailed`                                   |
| Stripe customer ID       | `auth.users.app_metadata.stripe_customer_id`              | `handleCheckoutCompleted`                               |
| Stripe subscription ID   | `auth.users.app_metadata.stripe_subscription_id`          | `handleCheckoutCompleted` / `handleSubscriptionDeleted` |
| Per-plan grace window    | `public.plan_configs.payment_grace_hours`                 | Admin UI                                                |
| Failed charge audit      | `public.audit_log` action=`stripe.charge_failed`          | `handleChargeFailed`                                    |
| Unmatched webhook events | Sentry (tag `webhook_event`)                              | `captureUnmatchedEvent`                                 |

**Single source of truth for access:** `isSubscriptionFunctional(sub, plan)` in `app/lib/subscriptions.ts`. Do not reimplement this logic elsewhere.

---

## 3. Common scenarios

### 3.1 "User paid but still has no access"

1. Verify in Stripe Dashboard: customer's subscription is `active` and latest invoice is `paid`.
2. Verify in Supabase Auth → Users → find user → **Raw user meta data**:
   - `subscription.status` should be `active`
   - `subscription.isPaid` should be `true`
   - `stripe_customer_id` should match the Stripe customer
3. If Stripe is `active` but Supabase says `past_due` / `payment_failed`:
   - The status-update webhook was missed. Pending events may still land — check Stripe Dashboard → Developers → Webhooks → `we_1TIdJ7…` → Activity.
   - Manual resend: Stripe Dashboard → the event → "Resend".
   - API resend: `POST https://api.stripe.com/v1/events/{event_id}/retry` with `webhook_endpoint={endpoint_id}`.
4. If the webhook ran but did not find the user — check Sentry for `[stripe/webhook] Unmatched` events. Usually means `supabase_user_id` in Stripe metadata points to a deleted user. Fix by updating Stripe subscription metadata to the live user id, then resend the event.

### 3.2 "User's card was charged again after I thought the subscription was cancelled"

1. Check Stripe Dashboard → Customers → subscriptions. A subscription with `cancel_at_period_end=true` still charges until period end.
2. If immediate cancellation was requested, cancel via Stripe Dashboard with "Cancel immediately". Our webhook (`customer.subscription.deleted`) will set Supabase status to `cancelled`.
3. Refund the most recent invoice via Stripe Dashboard if the charge was accidental.

### 3.3 "Banner still shows after I updated my card"

1. Stripe retry has not yet fired — Smart Retries are scheduled on Stripe's timeline, not instant.
2. To force immediate retry: Stripe Dashboard → the invoice → "Charge now". This fires `invoice.payment_succeeded` → our webhook → `customer.subscription.updated` → clears grace fields → banner disappears.
3. Ask user to reload the page after ~30 seconds.

### 3.4 "User wants to resume after payment_failed"

Recommended path: the Stripe customer portal handles this cleanly.

1. User clicks "Update payment method" in the banner → `/api/stripe/portal` → Stripe portal.
2. User updates card → clicks "Pay this invoice" on the overdue invoice.
3. `invoice.payment_succeeded` fires → subscription reactivates automatically.

Manual recovery (operator):

1. Ensure the user has a valid card in Stripe (Customers → Update payment method).
2. Stripe Dashboard → overdue invoice → "Charge now".
3. Verify `auth.users.app_metadata.subscription.status === 'active'` within 30 seconds.

### 3.5 "Orphaned subscription in Stripe for a deleted user"

Cause: user was deleted in Supabase but the Stripe subscription (and customer) still exists.

1. Cancel the Stripe subscription:
   ```bash
   curl -u "$STRIPE_SECRET_KEY:" -X DELETE \
     "https://api.stripe.com/v1/subscriptions/{sub_id}" \
     --data-urlencode "prorate=false" \
     --data-urlencode "invoice_now=false"
   ```
2. Our webhook will fire `customer.subscription.deleted`. The 3-step fallback (BIZZ-543) will try to resolve via email — if no live user matches, the event is Sentry-captured and consumed with 200. That is the correct behaviour.

### 3.6 "Stuck past_due event keeps retrying"

Before BIZZ-543, `handleSubscriptionUpdated` threw 500 when `supabase_user_id` referenced a deleted user — Stripe then retried forever. Post-BIZZ-543 the handler returns 200 + Sentry. If you still see a pending webhook:

1. Stripe Dashboard → the event → check response status. If not 2xx, our deployment has an error.
2. Check Vercel deployment health.
3. Resend the event via the Dashboard.

### 3.7 "Token top-up payment failed — user still does not have tokens"

1. Confirm: Stripe Dashboard → the charge → status = failed.
2. `handleTokenTopUp` only runs on `checkout.session.completed` — which fires only on success. So no tokens were added; that is correct.
3. Audit trail: `audit_log` should have a `stripe.charge_failed` entry with `flow=token_topup`.
4. Ask user to retry purchase (`/dashboard/tokens`). If the card keeps failing, redirect them to update it via Stripe portal.

---

## 4. Operator controls

### Change per-plan grace

1. Go to `/dashboard/admin/plans`.
2. Edit the plan row or the create form.
3. Set "Grace-timer ved fejlet betaling" (0–168 hours).
4. Save — the next `invoice.payment_failed` for that plan uses the new value.

### Extend a specific user's grace manually

Only for one-off exceptions. Prefer raising the plan's grace.

```bash
# Bump grace for user X to expire in 7 days
curl -s -X PUT "$SUPABASE_URL/auth/v1/admin/users/$USER_ID" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"app_metadata": {"subscription": {"graceExpiresAt": "'$(date -u -d "+7 days" +%FT%TZ)'"}}}'
```

### Force-sync a user's status from Stripe

Rare — used when webhook delivery is permanently broken for a single event.

1. Read Stripe subscription: `GET /v1/subscriptions/{sub_id}`.
2. Map Stripe status to our status (see `handleSubscriptionUpdated`).
3. PATCH the user's `app_metadata.subscription.status` via Supabase Admin API.
4. Add an audit_log entry `action='manual_subscription_sync'` with operator id + reason.

---

## 5. Monitoring / alerts

- **Sentry tags:** `webhook_event` (e.g. `invoice.payment_failed`) and `trace=bizz543-debug` (temporary debug markers).
- **Audit log queries:**
  ```sql
  select created_at, metadata
  from audit_log
  where action = 'stripe.charge_failed'
    and created_at > now() - interval '7 days'
  order by created_at desc;
  ```
- **Pending webhooks:** Stripe Dashboard → Developers → Webhooks → endpoint → "Deliveries" tab shows any non-2xx responses.

---

## 6. When to escalate

- Stripe webhook signature failures (400 status on all events) → check `STRIPE_WEBHOOK_SECRET` in Vercel matches the endpoint signing secret.
- Recurring webhook 500s → check Vercel runtime logs; likely a code bug, ping backend on-call.
- `fraudulent` or `do_not_honor` decline codes spiking → fraud investigation, coordinate with Stripe.
- User reports data-loss or incorrect billing → create a BIZZ- ticket with Stripe event ID + screenshot.
