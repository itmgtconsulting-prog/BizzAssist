#!/usr/bin/env node
/**
 * BIZZ-1959: Data-eksploration — kategorisér unmatched ejf_administrator-records
 * og mål baseline match-rate pr. approach på en deterministisk stikprøve.
 *
 * Formål: FØR vi bygger flere backfill-fixes vil vi vide HVORFOR de gældende
 * ejf_administrator-records uden CVR ikke matcher en ejerforening — og hvor
 * meget hver approach realistisk kan løse. Ingen UI-/schema-ændringer; output
 * er et MD-dokument der dirigerer fremtidige fix-tickets.
 *
 * 4 approaches (kørt parallelt pr. BFE):
 *   A. Eksisterende vejnavn+husnr-search  — tmp_ejerforening_cvr.navn_lower LIKE
 *      '%vejnavn husnr%' + husnr word-boundary-filter (= backfill-ejf-admin-cvr-match).
 *   B. Vejnavn-only (bredere)             — drop husnr-leddet. Måler bredere yield
 *      OG false-positive-risiko (flere kandidater på samme vej).
 *   C. Fuzzy similarity (embedding-PROXY) — INGEN embedding-provider er konfigureret
 *      i miljøet (OPENAI_API_KEY/VOYAGE_API_KEY mangler), så vi bruger pg_trgm
 *      similarity('E/F vejnavn husnr' ↔ forenings-navn) over hele ejerforenings-
 *      universet som et deterministisk PROXY for cosine-similarity. Giver en
 *      threshold-kurve der estimerer loftet en rigtig embedding-approach kan nå.
 *   D. Resights direkte lookup            — BLOKERET: ingen Resights-credentials i
 *      miljøet. Rapporteres som ikke-målt (kræver separat adgang).
 *
 * Segmenter (pr. BFE, prioriteret klassifikation):
 *   RESOLVABLE_VIA_A    — A==1, eller A==0 & B==1 (entydig vejnavn-forening)
 *   AMBIGUOUS           — A>1, eller (A==0 & B>1): flere plausible → kræver verifikation
 *   RESOLVABLE_VIA_C    — A/B løste ikke, men trigram-proxy giver entydigt højt match
 *   RESOLVABLE_VIA_D    — 0 (blokeret)
 *   WRONG_BRANCH        — forening med vejnavn findes i cvr_virksomhed, men IKKE i
 *                         ejerforenings-universet (anden branchekode)
 *   NO_CVR_EJERFORENING — ingen forening nævner vejnavnet nogensteds → irreducible
 *
 * Usage:
 *   node scripts/analyze-unmatched-ejf-admin.mjs [--sample=200] [--seed=1959] [--no-dawa]
 */
import pg from 'pg';
import fs from 'fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const SAMPLE = parseInt(args.sample || '200', 10);
const SEED = args.seed || '1959';
const USE_DAWA = args['no-dawa'] !== 'true';

const env = fs.readFileSync('/root/BizzAssist/.env.local', 'utf8');
const PROD_DB_URL = env.match(/^SUPABASE_PROD_DB_URL=(.+)$/m)?.[1];
const HAS_EMBEDDING_PROVIDER = !!(env.match(/^OPENAI_API_KEY=(.+)$/m) || env.match(/^VOYAGE_API_KEY=(.+)$/m));
const HAS_RESIGHTS = !!env.match(/^RESIGHTS_/m);

const DAWA_BASE = 'https://api.dataforsyningen.dk';

// Trigram-similarity thresholds for approach C-proxy (cosine-analog kurve).
const C_THRESHOLDS = [0.3, 0.4, 0.5, 0.6];
// "Entydigt højt" C-match: top-sim skal være ≥ dette OG have margin til #2.
const C_HIGH = 0.5;
const C_MARGIN = 0.1;

/**
 * Udtræk vejnavn + husnr fra en dansk adressestreng.
 * "Lundevej 6B" → { vejnavn: 'Lundevej', husnr: '6B' }
 * Fjerner etage/dør- og parentes-suffikser før husnr-udtræk.
 *
 * @param {string} adresse - rå adresse fra bfe_adresse_cache
 * @returns {{vejnavn: string, husnr: string}}
 */
function extractVejnavnHusnr(adresse) {
  const cleaned = adresse
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/,\s*\d*\.?\s*(?:kl|st|sal|th|tv|mf)\.?\s*$/i, '')
    .replace(/,.*$/, '')
    .trim();
  const m = cleaned.match(/^(.*?)\s+(\d+[a-zA-ZæøåÆØÅ]?)\s*$/);
  if (m) return { vejnavn: m[1].trim(), husnr: m[2].trim() };
  return { vejnavn: cleaned, husnr: '' };
}

/** SQL LIKE-escape for et bruger-leveret substring. */
function likeEsc(s) {
  return s.replace(/[%_\\]/g, '\\$&');
}

/**
 * Approach A — eksisterende vejnavn+husnr-match mod ejerforenings-universet.
 * @returns {Promise<{count:number, rows:Array<{cvr:string,navn:string}>}>}
 */
async function approachA(client, vejnavn, husnr) {
  const v = likeEsc(vejnavn.toLowerCase());
  let rows;
  if (husnr) {
    const r = await client.query(
      `SELECT cvr, navn FROM tmp_ejerforening_cvr WHERE navn_lower LIKE $1 LIMIT 25`,
      [`%${v} ${husnr.toLowerCase()}%`]
    );
    // Word-boundary husnr-filter (8 må ikke matche 80 / 8-10).
    const re = new RegExp(
      `\\b${husnr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([,. ;/-]|$|\\s+(og|m\\.fl|mfl|,))`,
      'i'
    );
    rows = r.rows.filter((x) => re.test(x.navn));
  } else {
    const r = await client.query(
      `SELECT cvr, navn FROM tmp_ejerforening_cvr WHERE navn_lower LIKE $1 LIMIT 25`,
      [`%${v}%`]
    );
    rows = r.rows;
  }
  return { count: rows.length, rows };
}

/**
 * Approach B — bredere vejnavn-only match (uden husnr-led).
 * @returns {Promise<{count:number, rows:Array<{cvr:string,navn:string}>}>}
 */
async function approachB(client, vejnavn) {
  const v = likeEsc(vejnavn.toLowerCase());
  const r = await client.query(
    `SELECT cvr, navn FROM tmp_ejerforening_cvr WHERE navn_lower LIKE $1 LIMIT 25`,
    [`%${v}%`]
  );
  return { count: r.rows.length, rows: r.rows };
}

/**
 * Approach C-proxy — pg_trgm similarity mellem 'e/f vejnavn husnr' og
 * forenings-navne. Deterministisk stand-in for embedding cosine-similarity.
 * @returns {Promise<{top:{cvr:string,navn:string,sim:number}|null, second:number}>}
 */
async function approachCproxy(client, vejnavn, husnr) {
  const query = `e/f ${vejnavn} ${husnr}`.toLowerCase().trim();
  const r = await client.query(
    `SELECT cvr, navn, similarity(navn_lower, $1) AS sim
       FROM tmp_ejerforening_cvr
      WHERE navn_lower % $1
      ORDER BY sim DESC
      LIMIT 5`,
    [query]
  );
  if (r.rows.length === 0) return { top: null, second: 0 };
  return {
    top: { cvr: r.rows[0].cvr, navn: r.rows[0].navn, sim: Number(r.rows[0].sim) },
    second: r.rows[1] ? Number(r.rows[1].sim) : 0,
  };
}

/**
 * WRONG_BRANCH-detektor — findes der en forening hvis navn nævner vejnavnet i
 * cvr_virksomhed, men som IKKE er i ejerforenings-universet (tmp)? Det indikerer
 * en eksisterende ejerforening registreret under en anden branchekode.
 * @returns {Promise<boolean>}
 */
async function hasWrongBranchForening(client, vejnavn) {
  const r = await client.query(
    `SELECT v.cvr
       FROM cvr_virksomhed v
       LEFT JOIN tmp_ejerforening_cvr t ON t.cvr = v.cvr
      WHERE t.cvr IS NULL
        AND v.branche_kode <> '683220'
        AND to_tsvector('danish', v.navn) @@ plainto_tsquery('danish', $1)
        AND (lower(v.navn) LIKE '%ejerforening%' OR lower(v.navn) LIKE '%e/f%'
             OR lower(v.navn) LIKE '%a/b%' OR lower(v.navn) LIKE '%andelsbolig%')
      LIMIT 1`,
    [`${vejnavn} ejerforening`]
  );
  return r.rows.length > 0;
}

/** DAWA matrikel-lookup (informativt; non-fatal, timeboxet). */
async function getMatrikel(bfe, dawaId) {
  if (!USE_DAWA) return null;
  try {
    const r = await fetch(`${DAWA_BASE}/jordstykker?bfenummer=${bfe}&format=json`, {
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const arr = await r.json();
      if (arr[0]?.matrikelnr) return arr[0].matrikelnr;
    }
  } catch {
    /* non-fatal */
  }
  if (dawaId) {
    try {
      const r = await fetch(`${DAWA_BASE}/adgangsadresser/${dawaId}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const a = await r.json();
        if (a.jordstykke?.matrikelnr) return a.jordstykke.matrikelnr;
      }
    } catch {
      /* non-fatal */
    }
  }
  return null;
}

/**
 * Dækker en forenings navn et givent husnr? Street-level navne uden tal
 * (fx "E/F Brabrand Skovvej") dækker hele vejen; navne med husnr/range
 * (fx "E/F Vesterbrogade 13-15") dækker kun hvis vores husnr er inkluderet.
 *
 * @param {string} navn - forenings-navn
 * @param {string} husnr - vores husnr, fx "15A"
 * @returns {boolean}
 */
function foreningCoversHusnr(navn, husnr) {
  const nums = (navn.match(/\d+/g) ?? []).map(Number);
  if (nums.length === 0) return true; // street-level navn → dækker hele vejen
  const our = parseInt(husnr, 10);
  if (Number.isNaN(our)) return false; // forening er husnr-specifik, vi har intet husnr
  // Ranges (fx "13-15"): tjek inklusion.
  for (const rm of navn.matchAll(/(\d+)\s*-\s*(\d+)/g)) {
    if (our >= Number(rm[1]) && our <= Number(rm[2])) return true;
  }
  return nums.includes(our); // eksakt husnr-match i navnet
}

/**
 * Klassificér én BFE i præcis ét segment ud fra approach-resultaterne.
 * @returns {string|null} segment-navn, eller null hvis wrong-branch/no-cvr skal afgøres async
 */
function classify({ a, b, husnr }) {
  if (a.count === 1) return 'RESOLVABLE_VIA_A'; // eksisterende approach løser den
  if (a.count > 1) return 'AMBIGUOUS';
  // a.count === 0 herfra.
  if (b.count > 1) return 'AMBIGUOUS';
  if (b.count === 1) {
    // Entydig vejnavn-forening: kun resolvable hvis navnet faktisk dækker husnr.
    return foreningCoversHusnr(b.rows[0].navn, husnr) ? 'RESOLVABLE_VIA_A' : 'AMBIGUOUS';
  }
  // a.count===0 && b.count===0 → ingen direkte navne-substring-match.
  return null; // C / wrong-branch / no-cvr afgøres i kalder
}

async function main() {
  console.log(`[1959] sample=${SAMPLE} seed=${SEED} dawa=${USE_DAWA}`);
  console.log(`[1959] embedding-provider=${HAS_EMBEDDING_PROVIDER} resights=${HAS_RESIGHTS}`);
  const pool = new pg.Pool({ connectionString: PROD_DB_URL, max: 6, statement_timeout: 120000 });

  // Universe-tal til rapporten.
  const meta = (
    await pool.query(`
    SELECT
      (SELECT count(*) FROM ejf_administrator WHERE status='gældende' AND administrator_type='ukendt' AND virksomhed_cvr IS NULL)::int AS unmatched_total,
      (SELECT count(*) FROM ejf_administrator a JOIN bfe_adresse_cache ba ON ba.bfe_nummer=a.bfe_nummer
         WHERE a.status='gældende' AND a.administrator_type='ukendt' AND a.virksomhed_cvr IS NULL
           AND ba.adresse IS NOT NULL AND ba.adresse <> 'Ukendt adresse' AND ba.adresse NOT LIKE 'BFE %' AND ba.postnr <> '0000')::int AS unmatched_with_addr,
      (SELECT count(*) FROM tmp_ejerforening_cvr)::int AS ejf_universe,
      (SELECT count(*) FROM cvr_virksomhed WHERE branche_kode='683220')::int AS branche_683220
  `)
  ).rows[0];

  // Deterministisk stikprøve: kun records med RIGTIG adresse (ikke 'Ukendt adresse'/0000).
  const { rows: sample } = await pool.query(
    `SELECT a.bfe_nummer, ba.adresse, ba.postnr, ba.dawa_id
       FROM ejf_administrator a
       JOIN bfe_adresse_cache ba ON ba.bfe_nummer = a.bfe_nummer
      WHERE a.status='gældende' AND a.administrator_type='ukendt' AND a.virksomhed_cvr IS NULL
        AND ba.adresse IS NOT NULL AND ba.adresse <> 'Ukendt adresse' AND ba.adresse NOT LIKE 'BFE %' AND ba.postnr <> '0000'
      ORDER BY md5(a.bfe_nummer::text || $1)
      LIMIT $2`,
    [SEED, SAMPLE]
  );
  console.log(`[1959] stikprøve: ${sample.length} BFE'er med rigtig adresse`);

  const segments = {
    RESOLVABLE_VIA_A: 0,
    RESOLVABLE_VIA_C: 0,
    RESOLVABLE_VIA_D: 0,
    AMBIGUOUS: 0,
    WRONG_BRANCH: 0,
    NO_CVR_EJERFORENING: 0,
  };
  // Approach-aggregater.
  const aStats = { unique: 0, ambiguous: 0, none: 0, candSum: 0 };
  const bStats = { unique: 0, ambiguous: 0, none: 0, candSum: 0 };
  const cCurve = Object.fromEntries(C_THRESHOLDS.map((t) => [t, { any: 0, uniqueHigh: 0 }]));
  const examples = [];

  let i = 0;
  const CONC = 6;
  async function processOne(rec) {
    const client = await pool.connect();
    try {
      const { vejnavn, husnr } = extractVejnavnHusnr(rec.adresse);
      if (!vejnavn || vejnavn.length < 2) {
        return { segment: 'NO_CVR_EJERFORENING', rec, vejnavn, husnr, a: { count: 0 }, b: { count: 0 }, c: { top: null, second: 0 } };
      }
      // Sekventielt: én pg-client kan ikke køre parallelle queries.
      const a = await approachA(client, vejnavn, husnr);
      const b = await approachB(client, vejnavn);
      const c = await approachCproxy(client, vejnavn, husnr);
      let segment = classify({ a, b, husnr });
      if (!segment) {
        // A/B gav ingen navne-substring-match. Tjek C-proxy for et entydigt højt
        // fuzzy-match (sim≥C_HIGH med margin til #2) → kandidat til embedding-fix.
        if (c.top && c.top.sim >= C_HIGH && c.top.sim - c.second >= C_MARGIN) {
          segment = 'RESOLVABLE_VIA_C';
        } else {
          const wrong = await hasWrongBranchForening(client, vejnavn);
          segment = wrong ? 'WRONG_BRANCH' : 'NO_CVR_EJERFORENING';
        }
      }
      return { segment, rec, vejnavn, husnr, a, b, c };
    } finally {
      client.release();
    }
  }

  for (let off = 0; off < sample.length; off += CONC) {
    const batch = sample.slice(off, off + CONC);
    // DAWA matrikel parallelt (informativt) — påvirker ikke klassifikation.
    const results = await Promise.all(
      batch.map(async (rec) => {
        const res = await processOne(rec);
        res.matrikel = await getMatrikel(rec.bfe_nummer, rec.dawa_id);
        return res;
      })
    );
    for (const r of results) {
      i++;
      segments[r.segment]++;
      // Approach A-aggregat
      if (r.a.count === 1) aStats.unique++;
      else if (r.a.count > 1) aStats.ambiguous++;
      else aStats.none++;
      aStats.candSum += r.a.count;
      // Approach B-aggregat
      if (r.b.count === 1) bStats.unique++;
      else if (r.b.count > 1) bStats.ambiguous++;
      else bStats.none++;
      bStats.candSum += r.b.count;
      // Approach C-kurve
      for (const t of C_THRESHOLDS) {
        if (r.c.top && r.c.top.sim >= t) {
          cCurve[t].any++;
          if (r.c.top.sim - r.c.second >= C_MARGIN) cCurve[t].uniqueHigh++;
        }
      }
      if (examples.length < 20) {
        examples.push({
          bfe: r.rec.bfe_nummer,
          adresse: r.rec.adresse,
          postnr: r.rec.postnr,
          vejnavn: r.vejnavn,
          husnr: r.husnr,
          matrikel: r.matrikel ?? '—',
          segment: r.segment,
          A: r.a.count,
          B: r.b.count,
          Ctop: r.c.top ? `${r.c.top.sim.toFixed(2)} ${r.c.top.navn.slice(0, 40)}` : '—',
        });
      }
    }
    if (i % 30 === 0 || i === sample.length) console.log(`[1959] ${i}/${sample.length}`);
  }

  const n = sample.length;
  const pct = (x) => ((x / n) * 100).toFixed(1) + '%';

  // ── Byg MD-rapport ──
  const now = new Date().toISOString().slice(0, 10);
  let md = `# EJF-administrator match-baseline (BIZZ-1959)\n\n`;
  md += `> Genereret ${now} af \`scripts/analyze-unmatched-ejf-admin.mjs\` (sample=${n}, seed=${SEED}, deterministisk).\n`;
  md += `> Datakilde: PROD-DB. Ingen UI-/schema-ændringer — ren data-eksploration.\n\n`;

  md += `## Universe\n\n`;
  md += `| Mål | Antal |\n|---|---|\n`;
  md += `| Gældende ejf_administrator uden CVR (\`administrator_type='ukendt'\`) | **${meta.unmatched_total.toLocaleString('da-DK')}** |\n`;
  md += `| — heraf med rigtig adresse (ekskl. 'Ukendt adresse'/postnr 0000) | ${meta.unmatched_with_addr.toLocaleString('da-DK')} |\n`;
  md += `| Ejerforenings-navne-universe (\`tmp_ejerforening_cvr\`) | ${meta.ejf_universe.toLocaleString('da-DK')} |\n`;
  md += `| Virksomheder med branchekode 683220 | ${meta.branche_683220.toLocaleString('da-DK')} |\n\n`;
  md += `**NB:** Ticket nævnte 15.028 unmatched — det matcher dawa-delmængden på analysetidspunktet. Aktuelt totale unmatched-tal er ${meta.unmatched_total.toLocaleString('da-DK')} (vokset siden). Procenterne nedenfor er på en tilfældig stikprøve på ${n} records med rigtig adresse.\n\n`;

  md += `## Approach-resultater (stikprøve N=${n})\n\n`;
  md += `### A. Eksisterende vejnavn+husnr-search\n\n`;
  md += `| Udfald | Antal | Andel |\n|---|---|---|\n`;
  md += `| Entydigt match (A==1) | ${aStats.unique} | ${pct(aStats.unique)} |\n`;
  md += `| Flertydigt (A>1) | ${aStats.ambiguous} | ${pct(aStats.ambiguous)} |\n`;
  md += `| Intet match (A==0) | ${aStats.none} | ${pct(aStats.none)} |\n`;
  md += `| Gns. kandidater pr. BFE | ${(aStats.candSum / n).toFixed(2)} | |\n\n`;

  md += `### B. Vejnavn-only (bredere, uden husnr)\n\n`;
  md += `| Udfald | Antal | Andel |\n|---|---|---|\n`;
  md += `| Entydigt match (B==1) | ${bStats.unique} | ${pct(bStats.unique)} |\n`;
  md += `| Flertydigt (B>1 — false-positive-risiko) | ${bStats.ambiguous} | ${pct(bStats.ambiguous)} |\n`;
  md += `| Intet match (B==0) | ${bStats.none} | ${pct(bStats.none)} |\n`;
  md += `| Gns. kandidater pr. BFE | ${(bStats.candSum / n).toFixed(2)} | |\n\n`;

  md += `### C. Fuzzy similarity (embedding-PROXY via pg_trgm)\n\n`;
  md += `> ${HAS_EMBEDDING_PROVIDER ? 'Embedding-provider konfigureret.' : '**Ingen embedding-provider (OPENAI_API_KEY/VOYAGE_API_KEY mangler)** — kørt som deterministisk pg_trgm similarity-proxy. Tallene estimerer loftet en rigtig embedding-cosine-approach ville nå; trigram undervurderer typisk semantiske matches (forkortelser, ordstilling).'}\n\n`;
  md += `| Similarity-threshold | BFE'er m. match | — heraf entydigt højt (margin≥${C_MARGIN}) |\n|---|---|---|\n`;
  for (const t of C_THRESHOLDS) {
    md += `| sim ≥ ${t} | ${cCurve[t].any} (${pct(cCurve[t].any)}) | ${cCurve[t].uniqueHigh} (${pct(cCurve[t].uniqueHigh)}) |\n`;
  }
  md += `\n`;

  md += `### D. Resights direkte lookup\n\n`;
  md += `**BLOKERET** — ingen Resights-credentials i miljøet (\`RESIGHTS_*\` mangler i \`.env.local\`). Kan ikke måles uden separat API-adgang. Anbefales scoped til egen spike-ticket hvis adgang skaffes.\n\n`;

  md += `## Segment-fordeling (hver BFE i præcis ét segment)\n\n`;
  md += `| Segment | Antal | Andel | Betydning |\n|---|---|---|---|\n`;
  const segDesc = {
    RESOLVABLE_VIA_A: 'Vejnavn-search løser den (A==1 eller entydig vejnavn-only)',
    RESOLVABLE_VIA_C: 'Fuzzy-proxy giver entydigt højt match — kandidat til embedding-fix',
    RESOLVABLE_VIA_D: 'Resights (blokeret — ikke målt)',
    AMBIGUOUS: 'Flere plausible foreninger — kræver crowdsourced verifikation (BIZZ-1830)',
    WRONG_BRANCH: 'Forening findes men under anden branchekode end 683220',
    NO_CVR_EJERFORENING: 'Ingen forening nævner vejnavnet — irreducible (ingen CVR-ejerforening)',
  };
  for (const [seg, cnt] of Object.entries(segments)) {
    md += `| ${seg} | ${cnt} | ${pct(cnt)} | ${segDesc[seg]} |\n`;
  }
  md += `\n`;

  md += `## 20 eksempel-cases (til manuel validering)\n\n`;
  md += `| BFE | Adresse | Vejnavn | Husnr | Matrikel | Segment | A | B | C-top |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const e of examples) {
    md += `| ${e.bfe} | ${e.adresse} | ${e.vejnavn} | ${e.husnr || '—'} | ${e.matrikel} | ${e.segment} | ${e.A} | ${e.B} | ${e.Ctop} |\n`;
  }
  md += `\n`;

  const resolvableA = segments.RESOLVABLE_VIA_A;
  const resolvableC = segments.RESOLVABLE_VIA_C;
  const ambiguous = segments.AMBIGUOUS;
  const noCvr = segments.NO_CVR_EJERFORENING;
  const wrong = segments.WRONG_BRANCH;
  md += `## Anbefaling (ROI pr. backfill-fix)\n\n`;
  md += `Ekstrapoleret til hele populationen (${meta.unmatched_total.toLocaleString('da-DK')} unmatched):\n\n`;
  md += `1. **RESOLVABLE_VIA_A (${pct(resolvableA)} ≈ ${Math.round((resolvableA / n) * meta.unmatched_total).toLocaleString('da-DK')} records)** — højeste ROI og lavest risiko. Re-kør den eksisterende vejnavn+husnr-backfill (post BIZZ-1888/1917-fixes) på hele populationen. Disse burde have matchet og gør det nu.\n`;
  md += `2. **AMBIGUOUS (${pct(ambiguous)})** — kanaliser til crowdsourced verifikation (BIZZ-1830). Auto-match er for risikabelt (flere foreninger på samme vej).\n`;
  md += `3. **RESOLVABLE_VIA_C (${pct(resolvableC)} via trigram-proxy)** — medium ROI, men kræver embedding-provider (OPENAI/VOYAGE-key). **Tallet skal IKKE auto-matches:** trigram-proxyen producerer street-navn-false-positives — fx blev "Grevenlundsvej 22A" matchet til "E/F Gyldenlundsvej 21" (anden vej, sim 0.50). Trigram måler tegn-overlap, ikke semantik, så det både over- og underestimerer en rigtig embedding-approach. Behandl C-segmentet som *kandidater til manuel/embedding-verifikation* (BIZZ-1960), ikke som klar-til-backfill. Byg KUN hvis A+verifikation ikke er nok.\n`;
  md += `4. **WRONG_BRANCH (${pct(wrong)})** — foreninger findes men under anden branchekode. Lav ROI: udvid ejerforenings-universet (\`tmp_ejerforening_cvr\`) til at inkludere navne-mønster uanset branchekode, så A/B fanger dem.\n`;
  md += `5. **NO_CVR_EJERFORENING (${pct(noCvr)})** — irreducible: der findes ingen CVR-registreret ejerforening for adressen. Byg IKKE flere fixes mod disse; markér dem \`administrator_type='ingen_cvr_forening'\` så de holdes ude af fremtidige candidate-tællinger.\n\n`;
  md += `**Bottom line:** Start med at re-køre Approach A på fuld population (størst yield, nul ny infrastruktur), send AMBIGUOUS til verifikation, og reservér embedding-arbejdet (C/BIZZ-1960) til resten. ${pct(noCvr)} er sandsynligvis uopnåelige og bør mærkes som sådan for at stoppe gentagne candidate-re-scans.\n`;

  const outPath = '/root/BizzAssist/docs/analyse/ejf-admin-match-baseline.md';
  fs.mkdirSync('/root/BizzAssist/docs/analyse', { recursive: true });
  fs.writeFileSync(outPath, md);

  console.log('\n[1959] SEGMENTER:');
  for (const [seg, cnt] of Object.entries(segments)) console.log(`  ${seg}: ${cnt} (${pct(cnt)})`);
  console.log(`\n[1959] Approach A: unique=${pct(aStats.unique)} ambiguous=${pct(aStats.ambiguous)} none=${pct(aStats.none)}`);
  console.log(`[1959] MD skrevet: ${outPath}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
