/**
 * BIZZ-2121 repro: kør parseOversigt på DBRAMANTE-aftalens extracted_text
 * (/tmp/dbramante-text.txt) og rapportér hvilke forsikringer/coverages der
 * fanges. Engangs-script.
 */
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const jiti = createJiti(import.meta.url, { alias: { '@': '/root/BizzAssist' } });
const parser = await jiti.import('/root/BizzAssist/app/lib/forsikring/parser.ts');

const text = readFileSync(process.argv[2] ?? '/tmp/dbramante-text.txt', 'utf8');
const res = await parser.parseOversigt(text, process.env.BIZZASSIST_CLAUDE_KEY);
if (!res.ok) {
  console.log('PARSE FEJLEDE:', res.error);
  process.exit(1);
}
const pols = res.oversigt.policies;
console.log(`policies: ${pols.length}`);
for (const p of pols) {
  console.log(
    `\n— ${p.insurance_type ?? '?'} | nr=${p.policy_number} | addr=${p.property_address ?? '-'} | sum=${p.sum_insured_dkk ?? '-'}`
  );
  for (const c of p.coverages ?? []) {
    console.log(`    ${c.coverage_code} | "${c.coverage_label}" | sum=${c.sum_dkk} | covered=${c.is_covered}`);
  }
}
