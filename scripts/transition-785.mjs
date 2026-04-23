#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', c => y += c); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const body = { type: 'doc', version: 1, content: [
  p(strong('Iter 1 shipped — DAR status pipethrough + client-filter')),
  p(txt('Root-cause på "Skjul udfasede" var at DAR GraphQL svaret '), strong('allerede'), txt(' indeholdt '), code('status'), txt(' feltet (Gældende/Nedlagt/Henlagt/Foreløbig) men det blev smidt væk ved mapping. Iter 1 piper det hele vejen igennem:')),
  ul(
    li(p(code('DawaAutocompleteResult'), txt(' har nu optional '), code('status?: string | null'), txt(' felt (null for vejnavn-type og DAWA-fallback)'))),
    li(p(code('darAutocomplete()'), txt(' mapper '), code('h.status'), txt(' + '), code('a.status'), txt(' fra både '), code('DAR_Husnummer'), txt(' og '), code('DAR_Adresse'), txt(' ind i resultat-objektet'))),
    li(p(code('UniversalSearchPageClient'), txt(' properties-tab filtrerer nu på '), code('hideRetiredProperties'), txt(': viser kun '), code('status === "Gældende" | "Foreløbig"'), txt(' eller '), strong('null/undefined'), txt(' (ukendt = aktiv)'))),
  ),
  p(strong('Hvad iter 1 IKKE løser:')),
  ul(
    li(p(txt('Ingen BBR-status code lookup per ejendom (bygningsstatus 4/10/11). Ejendomme hvor DAR siger "Gældende" men selve bygningen er nedlagt, vises stadig.'))),
    li(p(txt('DAWA-fallback (når DAR fejler/IP-blokeret) har ikke status → alle vises.'))),
    li(p(txt('Resultat-count kan være lavt når mange filtreres væk — kunne fetch flere for at kompensere.'))),
  ),
  p(strong('Iter 2 scope (parkeret — kræver architect signoff pga. scope):')),
  ul(
    li(p(code('BIZZ-785a'), txt(' — migration 068: '), code('bbr_ejendom_status'), txt(' tabel med '), code('bfe_nummer'), txt(', '), code('bygning_status'), txt(', '), code('enhed_status'), txt(', '), code('is_udfaset'), txt(', '), code('last_checked_at'), txt(' + indexes.'))),
    li(p(code('BIZZ-785b'), txt(' — '), code('/api/cron/backfill-ejendom-status'), txt(': batch-kald BBR for alle 46k ejendomme, populate tabel. Respekter rate-limit (50/sek).'))),
    li(p(code('BIZZ-785c'), txt(' — '), code('/api/cron/refresh-ejendom-status'), txt(' daily cron + lazy refresh ved detail-page view hvis '), code('last_checked_at > 30d'), txt('.'))),
    li(p(code('BIZZ-785d'), txt(' — join '), code('bbr_ejendom_status'), txt(' i '), code('/api/adresse/autocomplete'), txt(' med '), code('WHERE is_udfaset = false'), txt(' (når param sat).'))),
    li(p(code('BIZZ-785e'), txt(' — BBR push-abonnement (event-driven refresh, ikke daily cron) — kræver tilmelding hos BBR/Datafordeler.'))),
  ),
  p(strong('Virksomheder (CVR):'), txt(' eksisterende client-side filter '), code('!onlyActiveCompanies || r.active'), txt(' virker korrekt — '), code('CVRSearchResult.active'), txt(' beregnes server-side fra '), code('virksomhedsstatus + livsforloeb'), txt('. Ingen ændring nødvendig.')),
  p(strong('Commit: '), code('a5cdb87'), txt('. Tests 1640/1654 grønne. '), strong('→ In Review (iter 1).')),
]};

const cr = await req('POST', '/rest/api/3/issue/BIZZ-785/comment', { body });
console.log(cr.status === 201 ? '✅ comment' : `❌ ${cr.status} ${cr.body}`);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-785/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-785/transitions', { transition: { id: t.id } });
  console.log(r.status === 204 ? '✅ → In Review' : `⚠️ ${r.status}`);
}
