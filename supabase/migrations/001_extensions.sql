-- ============================================================
-- Migration 001: Enable required PostgreSQL extensions
-- BizzAssist — ISO 27001 A.14 (Secure Development)
-- ============================================================
-- vector    : AI embeddings for RAG / semantic search (pgvector)
-- uuid-ossp : UUID generation for all primary keys
-- pg_trgm   : Trigram fuzzy search for company/person name matching
-- ============================================================

create extension if not exists "vector"    with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists "pg_trgm"   with schema extensions;
