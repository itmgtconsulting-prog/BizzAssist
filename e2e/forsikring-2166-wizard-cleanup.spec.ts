/**
 * BIZZ-2166: Ryd op i dokumenter ved skift af forsikringsejer.
 *
 * Reproducerer fejlen hvor friske wizard-uploads ("ny"-badge) fra én
 * forsikringsejer forblev synlige efter man trykkede "← Ny forsikringsejer".
 * Det er et databrud på tværs af kunder — forskellige forsikringsejeres
 * dokumenter må ALDRIG blandes sammen.
 *
 * Flow: vælg kunde A (via URL-restore, BIZZ-2148) → upload et unikt dokument i
 * wizard'en → bekræft at det vises som "ny" → tryk "Ny forsikringsejer" →
 * dokumentet SKAL være forsvundet (wizardUploads nulstilles på kunde-skift).
 *
 * Oprydning: det uploadede dokument slettes igen via DELETE
 * /api/forsikring/documents/{id} (finally-blok), så live-tenanten ikke
 * forurenes.
 *
 * Kører mod test.bizzassist.dk (develop) med gemt auth-state.
 */
import { test, expect } from '@playwright/test';
import { AUTH_STATE_PATH } from './helpers';

test.use({ storageState: AUTH_STATE_PATH });

const KUNDE = '24301117'; // BELVEDERE EJENDOMME A/S
const KUNDE_NAVN = 'BELVEDERE EJENDOMME A/S';

// Unikt filnavn pr. kørsel så vi kan asserte præcist + undgå dedup-kollision.
const UNIQUE_NAME = `bizz2166-test-${Date.now()}.pdf`;
// Minimal PDF-byte-buffer — upload-ruten parser ikke, så indholdet er ligegyldigt.
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
);

// Exact accept-attribut for wizard-upload-inputtet (unikt ift. sags-upload-inputtet).
const WIZARD_INPUT =
  'input[accept=".pdf,.docx,.xlsx,.xls,.pptx,.rtf,.txt,.png,.jpg,.jpeg,.gif,.webp,application/pdf,image/*"]';

test('BIZZ-2166: wizard-uploads ryddes når man skifter forsikringsejer', async ({ page }) => {
  let uploadedDocId: string | undefined;

  try {
    // 1) Genskab kunde A via URL — sætter selected + åbner doc-picker.
    await page.goto(
      `/dashboard/forsikring?kunde=${KUNDE}&type=virksomhed&navn=${encodeURIComponent(KUNDE_NAVN)}`
    );
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(KUNDE_NAVN).first()).toBeVisible({ timeout: 20_000 });

    // 2) Upload et unikt dokument i wizard'en. Fang upload-svaret for at få doc-id (til oprydning).
    const uploadResp = page.waitForResponse(
      (r) => r.url().includes('/api/forsikring/upload') && r.request().method() === 'POST',
      { timeout: 30_000 }
    );
    await page.locator(WIZARD_INPUT).setInputFiles({
      name: UNIQUE_NAME,
      mimeType: 'application/pdf',
      buffer: PDF_BYTES,
    });
    const resp = await uploadResp;
    const body = await resp.json().catch(() => ({}));
    uploadedDocId = body?.document?.id;

    // 3) Dokumentet skal vises i listen (som "ny").
    await expect(page.getByText(UNIQUE_NAME).first()).toBeVisible({ timeout: 20_000 });

    // 4) Tryk "← Ny forsikringsejer".
    await page.getByRole('button', { name: /Ny forsikringsejer|New insurance owner/ }).click();

    // 5) ASSERT: den forrige forsikringsejers dokument er væk (wizardUploads nulstillet).
    await expect(page.getByText(UNIQUE_NAME)).toHaveCount(0, { timeout: 10_000 });

    await page.screenshot({ path: '.playwright/forsikring-2166-cleanup.png', fullPage: true });
  } finally {
    // Oprydning: slet det uploadede testdokument igen.
    if (uploadedDocId) {
      await page.request
        .delete(`/api/forsikring/documents/${uploadedDocId}`)
        .catch(() => undefined);
    }
  }
});
