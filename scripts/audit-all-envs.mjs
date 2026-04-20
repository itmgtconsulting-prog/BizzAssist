/** Audit alle 3 Supabase-miljøer for manglende migrations */
const token = process.env.SUPABASE_ACCESS_TOKEN;
const projects = [
  { name: 'dev  ', ref: 'wkzwxfhyfmvglrqtmebw' },
  { name: 'test ', ref: 'rlkjmqjxmkxuclehbrnl' },
  { name: 'prod ', ref: 'xsyldjqcntiygrtfcszm' },
];

async function q(ref, sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  return { status: r.status, body: await r.json() };
}

// SQL probes per migration
const probes = {
  '039': `SELECT conname FROM pg_constraint WHERE conname='service_manager_scans_scan_type_check'`,
  '040': `SELECT to_regclass('public.ai_feedback_log') IS NOT NULL as exists`,
  '041': `SELECT to_regclass('public.cron_heartbeats') IS NOT NULL as exists`,
  '042': `SELECT to_regclass('public.consent_log') IS NOT NULL as exists`,
  '043': `SELECT to_regclass('public.notification_preferences') IS NOT NULL as exists`,
  '045': `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='plan_configs' AND column_name='payment_grace_hours'`,
  '046': `SELECT to_regclass('public.ejf_ejerskab') IS NOT NULL as exists`,
  '047': `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='ejf_ejerskab' AND column_name='ejer_ejf_id'`,
  '049': `SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='plan_configs' AND policyname='plan_configs_service_role_write'`,
  '050': `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='service_manager_scans_scan_type_check'`,
};

for (const p of projects) {
  console.log(`\n=== ${p.name} (${p.ref}) ===`);
  for (const [mig, sql] of Object.entries(probes)) {
    const r = await q(p.ref, sql);
    let summary = '';
    if (mig === '050') {
      const def = r.body?.[0]?.def ?? '';
      summary = def.includes('cron_failure') ? '✅ cron_failure allowed' : '❌ cron_failure missing';
    } else if (mig === '047') {
      summary = r.body?.[0]?.data_type === 'text' ? '✅ text' : `❌ ${r.body?.[0]?.data_type ?? 'col missing'}`;
    } else if (['040','041','042','043','046'].includes(mig)) {
      summary = r.body?.[0]?.exists ? '✅ exists' : '❌ missing';
    } else if (mig === '045') {
      summary = r.body?.[0]?.column_name === 'payment_grace_hours' ? '✅ exists' : '❌ missing';
    } else if (mig === '039') {
      summary = r.body?.length ? '✅ constraint exists' : '❌ missing';
    } else if (mig === '049') {
      summary = r.body?.[0]?.policyname ? '✅ policy exists' : '❌ missing';
    }
    console.log(`  ${mig}: ${summary}`);
  }
}
