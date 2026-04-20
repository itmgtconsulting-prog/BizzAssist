const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');

const tickets = [
  {
    key: 'BIZZ-621',
    text: 'Root cause for HTTP 500 fundet: endpoint bubblede heartbeat-query-fejl op som fatal. Fix i 1439930 — hele handleren wrappet i try/catch, heartbeat-query-fejl behandles graceful: endpoint returnerer nu 200 med alle jobs markeret "missing" + en heartbeatError-meddelelse i body. UI viser en amber advarsels-banner så admin ved at heartbeat-data ikke er tilgængelig (fx manglende migration 041 i det pågældende supabase-miljø). Dashboard rendrer korrekt uanset om heartbeats kan læses eller ej. Klar til re-verifikation.',
  },
  {
    key: 'BIZZ-598',
    text: 'Implementeret i 1439930 — alle 18 tilbageværende console.log/error/warn-forekomster i app/ + lib/ er erstattet med logger.*-wrapperen (lib/sms.ts, lib/api/auth.ts, lib/db/tenant.ts, lib/monitorEmail.ts, lib/service-manager-alerts.ts, lib/service-manager-rules.ts). /api/cvr-public/person/raw har nu try/catch selv om det er en 410-stub. Total console.* count udenfor __tests__ + logger.ts + requestLogger.ts = 0 (verificeret med grep). requestLogger.ts beholder direkte console.log som produktionens log-aggregation-sink (logger.log er no-op i prod). Klar til re-verifikation.',
  },
  {
    key: 'BIZZ-633',
    text: 'Kort afklaring: /api/salgshistorik blev opdateret i commit 886f2e1 (14:58 UTC) til at bruge EJFCustom_EjerskabBegraenset i stedet for EJF_Ejerskifte. Verifier-testen ved 14:20 var 40 minutter FØR dette commit ramte test.bizzassist.dk. Deployet er nu pushed — curl /api/salgshistorik?bfeNummer=425479 bør returnere handler-array uden "EJF_Ejerskifte query fejlede"-fejl. Klar til re-verifikation.',
  },
  {
    key: 'BIZZ-629',
    text: 'Kort afklaring: resolveBfeToAdgangsadresseId-fallback blev landet i commit 886f2e1 (14:58 UTC). Verifier-testen ved 14:16 var FØR dette commit. Fallbacken: når dawaId mangler eller BBR_Bygning returnerer tom, resolver vi BFE via DAWA /jordstykker?bfenummer=X → /adgangsadresser?ejerlavkode=&matrikelnr= og retryer BBR-queryen. Tilføjet logger.warn så evt. resterende fejl kan diagnoseres via Vercel logs. curl /api/ejendomme-by-owner/enrich?bfe=226630 bør nu returnere boligAreal + erhvervsAreal != null efter deploy. Klar til re-verifikation.',
  },
  {
    key: 'BIZZ-600',
    text: 'Afklaring på lazy-load: Grep-metoden "dynamic(...mapbox|recharts|d3)" matcher ikke vores import-pattern fordi dynamic importerer den VIRKENDE komponent, ikke library-navnet. Korrekt grep: grep -rnE "dynamic\\(" app/ --include=*.tsx | grep -E "Map|Chart|Diagram" giver 6+ matches: PropertyMap.tsx (mapbox), RegnskabChart.tsx + EjendomPrisChart.tsx (recharts), DiagramForce.tsx (d3-force) — alle importeret via next/dynamic fra 3+ consumer-komponenter. mapbox-gl / recharts / d3-force er dermed ikke i main bundle. Verificer via npm run build bundle-output. Klar til re-verifikation.',
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
