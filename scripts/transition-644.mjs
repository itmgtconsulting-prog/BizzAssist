#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});r.on('error',rej);if(d)r.write(d);r.end()});}

const p = (...c) => ({ type:'paragraph', content:c });
const txt = (t,m) => m?{type:'text',text:t,marks:m}:{type:'text',text:t};
const strong = (s) => txt(s,[{type:'strong'}]);
const code = (s) => txt(s,[{type:'code'}]);
const h = (l,t) => ({type:'heading',attrs:{level:l},content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});

const body = {
  type:'doc', version:1, content:[
    h(2, 'Implementeret i commit d17adba'),
    p(txt('Fix i 3 lag — migration, provision-funktion, og TypeScript-caller.')),
    h(3, '1) Ny migration 051_tenant_ai_feedback_notification_backfill.sql'),
    ul(
      li(p(strong('Ny helper: '),code('public.provision_tenant_ai_tables(schema_name, tenant_id)'),txt(' — opretter begge tabeller + RLS-policies for ét tenant-schema'))),
      li(p(strong('RLS-policies: '),txt('ai_feedback_log (members read/write + admin delete) og notification_preferences (user own-data only)'))),
      li(p(strong('Idempotent: '),code('CREATE TABLE IF NOT EXISTS'),txt(' + '),code('DROP POLICY IF EXISTS'),txt(' — kan køres flere gange'))),
      li(p(strong('Backfill-DO-block: '),txt('iterér alle '),code("information_schema.schemata LIKE 'tenant_%'"),txt(', slå tenant_id op via '),code('public.tenants.schema_name'),txt(', og kald provision_tenant_ai_tables'))),
      li(p(strong('Orphan-håndtering: '),txt('schemaer uden matching tenants-række springes over med RAISE NOTICE'))),
    ),
    h(3, '2) TypeScript provisionTenantSchema udvidet'),
    p(code('lib/db/tenant.ts:800'),txt(' kalder nu '),code('admin.rpc(\'provision_tenant_ai_tables\')'),txt(' efter '),code('provision_tenant_schema'),txt(' — så nye tenants også får tabellerne. Fejl her er ikke-fatal (core-flow med tenants-row + primære tabeller har præcedens).')),
    h(3, '3) Kørt på alle 3 miljøer via Management API'),
    ul(
      li(p(strong('Dev: '),txt('3 tenants backfilled (+ literal tenant-schema havde allerede tabellerne)'))),
      li(p(strong('Test: '),txt('1 tenant backfilled — øvrige 3 har ingen matching schema (orphan-tenants-rows)'))),
      li(p(strong('Prod: '),txt('9 tenants × 2 tabeller = 18 tabeller oprettet ✅'))),
    ),
    p(strong('Verifikation:')),
    ul(
      li(p(code("SELECT table_schema FROM information_schema.tables WHERE table_name='ai_feedback_log' AND table_schema LIKE 'tenant_%'"),txt(' bekræfter eksistens på begge miljøer'))),
      li(p(code('scripts/run-migrations.mjs'),txt(' opdateret — 051 er nu i listen på alle 3 envs'))),
      li(p(code('npx tsc + npm test'),txt(' grønne (1448 passed)'))),
    ),
    h(3, 'Acceptkriterier'),
    ul(
      li(p(txt('Alle tenant-schemaer på test + prod har ai_feedback_log + notification_preferences ✅'))),
      li(p(txt('RLS-policies er aktive (tenant_member/admin checks via is_tenant_member + is_tenant_admin) ✅'))),
      li(p(txt('Nye tenants får tabellerne automatisk via updated provisionTenantSchema ✅'))),
      li(p(txt('Backfill-script er committed (migration 051) så det kan genbruges ✅'))),
    ),
    p(strong('Klar til review.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-644/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-644/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-644 → In Review':`⚠️ (${tr.status})`);
