const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Implementeret i 43455e1 — /api/salgshistorik spørger nu både EJF FlexibleCurrent (aktuelle) og HistoriskCurrent (alle historiske ejerskifter) parallelt og merger via handelsoplysningerLokalId. FlexibleCurrent returnerer primært gældende ejerskifter — ældre udslettede ligger i HistoriskCurrent. Ny env EJF_GQL_HISTORISK_ENDPOINT (default graphql.datafordeler.dk/historiskCurrent/v1/). Kaffevej 31 1.tv og andre ejendomme med flere ejerskifter bør nu vise den fulde handelskæde i stedet for kun seneste. LRU-cache holder den mergede response pr. BFE. Klar til verifikation.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-633/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-633/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-633 comment:', r1.status, 'transition:', r2.status);
