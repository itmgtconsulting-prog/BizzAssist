-- ============================================================================
-- 153: AI Token Ledger — debit/credit transaktionshistorik (BIZZ-1770)
-- ============================================================================
-- Bank-konto-analog for AI-tokens: hver transaktion er en debit (forbrug)
-- eller credit (påfyldning). Running balance beregnes ved insert.
-- Tilgås via GET /api/tokens/ledger og vises i /dashboard/tokens.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant.ai_token_ledger (
  id              bigserial    PRIMARY KEY,
  tenant_id       uuid         NOT NULL,
  user_id         uuid         NOT NULL,
  txn_type        text         NOT NULL CHECK (txn_type IN ('debit', 'credit')),
  amount_tokens   integer      NOT NULL,
  amount_dkk      numeric(10,2),
  action          text         NOT NULL,
  description     text,
  source_id       text,
  model           text,
  tokens_in       integer,
  tokens_out      integer,
  balance_after   integer      NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  created_by      uuid
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_created
  ON tenant.ai_token_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_tenant_created
  ON tenant.ai_token_ledger (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_action
  ON tenant.ai_token_ledger (action)
  WHERE action IS NOT NULL;

COMMENT ON TABLE tenant.ai_token_ledger IS
  'BIZZ-1770: AI token debit/credit ledger — transaktionshistorik med running balance';
