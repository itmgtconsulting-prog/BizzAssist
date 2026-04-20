const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const tickets = [
  {
    key: 'BIZZ-595',
    text: 'Implementeret i 886f2e1 — Oversigt-tabbens "Kommer snart"-placeholder på Ejendomme-sektionen er erstattet med aktuelle tæller (aktive + historiske, heraf personligt ejet) der klikker til Ejendomme-tab. Tab-navigationen har nu WAI-ARIA role=tablist/role=tab/aria-selected så Playwright kan navigere korrekt. Selve Ejendomme-tabbens personlige-ejendomme-visning har været shipped siden 7b4d917 — bør nu være synlig når tabklik rammer ordentligt. Klar til verifikation.',
  },
  {
    key: 'BIZZ-596',
    text: 'Implementeret i 886f2e1 — samme fix som BIZZ-595. Tab-navigationen rammer nu ordentligt, Oversigts-tabbens "Kommer snart"-placeholder er væk, og enrich-batch-flowet (BIZZ-569-pattern med parallelle fetches + dawaIds + LRU-cache) er aktivt på person-Ejendomme-tabben. Klar til verifikation — sammenlign med virksomhedens Ejendomme-tab.',
  },
  {
    key: 'BIZZ-619',
    text: 'Implementeret i 886f2e1 — MAX_PROPS_PER_COMPANY=5-cap fjernet fra personalProperties-blokken i buildPersonDiagramGraph(). Jakobs 9 personligt ejede ejendomme bør nu alle vises i stedet for 5/9. ENK-virksomheden (IT Management consulting) inkluderes allerede via topLevelEjer (BIZZ-620 fix) — tjek at den dukker op i diagrammet. Tilføjet personallyOwned=true flag på person→sole-owned-edges så de kan rendres stiplet emerald (BIZZ-585). Klar til verifikation.',
  },
  {
    key: 'BIZZ-633',
    text: 'Implementeret i 886f2e1 — /api/salgshistorik skifter fra EJF_Ejerskifte + EJF_Handelsoplysninger (IKKE i vores grant per BIZZ-584) til EJFCustom_EjerskabBegraenset. Bygger ejerskab-events fra unikke virkningFra-tidspunkter per (cvr|person, dato). Endpointet returnerer nu multi-line handler-array uden "EJF_Ejerskifte query fejlede"-fejl. Priser + købernavne merges klient-side via Tinglysning-adkomster (eksisterende flow). Klar til verifikation: curl /api/salgshistorik?bfeNummer=425479 skal returnere mindst 2 handler.',
  },
  {
    key: 'BIZZ-629',
    text: 'Implementeret i 886f2e1 — fetchBbrAreasByBfe har nu BFE→adgangsadresse-UUID fallback via DAWA /jordstykker?bfenummer=X → /adgangsadresser?ejerlavkode=...&matrikelnr=.... Fanger kommercielle ejendomme med stale/missing dawaId (som Høvedstensvej 33/39/43 og Arnold Nielsens Boulevard 62A/62B/64B). Tilføjet logger.warn når BBR_Bygning er tom så evt. resterende regression kan diagnoses i produktions-logs. Klar til verifikation.',
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
