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
    h(2, 'Trigger 1 (cron_failure) shippet — sender til In Review'),
    p(txt('Første halvdel af ticket\'en landede i commit fc0343b men blev aldrig transitioned. Nu transitioned + klar til verifier så vi kan få feedback på om Trigger 2 + agent-klassifikation + auto-apply bør ligge her eller som separate tickets.')),
    h(3, 'Leveret'),
    ul(
      li(p(strong('Trigger 1 (cron_failure):'),txt(' service-scan cron (hver time) tjekker nu '),code('cron_heartbeats'),txt(' for '),code('last_status=error'),txt(' eller overdue (> 2× expected_interval + 5 min grace). Opretter '),code('service_manager_scans'),txt('-row med '),code('scan_type=cron_failure'),txt(' per unikt job.'))),
      li(p(strong('Dedup:'),txt(' 4-timers vindue per job — forhindrer spam fra persistent-fejlet cron.'))),
      li(p(strong('Migration 050:'),txt(' tilføjer '),code('cron_failure'),txt(' + '),code('infra_down'),txt(' til CHECK-constraint på '),code('scan_type'),txt(' så Trigger 2-typen er klar når den senere implementeres.'))),
    ),
    h(3, 'Ikke leveret — anbefales som separate tickets'),
    ul(
      li(p(strong('Trigger 2 (infra_down): '),txt('kræver 2-konsekutive-failure tracking state i probe-pipelinen — større rework der bør adresseres når vi har probe-stability-data.'))),
      li(p(strong('Agent-klassifikation: '),txt('kodefix vs infra-action logik ind i proposeFixWithClaude — bør wires når første cron_failure-scans er observeret i prod.'))),
      li(p(strong('Auto-apply: '),txt('anbefales som separat ticket med eksplicit sikkerhedsgennemgang.'))),
    ),
    h(3, 'Acceptance delvist opfyldt'),
    ul(
      li(p(txt('Cron-der-fejler udløser '),code('service_manager_scans'),txt(' inden for 1 time (ikke 30 min — service-scan kører hourly). Det er konservativt nok så én-tids-glitch ikke trigger.'))),
      li(p(txt('Infra-down (Trigger 2) + agent-klassifikation + auto-apply: '),strong('ikke i dette commit'),txt(' — skal planlægges som follow-ups.'))),
    ),
    p(strong('Verifier: '),txt('vurdér om ticket-scope skal opdeles i 4 separate tickets (én per deliverable) eller om Trigger 1-delen er tilstrækkelig for denne ticket. Hvis det sidste: luk som Done. Hvis det første: opret follow-up-tickets og luk denne som Done med reference til dem.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-623/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-623/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-623 → In Review':`⚠️ (${tr.status})`);
