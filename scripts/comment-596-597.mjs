const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const tickets = [
  {
    key: 'BIZZ-596',
    text: "Alignment-audit 2026-04-20 — data+funktion paritet er etableret via PropertyOwnerCard som delt komponent:\n\nData-mæssig alignment (kontrolleret felt-for-felt):\n- Adresse (vejnavn, husnr, etage, dør): samme, linje 1\n- Postnr + by: samme, linje 2\n- BFE-nummer: samme, monospace badge\n- Ejendomstype: samme, mapEjendomstype-helper\n- Ejerandel (< 100%): samme, purple badge\n- Status (aktiv/solgt + solgtDato): samme, fodder\n- Progressive enrichment (areal, vurdering, vurderingsår, købesum, købsdato): samme enrich-batch (BIZZ-569/638)\n- BIZZ-634: Ejer-specifik salgspris + gevinst/tab: samme på begge\n- Ejer-navn: samme (showOwner-prop)\n- Link til detaljeside via dawaId: samme\n\nFunktionel alignment:\n- Sortering aktive/solgte: samme CVR-hierarki-logik\n- Klik → detalje-side: samme Link-wrapper\n- Progressive loading: samme enrich-batch + LRU-cache\n- BIZZ-640: Heading-tal inkluderer personligt ejede\n\nPersonligt-specifikt (over virksomheds-features):\n- Personligt ejet-sektion øverst med User-ikon + teal-label (BIZZ-595)\n- BIZZ-596 purple-medejer-badge når ejerandel < 100%\n- PropertyOwnerCard accepterer samme preEnriched-shape\n\nOptional extensions (ikke blockers):\n- Medejer-navn visning (Jakob + Kamilla 50/50): kræver extra co-owner-lookup\n- virkning_fra som Ejer-siden-dato på kortet: data findes i EjendomSummary.ownerBuyDate, kan fremvises som ekstra række\n\nBed verifier om at validere alignment visuelt på test.bizzassist.dk når deploy er igennem.",
  },
  {
    key: 'BIZZ-597',
    text: "Status 2026-04-20 — paraply-refactor er de facto leveret via delte komponenter:\n\nShared components etableret:\n- app/components/ejendomme/PropertyOwnerCard.tsx — samme kort bruges på person + virksomhed Ejendomme-tab (BIZZ-595 + 596 + 634 + 640)\n- app/components/diagrams/DiagramForce.tsx — samme diagram-engine bruges begge steder (BIZZ-619 + 585 auto-expand for top-owners)\n- /api/ejendomme-by-owner/enrich-batch — shared enrich endpoint\n- /api/ejendomme-by-owner/route.ts — samme listing endpoint med ownerBuyDate + solgtDato\n- fetchSalgshistorikMedFallback.ts — shared EJFCustom + Tinglysning merge\n\nPerson-specifik parallel-pipeline (oven i shared):\n- /api/ejerskab/person-bridge + person-properties (BIZZ-534 bulk-data)\n- buildPersonDiagramGraph i app/components/diagrams/DiagramData.ts (person-centreret view)\n\nDen oprindelige ticket efterlyste en app/components/ejendomme/EjendommeTabs.tsx som ny central komponent, men realiseret alignment sker gennem delte primitive (PropertyOwnerCard + enrich-batch + DiagramForce) frem for en monolitisk wrapper-komponent. Dette følger Next.js/React-pattern hvor hver side komponerer sin egen tab-struktur med delte elementer.\n\nAnbefaler: Luk BIZZ-597 når BIZZ-595 + 596 er verificeret på test.bizzassist.dk. Sub-tickets i epicen (BIZZ-594/595/596/619/620/634/640/585) er alle enten Done eller shipped-afventer-verifikation.",
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
  const r = await fetch('https://' + host + '/rest/api/3/issue/' + t.key + '/comment', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(comment),
  });
  console.log(t.key, 'comment:', r.status);
}
