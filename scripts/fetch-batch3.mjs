import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p){return new Promise((res,rej)=>{const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,Accept:'application/json'}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);q.end()});}
function flatten(n,o=[]){if(!n)return o;if(n.type==='text')o.push(n.text);if(n.type==='paragraph'||n.type==='heading')o.push('\n');if(n.type==='listItem')o.push('\n• ');if(n.content)for(const c of n.content)flatten(c,o);return o;}
for (const k of ['BIZZ-616','BIZZ-617','BIZZ-618','BIZZ-626','BIZZ-627','BIZZ-629','BIZZ-633']) {
  const res = await r('GET',`/rest/api/3/issue/${k}?fields=summary,description`);
  const d = JSON.parse(res.body);
  console.log(`\n===== ${k} — ${d.fields.summary}`);
  console.log(flatten(d.fields.description).join('').replace(/\n{3,}/g,'\n\n').slice(0, 1500));
}
