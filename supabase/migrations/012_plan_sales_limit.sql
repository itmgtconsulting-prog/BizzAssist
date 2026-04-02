-- Migration 012: Add sales limit columns to plan_configs
--
-- max_sales:   Maximum number of subscriptions allowed (NULL = unlimited)
-- sales_count: Current number of subscriptions sold (0 by default)

ALTER TABLE public.plan_configs
  ADD COLUMN IF NOT EXISTS max_sales    INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sales_count  INTEGER NOT NULL DEFAULT 0;
