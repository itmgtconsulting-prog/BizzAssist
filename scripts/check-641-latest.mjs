import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p){return new Promise((res,rej)=>{const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,Accept:'application/json'}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);q.end()});}
function flat(n,o=[]){if(!n)return o;if(n.type==='text')o.push(n.text);if(n.type==='paragraph'||n.type==='heading')o.push('\n');if(n.type==='listItem')o.push('\n• ');if(n.content)for(const c of n.content)flat(c,o);return o;}
const cm = await r('GET','/rest/api/3/issue/BIZZ-641/comment');
const comments = JSON.parse(cm.body).comments || [];
const latest = comments.slice(-1);
for (const c of latest) {
  console.log(`--- ${c.created?.slice(0,16)} (${c.author?.displayName}) ---`);
  console.log(flat(c.body).join('').slice(0, 1200));
}
