-- ============================================================
-- Migration 194: Fjern 8s-timeout på materialized-view refresh
-- BIZZ-2209: refresh-materialized-views-cronen kalder RPC'en
--   public.refresh_materialized_view(view_name) via PostgREST. PostgREST kører
--   som rollen `authenticator`, der har statement_timeout=8s. REFRESH af store
--   MV'er (fx mv_virksomhedshandel_kandidater — 1,75M rækker / 274 MB) tager
--   >8s → cancelleres → MV'et frøs siden ~2. juni (M&A-radar viser 0 kandidater).
--
-- Fix: giv SECURITY DEFINER-funktionen statement_timeout=0, så REFRESH inde i
-- den ikke arver authenticator-rollens 8s-grænse. Funktionslokalt SET
-- overstyrer session/rolle-værdien for kaldets varighed.
-- ============================================================

ALTER FUNCTION public.refresh_materialized_view(text) SET statement_timeout = '0';
