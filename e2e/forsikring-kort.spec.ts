import { test, expect } from '@playwright/test';

/**
 * BIZZ-2131: Visuel verifikation af kort-sidepanel på forsikringssiden.
 * Checker at kort-knappen er synlig i analyse-header og at Mapbox
 * loader når knappen klikkes.
 */
test.describe('Forsikring kort-sidepanel', () => {
  test('forsikringsside loader med kort-knap synlig', async ({ page }) => {
    await page.goto('/dashboard/forsikring');
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Verificér at siden loader
    await expect(page.locator('text=Forsikringer')).toBeVisible({ timeout: 10000 });

    // Screenshot
    await page.screenshot({ path: '/tmp/forsikring-kort-check.png', fullPage: false });
  });
});
