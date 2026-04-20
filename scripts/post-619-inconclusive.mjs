#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request({ hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } }, (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (text, marks) => marks ? { type: 'text', text, marks } : { type: 'text', text };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });

const body = {
  type: 'doc', version: 1, content: [
    h(2, 'Playwright-verifikation — INKONKLUSIV'),
    p(txt('Forsøgte at navigere til '), code('/dashboard/owners/4000115446'), txt(' → Diagram-tab via flere selektorer (role=tab, text=Diagram, button:has-text, URL-param). Tab-klikket registrerede ikke — siden forblev på Oversigt i screenshot.')),
    p(txt('Kan ikke verificere om Jakobs personligt ejede ejendomme vises på diagrammet eller om fuldt virksomhedsnetværk loades efter Udvid-klik. Anbefaler manuel verifikation:')),
    p(strong('Manuel test: '), txt('Åbn Jakobs persondetailside → klik Diagram-tab → tjek om (a) mindst 3 personligt ejede ejendomme (Søbyvej 11, Vigerslevvej 146, H C Møllersvej 21, Horsekildevej 26, Hovager 8) vises som grønne bokse under Jakob-noden og (b) at Udvid-knappen loader alle 21 virksomheder progressivt.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-619/comment', { body });
console.log(c.status === 201 ? '✅ inkonklusiv-kommentar posted — forbliver In Review' : `❌ (${c.status})`);
