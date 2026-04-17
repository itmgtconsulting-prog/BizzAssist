# ADR 0002 — Stripe Dunning Strategy

**Date:** 2026-04-17
**Status:** Accepted
**Deciders:** Jakob Juul Rasmussen
**Ticket:** BIZZ-542

---

## Context

BizzAssist charges users recurring subscriptions (monthly/daily) via Stripe. When a renewal charge fails — typically because a customer's card is blocked, expired, or has insufficient funds — we need a defined strategy for:

1. How many retries Stripe should attempt before giving up
2. When the user should lose access to the product
3. What notifications the user receives at each step
4. How our internal state tracks the dunning lifecycle

Until this ADR, we had no documented strategy and relied implicitly on Stripe's defaults. A state change to Stripe's retry schedule, or a question from support about a failed customer, had no canonical answer.

## Decision

### 1. Retry schedule — Stripe Smart Retries (default)

We use **Stripe Smart Retries** (configured in the Stripe Dashboard → Settings → Subscriptions and emails → "Smart Retries"), not a custom retry cadence. Smart Retries run Stripe's ML model which picks retry times predicted to maximise success per card network. At the time of writing this is typically 4 attempts over 3 weeks but the exact cadence is fluid.

Why: Stripe's model outperforms any hand-tuned schedule for our volume. Customising the cadence would add complexity without measurable upside.

Fallback timeline (used for communication / runbook purposes even though the actual timing is model-driven):

| Day                   | Stripe event                                                                | BizzAssist state                                                                                 |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 0                     | Charge declined → `invoice.payment_failed` + `charge.failed`                | `past_due` (with plan grace) OR `payment_failed` (no grace) — see per-plan `payment_grace_hours` |
| +1..+20               | Stripe auto-retries (smart schedule)                                        | Unchanged until a retry succeeds or exhausts                                                     |
| retry succeeds        | `invoice.payment_succeeded` + `customer.subscription.updated` (active)      | `active` — grace fields cleared                                                                  |
| all retries exhausted | `customer.subscription.updated` (unpaid) or `customer.subscription.deleted` | `payment_failed` or `cancelled`                                                                  |

### 2. Access revocation — per-plan grace (see BIZZ-541)

The `plan_configs.payment_grace_hours` column controls how long a user keeps access after a failed payment while Stripe retries:

- `0` (default) — access revoked immediately. Failed payment behaves exactly like an unpaid plan.
- `>0` — access retained for the grace window; banner warns the user; email prompts them to update payment.

The grace field is deliberately off by default. Cheap plans (basis, testplan1) use 0 so we never grant free usage while a card declines. Enterprise plans can opt in via the admin UI.

### 3. Final state after Stripe gives up

When Stripe exhausts retries it either sets subscription status to `unpaid` or deletes it outright, depending on the Subscription Retry settings. We map:

- `unpaid` → `subscription.status = 'payment_failed'` (`handleSubscriptionUpdated`)
- `deleted` → `subscription.status = 'cancelled'` (`handleSubscriptionDeleted`)

We retain the subscription row (app_metadata) in both cases. Historical subscription state is needed for GDPR compliance and support follow-up. The user can re-subscribe via Stripe Checkout at any time; a fresh subscription overwrites the old one.

### 4. User notification channels

| Channel                                    | Trigger                                             | Ticket   |
| ------------------------------------------ | --------------------------------------------------- | -------- |
| Email ("Payment failed — action required") | `invoice.payment_failed` webhook                    | BIZZ-540 |
| In-app banner (amber / red)                | `subscription.status` in (past_due, payment_failed) | BIZZ-541 |
| Audit log (`stripe.charge_failed`)         | `charge.failed` webhook                             | BIZZ-542 |
| Sentry alert (unusual failure codes)       | `charge.failed` with non-routine `failure_code`     | BIZZ-542 |

Routine decline codes (`card_declined`, `insufficient_funds`, `expired_card`, `incorrect_cvc`, `processing_error`, `generic_decline`) are audit-only. Everything else escalates to Sentry so operations can investigate.

### 5. Manual recovery

See `docs/runbooks/STRIPE_PAYMENT_FAILURES.md` for step-by-step manual recovery (subscription stuck in past_due, orphaned customer, etc.).

## Rationale

- **Why Smart Retries over custom cadence:** Stripe's model beats hand-tuned schedules; less code to maintain.
- **Why per-plan grace (default 0):** Matches Jakob's intent that "payment failure = unpaid." Plans that benefit from a buffer (enterprise) can opt in.
- **Why keep subscription rows after cancellation:** GDPR requires us to prove when access was granted/revoked; support needs history; users can resubscribe cleanly.
- **Why audit + Sentry split on `charge.failed`:** Routine declines would flood Sentry; unusual codes (e.g. `fraudulent`, `do_not_honor`) signal real problems worth paging on.

## Consequences

### Positive

- Clear, documented lifecycle from first failure to resolution
- Operators know exactly where state lives (`app_metadata.subscription`) and how it evolves
- Per-plan grace gives flexibility without code changes
- No PII in logs — only user_id and Stripe IDs

### Negative / Trade-offs

- Stripe's retry schedule is opaque (model-driven) — we cannot show the user an exact "next retry" time before the retry is scheduled. The `next_payment_attempt` field Stripe provides on the failed invoice is our best approximation.
- Users on grace=0 plans lose access immediately; if we want to be friendlier for specific customers we must adjust `plan_configs.payment_grace_hours` or issue a manual extension.

## Revisit triggers

Re-evaluate this ADR when any of these occur:

- Stripe announces a major change to Smart Retries behaviour
- Involuntary-churn rate exceeds 3% of MRR (consider custom retry cadence)
- We add a new payment method beyond cards (SEPA, bank transfer) with different retry semantics
- Support receives repeated complaints about abrupt access loss on a specific plan

## References

- [Stripe Docs — Smart Retries](https://stripe.com/docs/billing/subscriptions/smart-retries)
- BIZZ-540 — Email notification on payment failure
- BIZZ-541 — In-app banner + per-plan grace
- BIZZ-543 — Webhook resilience (3-step user fallback)
- `app/api/stripe/webhook/route.ts` — implementation
- `docs/runbooks/STRIPE_PAYMENT_FAILURES.md` — operator recovery procedures
