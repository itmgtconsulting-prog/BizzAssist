import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);if(d)q.write(d);q.end()});}
const res = await r('POST','/rest/api/3/search/jql',{jql:'project = BIZZ AND created >= "2026-04-20" ORDER BY created DESC',fields:['summary','status','priority','labels'],maxResults:50});
const d = JSON.parse(res.body);
console.log(`Tickets oprettet 2026-04-20: ${d.total ?? 0}\n`);
for (const i of d.issues || []) {
  const labels = (i.fields.labels||[]).join(',') || '-';
  console.log(`${i.key} [${i.fields.status.name}] (${i.fields.priority?.name||'?'}) labels=${labels}`);
  console.log(`    ${i.fields.summary}`);
}
