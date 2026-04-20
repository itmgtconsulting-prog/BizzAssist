import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ hostname: HOST, path: p, method,
      headers: { Authorization: 'Basic '+auth, 'Content-Type':'application/json', Accept:'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode, body:d})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const key = process.argv[2] || 'BIZZ-584';
const res = await req('GET', `/rest/api/3/issue/${key}?fields=summary,description,status,issuelinks`);
const d = JSON.parse(res.body);
console.log(`${d.key}: ${d.fields.summary}`);
console.log(`Status: ${d.fields.status.name}`);
console.log('---');
// Flatten ADF description to text
function flatten(node, out=[]) {
  if (!node) return out;
  if (node.type === 'text') out.push(node.text);
  if (node.type === 'paragraph' || node.type === 'heading') out.push('\n');
  if (node.type === 'listItem') out.push('\n• ');
  if (node.content) for (const c of node.content) flatten(c, out);
  return out;
}
console.log(flatten(d.fields.description).join(''));
console.log('\nLinks:');
for (const link of d.fields.issuelinks || []) {
  const other = link.inwardIssue || link.outwardIssue;
  console.log(`  ${link.type.name}: ${other.key} ${other.fields.summary}`);
}
