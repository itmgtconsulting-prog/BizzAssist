const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const keys = process.argv.slice(2);

const extract = (node) => {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.content) return node.content.map(extract).join('');
  return '';
};

for (const k of keys) {
  const r = await fetch(
    'https://' + host + '/rest/api/3/issue/' + k + '/comment?orderBy=-created',
    { headers: { Authorization: auth } }
  );
  const d = await r.json();
  console.log('\n========== ' + k + ' (latest 4 comments) ==========');
  const comments = (d.comments ?? []).slice(-4).reverse();
  for (const c of comments) {
    const body = extract(c.body);
    console.log(
      '\n[' +
        c.created +
        '] ' +
        (c.author?.displayName ?? '?') +
        ':\n' +
        body.slice(0, 1500)
    );
  }
}
