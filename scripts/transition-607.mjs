const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  "Audit 2026-04-20 — navigation allerede implementeret:\n\n1. Fra diagram/ejendomstab til selve lejligheden: PropertyOwnerCard bruger ejendom.dawaId → /dashboard/ejendomme/{dawaId}. _hentDawaBfeDataImpl (ejendomme-by-owner/route.ts:389-447) sætter dawaId = beliggenhedsadresse.id som for ejerlejligheder er adresse-UUID med etage/dør (BIZZ-576). Klik på 62A (BFE 226630) åbner derfor ejerlejligheds-siden, ikke hovedejendommen.\n\n2. Fra ejerlejlighed tilbage til hovedejendom: EjendomDetaljeClient.tsx:2167-2194 viser en 'Gå til hovedejendom'-knap (amber badge) når bbrData.moderBfe + ejerlejlighedBfe er sat + dawaAdresse.etage eksisterer. Knappen resolver moder-BFE → adgangsadresseId via /api/adresse/jordstykke og router til den.\n\n3. Fra hovedejendom til lejligheder: EjendomDetaljeClient.tsx:4001-4063 renderer en Lejligheder-tabel (genereret fra /api/ejerlejligheder?ejerlavKode=&matrikelnr=) som liste med klikbare Link per lejlighed. Hver række viser adresse, ejer, areal, købspris, købsdato.\n\n4. Hovedejendom-badge: 2197-2209 viser en statisk amber 'Hovedejendom'-badge når man er på hovedejendommens adresse — så brugeren ved hvilken type ejendom de kigger på.\n\nTest-scenariet i ticketet (62A/62B under JaJR Holding) bør virke per design. Hvis bruger ser hovedejendommen i stedet for lejligheden, kan det skyldes at test.bizzassist.dk ikke har seneste BIZZ-576-fix deployed, eller at specifikke BFE'er i EJF mangler etage/dør i DAWA-opslaget. Klar til verifikation.";
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-607/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-607/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-607 comment:', r1.status, 'transition:', r2.status);
