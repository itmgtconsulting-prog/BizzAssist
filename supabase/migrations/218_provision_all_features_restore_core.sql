-- Migration 218: GENINDSÆT kerne-schema-kaldet i provision_tenant_all_features (BIZZ-2196 REGRESSION)
--
-- Rod-årsag (regression): Migration 189 tilføjede `PERFORM public.provision_tenant_schema(...)`
-- som FØRSTE trin i orkestratoren, så ét kald gav en KOMPLET tenant (13 kerne-tabeller
-- + features). Migration 206 (normalize_notifications_snapshots) lavede CREATE OR REPLACE
-- på provision_tenant_all_features UDEN at bevare kerne-kaldet, og migrationerne 216/217
-- videreførte den ødelagte version. Resultat: kerne-kaldet forsvandt igen.
--
-- Konsekvens: Nye tenants fik kun de 4 inline-kerne-tabeller fra provisionTenant.ts
-- (saved_entities, notifications, property_snapshots, recent_entities) + feature-tabeller,
-- men manglede de 9 øvrige kerne-tabeller: saved_searches, reports, ai_conversations,
-- ai_messages, document_embeddings, audit_log, activity_log, support_chat_sessions,
-- ai_token_usage. AI-token-logging, audit-log, AI-chat-historik, rapporter, gemte
-- søgninger og support-chat fejler for disse brugere.
-- Observeret i TEST: tenant_vandkunsten_me_com (oprettet 2026-09-23).
--
-- Fix: Genindfør public.provision_tenant_schema FØRST (idempotent, CREATE TABLE IF NOT
-- EXISTS) — nøjagtig som migration 189 gjorde. Fuld body re-erklæres (CREATE OR REPLACE)
-- for at bevare ALLE eksisterende sub-provisionerings-kald (incl. knowledge/mig 216 og
-- email/mig 217). Kerne-trinnet wrappes i sin egen EXCEPTION-blok (samme mønster som de
-- øvrige), så en delfejl aldrig blokerer resten — og den afsluttende GRANT dækker også
-- kerne-tabellerne.

CREATE OR REPLACE FUNCTION public.provision_tenant_all_features(p_schema_name text, p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- BIZZ-2196 (genindført i mig 218): Kerne-schema FØRST (13 tabeller incl. audit_log,
  -- ai_token_usage, saved_searches, reports, ai_conversations, ai_messages,
  -- document_embeddings, activity_log, support_chat_sessions). Idempotent. Uden dette
  -- mangler nye tenants disse tabeller, fordi provisionTenant.ts kun laver 4 kerne-tabeller.
  BEGIN PERFORM public.provision_tenant_schema(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features core_schema %: %', p_schema_name, SQLERRM; END;

  -- AI chat (mig 073)
  BEGIN PERFORM public.provision_ai_chat_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ai_chat %: %', p_schema_name, SQLERRM; END;

  -- AI feedback/notification (mig 051)
  BEGIN PERFORM public.provision_tenant_ai_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ai_tables %: %', p_schema_name, SQLERRM; END;

  -- TTL-indekser (mig 024)
  BEGIN PERFORM public.provision_tenant_schema_ttl_patch(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features ttl %: %', p_schema_name, SQLERRM; END;

  -- BIZZ-2194: Normalisér notifications + property_snapshots til kanonisk skema
  BEGIN PERFORM public.provision_tenant_notify_canonical(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features notify_canonical %: %', p_schema_name, SQLERRM; END;

  -- Forsikring-kæde i FK-rækkefølge: tables → analyser → kunde_id → sager → analyse_documents → gaps_fk → user_scope
  BEGIN PERFORM public.provision_tenant_forsikring_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_tables %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_analyser_tables(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_analyser %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_kunde_id(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_kunde_id %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_sager(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_sager %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_analyse_documents(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_analyse_docs %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_tenant_forsikring_gaps_analyse_fk(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_gaps_fk %: %', p_schema_name, SQLERRM; END;

  BEGIN PERFORM public.provision_forsikring_user_scope(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features fors_user_scope %: %', p_schema_name, SQLERRM; END;

  -- Vurderingsrapport (mig 146)
  BEGIN PERFORM public.provision_tenant_vurdering_sager(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features vurdering %: %', p_schema_name, SQLERRM; END;

  -- Videnbase / knowledge base (mig 216, BIZZ-2277)
  BEGIN PERFORM public.provision_tenant_knowledge(p_schema_name, p_tenant_id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features knowledge %: %', p_schema_name, SQLERRM; END;

  -- Email/OAuth integrations (mig 217, BIZZ-2275)
  BEGIN PERFORM public.provision_tenant_email_integrations(p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features email_integrations %: %', p_schema_name, SQLERRM; END;

  -- KRITISK (BIZZ-2165): SECURITY DEFINER-funktionerne opretter tabeller ejet af
  -- function-owneren (postgres). PostgREST forbinder som authenticator og skifter
  -- til service_role/authenticated, der har brug for eksplicit GRANT — ellers
  -- fejler enhver .schema(...).from(...) med 42501 "permission denied for table".
  -- Base-provisioneringen GRANT'er kun de tabeller der fandtes paa det tidspunkt,
  -- saa feature-tabeller skabt her SKAL grantes til sidst. Uden dette kunne nye
  -- brugere ikke uploade policer (slj@rtm.dk: forsikring_documents 42501).
  BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated, service_role', p_schema_name);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO authenticated, service_role', p_schema_name);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO authenticated, service_role', p_schema_name);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'all_features grants %: %', p_schema_name, SQLERRM; END;
END;
$function$;
