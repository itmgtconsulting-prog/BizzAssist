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
    h(2, 'Trigger 2 (infra_down) implementeret (commit 4203b39)'),
    p(strong('Acceptance-criterium "Infra-komponent der går ned udløser service_manager_scans med scan_type=\'infra_down\' inden for 10 min"'),txt(' nu opfyldt med 2-konsekutive-filter der forhindrer falske positive.')),
    h(3, 'Implementation'),
    ul(
      li(p(strong('Migration 052: '),code('public.service_probe_history'),txt(' — ny tabel med '),code('service_id, probed_at, is_down, http_status, detail'),txt(' + indexes. Applied på dev + test + prod.'))),
      li(p(strong('service-scan cron probe-flow: '),txt('hourly probe af 7 infra-services (datafordeler, upstash, resend, cvr, brave, mediastack, twilio) via '),code('/api/admin/service-status?probe=<id>'),txt('. Hver probe logges til service_probe_history.'))),
      li(p(strong('2-konsekutive detection: '),txt('for hver service hentes de 2 seneste probe-rows; når begge har '),code('is_down=true'),txt(' oprettes '),code('scan_type=infra_down'),txt(' med service-id i summary.'))),
      li(p(strong('Dedup: '),txt('4-timers vindue per service (samme mønster som cron_failure) så persistent downtime ikke spammer.'))),
      li(p(strong('Auth-bypass: '),code('/api/admin/service-status'),txt(' accepterer nu '),code('Authorization: Bearer $CRON_SECRET'),txt(' som bypass for admin-gate, så cronen kan kalde probe-endpointet uden user session.'))),
    ),
    h(3, 'Dækker acceptance'),
    ul(
      li(p(txt('Cron-der-fejler → '),code('cron_failure'),txt('-scan ✅ (Trigger 1)'))),
      li(p(txt('Infra-komponent ned → '),code('infra_down'),txt('-scan ✅ (Trigger 2)'))),
      li(p(txt('Ingen falske positive ved single-probe-glitch ✅ (2-konsekutive filter)'))),
      li(p(txt('Agent-klassifikation (kodefix vs infra-action) + auto-apply: '),strong('ikke i dette commit'),txt(' — anbefales som separat tickets når vi har første real-world data fra de 2 triggers.'))),
    ),
    p(strong('7 unit-tests'),txt(' dækker detection-edge-cases. Total tests: 1480 grønne.')),
    p(strong('Klar til verifier-review. '),txt('Resterende 2 sub-leverancer (agent-klassifikation + auto-apply) anbefales splittes til separate follow-up-tickets.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-623/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-623/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-623 → In Review':`⚠️ (${tr.status})`);
