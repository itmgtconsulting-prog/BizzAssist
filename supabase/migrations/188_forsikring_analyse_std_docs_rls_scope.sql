-- Migration 188: Stram RLS på forsikring_analyse_standard_docs (BIZZ-2191)
--
-- Junction-tabellen (analyse_id ↔ standard_doc_id) havde SELECT- og DELETE-
-- policies med blot `auth.uid() IS NOT NULL`. Enhver authenticated bruger kunne
-- dermed i princippet læse ALLE analyse→dokument-koblinger og slette vilkårlige
-- rækker hvis UUID'et var kendt. Ikke en akut læk (routes bruger service-role +
-- tenant-scoping), men en defense-in-depth-svaghed hvis en fremtidig kodevej
-- læser tabellen med session-client, eller ved direkte DB-adgang.
--
-- Fix: SELECT/DELETE scopes nu til rækker hvor det refererede standard_doc er
-- synligt for brugeren — samme synligheds-logik som forsikring_standard_doc
-- "read scoped" (migration 164/177): curated, eget upload, eller domain-delt i
-- et domæne brugeren er medlem af. INSERT bevares uændret (sker via service-role
-- fra routes med app-scoping; WITH CHECK auth-only er tilstrækkeligt der).

-- ── Genbrugelig synligheds-betingelse på det refererede standard_doc ──
-- (Inline EXISTS frem for funktion for at matche eksisterende migrations-stil.)

DROP POLICY IF EXISTS "forsikring_analyse_std: read authenticated"
  ON public.forsikring_analyse_standard_docs;
CREATE POLICY "forsikring_analyse_std: read scoped"
  ON public.forsikring_analyse_standard_docs FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.forsikring_standard_doc d
      WHERE d.id = forsikring_analyse_standard_docs.standard_doc_id
        AND (
          d.visibility = 'curated'
          OR d.added_by_user = auth.uid()
          OR (d.visibility = 'domain' AND d.added_by_domain IN (
            SELECT domain_id FROM public.domain_member WHERE user_id = auth.uid()
          ))
        )
    )
  );

DROP POLICY IF EXISTS "forsikring_analyse_std: delete authenticated"
  ON public.forsikring_analyse_standard_docs;
CREATE POLICY "forsikring_analyse_std: delete scoped"
  ON public.forsikring_analyse_standard_docs FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.forsikring_standard_doc d
      WHERE d.id = forsikring_analyse_standard_docs.standard_doc_id
        AND (
          d.visibility = 'curated'
          OR d.added_by_user = auth.uid()
          OR (d.visibility = 'domain' AND d.added_by_domain IN (
            SELECT domain_id FROM public.domain_member WHERE user_id = auth.uid()
          ))
        )
    )
  );
