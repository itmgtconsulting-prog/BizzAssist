/**
 * BIZZ-2159: Backfill bfe_adresse_cache med BBRs officielle beliggenhedsadresse.
 *
 * Retter to klasser af forkerte data i bfe_adresse_cache for grund-/bygnings-
 * BFE'er (IKKE ejerlejligheder — de har etage/dør fra VP og røres ikke):
 *   A) jordstykke-rækker hvor DAWA-jordstykke valgte en VILKÅRLIG adgangsadresse
 *      (SFE med flere adgangsadresser, fx hjørnebygning Gyldenstræde 8/Stengade 10).
 *   B) grund-rækker med matrikelbetegnelse ("5y Fandrup By") hvor BBR faktisk
 *      har en rigtig beliggenhedsadresse.
 *
 * For hver kandidat resolves bbr_ejendom_status.adgangsadresse_id mod DAWA og
 * cache-rækken opdateres til kilde='bbr_beliggenhed'. Rækker hvor BBR-id'et ikke
 * kan resolves (nedlagt/ukendt) springes over (urørt).
 *
 * Kør:  node scripts/_backfill-2159-bbr-beliggenhed.mjs [test|prod] [maxRows]
 *   - default env: test. 'prod' kræves eksplicit.
 *   - maxRows: valgfri øvre grænse (default: alle kandidater).
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const ENV = process.argv[2] === 'prod' ? 'prod' : 'test';
const MAX_ROWS = process.argv[3] ? parseInt(process.argv[3], 10) : Infinity;
const PROJ = ENV === 'prod' ? 'fnatkyxyfjjcxqwsbngs' : 'rlkjmqjxmkxuclehbrnl';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const DAWA = process.env.DAWA_BASE_URL ?? 'https://api.dataforsyningen.dk';

const GROUND_KILDER = [
  'auto_jordstykke',
  'cron_jordstykke',
  'fix_2092_jordstykke',
  'backfill_1850_jordstykke',
  'backfill_1886_jordstykke',
  'backfill_jordstykke',
  'auto_grund',
  'cron_grund',
  'fix_2092_grund',
]
  .map((k) => `'${k}'`)
  .join(',');

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJ}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    throw new Error(`SQL non-JSON (${r.status}): ${t.slice(0, 300)}`);
  }
  if (j.message) throw new Error(`SQL error: ${j.message}`);
  return j;
}

/** Resolve én DAWA adgangsadresse-UUID → {adresse, postnr, postnrnavn, kommune_kode, dawa_id} | null */
async function resolveDawa(id) {
  try {
    const r = await fetch(`${DAWA}/adgangsadresser/${encodeURIComponent(id)}?struktur=mini`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const a = await r.json();
    if (!a?.vejnavn || a?.postnr == null) return null;
    return {
      adresse: `${a.vejnavn} ${a.husnr ?? ''}`.trim(),
      postnr: String(a.postnr),
      postnrnavn: a.postnrnavn ?? null,
      kommune_kode: a.kommunekode != null ? String(a.kommunekode) : null,
      dawa_id: a.id ?? id,
    };
  } catch {
    return null;
  }
}

/** SQL-escape en streng-literal (eller NULL) */
function lit(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function run() {
  if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN mangler i .env.local');
  console.log(`[2159-backfill] env=${ENV} proj=${PROJ} maxRows=${MAX_ROWS}`);

  // Hent alle kandidater (grund/bygning, ikke ejerlejlighed, BBR uenig/mangler)
  const candRes = await sql(`
    select c.bfe_nummer, s.adgangsadresse_id::text as bbr_id
    from public.bfe_adresse_cache c
    join public.bbr_ejendom_status s on s.bfe_nummer = c.bfe_nummer
    where c.etage is null and c.doer is null
      and s.adgangsadresse_id is not null
      and c.kilde in (${GROUND_KILDER})
      and (c.dawa_id is null or c.dawa_id <> s.adgangsadresse_id::text)
    order by c.bfe_nummer
  `);
  let candidates = candRes;
  if (Number.isFinite(MAX_ROWS)) candidates = candidates.slice(0, MAX_ROWS);
  console.log(`[2159-backfill] ${candidates.length} kandidater`);

  let updated = 0;
  let skipped = 0;
  const PAGE = 400;
  const CONC = 12;

  for (let i = 0; i < candidates.length; i += PAGE) {
    const page = candidates.slice(i, i + PAGE);
    const resolved = [];
    for (let j = 0; j < page.length; j += CONC) {
      const chunk = page.slice(j, j + CONC);
      const out = await Promise.all(
        chunk.map(async (row) => ({ bfe: row.bfe_nummer, adr: await resolveDawa(row.bbr_id) }))
      );
      for (const o of out) {
        if (o.adr) resolved.push(o);
        else skipped++;
      }
    }
    if (resolved.length > 0) {
      const values = resolved
        .map(
          (o) =>
            `(${o.bfe}::bigint, ${lit(o.adr.adresse)}, ${lit(o.adr.postnr)}, ${lit(
              o.adr.postnrnavn
            )}, ${lit(o.adr.kommune_kode)}, ${lit(o.adr.dawa_id)})`
        )
        .join(',\n');
      await sql(`
        update public.bfe_adresse_cache as c set
          adresse = v.adresse,
          postnr = v.postnr,
          postnrnavn = v.postnrnavn,
          kommune_kode = v.kommune_kode,
          dawa_id = v.dawa_id,
          etage = null,
          doer = null,
          kilde = 'bbr_beliggenhed',
          sidst_opdateret = now()
        from (values
          ${values}
        ) as v(bfe_nummer, adresse, postnr, postnrnavn, kommune_kode, dawa_id)
        where c.bfe_nummer = v.bfe_nummer
      `);
      updated += resolved.length;
    }
    console.log(
      `[2159-backfill] ${Math.min(i + PAGE, candidates.length)}/${candidates.length} — opdateret ${updated}, sprunget over ${skipped}`
    );
  }

  console.log(`[2159-backfill] FÆRDIG. Opdateret ${updated}, sprunget over ${skipped}.`);
}

run().catch((e) => {
  console.error('[2159-backfill] FEJL:', e.message);
  process.exit(1);
});
