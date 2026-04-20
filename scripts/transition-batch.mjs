const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const tickets = [
  {
    key: 'BIZZ-636',
    text: 'Migration 049 + mapDbError helper er pushed på develop. RLS tillader nu service_role + authenticated isAdmin at skrive til plan_configs og token_packs. Ready for verifikation.',
  },
  {
    key: 'BIZZ-638',
    text: 'Enrich-batch kalder nu fælles-BFE-listen (ejendommeData + personalBfes) så personligt ejede ejendomme også får area/vurdering/købspris. Ready for verifikation.',
  },
  {
    key: 'BIZZ-635',
    text: 'Inderste duplicate TabLoadingSpinner fjernet — kun den ydre spinner vises nu, gated på ejendommeData.length === 0. Ready for verifikation.',
  },
  {
    key: 'BIZZ-637',
    text: 'BBR_Enhed queries nu først for ejerlejligheder via adresseIdentificerer — fanger areal på ejerlejligheder hvor BBR_Bygning returnerede 0. Ready for verifikation.',
  },
];

for (const t of tickets) {
  const comment = {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t.text }] }],
    },
  };
  const r1 = await fetch('https://' + host + '/rest/api/3/issue/' + t.key + '/comment', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(comment),
  });
  const r2 = await fetch('https://' + host + '/rest/api/3/issue/' + t.key + '/transitions', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: '31' } }),
  });
  console.log(t.key, 'comment:', r1.status, 'transition:', r2.status);
}
