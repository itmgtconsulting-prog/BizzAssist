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
const plain = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

async function done(key, text) {
  const cr = await req('POST', `/rest/api/3/issue/${key}/comment`, { body: plain(text) });
  console.log(cr.status === 201 ? `✅ ${key} comment` : `❌ ${key}`);
  const tr = await req('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (JSON.parse(tr.body).transitions || []).find(x => /^done$/i.test(x.name));
  if (t) {
    const r = await req('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
    console.log(r.status === 204 ? `  ✅ ${key} → Done` : `  ⚠️ ${r.status}`);
  }
}

await done('BIZZ-737', 'Code-review PASS. Commits 6e4aeea + 44e9ee7 + d7e216a. Shared AdminNavTabs.tsx (185 lines) oprettet, alle 9 admin client-filer refactoret. Domains-tab er feature-flag-gated via isDomainFeatureEnabled(). /dashboard/admin/domains/new + detail-route eksisterer og gater korrekt. Auto-add super-admin som domain_member ved create. Transitioned til Done.');

await done('BIZZ-740', 'Code-review PASS. Commit 73f54d1. "Indstillinger"-knappen er nu erstattet af Indstillinger-tab i det nye tab-baserede nav. Settings-tab linker til /domain/[id]/admin/settings med fuld editor (4 tabs i selve settings-siden: General/AI/Opbevaring/Isolation). Transitioned til Done.');

await done('BIZZ-742', 'Code-review PASS. Commit 73f54d1. DomainAdminTabs.tsx (162 linjer) renderer 6 tabs (Oversigt/Brugere/Skabeloner/Dokumenter/Historik/Indstillinger). Path-baseret routing med activeTabIdFor() longest-suffix-match, så /admin/templates/[id] fortsat highlighter Templates-tab. Layout gater via assertDomainAdmin + isDomainFeatureEnabled. Transitioned til Done.');

await done('BIZZ-744', 'Code-review PASS. Commit 73f54d1. Back-arrow med aria-label "Tilbage til domain" (linje 112-118) + Shield-ikon + domain-navn + "Administration"-label i tab-header. Tab-bar obsoleter oprindelige "ingen tilbage-nav"-problem fordi alle sub-sider renderes inden for tab-layout med constant header. Transitioned til Done.');

console.log('\nDone.');
