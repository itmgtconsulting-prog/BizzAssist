#!/usr/bin/env node
import { config } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

config({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

if (process.env.PROJECT_REF) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${process.env.PROJECT_REF}.supabase.co`;
}

const { fetchCatalog, _resetCatalogCache } = await import('../app/lib/dataIntelligence/fetchCatalog.ts');
const { formatCatalogForPrompt } = await import('../app/lib/dataIntelligence/formatCatalogForPrompt.ts');

_resetCatalogCache();
const { rows, computedAt } = await fetchCatalog();
console.log('# rows:', rows.length, '| computedAt:', computedAt);
console.log('---');
const md = formatCatalogForPrompt(rows, computedAt || undefined);
console.log(md);
console.log('---');
console.log('Length chars:', md.length, '| approx tokens:', Math.ceil(md.length / 4));
