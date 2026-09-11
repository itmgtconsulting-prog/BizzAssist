-- Migration 215: haerd anon-grants + RLS-konsistens (BIZZ-2242)
--
-- Fund fra tenant-isolation/RLS-audit 2026-09-05. Baseline er staerk (schema-per-
-- tenant, RLS enabled overalt). Disse defense-in-depth-huller lukkes:
--
-- 1) deleted_accounts (GDPR-PII fra slettede konti) + user_session_preferences
--    (bruger-scoped): anon havde SELECT-grant. Beskyttet KUN af RLS-enabled-uden-
--    policy (default-deny). En enkelt fejl-permissiv policy eller RLS-disable =
--    oejeblikkelig anonym PII-eksponering. Defense-in-depth: kraev baade grant OG
--    policy → fjern den overfloedige anon-grant.
--
-- 2) Public-record data-tabeller (cvr_deltager, ejendomshandel,
--    tinglysning_haeftelse): anon havde SELECT men RLS-no-policy denier → anon fik
--    0 raekker (inkonsistent "grant men denied"). Intent afklaret: de laeses KUN
--    server-side via service_role (API-routes + app/lib) — ALDRIG via anon-klient
--    (verificeret). De skal ikke vaere anon-PostgREST-laesbare (cvr_deltager ~2M
--    person-raekker = uoensket bulk-scrape-flade). → revoke grant (least privilege).
--
-- 3) tenant.ai_token_usage (template-schema): RLS var slaaet fra, mens ALLE
--    per-tenant-kopier har RLS on. Ingen anon-grant. Enables for konsistens.
--
-- Sikkert: REVOKE fjerner kun adgang der ALLEREDE RLS-denies (0 raekker → nu
-- permission denied for anon, som intet app-kald afhaenger af). Fuldt reversibelt
-- (GRANT / DISABLE RLS). service_role (app-backend) er upaavirket.

-- 1 + 2: fjern overfloedige anon SELECT-grants
REVOKE SELECT ON public.deleted_accounts FROM anon;
REVOKE SELECT ON public.user_session_preferences FROM anon;
REVOKE SELECT ON public.cvr_deltager FROM anon;
REVOKE SELECT ON public.ejendomshandel FROM anon;
REVOKE SELECT ON public.tinglysning_haeftelse FROM anon;

-- 3: RLS-konsistens paa template-schemaets ai_token_usage
ALTER TABLE tenant.ai_token_usage ENABLE ROW LEVEL SECURITY;
