const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  "Undersøgelse afsluttet i 69cd926 — docs/adr/0004-tinglysning-event-feed-evaluation.md. Nøgleresultat: e-TL tilbyder et Valgfrit abonnement-modul (gratis, objekt-specifikt, push via svarservice-endpoint), MEN ingen global ændringsstream eller delta-udtræk. Ikke brugbar til bulk-sync af 2.8M BFE er; velegnet til watch-list feature hvor brugeren følger specifikke ejendomme. Bulk incremental forbliver afhængig af Datafordeler Hændelsesbesked (EJF/BBR). Anbefaler follow-up ticket for watch-list implementation + /api/tinglysning/event-callback endpoint, betinget af BIZZ-613 produktionsadgang.";
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-615/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
console.log('comment:', r1.status);
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-615/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('transition:', r2.status);
