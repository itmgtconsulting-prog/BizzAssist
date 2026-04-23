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
  p(strong('Iter 1 shipped — filter-panel med 3 kolonner')),
  p(txt('Collapsible right-hand sidebar med 3 sections: Ejendomme (emerald) / Virksomheder (blue) / Personer (purple). Toggle-button øverst ved tab-bar. Panel åbner default når man lander i matrikel-mode (BIZZ-763).')),
  p(strong('Virkende filtre denne iteration:')),
  ul(
    li(p(txt('Ejendomme: '), code('Skjul udfasede'), txt(' checkbox (default on). Effektuering kræver '), code('zone'), txt(' felt på DawaAutocompleteResult — stub nu, iter 2 wireup.'))),
    li(p(txt('Virksomheder: '), code('Kun aktive'), txt(' checkbox (default on). Filter fungerer direkte på '), code('CVRSearchResult.active'), txt('.'))),
    li(p(txt('Reset-knap i panel-header clearer begge til default.'))),
  ),
  p(strong('Iter 2 scope (dokumenteret i ticket, stubbed i UI):')),
  ul(
    li(p(txt('Ejendomme: opførelsesår, areal, energimærke, bygningstype, varmeform, ejerforhold, fredning, zone'))),
    li(p(txt('Virksomheder: virksomhedsform, branche, geografi, stiftet, ansatte'))),
    li(p(txt('Personer: rolle, stilling, geografi'))),
    li(p(txt('Live-preview af match-antal per filter'))),
  ),
  p(strong('Commit: '), code('204df78'), txt('. Tests 1626/1640 grønne. '), strong('→ In Review (iter 1 partial).')),
]};
const cr = await req('POST', '/rest/api/3/issue/BIZZ-774/comment', { body });
console.log(cr.status === 201 ? 'ok' : 'fail', cr.status);
const tr = await req('GET', '/rest/api/3/issue/BIZZ-774/transitions');
const t = (JSON.parse(tr.body).transitions || []).find(x => /^in review$/i.test(x.name));
if (t) { const r = await req('POST', '/rest/api/3/issue/BIZZ-774/transitions', { transition: { id: t.id } }); console.log(r.status === 204 ? '-> In Review' : 'warn'); }
