const host = process.env.JIRA_HOST;
const user = process.env.JIRA_EMAIL;
const tok = process.env.JIRA_API_TOKEN;
const auth = 'Basic ' + Buffer.from(user + ':' + tok).toString('base64');
const text =
  'Implementeret i 2340546 — 3 af 8 listede API-routes manglede try/catch (linkedin/auth, linkedin/enrich, gmail/auth). De er nu wrappet og returnerer generisk "Ekstern API fejl" 500 til klienten med interne fejl logget til Sentry. De resterende 5 havde allerede try/catch. Request-line logging i app/lib/requestLogger.ts beholder direkte console.log (produktionens log-aggregation — logger.log er no-op i prod, så substitution ville slette al request-logging). any-typer i notifications.ts/daily-status/VDC har allerede eslint-disable med Supabase-type-regeneration som årsag — kræver post-migration 046 type-regen (separat opgave, nævnt i ticket-beskrivelse). Klar til verifikation.';
const comment = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
};
const r1 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-598/comment', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(comment),
});
const r2 = await fetch('https://' + host + '/rest/api/3/issue/BIZZ-598/transitions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ transition: { id: '31' } }),
});
console.log('BIZZ-598 comment:', r1.status, 'transition:', r2.status);
