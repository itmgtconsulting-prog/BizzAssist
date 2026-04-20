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
    h(2, 'Code-level verifikation — PASSED'),
    p(txt('Ny migration: '), code('supabase/migrations/051_tenant_ai_feedback_notification_backfill.sql'), txt(' med eksplicit BIZZ-644 reference.')),
    ul(
      li(p(strong('Del 1: '), code('provision_tenant_ai_tables()'), txt(' — ny SQL-funktion der opretter '), code('ai_feedback_log'), txt(' + '), code('notification_preferences'), txt(' i en given tenant-schema. Integreres i '), code('provision_tenant_schema()'), txt(' for nye tenants.'))),
      li(p(strong('Del 2: '), txt('Backfill-loop — '), code('CREATE TABLE IF NOT EXISTS'), txt(' + RLS-policies for alle eksisterende '), code('tenant_*'), txt('-schemaer.'))),
      li(p(strong('Idempotent design: '), txt('Kan køres flere gange uden fejl (CREATE TABLE IF NOT EXISTS + CREATE POLICY IF NOT EXISTS).'))),
    ),
    p(txt('Migration 051 løser 040 + 043 gap beskrevet i ticketens "Konkret situation (2026-04-20)". Kør på test + prod via normale migration-pipeline.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-644/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-644/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-644/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-644 → Done':`⚠️ (${r.status})`);
