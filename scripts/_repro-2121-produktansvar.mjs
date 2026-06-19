/**
 * BIZZ-2121 repro: kør police-pathen (parsePolicyFile, SYSTEM_PROMPT) på
 * produktansvars-policens extracted_text (/tmp/dbramante-produktansvar.txt)
 * og tjek om "Fareafværgelse" stadig kodes som driftstab. Engangs-script.
 */
import { readFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { config } from 'dotenv';
config({ path: '/root/BizzAssist/.env.local' });

const jiti = createJiti(import.meta.url, { alias: { '@': '/root/BizzAssist' } });
const parser = await jiti.import('/root/BizzAssist/app/lib/forsikring/parser.ts');

const text = readFileSync(process.argv[2] ?? '/tmp/dbramante-produktansvar.txt', 'utf8');
const res = await parser.parsePolicyFile(Buffer.from(text, 'utf8'), 'txt', process.env.BIZZASSIST_CLAUDE_KEY);
if (!res.ok) {
  console.log('PARSE FEJLEDE:', res.error);
  process.exit(1);
}
const p = res.policy;
console.log(`police: nr=${p.policy_number} | holder=${p.policyholder_name} | sum=${p.sum_insured_dkk ?? '-'}`);
for (const c of p.coverages ?? []) {
  console.log(`  ${c.coverage_code} | "${c.coverage_label}" | sum=${c.sum_dkk} | covered=${c.is_covered}`);
}
