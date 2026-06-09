#!/usr/bin/env node
/**
 * BIZZ-2053 — engangs-backfill: indsæt manglende EJF-handler i
 * ejerskifte_historik (bagud-katalog, ~4,2 mio. rækker).
 *
 * Den daglige cron /api/cron/backfill-ejerskifte-handel holder kun de
 * seneste 180 dage i sync; dette script fylder hele historikken.
 *
 * Keyset-vinduer på bfe_nummer: en given BFE ligger ALTID helt i ét
 * vindue (filter `> lo AND <= hi`), så DISTINCT ON (bfe, dato) pr.
 * vindue er korrekt. Idempotent via NOT EXISTS på (bfe, dato).
 *
 * Kør: node scripts/backfill-ejerskifte-handel-initial.mjs
 */
import fs from 'fs';
import pg from 'pg';

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const STRIDE = parseInt(process.env.STRIDE || '300000', 10); // ejf-rækker pr. vindue

const c = new pg.Client({ connectionString: PROD });
await c.connect();
await c.query('SET statement_timeout = 0'); // ubundet — store vinduer kan tage tid

const { rows: [{ maxbfe }] } = await c.query('SELECT MAX(bfe_nummer)::bigint AS maxbfe FROM ejf_ejerskifte');
console.log(`max bfe = ${maxbfe}, stride = ${STRIDE} rows/window`);

const INSERT_SQL = `
  WITH inserted AS (
    INSERT INTO public.ejerskifte_historik
      (bfe_nummer, overtagelsesdato, kontant_koebesum, i_alt_koebesum,
       koebsaftale_dato, kommune_kode, byg021_anvendelse, kilde, historisk_kilde)
    SELECT DISTINCT ON (e.bfe_nummer, e.overtagelsesdato::date)
      e.bfe_nummer,
      e.overtagelsesdato::date,
      h.kontant_koebesum,
      COALESCE(h.samlet_koebesum, h.kontant_koebesum),
      h.koebsaftale_dato,
      b.kommune_kode,
      b.byg021_anvendelse,
      'ejf_handel',
      'ejf_handel'
    FROM public.ejf_ejerskifte e
    JOIN public.ejf_handelsoplysninger h
      ON h.id_lokal_id = e.handelsoplysninger_lokal_id
    JOIN public.bbr_ejendom_status b
      ON b.bfe_nummer = e.bfe_nummer
    WHERE COALESCE(h.samlet_koebesum, h.kontant_koebesum) > 0
      AND e.overtagelsesdato IS NOT NULL
      AND e.bfe_nummer > $1 AND e.bfe_nummer <= $2
      AND NOT EXISTS (
        SELECT 1 FROM public.ejerskifte_historik eh
        WHERE eh.bfe_nummer = e.bfe_nummer
          AND eh.overtagelsesdato = e.overtagelsesdato::date
      )
    ORDER BY
      e.bfe_nummer,
      e.overtagelsesdato::date,
      COALESCE(h.samlet_koebesum, h.kontant_koebesum) DESC
    RETURNING 1
  )
  SELECT COUNT(*)::int AS n FROM inserted
`;

let lo = 0;
let totalInserted = 0;
let windowNo = 0;
const start = Date.now();

while (lo < Number(maxbfe)) {
  // Find hi = bfe-værdi STRIDE rækker frem (keyset, ingen split af én BFE)
  const { rows: hiRows } = await c.query(
    'SELECT bfe_nummer::bigint AS hi FROM ejf_ejerskifte WHERE bfe_nummer > $1 ORDER BY bfe_nummer LIMIT 1 OFFSET $2',
    [lo, STRIDE]
  );
  const hi = hiRows.length > 0 ? Number(hiRows[0].hi) : Number(maxbfe);

  const wStart = Date.now();
  const { rows } = await c.query(INSERT_SQL, [lo, hi]);
  const n = rows[0].n;
  totalInserted += n;
  windowNo++;
  const wSec = ((Date.now() - wStart) / 1000).toFixed(1);
  const totSec = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`window ${windowNo}: bfe (${lo}, ${hi}] inserted=${n} (${wSec}s) | total=${totalInserted} @ ${totSec}s`);

  if (hi <= lo) break; // safety
  lo = hi;
}

const { rows: [{ cnt }] } = await c.query(
  "SELECT COUNT(*)::int AS cnt FROM ejerskifte_historik WHERE historisk_kilde = 'ejf_handel'");
console.log(`\nDONE. total inserted this run=${totalInserted}, ejf_handel rows in table=${cnt}`);
await c.end();
