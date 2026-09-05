/**
 * BIZZ-2196: Structural schema-parity gate across test/dev/prod Supabase envs.
 *
 * Unlike check-migration-drift.mjs (which trusts supabase_migrations tracking —
 * and that tracking LIES: migrations get marked applied while the actual columns
 * were never created), this gate introspects the ACTUAL current structure via
 * information_schema / pg_catalog and diffs it across all three environments:
 *
 *   1. public + dataintel BASE TABLES              (cross-env)
 *   2. public + dataintel COLUMNS (name:type)      (cross-env, common tables)
 *   3. public FUNCTIONS (non-extension)            (cross-env)
 *   4. tenant_* schema template uniformity         (intra-env, BIZZ-2199)
 *
 * Exit 0 = full parity (only allowlisted intentional differences remain).
 * Exit 1 = drift detected — the report above lists it. Designed to run as a
 * scheduled GitHub Action (schema-parity.yml) so a failing run is the alert;
 * it is NOT a PR blocker.
 *
 * Requires SUPABASE_ACCESS_TOKEN in .env.local (or process.env).
 *
 * The diff logic is exported as pure functions and unit-tested in
 * __tests__/unit/schemaParity.test.ts (no DB needed). main() only runs when the
 * file is executed directly, so importing it is side-effect-free.
 *
 * @module scripts/check-schema-parity
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ENVS = [
  { name: 'test', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'dev', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'prod', ref: 'xsyldjqcntiygrtfcszm' },
];

/**
 * Intentional, accepted differences — NOT flagged as drift.
 * Every entry needs a reason so the allowlist stays honest.
 */
export const ALLOWLIST = {
  // Junk/scratch tables that exist only in prod and must never be replicated
  // (per BIZZ-2197 remediation).
  tables: new Set(['public.tinglysning_backfill_probed', 'public.tmp_ejerforening_cvr']),
  // Extension-owned functions are excluded at query time (pg_depend deptype='e'),
  // but keep an explicit escape hatch for utility funcs if needed later.
  functions: new Set(),
};

/** Sorted array difference: elements in `a` not in `b`. */
export function onlyIn(a, b) {
  const bs = b instanceof Set ? b : new Set(b);
  return [...a].filter((x) => !bs.has(x)).sort();
}

/**
 * Cross-env base-table drift: for each env, which tables (present somewhere)
 * are missing here. Allowlisted tables are ignored.
 *
 * @param snapshots - { [envName]: string[] of 'schema.table' }
 * @param ignore - Set of allowlisted 'schema.table'
 * @returns { union: string[], missingByEnv: { [env]: string[] } }
 */
export function crossEnvTableDrift(snapshots, ignore = ALLOWLIST.tables) {
  const envs = Object.keys(snapshots);
  const union = new Set();
  for (const e of envs) for (const t of snapshots[e]) if (!ignore.has(t)) union.add(t);
  const missingByEnv = {};
  for (const e of envs) {
    const have = new Set(snapshots[e]);
    missingByEnv[e] = [...union].filter((t) => !have.has(t)).sort();
  }
  return { union: [...union].sort(), missingByEnv };
}

/**
 * Cross-env column drift, restricted to tables present in ALL envs (so a whole
 * missing table — already reported by crossEnvTableDrift — doesn't double-count
 * as N column diffs). Each column is 'schema.table.column:type'.
 *
 * @param snapshots - { [envName]: string[] of 'schema.table.column:type' }
 * @returns { extraByEnv: { [env]: string[] } } — columns this env has that at
 *          least one other common-table env lacks.
 */
export function crossEnvColumnDrift(snapshots) {
  const envs = Object.keys(snapshots);
  const tableOf = (c) => c.split('.').slice(0, 2).join('.');
  const colTable = (c) => c.slice(0, c.lastIndexOf(':')); // schema.table.col
  // tables present in every env
  const tableSets = envs.map((e) => new Set(snapshots[e].map(tableOf)));
  const commonTables = [...tableSets[0]].filter((t) => tableSets.every((s) => s.has(t)));
  const common = new Set(commonTables);
  const filtered = {};
  for (const e of envs) filtered[e] = new Set(snapshots[e].filter((c) => common.has(tableOf(c))));
  const extraByEnv = {};
  for (const e of envs) {
    const others = envs.filter((o) => o !== e);
    extraByEnv[e] = [...filtered[e]]
      .filter((c) => others.some((o) => !filtered[o].has(c)))
      // report by column identity (not type) once
      .map(colTable)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort();
  }
  return { extraByEnv };
}

/**
 * Cross-env function drift. `snapshots` values are 'name/nargs' (extension
 * functions already excluded by the query).
 *
 * @returns { extraByEnv: { [env]: string[] } }
 */
export function crossEnvFunctionDrift(snapshots, ignore = ALLOWLIST.functions) {
  const envs = Object.keys(snapshots);
  const sets = {};
  for (const e of envs) sets[e] = new Set(snapshots[e].filter((f) => !ignore.has(f)));
  const extraByEnv = {};
  for (const e of envs) {
    const others = envs.filter((o) => o !== e);
    extraByEnv[e] = [...sets[e]].filter((f) => others.some((o) => !sets[o].has(f))).sort();
  }
  return { extraByEnv };
}

/**
 * Intra-env tenant-template drift: within one env every tenant_* schema should
 * have an identical (table.column) fingerprint. Reports schemas deviating from
 * the most-common fingerprint (the de-facto canonical template). BIZZ-2199.
 *
 * @param rows - [{ s: 'tenant_x', tc: 'table.column' }]
 * @returns { schemaCount, distinctStructures, canonicalCount, deviations:
 *          [{ schema, missing: string[], extra: string[] }] }
 */
export function tenantTemplateDrift(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.s)) by.set(r.s, new Set());
    by.get(r.s).add(r.tc);
  }
  const schemas = [...by.keys()];
  if (schemas.length === 0) {
    return { schemaCount: 0, distinctStructures: 0, canonicalCount: 0, deviations: [] };
  }
  // group by fingerprint
  const fp = new Map();
  for (const [s, set] of by) {
    const key = [...set].sort().join('|');
    if (!fp.has(key)) fp.set(key, { count: 0, set });
    fp.get(key).count++;
  }
  const canonical = [...fp.values()].sort((a, b) => b.count - a.count)[0];
  const deviations = [];
  for (const [s, set] of by) {
    if ([...set].sort().join('|') === [...canonical.set].sort().join('|')) continue;
    deviations.push({
      schema: s,
      missing: [...canonical.set].filter((x) => !set.has(x)).sort(),
      extra: [...set].filter((x) => !canonical.set.has(x)).sort(),
    });
  }
  return {
    schemaCount: schemas.length,
    distinctStructures: fp.size,
    canonicalCount: canonical.count,
    deviations: deviations.sort((a, b) => a.schema.localeCompare(b.schema)),
  };
}

/**
 * Aggregate: is there any drift across the four categories?
 *
 * @returns { hasDrift: boolean, ... echoes of the category results }
 */
export function summarize({ tableDrift, columnDrift, functionDrift, tenantDriftByEnv }) {
  const tableHas = Object.values(tableDrift.missingByEnv).some((a) => a.length > 0);
  const colHas = Object.values(columnDrift.extraByEnv).some((a) => a.length > 0);
  const fnHas = Object.values(functionDrift.extraByEnv).some((a) => a.length > 0);
  const tenHas = Object.values(tenantDriftByEnv).some((d) => d.deviations.length > 0);
  return { hasDrift: tableHas || colHas || fnHas || tenHas, tableHas, colHas, fnHas, tenHas };
}

// ─── I/O layer (only runs when executed directly) ───────────────────────────

function loadEnv() {
  if (!existsSync('.env.local')) return {};
  return Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
        return m ? [m[1], m[2]] : [null, null];
      })
      .filter(([k]) => k)
  );
}

async function sql(ref, token, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`query failed: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const Q_TABLES = `SELECT table_schema||'.'||table_name AS v FROM information_schema.tables WHERE table_schema IN ('public','dataintel') AND table_type='BASE TABLE' ORDER BY 1`;
const Q_COLS = `SELECT table_schema||'.'||table_name||'.'||column_name||':'||data_type AS v FROM information_schema.columns WHERE table_schema IN ('public','dataintel') ORDER BY 1`;
const Q_FNS = `SELECT p.proname||'/'||p.pronargs AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY 1`;
const Q_TENANT = `SELECT table_schema AS s, table_name||'.'||column_name AS tc FROM information_schema.columns WHERE table_schema LIKE 'tenant_%' ORDER BY 1,2`;

async function main() {
  const env = loadEnv();
  const token = env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error('SUPABASE_ACCESS_TOKEN not set');
    process.exit(2);
  }

  const tables = {};
  const cols = {};
  const fns = {};
  const tenantRows = {};
  for (const e of ENVS) {
    tables[e.name] = (await sql(e.ref, token, Q_TABLES)).map((r) => r.v);
    cols[e.name] = (await sql(e.ref, token, Q_COLS)).map((r) => r.v);
    fns[e.name] = (await sql(e.ref, token, Q_FNS)).map((r) => r.v);
    tenantRows[e.name] = await sql(e.ref, token, Q_TENANT);
  }

  const tableDrift = crossEnvTableDrift(tables);
  const columnDrift = crossEnvColumnDrift(cols);
  const functionDrift = crossEnvFunctionDrift(fns);
  const tenantDriftByEnv = {};
  for (const e of ENVS) tenantDriftByEnv[e.name] = tenantTemplateDrift(tenantRows[e.name]);

  console.log('=== Schema-parity gate (public+dataintel + tenant-template) ===\n');

  console.log('① Base tables:');
  for (const e of ENVS) {
    const m = tableDrift.missingByEnv[e.name];
    console.log(`  ${e.name.padEnd(5)} ${m.length ? '✗ mangler: ' + m.join(', ') : '✓'}`);
  }

  console.log('\n② Columns (public+dataintel, common tables):');
  for (const e of ENVS) {
    const x = columnDrift.extraByEnv[e.name];
    console.log(`  ${e.name.padEnd(5)} ${x.length ? '✗ har unikt: ' + x.join(', ') : '✓'}`);
  }

  console.log('\n③ Functions (non-extension):');
  for (const e of ENVS) {
    const x = functionDrift.extraByEnv[e.name];
    console.log(`  ${e.name.padEnd(5)} ${x.length ? '✗ har unikt: ' + x.join(', ') : '✓'}`);
  }

  console.log('\n④ Tenant-template uniformity (intra-env):');
  for (const e of ENVS) {
    const d = tenantDriftByEnv[e.name];
    console.log(
      `  ${e.name.padEnd(5)} ${d.schemaCount} skemaer, ${d.distinctStructures} strukturer` +
        ` (canonical ${d.canonicalCount}/${d.schemaCount})` +
        `${d.deviations.length ? ' ✗ ' + d.deviations.length + ' afviger' : ' ✓'}`
    );
    for (const dev of d.deviations) {
      const miss = dev.missing.slice(0, 5).join(', ') + (dev.missing.length > 5 ? '…' : '');
      const ext = dev.extra.slice(0, 5).join(', ') + (dev.extra.length > 5 ? '…' : '');
      console.log(`        ${dev.schema}: mangler[${miss}] extra[${ext}]`);
    }
  }

  const { hasDrift } = summarize({ tableDrift, columnDrift, functionDrift, tenantDriftByEnv });
  if (hasDrift) {
    console.error('\n✗ SCHEMA DRIFT detected — see report above.');
    process.exit(1);
  }
  console.log('\n✓ All environments in structural parity.');
}

// Only run when executed directly (keeps the module import side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
