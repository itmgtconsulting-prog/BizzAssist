/**
 * GET /indexnow/key — serverer IndexNow-nøglen som text/plain.
 *
 * IndexNow-søgemaskinerne (Bing, Yandex) henter denne URL (keyLocation) og
 * sammenligner indholdet med `key` i indsendelsen for at bekræfte domæne-ejerskab.
 * Nøglen er PUBLIC pr. design — ikke en hemmelighed.
 *
 * VIGTIGT: Ruten ligger bevidst IKKE under /api/ (som robots.txt blokerer).
 * IndexNow's verifier honorerer robots.txt, så keyLocation SKAL være crawlbar —
 * robots.ts tillader derfor /indexnow/ eksplicit. (Tidl. /api/indexnow/key gav
 * 422 "URLs not related to verified site" fordi keyLocation var blokeret.)
 *
 * Returnerer 404 hvis INDEXNOW_KEY ikke er konfigureret.
 *
 * @returns Nøglen som text/plain, eller 404
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const key = process.env.INDEXNOW_KEY;
  if (!key) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  return new NextResponse(key, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
