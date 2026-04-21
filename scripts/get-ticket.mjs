const key = process.argv[2];
if (!key) { console.error('Usage: get-ticket.mjs BIZZ-XXX'); process.exit(1); }
const host = process.env.JIRA_HOST;
const auth = 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
const r = await fetch('https://' + host + `/rest/api/3/issue/${key}?fields=summary,description,status,priority,comment`, {
  headers: { Authorization: auth, Accept: 'application/json' },
});
const d = await r.json();
console.log(`=== ${key}: ${d.fields.summary} ===`);
console.log('Status:', d.fields.status?.name, '| Priority:', d.fields.priority?.name);
function walk(n) {
  if (!n) return '';
  if (n.type === 'text') return n.text || '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content || []).map(walk).join('');
  if (n.type === 'paragraph' || n.type === 'heading') return inner + '\n';
  if (n.type === 'listItem') return '• ' + inner;
  if (n.type === 'bulletList' || n.type === 'orderedList') return inner;
  if (n.type === 'codeBlock') return '```\n' + inner + '\n```\n';
  return inner;
}
console.log('\n--- Description ---\n' + walk(d.fields.description));
const comments = d.fields.comment?.comments || [];
for (const c of comments.slice(-3)) {
  console.log(`\n--- Comment (${c.author?.displayName}, ${c.created?.slice(0, 10)}) ---`);
  console.log(walk(c.body).slice(0, 1200));
}
