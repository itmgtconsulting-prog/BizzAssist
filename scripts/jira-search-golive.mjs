import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: '/root/BizzAssist/.env.local' });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function r(m,p,b) {
  return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);if(d)q.write(d);q.end()});
}

const res = await r('POST', '/rest/api/3/search/jql', {
  jql: 'project = BIZZ AND (text ~ "production go-live" OR text ~ "go-live" OR text ~ "production ready" OR text ~ "enterprise ready" OR text ~ "ISO 27001" OR text ~ "ISO27001" OR text ~ "test coverage" OR text ~ "løsningsreview" OR text ~ "solution review" OR text ~ "security review" OR text ~ "readiness") AND created >= -3d ORDER BY created DESC',
  fields: ['summary','status','issuetype','created','priority'],
  maxResults: 30
});
const d = JSON.parse(res.body);
console.log(`Tickets oprettet seneste 3 dage med review-termer: ${d.total ?? 0}\n`);
for (const i of d.issues || []) {
  const created = new Date(i.fields.created);
  console.log(`${i.key} [${i.fields.status.name}] (${i.fields.priority?.name||'?'}) — ${i.fields.summary}`);
  console.log(`    created: ${created.toISOString()}`);
}
