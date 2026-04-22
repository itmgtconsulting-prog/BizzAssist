import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => { const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/); return m ? [m[1], m[2]] : [null, null]; })
    .filter(([k]) => k)
);
const URL = 'https://test.bizzassist.dk';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(URL + '/login');
await page.fill('input[type=email]', env.E2E_TEST_EMAIL);
await page.fill('input[type=password]', env.E2E_TEST_PASS);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 15000 });

// Probe /api/ejerskab/chain for 62C (BFE 2091165)
const r = await page.request.get(`${URL}/api/ejerskab/chain?bfe=2091165&adresse=${encodeURIComponent('Arnold Nielsens Boulevard 62C')}`);
const d = await r.json();
console.log('Nodes:', (d.nodes||[]).length);
const statusNodes = (d.nodes||[]).filter(n => n.type === 'status');
const personNodes = (d.nodes||[]).filter(n => n.type === 'person');
console.log('Status nodes:', statusNodes.length, statusNodes.map(n => n.label).join(', '));
console.log('Person nodes:', personNodes.length, personNodes.map(n => n.label).join(', '));
const anpartAsPerson = personNodes.some(n => /opdelt i anpart/i.test(n.label));
const anpartAsStatus = statusNodes.some(n => /opdelt i anpart/i.test(n.label));
console.log();
console.log('"Opdelt i anpart" classified as person:', anpartAsPerson ? 'YES (BUG)' : 'NO (OK)');
console.log('"Opdelt i anpart" classified as status:', anpartAsStatus ? 'YES (OK)' : 'NO');
await browser.close();
process.exit(!anpartAsPerson ? 0 : 1);
