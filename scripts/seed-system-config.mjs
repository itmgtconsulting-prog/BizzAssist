/**
 * Seed default values into public.system_config.
 *
 * BIZZ-419: Initial population af admin-konfigurerbare værdier. Script er
 * idempotent — kører ON CONFLICT (key) DO NOTHING så det kan gentages uden
 * at overskrive ændringer admin har lavet siden.
 *
 * Run: node scripts/seed-system-config.mjs
 *
 * Tilføj nye defaults ved at appende til SEEDS-arrayet herunder.
 */
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing SUPABASE_ACCESS_TOKEN');
  process.exit(1);
}

const PROJECTS = [
  { name: 'dev', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'test', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'prod', ref: 'xsyldjqcntiygrtfcszm' },
];

/**
 * Default-værdier pr. kategori. Disse matcher nuværende hardcoded values
 * i companyInfo + andre const-objekter. Formål er at give admin et
 * starting point — ingen application-code ændres som del af denne seed.
 *
 * JSONB tolereres som objekt/array/string/number/boolean.
 */
const SEEDS = [
  // ─── email ────────────────────────────────────────────────────────────
  {
    category: 'email',
    key: 'support_email',
    value: 'support@pecuniait.com',
    description: 'Support-email vist i footers, privacy-side og onboarding-mails.',
  },
  {
    category: 'email',
    key: 'noreply_email',
    value: 'noreply@bizzassist.dk',
    description: 'Afsender-adresse for transaktionelle emails (Resend).',
  },
  {
    category: 'email',
    key: 'admin_email',
    value: 'admin@bizzassist.dk',
    description: 'Intern admin-adresse for systemnotifikationer.',
  },

  // ─── company ──────────────────────────────────────────────────────────
  {
    category: 'company',
    key: 'company_name',
    value: 'Pecunia IT ApS',
    description: 'Juridisk navn på den virksomhed der driver BizzAssist. Bruges i emails og juridiske sider.',
  },
  {
    category: 'company',
    key: 'company_cvr',
    value: '44718502',
    description: 'CVR-nummer for driftsselskabet.',
  },
  {
    category: 'company',
    key: 'company_address',
    value: { address: 'Søbyvej 11', postalCode: '2650', city: 'Hvidovre', country: 'Denmark' },
    description: 'Firmaadresse til email-footers, privacy-side og PDF-generering.',
  },

  // ─── rate_limits ──────────────────────────────────────────────────────
  {
    category: 'rate_limits',
    key: 'ai_chat_requests_per_hour',
    value: 120,
    description: 'Maksimum AI-chat requests pr. hour pr. user. Håndhæves i /api/ai/chat via Upstash.',
  },
  {
    category: 'rate_limits',
    key: 'api_requests_per_minute',
    value: 60,
    description: 'Global rate-limit for authenticated API-requests pr. minute pr. user.',
  },

  // ─── cache ────────────────────────────────────────────────────────────
  {
    category: 'cache',
    key: 'bbr_ttl_seconds',
    value: 3600,
    description: 'Cache-TTL for BBR-data i sekunder. Data opdateres af Datafordeler hver nat — 1h er rimelig.',
  },
  {
    category: 'cache',
    key: 'cvr_ttl_seconds',
    value: 86400,
    description: 'Cache-TTL for CVR virksomhedsdata. Ændres sjældent — 24h acceptable.',
  },

  // ─── endpoints ────────────────────────────────────────────────────────
  {
    category: 'endpoints',
    key: 'datafordeler_graphql_url',
    value: 'https://services.datafordeler.dk/BBR/BBRPublic/1/REST/GraphQL',
    description: 'Datafordeler GraphQL endpoint for BBR-data. Kan skiftes mellem prod og test-miljø.',
  },
  {
    category: 'endpoints',
    key: 'df_proxy_base_url',
    value: 'https://bizzassist-test.bizzassist.dk',
    description: 'Hetzner-proxy base URL for mTLS-cert opkald til Tinglysning/Datafordeler.',
  },

  // ─── feature_flags ────────────────────────────────────────────────────
  {
    category: 'feature_flags',
    key: 'domain_feature_enabled',
    value: true,
    description: 'Master-switch for domain/sager-feature. Oprindelig styret via DOMAIN_FEATURE_ENABLED env-var.',
  },
  {
    category: 'feature_flags',
    key: 'ai_tools_enabled',
    value: true,
    description: 'Master-switch for AI-chat tool-use. Kan slås fra ved incidents.',
  },
];

async function runOn(p) {
  // Brug INSERT ... ON CONFLICT (key) DO NOTHING for idempotens.
  const values = SEEDS.map(
    (s) =>
      `(${escapeLit(s.category)}, ${escapeLit(s.key)}, ${escapeLit(JSON.stringify(s.value))}::jsonb, ${escapeLit(s.description ?? null)})`
  ).join(',\n');
  const sql = `
    INSERT INTO public.system_config (category, key, value, description)
    VALUES
    ${values}
    ON CONFLICT (key) DO NOTHING;
  `;

  const r = await fetch(`https://api.supabase.com/v1/projects/${p.ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error(`✗ ${p.name}: ${r.status} ${txt}`);
    return false;
  }
  console.log(`✓ ${p.name}: seeded ${SEEDS.length} defaults (existing keys skipped)`);
  return true;
}

function escapeLit(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replaceAll("'", "''") + "'";
}

const results = [];
for (const p of PROJECTS) {
  results.push(await runOn(p));
}
process.exit(results.every(Boolean) ? 0 : 1);
