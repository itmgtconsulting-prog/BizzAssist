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

// Close BIZZ-411 (Person økonomi-tab)
const body411 = { type: 'doc', version: 1, content: [
  p(strong('Closed — descoped pr. product-beslutning 2026-04-23')),
  p(txt('Økonomi-tab med estimeret personlig formue baseret på ejendomme + virksomhedsandele er descoped:')),
  p(txt('- Formue-estimat er PII-sensitivt og kræver separat DPA-proces')),
  p(txt('- Kvalitetsbånd på ejendomsvurdering + selskabsandel-value er for usikkert til at være nyttigt (±30% fejlmargin forventet)')),
  p(txt('- Use-case (due diligence på person) dækkes bedre af BIZZ-789 (virksomhedsfiltre) + manuel research')),
  p(strong('Kan genåbnes hvis:'), txt(' brugerne efterspørger det aktivt efter filter-katalogerne (788-790) er landet. Indtil da er det ikke en prioritet.')),
]};

const r1 = await req('POST', '/rest/api/3/issue/BIZZ-411/comment', { body: body411 });
console.log('BIZZ-411 comment:', r1.status === 201 ? 'ok' : r1.status);
const tr1 = await req('GET', '/rest/api/3/issue/BIZZ-411/transitions');
const t1 = (JSON.parse(tr1.body).transitions || []).find((t) => /^done$/i.test(t.name));
if (t1) {
  const r = await req('POST', '/rest/api/3/issue/BIZZ-411/transitions', { transition: { id: t1.id } });
  console.log('BIZZ-411 →', r.status === 204 ? '✅ Done' : '⚠️ ' + r.status);
}

// Comment BIZZ-790 that 790e scope is descoped (don't close 790 — 790a still in progress)
const body790 = { type: 'doc', version: 1, content: [
  p(strong('Scope-opdatering: 790e helt descoped')),
  p(txt('Product-beslutning 2026-04-23: Sub-scope '), code('790e'), txt(' (Relateret til CVR/person, Koncern, Alder) er '), strong('helt descoped'), txt(', ikke kun alder-via-CPR som ARCHITECT tidligere afviste.')),
  p(strong('Begrundelse:')),
  p(txt('- Alder via CPR: kræver ny DPA (afvist)')),
  p(txt('- Relateret til CVR/person + Koncern-detection: er dyr at implementere og use-case er svag. Brugere kan navigere via deres eksisterende relationer uden disse filtre')),
  p(strong('Impact:'), txt(' Når 790-epic splittes i sub-tickets, oprettes '), code('790e'), txt(' IKKE. Roadmap er nu: 790a (MVP) → 790b (deltager-berigelse) → 790c (branche+kommune) → 790d (cross-domain ejendom) → 790f (presets). Phase e springer over.')),
]};

const r2 = await req('POST', '/rest/api/3/issue/BIZZ-790/comment', { body: body790 });
console.log('BIZZ-790 comment:', r2.status === 201 ? 'ok' : r2.status);
