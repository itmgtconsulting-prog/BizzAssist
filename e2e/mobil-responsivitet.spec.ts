/**
 * BIZZ-2257: Mobil-responsivitet regressionstest (375px iPhone-viewport).
 *
 * Låser mobil-adfærden: ingen VANDRET side-overflow på nøglesider/-faner (bevidst
 * scroll-bare containere med overflow-x-auto undtages). Kører mod test.bizzassist.dk
 * via den authede storageState (auth setup-projektet). Beviser samtidig at
 * bizz-2251 (diagram), bizz-2253 (tabeller) og bizz-2255 (compare) ikke overflyder.
 *
 * PC-uændret-verifikationen (1440px-baseline) håndteres separat — her fokuseres på
 * at ALT er synligt uden vandret side-scroll på mobil.
 */
import { test, expect, type Page } from '@playwright/test';

const BFE = process.env.E2E_MOBIL_BFE || '9674708';
const CVR = process.env.E2E_MOBIL_CVR || '43266934';

/**
 * Måler om SIDEN (ikke bevidst scroll-bare bokse) overflyder vandret. Elementer
 * inde i en overflow-x auto/scroll-container tæller ikke som side-overflow.
 *
 * @param page - Playwright page
 * @returns overflow-flag + de værste offenders (til fejl-diagnose)
 */
async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const de = document.scrollingElement || document.documentElement;
    const vw = de.clientWidth;
    const offenders: { tag: string; cls: string; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 2 && r.width > 40) {
        let p = el.parentElement;
        let scrollable = false;
        while (p) {
          const ov = getComputedStyle(p).overflowX;
          if (ov === 'auto' || ov === 'scroll') {
            scrollable = true;
            break;
          }
          p = p.parentElement;
        }
        if (!scrollable)
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 70),
            right: Math.round(r.right),
          });
      }
    }
    const seen: Record<string, { tag: string; cls: string; right: number }> = {};
    for (const o of offenders) if (!seen[o.cls] || seen[o.cls].right < o.right) seen[o.cls] = o;
    return {
      vw,
      scrollW: de.scrollWidth,
      overflow: de.scrollWidth > vw + 2,
      offenders: Object.values(seen)
        .sort((a, b) => b.right - a.right)
        .slice(0, 6),
    };
  });
}

/** Asserter ingen side-overflow; ved fejl logges offenders for hurtig diagnose. */
async function expectNoOverflow(page: Page, label: string) {
  const r = await pageOverflow(page);
  if (r.overflow) {
    console.log(`[overflow] ${label} vw=${r.vw} scrollW=${r.scrollW}`, r.offenders);
  }
  expect(r.overflow, `${label} overflyder vandret på 375px`).toBe(false);
}

async function dismissModal(page: Page) {
  const close = page
    .locator(
      '[role="dialog"] button[aria-label*="Luk"], [role="dialog"] button[aria-label*="Close"]'
    )
    .first();
  if (await close.isVisible({ timeout: 1500 }).catch(() => false)) await close.click();
}

/**
 * Klikker hver navngiven fane (hvis den findes) og asserter ingen overflow. Fanerne
 * ligger i en overflow-x-auto tablist → nogle er scrollet ud af skærmen, så vi bruger
 * count()+scrollIntoView i stedet for isVisible (som falsk-springer off-screen-faner over).
 *
 * @param page - Playwright page
 * @param names - fane-labels (regex-matchet)
 * @param prefix - label-prefiks til fejlbesked
 */
async function checkTabs(page: Page, names: string[], prefix: string) {
  // Vent på at tablist'en (og dermed fanerne) er rendered — detalje-siden henter
  // data via API på test, så headeren+fanerne kommer efter navigation.
  await page
    .getByRole('tablist')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {});
  let clicked = 0;
  for (const name of names) {
    const tab = page.getByRole('tab', { name: new RegExp(name, 'i') }).first();
    if ((await tab.count()) === 0) continue;
    await tab.scrollIntoViewIfNeeded().catch(() => {});
    await tab.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    clicked++;
    await expectNoOverflow(page, `${prefix} tab: ${name}`);
  }
  // Sikkerhedsnet: fanerne SKAL findes (ellers falsk-grøn test pga. manglende data).
  expect(clicked, `${prefix}: ingen faner fundet — tjek test-entitet`).toBeGreaterThan(0);
}

test('dashboard-forside overflyder ikke på mobil', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await dismissModal(page);
  await page.waitForTimeout(1200);
  await expectNoOverflow(page, '/dashboard');
});

test('compare-siden overflyder ikke på mobil', async ({ page }) => {
  await page.goto('/dashboard/compare', { waitUntil: 'domcontentloaded' });
  await dismissModal(page);
  await page.waitForTimeout(1200);
  await expectNoOverflow(page, '/dashboard/compare');
});

test('virksomheds-detalje + faner overflyder ikke på mobil', async ({ page }) => {
  await page.goto(`/dashboard/companies/${CVR}`, { waitUntil: 'domcontentloaded' });
  await dismissModal(page);
  await page.waitForTimeout(1500);
  await expectNoOverflow(page, `company ${CVR} (default)`);
  await checkTabs(page, ['Diagram', 'Relationer', 'Ejerskab', 'Struktur', 'Regnskab'], 'company');
});

test('ejendoms-detalje + alle faner overflyder ikke på mobil', async ({ page }) => {
  await page.goto(`/dashboard/ejendomme/${BFE}`, { waitUntil: 'domcontentloaded' });
  await dismissModal(page);
  await page.waitForTimeout(1500);
  await expectNoOverflow(page, `ejendom ${BFE} (default)`);
  await checkTabs(
    page,
    ['Overblik', 'BBR', 'Økonomi', 'Dokumenter', 'Tinglysning', 'Ejerforhold'],
    'ejendom'
  );
});
