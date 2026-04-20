const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Partial implementation i 9677e7a — 23 nye unit-tests dækker 3 kritiske untested lib-filer:\n\n1) companyInfo.test.ts (8 tests) — static field invariants, CVR-format, email-domæner, fullAddress/legalLine/legalLineHtml getters.\n\n2) cronMonitor.test.ts (7 tests) — withCronMonitor wrapper der bruges af alle 14 cron-routes. Verificerer heartbeat(success) ved OK, heartbeat(error) ved exception, schedule+interval+maxRuntime forwarding til Sentry, og re-throw-semantikken.\n\n3) fetchSalgshistorikMedFallback.test.ts (8 tests) — shared helper med BIZZ-634 owner-specific pick-logik: legacy nyeste-handel, ejer-specifik buy+sell, 30-dages grace, TL fallback, backwards-compat.\n\nTotal tests: 1373 → 1396. Branch coverage-målet (65%+) kan først måles efter komponent-tests landes.\n\nResterende (ikke i denne commit):\n• Komponent-tests for DiagramForce/PropertyMap/AIChatPanel (kræver @testing-library/react setup)\n• Lib-tests for tlFetch/email/fetchBbrData (større filer — næste iteration)\n• E2E-dækning af dashboard/ejendomme/[id], companies/[cvr], owners/[enhedsNummer] (nye Playwright specs)\n\nAnbefalet: splitte resterende arbejde i separate sub-tickets så hver kan verificeres afgrænset. Denne commit løfter ikke branch-coverage væsentligt — kerne-wins er fundet i komponent-tests.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-599/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
console.log('BIZZ-599 comment:', r1.status);
// Ikke transitionér — ticket er partial, brugeren kan selv afgøre om de vil
// lukke eller beholde som In Progress med sub-tickets.
