-- ============================================================
-- BIZZ-1206: RPC functions for AI chat operations.
--
-- Bypasses PostgREST schema-scoped queries (Accept-Profile header)
-- which require every tenant schema to be listed in db_schema config.
-- These functions run server-side in Postgres with dynamic search_path,
-- eliminating the dependency on PostgREST config entirely.
-- ============================================================

-- ─── 1. List chat sessions ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_list_sessions(
  p_schema_name text,
  p_user_id uuid,
  p_include_archived boolean DEFAULT false,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(s)::jsonb), ''[]''::jsonb)
     FROM (
       SELECT id, tenant_id, user_id, title, context_type, context_id,
              last_msg_at, archived_at, created_at, updated_at
       FROM %I.ai_chat_sessions
       WHERE user_id = $1 %s
       ORDER BY last_msg_at DESC NULLS LAST
       LIMIT $2
     ) s',
    p_schema_name,
    CASE WHEN NOT p_include_archived THEN 'AND archived_at IS NULL' ELSE '' END
  )
  INTO result
  USING p_user_id, p_limit;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.ai_chat_list_sessions IS
  'BIZZ-1206: List AI chat sessions for a user. Uses dynamic schema to bypass PostgREST schema config.';

-- ─── 2. Create chat session ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_create_session(
  p_schema_name text,
  p_tenant_id uuid,
  p_user_id uuid,
  p_title text DEFAULT 'Ny samtale',
  p_context_type text DEFAULT NULL,
  p_context_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  EXECUTE format(
    'INSERT INTO %I.ai_chat_sessions (tenant_id, user_id, title, context_type, context_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING row_to_json(ai_chat_sessions)::jsonb',
    p_schema_name
  )
  INTO result
  USING p_tenant_id, p_user_id, p_title, p_context_type, p_context_id;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.ai_chat_create_session IS
  'BIZZ-1206: Create AI chat session. Uses dynamic schema to bypass PostgREST schema config.';

-- ─── 3. Get single session with messages ─────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_get_session(
  p_schema_name text,
  p_session_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  session_row jsonb;
  messages_arr jsonb;
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  EXECUTE format(
    'SELECT row_to_json(s)::jsonb
     FROM %I.ai_chat_sessions s
     WHERE s.id = $1 AND s.user_id = $2',
    p_schema_name
  )
  INTO session_row
  USING p_session_id, p_user_id;

  IF session_row IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.created_at ASC), ''[]''::jsonb)
     FROM %I.ai_chat_messages m
     WHERE m.session_id = $1',
    p_schema_name
  )
  INTO messages_arr
  USING p_session_id;

  RETURN jsonb_build_object(
    'session', session_row,
    'messages', COALESCE(messages_arr, '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.ai_chat_get_session IS
  'BIZZ-1206: Get single AI chat session with messages. Uses dynamic schema.';

-- ─── 4. Insert message ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_insert_message(
  p_schema_name text,
  p_session_id uuid,
  p_role text,
  p_content text,
  p_tool_calls jsonb DEFAULT NULL,
  p_token_count integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  EXECUTE format(
    'INSERT INTO %I.ai_chat_messages (session_id, role, content, tool_calls, token_count)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING row_to_json(ai_chat_messages)::jsonb',
    p_schema_name
  )
  INTO result
  USING p_session_id, p_role, p_content, p_tool_calls, p_token_count;

  -- Update session last_msg_at
  EXECUTE format(
    'UPDATE %I.ai_chat_sessions SET last_msg_at = now(), updated_at = now()
     WHERE id = $1',
    p_schema_name
  )
  USING p_session_id;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.ai_chat_insert_message IS
  'BIZZ-1206: Insert AI chat message. Updates session last_msg_at.';

-- ─── 5. Update session (title, archive) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_update_session(
  p_schema_name text,
  p_session_id uuid,
  p_user_id uuid,
  p_title text DEFAULT NULL,
  p_archived_at timestamptz DEFAULT NULL,
  p_set_archived boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  set_clauses text := 'updated_at = now()';
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  IF p_title IS NOT NULL THEN
    set_clauses := set_clauses || format(', title = %L', p_title);
  END IF;

  IF p_set_archived THEN
    IF p_archived_at IS NOT NULL THEN
      set_clauses := set_clauses || format(', archived_at = %L', p_archived_at);
    ELSE
      set_clauses := set_clauses || ', archived_at = now()';
    END IF;
  END IF;

  EXECUTE format(
    'UPDATE %I.ai_chat_sessions SET %s WHERE id = $1 AND user_id = $2
     RETURNING row_to_json(ai_chat_sessions)::jsonb',
    p_schema_name, set_clauses
  )
  INTO result
  USING p_session_id, p_user_id;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.ai_chat_update_session IS
  'BIZZ-1206: Update AI chat session (title, archive). Uses dynamic schema.';

-- ─── 6. Get messages since timestamp (polling) ──────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_get_messages_since(
  p_schema_name text,
  p_session_id uuid,
  p_since timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.created_at ASC), ''[]''::jsonb)
     FROM %I.ai_chat_messages m
     WHERE m.session_id = $1 AND m.created_at > $2',
    p_schema_name
  )
  INTO result
  USING p_session_id, p_since;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.ai_chat_get_messages_since IS
  'BIZZ-1206: Get AI chat messages since timestamp (for polling). Uses dynamic schema.';

-- ─── 7. Delete session ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ai_chat_delete_session(
  p_schema_name text,
  p_session_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rows_deleted integer;
BEGIN
  IF p_schema_name !~ '^tenant_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'Invalid schema name: %', p_schema_name;
  END IF;

  -- Delete messages first (foreign key)
  EXECUTE format(
    'DELETE FROM %I.ai_chat_messages WHERE session_id = $1',
    p_schema_name
  )
  USING p_session_id;

  EXECUTE format(
    'DELETE FROM %I.ai_chat_sessions WHERE id = $1 AND user_id = $2',
    p_schema_name
  )
  USING p_session_id, p_user_id;

  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  RETURN rows_deleted > 0;
END;
$$;

COMMENT ON FUNCTION public.ai_chat_delete_session IS
  'BIZZ-1206: Delete AI chat session and its messages. Uses dynamic schema.';
