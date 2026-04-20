const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  "Audit 2026-04-20 — alle items allerede implementeret:\n\n1. Heavy libs dynamic-loaded: mapbox-gl via PropertyMap-dynamic (EjendomDetaljeClient.tsx:49), recharts via RegnskabChart + EjendomPrisChart-dynamic (VDC:82, EDC:46), d3-force via DiagramForce-dynamic (3 call-sites — VDC, PersonDetailPageClient, PropertyOwnerDiagram). \n\n2. React.memo på DiagramForce: memo(DiagramForce) ved export default (DiagramForce.tsx:2629). PropertyMap har også memo. \n\n3. LRU cache: app/lib/lruCache.ts er oprettet og bruges i 3+ external-API wrappers: cvrStatus.ts, dar.ts (darHentAdresse + hentZoneFraPlandata = 2 caches), salgshistorik/route.ts. \n\n4. N+1 audit: /api/cvr/[cvr]/route.ts har ingen loop-baserede fetches. De store route-filer i app/api/ bruger konsekvent Promise.allSettled / parallelle fetches. \n\n5. PropertyMap event cleanup: document.addEventListener('mousedown/touchstart') har matching removeEventListener i useEffect-returnværdi (PropertyMap.tsx:917-921). Verificeret.\n\nKlar til verifikation — alle accept-criteria opfyldt uden ekstra kode-ændringer nødvendige.";
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-600/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-600/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-600 comment:', r1.status, 'transition:', r2.status);
