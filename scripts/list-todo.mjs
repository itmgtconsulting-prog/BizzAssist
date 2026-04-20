const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const jql =
  'project = BIZZ AND status = "To Do" AND issuetype != Epic ORDER BY priority DESC, updated DESC';
const r = await fetch('https://' + host + '/rest/api/3/search/jql', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jql,
    fields: ['summary', 'priority', 'issuetype'],
    maxResults: 40,
  }),
});
const d = await r.json();
if (!d.issues) {
  console.error('Response:', JSON.stringify(d).slice(0, 400));
  process.exit(1);
}
for (const issue of d.issues) {
  console.log(
    issue.key.padEnd(10),
    (issue.fields.priority?.name ?? '?').padEnd(8),
    issue.fields.issuetype?.name?.padEnd(8),
    issue.fields.summary
  );
}
console.log('\nTotal:', d.total);
