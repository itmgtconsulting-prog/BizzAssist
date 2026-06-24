-- Migration 190: provision_tenant_schema skal kunne resolve 'vector'-typen (BIZZ-2196)
--
-- provision_tenant_schema opretter document_embeddings med kolonnen
-- `embedding vector(1536)`. pgvector-typen `vector` ligger i schemaet `extensions`
-- (Supabase-konvention), men funktionens search_path var kun `public`. I prod
-- (hvor document_embeddings ikke allerede fandtes) fejlede CREATE TABLE derfor med
-- "type vector does not exist" på linjen — og da funktionen er transaktionel,
-- rullede HELE provisioneringen tilbage, så nye/0-reparerede tenants endte uden
-- kerne-tabeller. (I test/dev maskerede en præ-eksisterende document_embeddings
-- fejlen via CREATE TABLE IF NOT EXISTS.)
--
-- Fix: tilføj `extensions` til funktionens search_path, så `vector` kan resolves.
-- Rent additivt — eksisterende public-referencer påvirkes ikke.

ALTER FUNCTION public.provision_tenant_schema(text, uuid)
  SET search_path = public, extensions, pg_temp;
