const JIRA_HOST = 'bizzassist.atlassian.net';
const JIRA_EMAIL = 'itmgtconsulting@gmail.com';
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

const issueKey = process.argv[2] || 'BIZZ-3';
const res = await fetch(`https://${JIRA_HOST}/rest/api/3/issue/${issueKey}`, {
  headers: { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
});
const data = await res.json();

if (!res.ok) { console.error('Error:', JSON.stringify(data, null, 2)); process.exit(1); }

const f = data.fields;
console.log(`Key:      ${data.key}`);
console.log(`Summary:  ${f.summary}`);
console.log(`Type:     ${f.issuetype?.name}`);
console.log(`Priority: ${f.priority?.name}`);
console.log(`Status:   ${f.status?.name}`);
console.log(`Labels:   ${f.labels?.join(', ')}`);
console.log(`\nDescription:`);

function extractText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.content) return node.content.map(extractText).join('');
  return '';
}
console.log(extractText(f.description));
