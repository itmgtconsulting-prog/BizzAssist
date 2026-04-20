import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '/root/BizzAssist/.env.local' });

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

const res = await req('POST', '/rest/api/3/search/jql', {
  jql: 'project = BIZZ AND (text ~ "EJFCustom" OR text ~ "PersonSimpelBegraenset" OR text ~ "flexibleCurrent" OR text ~ "EJF Custom")',
  fields: ['summary', 'status', 'issuetype'],
  maxResults: 20
});
const d = JSON.parse(res.body);
for (const i of d.issues || []) {
  console.log(`${i.key} [${i.fields.status.name}] ${i.fields.summary}`);
}
