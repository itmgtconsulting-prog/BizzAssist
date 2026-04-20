import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);if(d)q.write(d);q.end()});}

const res = await r('POST','/rest/api/3/search/jql',{
  jql: 'project = BIZZ AND status = "In Review" ORDER BY updated DESC',
  fields: ['summary','status','priority','updated','labels'],
  maxResults: 30
});
const d = JSON.parse(res.body);
console.log(`Tickets i "In Review": ${d.total ?? (d.issues||[]).length}`);
for (const i of d.issues || []) {
  console.log(`\n${i.key} (${i.fields.priority?.name||'?'}) — updated ${i.fields.updated?.slice(0,10)}`);
  console.log(`  ${i.fields.summary}`);
  if (i.fields.labels?.length) console.log(`  labels: ${i.fields.labels.join(', ')}`);
}
