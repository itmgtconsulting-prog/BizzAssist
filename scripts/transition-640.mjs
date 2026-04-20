const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Implementeret i 06ef3a6 — overskriften summerer nu på tværs af både virksomhedsejede (ejendommeData) og personligt ejede (personalBfes). Map<bfeNummer, {aktiv}>-dedup forhindrer dobbelt-tælling når samme BFE optræder via begge kilder. Jakob skal nu vise "21 aktive ejendomme · 6 historiske" (9 personligt ejet + 12 via virksomheder). Virksomheds-Ejendomme-tab påvirkes ikke. Klar til verifikation.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-640/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-640/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-640 comment:', r1.status, 'transition:', r2.status);
