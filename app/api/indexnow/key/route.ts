/**
 * GET /api/indexnow/key — serverer IndexNow-nøglen som text/plain.
 *
 * IndexNow-søgemaskinerne (Bing, Yandex) henter denne URL (keyLocation) og
 * sammenligner indholdet med `key` i indsendelsen for at bekræfte at vi ejer
 * domænet. Nøglen er PUBLIC pr. design — ikke en hemmelighed.
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
