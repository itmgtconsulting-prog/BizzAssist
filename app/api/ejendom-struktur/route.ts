/**
 * GET /api/ejendom-struktur
 *
 * Bygger det fulde ejendomshierarki (SFE → Hovedejendom → Ejerlejlighed)
 * for en given matrikel. Bruger Tinglysningsrettens matrikelsøgning til at
 * finde alle ejendomme og klassificerer dem i 3 niveauer. Henter vurdering
 * for hver hovedejendom via VUR GraphQL.
 *
 * Query params:
 *   - ejerlavKode: string (ejerlav kode)
 *   - matrikelnr: string (matrikelnummer)
 *   - sfeBfe: number (optional — BFE for den aktuelle SFE, bruges til at tagge root)
 *
 * @returns EjendomStrukturResponse med tree-struktur
 */

import { NextRequest, NextResponse } from 'next/server';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '@/app/lib/logger';
import { resolveTenantId } from '@/lib/api/auth';
import { parseQuery } from '@/app/lib/validate';
import { getSharedOAuthToken } from '@/app/lib/dfTokenCache';
import { proxyUrl, proxyHeaders, proxyTimeout } from '@/app/lib/dfProxy';

// ─── Query param validation ─────��───────────────────────────────────────────

const strukturQuerySchema = z.object({
  ejerlavKode: z.string().regex(/^\d+$/, 'ejerlavKode skal være et heltal'),
  matrikelnr: z.string().min(1, 'matrikelnr er påkrævet'),
  sfeBfe: z.coerce.number().int().positive().optional(),
});

// ─── Types ─────────────────────────────────────────────���─────────────────────

/** Klassificering af en node i ejendomshierarkiet */
export type StrukturNiveau = 'sfe' | 'hovedejendom' | 'ejerlejlighed';

/** En enkelt node i ejendomsstrukturtræet */
export interface StrukturNode {
  bfe: number;
  adresse: string;
  niveau: StrukturNiveau;
  /** Ejendomsværdi fra vurdering (kun for hovedejendomme) */
  ejendomsvaerdi: number | null;
  /** Grundværdi fra vurdering (kun for hovedejendomme) */
  grundvaerdi: number | null;
  /** Vurderingsår */
  vurderingsaar: number | null;
  /** Tinglysningens ejendomsvurdering (fallback) */
  tlVurdering: number | null;
  /** Underliggende ejendomme */
  children: StrukturNode[];
}

/** API-svar */
export interface EjendomStrukturResponse {
  tree: StrukturNode | null;
  fejl: string | null;
}

// ─── Tinglysning mTLS ────────────────────────��──────────────────────────────

const CERT_PATH =
  process.env.TINGLYSNING_CERT_PATH ?? process.env.NEMLOGIN_DEVTEST4_CERT_PATH ?? '';
const CERT_PASSWORD =
  process.env.TINGLYSNING_CERT_PASSWORD ?? process.env.NEMLOGIN_DEVTEST4_CERT_PASSWORD ?? '';
const CERT_B64 = process.env.TINGLYSNING_CERT_B64 ?? process.env.NEMLOGIN_DEVTEST4_CERT_B64 ?? '';
const TL_BASE = process.env.TINGLYSNING_BASE_URL ?? 'https://test.tinglysning.dk';
const TL_API_PATH = '/tinglysning/ssl';

/** Tinglysning søge-item */
interface TLSearchItem {
  uuid: string;
  adresse: string;
  vedroerende: string;
  ejendomsVurdering: number | null;
  grundVaerdi: number | null;
  vurderingsDato: string | null;
  ejendomsnummer: string | null;
  kommuneNummer: string | null;
}

/**
 * HTTPS request med client-certifikat (mTLS) til Tinglysningsretten.
 *
 * @param urlPath - URL-sti efter /tinglysning/ssl/
 * @returns HTTP status + body
 */
function tlFetch(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let pfx: Buffer;
    if (CERT_B64) {
      pfx = Buffer.from(CERT_B64, 'base64');
    } else {
      const certAbsPath = path.resolve(CERT_PATH);
      if (!fs.existsSync(certAbsPath)) {
        reject(new Error('Certifikat ikke fundet: ' + certAbsPath));
        return;
      }
      pfx = fs.readFileSync(certAbsPath);
    }
    const url = new URL(TL_BASE + TL_API_PATH + urlPath);

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        pfx,
        passphrase: CERT_PASSWORD,
        rejectUnauthorized: false,
        timeout: 15000,
        headers: { Accept: 'application/json, application/xml, */*' },
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

// ─── VUR GraphQL helper ─────────────────────────────────────────────────────

/**
 * Henter ejendomsvurdering fra Datafordeler VUR GraphQL for et BFE-nummer.
 *
 * @param bfe - BFE-nummer
 * @returns Vurderingsdata eller null
 */
async function fetchVurderingForBfe(
  bfe: number
): Promise<{ ejendomsvaerdi: number | null; grundvaerdi: number | null; aar: number | null }> {
  try {
    const token = await getSharedOAuthToken();
    if (!token) return { ejendomsvaerdi: null, grundvaerdi: null, aar: null };

    const query = `query($bfe: [Int!]!) {
      VUR_BFEKrydsreference(where: { BFEnummer: { in: $bfe } }) {
        nodes {
          VUR_Ejendomsvurdering {
            nodes {
              ejendomsvaerdi
              grundvaerdi
              vurderingsaar
            }
          }
        }
      }
    }`;

    const VUR_GQL_URL = 'https://graphql.datafordeler.dk/VUR/v2';
    const resp = await fetch(proxyUrl(VUR_GQL_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...proxyHeaders(),
      },
      body: JSON.stringify({ query, variables: { bfe: [bfe] } }),
      signal: AbortSignal.timeout(proxyTimeout()),
    });

    if (!resp.ok) return { ejendomsvaerdi: null, grundvaerdi: null, aar: null };

    const data = (await resp.json()) as {
      data?: {
        VUR_BFEKrydsreference?: {
          nodes?: Array<{
            VUR_Ejendomsvurdering?: {
              nodes?: Array<{
                ejendomsvaerdi: number | null;
                grundvaerdi: number | null;
                vurderingsaar: number | null;
              }>;
            };
          }>;
        };
      };
    };

    const vurderinger =
      data.data?.VUR_BFEKrydsreference?.nodes?.[0]?.VUR_Ejendomsvurdering?.nodes ?? [];
    if (vurderinger.length === 0) return { ejendomsvaerdi: null, grundvaerdi: null, aar: null };

    // Nyeste vurdering (højeste år)
    const nyeste = vurderinger.reduce((a, b) =>
      (b.vurderingsaar ?? 0) > (a.vurderingsaar ?? 0) ? b : a
    );

    return {
      ejendomsvaerdi: nyeste.ejendomsvaerdi,
      grundvaerdi: nyeste.grundvaerdi,
      aar: nyeste.vurderingsaar,
    };
  } catch (err) {
    logger.warn(`[ejendom-struktur] VUR fetch fejl for BFE ${bfe}:`, err);
    return { ejendomsvaerdi: null, grundvaerdi: null, aar: null };
  }
}

// ─── Klassificering ─────────────────────────────────────────────────────────

/**
 * Klassificerer en TL-item baseret på vedroerende-tekst og adresse.
 * Tinglysning bruger "Ejerlejlighed:" prefix for ejerlejligheder og
 * "Hovedejendom:" for hovedejendomme. Alt uden etage-info og uden
 * "Ejerlejlighed" er enten SFE eller hovedejendom.
 *
 * @param item - Tinglysning søge-item
 * @returns Klassificering
 */
function klassificerItem(item: TLSearchItem): StrukturNiveau {
  const v = item.vedroerende.toLowerCase();
  if (v.includes('ejerlejlighed')) return 'ejerlejlighed';
  if (v.includes('hovedejendom')) return 'hovedejendom';
  // Fallback: items med etage i adressen er ejerlejligheder
  const parts = item.adresse.split(',');
  if (parts.length >= 3) {
    const mid = parts[1].trim();
    if (/^\d+\.|^st\.|^kl\./i.test(mid)) return 'ejerlejlighed';
  }
  return 'sfe';
}

/**
 * Ekstraher husnummer-suffix (bogstav) fra en adresse for at matche
 * ejerlejligheder til deres hovedejendom.
 * F.eks. "Arnold Nielsens Blvd 62B, st. th, 2650" → "62B"
 *
 * @param adresse - Fuld adressestreng
 * @returns Husnummer inkl. evt. bogstav (f.eks. "62A", "62B", "62")
 */
function extractHusnr(adresse: string): string {
  const streetPart = adresse.split(',')[0].trim();
  const match = streetPart.match(/(\d+\w*)$/);
  return match ? match[1].toUpperCase() : '';
}

// ─── Route handler ──────────────────────────────────────────────���───────────

export async function GET(request: NextRequest): Promise<NextResponse<EjendomStrukturResponse>> {
  const auth = await resolveTenantId();
  if (!auth) {
    return NextResponse.json({ tree: null, fejl: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseQuery(request, strukturQuerySchema);
  if (!parsed.success) return parsed.response as NextResponse<EjendomStrukturResponse>;
  const { ejerlavKode, matrikelnr, sfeBfe } = parsed.data;

  if ((!CERT_PATH && !CERT_B64) || !CERT_PASSWORD) {
    return NextResponse.json(
      { tree: null, fejl: 'Tinglysning certifikat ikke konfigureret' },
      { status: 200 }
    );
  }

  try {
    // ── Trin 1: Hent alle ejendomme på matriklen via Tinglysning ──
    const searchPath = `/ejendom/landsejerlavmatrikel?landsejerlavid=${encodeURIComponent(ejerlavKode)}&matrikelnr=${encodeURIComponent(matrikelnr)}`;
    const tlResult = await tlFetch(searchPath);

    if (tlResult.status !== 200) {
      logger.error(`[ejendom-struktur] Tinglysning svarede ${tlResult.status}`);
      return NextResponse.json(
        { tree: null, fejl: `Tinglysning svarede ${tlResult.status}` },
        { status: 200 }
      );
    }

    let items: TLSearchItem[];
    try {
      const parsed = JSON.parse(tlResult.body) as { items: TLSearchItem[] };
      items = parsed.items ?? [];
    } catch {
      return NextResponse.json(
        { tree: null, fejl: 'Ugyldig tinglysning-respons' },
        { status: 200 }
      );
    }

    if (items.length === 0) {
      return NextResponse.json({ tree: null, fejl: null }, { status: 200 });
    }

    // ─�� Trin 2: Klassificér alle items ──
    const classified = items.map((item) => ({
      ...item,
      niveau: klassificerItem(item),
      bfe: item.ejendomsnummer ? parseInt(item.ejendomsnummer, 10) : 0,
      husnr: extractHusnr(item.adresse),
    }));

    const sfeItems = classified.filter((i) => i.niveau === 'sfe');
    const hovedejendomItems = classified.filter((i) => i.niveau === 'hovedejendom');
    const ejerlejlighedItems = classified.filter((i) => i.niveau === 'ejerlejlighed');

    // ── Trin 3: Hent vurderinger for hovedejendomme parallelt ──
    const vurderinger = await Promise.all(
      hovedejendomItems.map(async (hej) => {
        if (hej.bfe <= 0)
          return { bfe: hej.bfe, ejendomsvaerdi: null, grundvaerdi: null, aar: null };
        return { bfe: hej.bfe, ...(await fetchVurderingForBfe(hej.bfe)) };
      })
    );
    const vurMap = new Map(vurderinger.map((v) => [v.bfe, v]));

    // ── Trin 4: Byg træet ──

    // Gruppér ejerlejligheder under hovedejendomme baseret på husnummer-match
    const hovedejendomNodes: StrukturNode[] = hovedejendomItems.map((hej) => {
      const vur = vurMap.get(hej.bfe);
      const children: StrukturNode[] = ejerlejlighedItems
        .filter((ejl) => ejl.husnr === hej.husnr)
        .map((ejl) => ({
          bfe: ejl.bfe,
          adresse: ejl.adresse,
          niveau: 'ejerlejlighed' as const,
          ejendomsvaerdi: null,
          grundvaerdi: null,
          vurderingsaar: null,
          tlVurdering: ejl.ejendomsVurdering,
          children: [],
        }));

      return {
        bfe: hej.bfe,
        adresse: hej.adresse,
        niveau: 'hovedejendom' as const,
        ejendomsvaerdi: vur?.ejendomsvaerdi ?? null,
        grundvaerdi: vur?.grundvaerdi ?? null,
        vurderingsaar: vur?.aar ?? null,
        tlVurdering: hej.ejendomsVurdering,
        children,
      };
    });

    // Ejerlejligheder der ikke matchede en hovedejendom (orphans)
    const matchedHusnrs = new Set(hovedejendomItems.map((h) => h.husnr));
    const orphanLejligheder: StrukturNode[] = ejerlejlighedItems
      .filter((ejl) => !matchedHusnrs.has(ejl.husnr))
      .map((ejl) => ({
        bfe: ejl.bfe,
        adresse: ejl.adresse,
        niveau: 'ejerlejlighed' as const,
        ejendomsvaerdi: null,
        grundvaerdi: null,
        vurderingsaar: null,
        tlVurdering: ejl.ejendomsVurdering,
        children: [],
      }));

    // Root node = SFE
    const sfeItem = sfeItems[0];
    const root: StrukturNode = {
      bfe: sfeBfe ?? sfeItem?.bfe ?? 0,
      adresse: sfeItem?.adresse ?? items[0].adresse.split(',').slice(0, 1).join(',').trim(),
      niveau: 'sfe',
      ejendomsvaerdi: null,
      grundvaerdi: null,
      vurderingsaar: null,
      tlVurdering: sfeItem?.ejendomsVurdering ?? null,
      children: [...hovedejendomNodes, ...orphanLejligheder],
    };

    return NextResponse.json(
      { tree: root, fejl: null },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' },
      }
    );
  } catch (err) {
    logger.error('[ejendom-struktur] Uventet fejl:', err);
    return NextResponse.json({ tree: null, fejl: 'Ekstern API fejl' }, { status: 200 });
  }
}
