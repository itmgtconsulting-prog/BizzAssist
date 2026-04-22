#!/usr/bin/env node
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const BASE = 'https://test.bizzassist.dk';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.fill('input[type=email]', process.env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', process.env.E2E_TEST_PASS);
await page.click('button[type=submit]');
try { await page.waitForURL(/dashboard/, { timeout: 45000 }); } catch { await page.waitForTimeout(5000); }
await page.waitForTimeout(2500);

const checks = [];
fs.mkdirSync('/tmp/verify-screenshots', { recursive: true });

console.log('→ Navigerer til Jakob person-side');
await page.goto(`${BASE}/dashboard/owners/4000115446`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Klik Diagram-tab — evaluate i stedet for Playwright locator
const clicked = await page.evaluate(() => {
  const candidates = [...document.querySelectorAll('button, a, [role=tab]')];
  const btn = candidates.find(el => el.textContent?.trim() === 'Diagram' && !el.closest('aside') && !el.closest('nav[class*="sidebar"]'));
  if (btn) { btn.click(); return true; }
  return false;
});
console.log('Diagram-tab clicked:', clicked);
await page.waitForTimeout(6000); // vent på diagram render + progressive ejendom-load

const ss = '/tmp/verify-screenshots/730-jakob-diagram.png';
await page.screenshot({ path: ss, fullPage: true });
console.log('Screenshot:', ss);

// Scroll hele diagrammet ind i view + klik "Udvid" for fuld view
try {
  const udvidBtn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^Udvid$/i.test(b.textContent?.trim() ?? ''));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (udvidBtn) await page.waitForTimeout(2000);
} catch {}

// Re-screenshot med fullpage
await page.screenshot({ path: ss, fullPage: true });

// Hent tekst fra body + alle SVG/foreignObject elementer
const body = await page.evaluate(() => {
  const texts = [];
  // SVG tekst
  document.querySelectorAll('svg text, svg foreignObject, [class*="react-flow"] *').forEach(el => {
    const t = el.textContent?.trim();
    if (t && t.length > 0 && t.length < 200) texts.push(t);
  });
  return document.body.innerText + '\n' + texts.join('\n');
});

// Check 1: Container-node "Personligt ejede ejendomme" synlig
const hasContainer = /personligt ejede ejendomme/i.test(body);
checks.push({
  ok: hasContainer,
  name: 'Container-node "Personligt ejede ejendomme" vises i diagram',
  detail: hasContainer ? 'OK' : 'mangler',
});

// Check 2: Viser et antal ejendomme
const countMatch = body.match(/(\d+)\s+ejendomme?/i);
checks.push({
  ok: !!countMatch,
  name: 'Container-node viser tæller for antal ejendomme',
  detail: countMatch ? `"${countMatch[0]}"` : 'ingen tæller synlig',
});

// Check 3: Kendte ejendomme fra ticket stadig synlige
const ejendomNames = ['Hovager', 'Søbyvej', 'Vigerslevvej', 'Kildegårdsvej', 'Stårupvej'];
const foundEjendomme = ejendomNames.filter(n => new RegExp(n, 'i').test(body));
checks.push({
  ok: foundEjendomme.length >= 2,
  name: 'Mindst 2 af de kendte ejendomme er synlige i diagrammet',
  detail: `fundet: ${foundEjendomme.join(', ')}`,
});

// Check 4: Virksomheder stadig synlige (ikke regression)
const selskabNames = ['JaJR Holding', 'IT Management', 'ProductLife', 'Pharma IT'];
const foundSelskaber = selskabNames.filter(n => new RegExp(n, 'i').test(body));
checks.push({
  ok: foundSelskaber.length >= 2,
  name: 'Mindst 2 kendte virksomheder stadig synlige (ingen regression)',
  detail: `fundet: ${foundSelskaber.join(', ')}`,
});

// Check 5: Visual layout — ejendomme og virksomheder IKKE på samme y-koordinat
// Find alle SVG text eller node-div elementer + deres positions
const layoutCheck = await page.evaluate(() => {
  // Find alle diagram-nodes (kan være <g class="node">, <div class="react-flow__node"> osv.)
  const candidates = [
    ...document.querySelectorAll('.react-flow__node, g.node, [data-node-id], [class*="node"]'),
  ];
  const nodes = candidates.map(el => {
    const box = el.getBoundingClientRect();
    const text = (el.textContent || '').trim().slice(0, 40);
    return { text, y: Math.round(box.y), x: Math.round(box.x), type: null };
  }).filter(n => n.text.length > 0 && n.y > 100);

  // Klassificer: ejendom vs virksomhed vs container baseret på tekst
  const ejendomRe = /(vej|gade|plads|boulevard|allé|by|park|stræde)/i;
  const selskabRe = /(ApS|A\/S|I\/S|Holding|Management|Pharma|JaJR)/i;
  const containerRe = /personligt ejede ejendomme/i;
  const classified = nodes.map(n => ({
    ...n,
    type: containerRe.test(n.text) ? 'container' : ejendomRe.test(n.text) ? 'ejendom' : selskabRe.test(n.text) ? 'selskab' : 'other',
  }));
  const ejendomYs = [...new Set(classified.filter(n => n.type === 'ejendom').map(n => n.y))];
  const selskabYs = [...new Set(classified.filter(n => n.type === 'selskab').map(n => n.y))];
  const containerYs = [...new Set(classified.filter(n => n.type === 'container').map(n => n.y))];
  return { ejendomYs, selskabYs, containerYs, totalNodes: classified.length, sample: classified.slice(0, 10) };
});
console.log('Layout check:', JSON.stringify(layoutCheck, null, 2).slice(0, 800));

// Ejendomme og virksomheder skal IKKE have overlappende y-koordinater (tolerance ±30px)
const overlap = layoutCheck.ejendomYs.some(ey => layoutCheck.selskabYs.some(sy => Math.abs(ey - sy) < 30));
checks.push({
  ok: !overlap || layoutCheck.ejendomYs.length === 0 || layoutCheck.selskabYs.length === 0,
  name: 'Ejendomme og virksomheder er på forskellige y-linjer (ikke blandet)',
  detail: `ejendom-ys: [${layoutCheck.ejendomYs.slice(0, 5).join(',')}], selskab-ys: [${layoutCheck.selskabYs.slice(0, 5).join(',')}], overlap: ${overlap}`,
});

// Check 6: Container node skal være MELLEM person og ejendomme (y-koordinat)
const hasContainerLayer = layoutCheck.containerYs.length > 0;
if (hasContainerLayer && layoutCheck.ejendomYs.length > 0) {
  const containerY = layoutCheck.containerYs[0];
  const minEjendomY = Math.min(...layoutCheck.ejendomYs);
  const containerAboveEjendomme = containerY < minEjendomY;
  checks.push({
    ok: containerAboveEjendomme,
    name: 'Container-node ligger OVER ejendomme (3-lag struktur)',
    detail: `container-y=${containerY}, min-ejendom-y=${minEjendomY}`,
  });
}

// Summary
console.log('\n' + '═'.repeat(70));
const pass = checks.filter(c => c.ok).length;
console.log(`BIZZ-730: ${pass}/${checks.length} passed`);
for (const c of checks) {
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
  if (c.detail) console.log(`      ${c.detail}`);
}
fs.writeFileSync('/tmp/verify-screenshots/730-results.json', JSON.stringify({ checks, layout: layoutCheck }, null, 2));
await b.close();
