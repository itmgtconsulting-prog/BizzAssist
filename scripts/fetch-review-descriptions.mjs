import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function r(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const q=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});q.on('error',rej);if(d)q.write(d);q.end()});}

function flatten(node, out=[]) {
  if (!node) return out;
  if (node.type === 'text') out.push(node.text);
  if (node.type === 'paragraph' || node.type === 'heading') out.push('\n');
  if (node.type === 'listItem') out.push('\n• ');
  if (node.content) for (const c of node.content) flatten(c, out);
  return out;
}

const keys = ['BIZZ-595','BIZZ-597','BIZZ-598','BIZZ-599','BIZZ-600','BIZZ-601','BIZZ-585','BIZZ-604','BIZZ-605','BIZZ-606','BIZZ-609','BIZZ-610'];
for (const k of keys) {
  const res = await r('GET', `/rest/api/3/issue/${k}?fields=summary,description`);
  const d = JSON.parse(res.body);
  console.log(`\n==================== ${k} ====================`);
  console.log(`SUMMARY: ${d.fields.summary}`);
  console.log('DESCRIPTION:');
  console.log(flatten(d.fields.description).join('').replace(/\n{3,}/g, '\n\n').slice(0, 2500));
}
