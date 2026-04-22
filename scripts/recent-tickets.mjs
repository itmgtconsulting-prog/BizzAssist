import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const jql = encodeURIComponent('project = BIZZ AND created >= -1d ORDER BY created DESC');
const r = await new Promise((res, rej) => {
  const r2 = https.request({ hostname: HOST, path: `/rest/api/3/search?jql=${jql}&fields=summary,status,labels,created&maxResults=30`, method: 'GET', headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } },
    (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res(y)); });
  r2.on('error', rej); r2.end();
});
const j = JSON.parse(r);
console.log(`Nye tickets (sidste 24t): ${j.issues?.length || 0}`);
for (const i of j.issues || []) {
  console.log(`  ${i.key} [${i.fields.status.name}] ${i.fields.summary}`);
  console.log(`    labels: ${i.fields.labels.join(', ')}`);
}
