import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);if(d)q.write(d);q.end()});}

const res = await r('POST','/rest/api/3/search/jql',{
  jql: 'project = BIZZ AND (summary ~ "P0" OR summary ~ "P1") AND (summary ~ "SECURITY" OR summary ~ "GDPR" OR summary ~ "ISO 27001" OR summary ~ "COMPLIANCE" OR summary ~ "OPS") ORDER BY key DESC',
  fields: ['summary','status','priority'],
  maxResults: 50
});
const d = JSON.parse(res.body);
console.log(`P0/P1 security/GDPR/ISO/ops tickets: ${d.total}`);
const byStatus = new Map();
for (const i of d.issues || []) {
  const s = i.fields.status.name;
  if (!byStatus.has(s)) byStatus.set(s, []);
  byStatus.get(s).push(i);
}
for (const [status, items] of byStatus) {
  console.log(`\n[${status}] (${items.length})`);
  for (const i of items) console.log(`  ${i.key} (${i.fields.priority?.name||'?'}) ${i.fields.summary}`);
}
