-- BIZZ-1881: bogføringstabel for TL-backfill så "missing"-sættet kan konvergere.
--
-- Problem: BFEer uden tinglysningsdata (no-uuid / no-tl-data) faldt aldrig ud af
-- backfillens kandidat-CTE (den tjekker kun haeftelse/handel). Permanente no-data-
-- BFEer blev derfor genprobet ved hver kørsel og "missing" konvergerede aldrig mod 0.
--
-- Løsning: marker hver probet BFE (data ELLER no-data) her. Kandidat-CTE'en
-- ekskluderer probede BFEer, så hver BFE kun probes én gang og derefter forsvinder
-- permanent fra kandidat-sættet. Ren bogføring — ingen PII, ingen API/cache-påvirkning.
CREATE TABLE IF NOT EXISTS tinglysning_backfill_probed (
  bfe_nummer integer PRIMARY KEY,
  probed_at  timestamptz NOT NULL DEFAULT now(),
  result     text NOT NULL
);
