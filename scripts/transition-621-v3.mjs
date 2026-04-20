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
    h(2, 'Manuel browser-verifikation — DELVIST, sender til To Do (2. gang)'),
    p(strong('Fremskridt siden sidste iteration: '), txt('HTTP 500 er væk. Siden loader, viser 14 cron-jobs listet med navn/beskrivelse/interval/schedule. Status-header siger "0/14 OK · 14 uden data".')),
    h(3, 'Tilbageværende bug'),
    p(txt('Gult varsel vises øverst:')),
    p(code('"Heartbeat-data kunne ikke hentes — Could not find the table \'public.cron_heartbeats\' in the schema cache"')),
    p(txt('Alle 14 rækker viser "Ingen data" fordi querien mod '), code('public.cron_heartbeats'), txt(' fejler i Supabase PostgREST.')),
    h(3, 'Fix-hypoteser'),
    ul(
      li(p(strong('Migration ikke kørt på test.bizzassist.dk: '), code('supabase/migrations/041_cron_heartbeats.sql'), txt(' opretter tabellen men er muligvis ikke applied på test-Supabase. Tjek via '), code('supabase migration list'), txt(' eller direkte i Supabase dashboard.'))),
      li(p(strong('Schema cache skal reloades: '), txt('efter migration kræver PostgREST NOTIFY pgrst reload — prøv '), code('SELECT pg_notify(\'pgrst\', \'reload schema\');'), txt(' i Supabase SQL editor.'))),
      li(p(strong('Heartbeats er ikke blevet skrevet endnu: '), txt('hvis tabellen eksisterer men er tom, bør "Ingen data" være korrekt for nylige deploys. Vent til cron-jobs har kørt mindst én gang.'))),
    ),
    h(3, 'Verifikation for Done'),
    p(txt('Alle 14 rækker skal vise '), code('seneste run'), txt(' + '), code('varighed'), txt(' + '), code('status-badge'), txt(' (grøn/gul/rød) i stedet for "Ingen data". Tabellen '), code('cron_heartbeats'), txt(' skal være populeret efter første cron-kørsel.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-621/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-621/transitions');
const todo = (JSON.parse(tr.body).transitions||[]).find(t=>/^to\s*do$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-621/transitions',{transition:{id:todo.id}});
console.log(r.status===204?'🔄 BIZZ-621 → To Do':`⚠️ (${r.status})`);
