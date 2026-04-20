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

// BIZZ-596 → To Do (ejerlejlighed bolig stadig null)
const b596 = {
  type:'doc', version:1, content:[
    h(2, 'API-level re-verifikation — FAILED (ejerlejlighed bolig stadig null)'),
    p(txt('Kaffevej 31 1.tv (BFE 425479, ejerlejlighed): '), code('boligAreal=null'), txt(' returneres stadig fra '), code('/api/ejendomme-by-owner/enrich'), txt(' — brugerens oprindelige klage ("596 på ejendomstab viser lejligheder ikke korrekt antal bolig m2") er fortsat ikke løst.')),
    p(txt('Sammenligning: Søbyvej 11 (BFE 2081243, SFE/bolig) returnerer '), code('boligAreal=220'), txt(' ✅. Problemet er specifikt for '), strong('ejerlejligheder'), txt(' — BBR_Enhed-lookup er ikke wired op til enrich-endpointet (selvom BIZZ-637 indførte logikken i '), code('fetchBbrData.ts'), txt(').')),
    p(strong('Fix: '), code('/api/ejendomme-by-owner/enrich/route.ts'), txt(' skal genbruge BIZZ-637\'s ejerlejlighed-branch i '), code('fetchBbrData'), txt(' — nuværende kode bruger kun BBR_Bygning-areal.')),
  ],
};

// BIZZ-623 → To Do (infra_down mangler)
const b623 = {
  type:'doc', version:1, content:[
    h(2, 'Code-level re-verifikation — DELVIST (cron-fejl ✅, infra_down ❌)'),
    p(strong('✅ Trigger 1 implementeret: '), code('service-scan/route.ts:912+949+957'), txt(' — cron-heartbeat-fejl opretter '), code('service_manager_scans'), txt(' med '), code("scan_type='cron_failure'"), txt('. Dedup-logik forhindrer duplikerede scans inden for 4 timer.')),
    p(strong('❌ Trigger 2 mangler: '), txt('Grep efter '), code('infra_down'), txt(' i service-scan + admin-routes returnerer 0 matches. Acceptance-criterium "Infra-komponent der går ned udløser service_manager_scans med scan_type=\'infra_down\' inden for 10 min" er ikke opfyldt.')),
    p(strong('Fix: '), txt('Tilføj logik i '), code('service-scan/route.ts'), txt(' der poller '), code('/api/admin/service-status'), txt(' (eller læser seneste probe-resultater) og ved 2 konsekutive '), code('down'), txt('-states → opretter '), code("scan_type='infra_down'"), txt(' row.')),
  ],
};

// BIZZ-621 → keep In Review (ask for admin QA)
const b621 = {
  type:'doc', version:1, content:[
    h(2, 'Re-verifikation — INKONKLUSIV (admin-only QA)'),
    p(txt('Sidste kommentar (schema-cache reloaded + 14 heartbeats seedet) ser lovende ud. Jeg kan ikke verificere som non-admin E2E-bruger — '), code('/api/admin/cron-status'), txt(' returnerer korrekt 403 for mig.')),
    p(strong('Manuel admin-QA nødvendig: '), txt('åbn '), code('/dashboard/admin/cron-status'), txt(' som '), code('jjrchefen@hotmail.com'), txt(' og bekræft: (1) ingen "Heartbeat-data kunne ikke hentes"-banner, (2) 14 cron-rækker med grønne status-badges, (3) schedule + duration synlige. Hvis alt OK → siger PASSED, så transitionerer jeg til Done.')),
  ],
};

for (const [key, body, dest] of [['BIZZ-596', b596, 'To Do'], ['BIZZ-623', b623, 'To Do'], ['BIZZ-621', b621, null]]) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, { body });
  if (c.status!==201) { console.log(`❌ ${key} (${c.status})`); continue; }
  if (!dest) { console.log(`📝 ${key} inkonklusiv-kommentar — forbliver In Review`); continue; }
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const target = (JSON.parse(tr.body).transitions||[]).find(t => t.name === dest);
  const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition:{ id: target.id } });
  console.log(r.status===204 ? `🔄 ${key} → ${dest}` : `⚠️ ${key} (${r.status})`);
}
