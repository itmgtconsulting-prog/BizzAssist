import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p){return new Promise((res,rej)=>{const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,Accept:'application/json'}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);q.end()});}
function flat(n,o=[]){if(!n)return o;if(n.type==='text')o.push(n.text);if(n.content)for(const c of n.content)flat(c,o);return o;}

const key = 'BIZZ-619';
const c = await r('GET',`/rest/api/3/issue/${key}/comment`);
const comments = JSON.parse(c.body).comments || [];
const alreadyVerified = comments.some(cm => {
  const t = flat(cm.body).join('');
  return /Playwright-verifikation|API-level verifikation|Code-level verifikation/.test(t);
});
console.log(`BIZZ-619 already verified: ${alreadyVerified}`);

// Fetch description
const d = await r('GET',`/rest/api/3/issue/${key}?fields=summary,description`);
const di = JSON.parse(d.body);
console.log(`\n=== ${key}: ${di.fields.summary} ===`);
console.log(flat(di.fields.description).join('').replace(/\n{3,}/g,'\n\n').slice(0, 2500));
