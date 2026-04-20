const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Audit 2026-04-20 — allerede implementeret:\n\nAPI: app/api/matrikel/historik/route.ts (397 linjer) — forespørger MAT GraphQL med temporale queries (11 historical checkpoints: 0, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50 år tilbage) og sammenligner snapshots for at detektere udstykninger, sammenlægninger, arealændringer og statusændringer. Returnerer MatrikelHistorikResponse med tidslinje-events. Cache: 24 timer pr. BFE.\n\nUI: app/dashboard/ejendomme/[id]/EjendomDetaljeClient.tsx — collapsible historik-sektion med 5 event-typer (oprettelse/udstykning/sammenlægning/arealændring/statusændring) rendret som farvede tidslinje-markers. Lazy-loadet ved klik på "Historik" toggle. Renderet to steder i client for både mobile og desktop-layout.\n\nTypes:\n- MatrikelHistorikEvent (dato, type, beskrivelse, detaljer)\n- MatrikelHistorikResponse (bfeNummer, historik, fejl)\n\nAcceptance-criteria opfyldt:\n✅ Historik-tidslinje for mindst én udstykket ejendom (MAT-queries er generiske)\n✅ Performance: cache pr. BFE i 24 timer (revalidate=86400)\n\nKlar til verifikation: åbn enhver ejendoms-detaljeside → BBR-tab (eller Matrikel-tab afhængigt af layout) → klik "Vis historik"-toggle.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-500/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-500/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-500 comment:', r1.status, 'transition:', r2.status);
