-- Migration 189: provision_tenant_all_features skal også oprette KERNE-tabellerne (BIZZ-2196)
--
-- Rod-årsag: Både signup (app/auth/actions.ts) og admin-opret (app/api/admin/
-- users/route.ts) provisionerer via lib/tenant/provisionTenant.ts, som:
--   (trin 3) opretter KUN 4 kerne-tabeller via inline SQL (saved_entities,
--            notifications, property_snapshots, recent_entities), og
--   (trin 5) kalder public.provision_tenant_all_features for feature-tabellerne.
-- Den fulde public.provision_tenant_schema (13 kerne-tabeller) blev ALDRIG kaldt
-- af denne vej. Derfor manglede nye tenants (fx slj@rtm.dk, dir@gardian.dk) 9
-- kerne-tabeller: audit_log, ai_token_usage, ai_messages, ai_conversations,
-- document_embeddings, reports, saved_searches, activity_log, support_chat_sessions.
-- Konsekvens: AI-token-logging, audit-log, AI-chat-historik, rapporter, gemte
-- søgninger og support-chat fejler ved brug for disse brugere.
--
-- Fix: provision_tenant_all_features kører nu public.provision_tenant_schema FØRST
-- (idempotent — CREATE TABLE IF NOT EXISTS), så ét orkestrator-kald giver en
-- KOMPLET tenant (kerne + features). Begge provisionerings-veje kalder allerede
-- denne funktion, så signup OG admin-opret rettes på ét sted. Kernetrinnet wrappes
-- i sin egen EXCEPTION-blok (samme mønster som de øvrige), så en delfejl aldrig
-- blokerer resten — og den afsluttende GRANT dækker også kerne-tabellerne.

CREATE OR REPLACE FUNCTION public.provision_tenant_all_features(p_schema_name text, p_tenant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- BIZZ-2196: Kerne-schema FØRST (13 tabeller incl. audit_log, ai_token_usage,
  -- saved_searches, reports, ai_conversations, ai_messages, document_embeddings,
  -- activity_log, support_chat_sessions). Idempotent. Uden dette manglede nye
  -- tenants disse tabeller, fordi provisionTenant.ts kun lavede 4 kerne-tabeller.
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

  -- BIZZ-2178: Normalisér notifications + property_snapshots til kanonisk skema
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
