const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Implementeret i b414d8b — BIZZ-637 havde gjort BBR_Enhed-query primary for alle ejendomme, men inner-loopen satte any=true så snart et areal-felt var != null (selv 0). Kommercielle ejendomme med enhed-noder uden beboelsesareal endte derfor i { null, null, null } i stedet for at falde igennem til BBR_Bygning. Fix: kun behold BBR_Enhed-resultatet hvis mindst ét areal er > 0. Ejerlejligheder påvirkes ikke (enh026/027 er altid positive). Klar til verifikation — Høvedstensvej 33/39/43 og Arnold Nielsens Boulevard 62A/62B/64B skal nu vise Erhv-m² igen.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-629/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-629/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-629 comment:', r1.status, 'transition:', r2.status);
