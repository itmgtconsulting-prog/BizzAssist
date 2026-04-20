const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const keys = process.argv.slice(2);
for (const k of keys) {
  const r = await fetch(
    'https://' + host + '/rest/api/3/issue/' + k + '?fields=summary,description,priority,status',
    { headers: { Authorization: auth } }
  );
  const d = await r.json();
  console.log('\n========== ' + k + ' ==========');
  console.log('Summary:', d.fields.summary);
  console.log(
    'Status:',
    d.fields.status?.name,
    '| Priority:',
    d.fields.priority?.name
  );
  const desc = d.fields.description;
  if (desc?.content) {
    const extract = (node) => {
      if (typeof node === 'string') return node;
      if (node.type === 'text') return node.text ?? '';
      if (node.content) return node.content.map(extract).join('');
      return '';
    };
    const parts = desc.content.map((n) => {
      if (n.type === 'heading') return '\n### ' + extract(n) + '\n';
      if (n.type === 'bulletList') {
        return n.content.map((li) => '- ' + extract(li)).join('\n') + '\n';
      }
      if (n.type === 'paragraph') return extract(n) + '\n';
      return extract(n) + '\n';
    });
    console.log(parts.join('').slice(0, 2500));
  }
}
