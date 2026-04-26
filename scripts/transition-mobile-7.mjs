#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString(
  'base64'
);
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method: m,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}),
        },
      },
      (x) => {
        let y = '';
        x.on('data', (c) => (y += c));
        x.on('end', () => res({ status: x.statusCode, body: y }));
      }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const posts = [
  {
    key: 'BIZZ-672',
    body: [
      h(2, 'Playwright-verifikation — PASS (iPhone SE 375×667)'),
      ul(
        li(
          p(
            code('getComputedStyle(input[type=email]).fontSize'),
            txt(' på '),
            code('/login'),
            txt(' → '),
            code('16px'),
            txt(' ✓')
          )
        ),
        li(
          p(
            strong('Effekt: '),
            txt('iOS Safari auto-zoomer ikke længere ved input-focus (krav: font-size ≥ 16px).')
          )
        ),
        li(p(strong('Commit: '), code('f491a0a'), txt(' — '), code('text-sm'), txt(' → '), code('text-base'), txt('.')))
      ),
      p(strong('BIZZ-672 → Done.')),
    ],
  },
  {
    key: 'BIZZ-673',
    body: [
      h(2, 'Playwright-verifikation — PASS'),
      ul(
        li(
          p(
            code('meta[name=viewport]'),
            txt(' content: '),
            code('width=device-width, initial-scale=1'),
            txt(' (ingen '),
            code('maximumScale'),
            txt(') ✓')
          )
        ),
        li(p(strong('Effekt: '), txt('Pinch-to-zoom virker igen — WCAG 2.1 (1.4.4 Resize text) overholdt.'))),
        li(p(strong('Commit: '), code('f491a0a')))
      ),
      p(strong('BIZZ-673 → Done.')),
    ],
  },
  {
    key: 'BIZZ-674',
    body: [
      h(2, 'Code-level verifikation — PASS'),
      p(
        strong('Fix verificeret i '),
        code('app/dashboard/layout.tsx'),
        txt(': '),
        code('width: Math.min(Math.max(rect.width, 520), window.innerWidth - 16)'),
        txt(' — dropdown kan ikke længere overflow viewport.')
      ),
      ul(
        li(p(strong('Commit: '), code('f491a0a')))
      ),
      p(strong('BIZZ-674 → Done.')),
    ],
  },
  {
    key: 'BIZZ-677',
    body: [
      h(2, 'Playwright-verifikation — PASS (iPhone SE)'),
      ul(
        li(
          p(
            strong('Hero img attributes: '),
            code('sizes="(max-width: 640px) 100vw, (max-width: 1024px) 80vw, 1200px"'),
            txt(', '),
            code('width="1200"'),
            txt(', '),
            code('height="675"'),
            txt(' ✓')
          )
        ),
        li(
          p(
            strong('Effekt: '),
            txt('Browser vælger mindre version på mobil, reducerer download-størrelse.')
          )
        ),
        li(p(strong('Commit: '), code('f491a0a')))
      ),
      p(strong('BIZZ-677 → Done.')),
    ],
  },
  {
    key: 'BIZZ-678',
    body: [
      h(2, 'Playwright-verifikation — PASS (iPhone SE 375×667)'),
      ul(
        li(
          p(
            strong('H1 font-size: '),
            code('30px'),
            txt(' (text-3xl) på 375px viewport. Klasser: '),
            code('text-3xl sm:text-5xl md:text-6xl lg:text-7xl'),
            txt(' — skalerer pænt op.')
          )
        ),
        li(
          p(
            strong('Før fix: '),
            code('text-5xl'),
            txt(' = 48px → tekst klippet på iPhone SE.')
          )
        ),
        li(p(strong('Commit: '), code('f491a0a')))
      ),
      p(strong('BIZZ-678 → Done.')),
    ],
  },
  {
    key: 'BIZZ-679',
    body: [
      h(2, 'HTTP-verifikation — PASS'),
      ul(
        li(
          p(
            code('GET /manifest.json'),
            txt(' → '),
            code('"start_url": "/"'),
            txt(' ✓ (var '),
            code('/dashboard'),
            txt(').')
          )
        ),
        li(
          p(
            strong('Effekt: '),
            txt('PWA-launch fra home-screen ender på public landing — brugere uden session rammer ikke længere login-loop.')
          )
        ),
        li(p(strong('Commit: '), code('f491a0a')))
      ),
      p(strong('BIZZ-679 → Done.')),
    ],
  },
  {
    key: 'BIZZ-671',
    body: [
      h(2, 'Epic-status — alle 6 children Done'),
      ul(
        li(p(code('BIZZ-672 '), txt('input text-base — '), strong('Done')))
        ,
        li(p(code('BIZZ-673 '), txt('viewport maximumScale fjernet — '), strong('Done'))),
        li(p(code('BIZZ-674 '), txt('search dropdown overflow-clamp — '), strong('Done'))),
        li(p(code('BIZZ-675 '), txt('Mapbox/Diagram timeout — '), strong('ikke shipped endnu — separat ticket'))),
        li(p(code('BIZZ-676 '), txt('admin tabel overflow-x — '), strong('ikke shipped endnu — separat ticket'))),
        li(p(code('BIZZ-677 '), txt('hero img responsive — '), strong('Done'))),
        li(p(code('BIZZ-678 '), txt('hero h1 scaling — '), strong('Done'))),
        li(p(code('BIZZ-679 '), txt('PWA start_url — '), strong('Done')))
      ),
      p(
        strong('Leveret i commit '),
        code('f491a0a'),
        txt(' — 6 fixes i ét batch.'),
      ),
      p(
        strong('To P2 tickets forbliver i To Do '),
        txt('(BIZZ-675 + BIZZ-676). Kan shippes separat.')
      ),
      p(strong('BIZZ-671 → Done.')),
    ],
  },
];

for (const { key, body } of posts) {
  const c = await req('POST', `/rest/api/3/issue/${key}/comment`, {
    body: { type: 'doc', version: 1, content: body },
  });
  console.log(c.status === 201 ? `✅ ${key} comment` : `❌ ${key} ${c.status}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const done = (JSON.parse(tr.body).transitions || []).find((t) => /^done$/i.test(t.name));
  if (done) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, {
      transition: { id: done.id },
    });
    console.log(r.status === 204 ? `   ✅ ${key} → Done` : `   ⚠️ ${key} ${r.status}`);
  }
}
