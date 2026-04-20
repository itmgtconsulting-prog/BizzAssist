const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  "Implementeret i 6bf71a1 — auto-expand-logikken i DiagramForce var før begrænset til main-node af type person. På virksomhedsdiagram (hvor main-node er company) blev co-owner-persons derfor aldrig auto-expanded, så Jakobs personligt ejede ejendomme forblev skjulte. Fix: identificér person-nodes med direkte udgående edge til main-company og auto-expand dem også. Edge-rendereren har allerede isPersonToProperty-detection med stiplet emerald-styling (DiagramForce.tsx:1909), så med data nu fetched vises edgene med korrekt styling. Pass 3-layout med MAX_PER_ROW=5 håndterer automatisk max-5-per-linje-kravet. Ejerandel-label på edgen rendres via edge.ejerandel-feltet. Klar til verifikation: åbn JaJR Holding -> Diagram. Jakob-noden skal nu vise stiplede emerald-linjer til hans personligt ejede ejendomme + ejerandel-labels.";
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-585/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-585/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-585 comment:', r1.status, 'transition:', r2.status);
