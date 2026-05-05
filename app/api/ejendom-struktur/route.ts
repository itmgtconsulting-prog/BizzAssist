/**
 * GET /api/ejendom-struktur
 *
 * Bygger det fulde ejendomshierarki (SFE → Hovedejendom → Ejerlejlighed)
 * for en given matrikel. Bruger Tinglysningsrettens matrikelsøgning til at
 * finde alle ejendomme og klassificerer dem i 3 niveauer. Henter vurdering
 * for hver hovedejendom via VUR GraphQL. Resolver DAWA-ID'er for navigation.
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
import { fetchDawa } from '@/app/lib/dawa';

// ─── Query param validation ─────────────────────────────────────────────────

const strukturQuerySchema = z.object({
  ejerlavKode: z.string().regex(/^\d+$/, 'ejerlavKode skal være et heltal'),
  matrikelnr: z.string().min(1, 'matrikelnr er påkrævet'),
  sfeBfe: z.coerce.number().int().positive().optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

/** Klassificering af en node i ejendomshierarkiet */
export type StrukturNiveau = 'sfe' | 'hovedejendom' | 'ejerlejlighed';

/** En enkelt node i ejendomsstrukturtræet */
export interface StrukturNode {
  bfe: number;
  adresse: string;
  niveau: StrukturNiveau;
  /** DAWA adresse-UUID for navigation til ejendomsdetalje */
  dawaId: string | null;
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

// ─── Tinglysning mTLS ───────────────────────────────────────────────────────

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

// ─── DAWA adresse-resolver ──────────────────────────────────────────────────

/**
 * Resolver DAWA adresse-ID (UUID) fra en TL-adressestreng.
 * Parser vejnavn, husnummer, postnummer og slår op i DAWA /adresser eller
 * /adgangsadresser for at finde UUID til navigation.
 *
 * @param tlAdresse - Tinglysnings-adresse (f.eks. "Arnold Nielsens Boulevard 62A, 2650 Hvidovre")
 * @param etage - Etage (for ejerlejligheder)
 * @param doer - Dør (for ejerlejligheder)
 * @returns DAWA UUID eller null
 */
async function resolveDawaId(
  tlAdresse: string,
  etage: string | null,
  doer: string | null
): Promise<string | null> {
  try {
    const parts = tlAdresse.split(',').map((s) => s.trim());
    const streetPart = parts[0];
    const m = streetPart.match(/^(.+?)\s+(\d+\w*)$/);
    if (!m) return null;
    const vejnavn = m[1];
    const husnummer = m[2];
    // Postnummer: find 4-cifret tal i adressestreng
    const postMatch = tlAdresse.match(/(\d{4})/);
    if (!postMatch) return null;
    const postnr = postMatch[1];

    // For ejerlejligheder: søg med etage/dør for specifik adresse-UUID
    if (etage) {
      const params = new URLSearchParams({
        vejnavn,
        husnr: husnummer,
        postnr,
        etage,
        struktur: 'mini',
      });
      if (doer) params.set('dør', doer);
      const res = await fetchDawa(
        `https://dawa.aws.dk/adresser?${params}`,
        { signal: AbortSignal.timeout(5000) },
        { caller: 'ejendom-struktur.dawa-adresse' }
      );
      if (res.ok) {
        const arr = (await res.json()) as Array<{ id: string }>;
        if (arr.length > 0) return arr[0].id;
      }
    }

    // For SFE/hovedejendom: søg adgangsadresse (uden etage)
    const params = new URLSearchParams({
      vejnavn,
      husnr: husnummer,
      postnr,
      struktur: 'mini',
    });
    const res = await fetchDawa(
      `https://dawa.aws.dk/adgangsadresser?${params}`,
      { signal: AbortSignal.timeout(5000) },
      { caller: 'ejendom-struktur.dawa-adgangsadresse' }
    );
    if (res.ok) {
      const arr = (await res.json()) as Array<{ id: string }>;
      if (arr.length > 0) return arr[0].id;
    }
    return null;
  } catch {
    return null;
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
 * Ekstraher husnummer (tal + evt. bogstav) fra en adressestreng.
 * F.eks. "Arnold Nielsens Boulevard 62B, st. th, 2650" → "62B"
 *
 * @param adresse - Fuld adressestreng
 * @returns Husnummer inkl. evt. bogstav (f.eks. "62A", "62B", "62")
 */
function extractHusnr(adresse: string): string {
  const streetPart = adresse.split(',')[0].trim();
  const match = streetPart.match(/(\d+\w*)$/);
  return match ? match[1].toUpperCase() : '';
}

/**
 * Parser etage+dør fra en tinglysningsadresse.
 * F.eks. "Vejnavn 18, 1. tv, 1799 København" → { etage: "1", doer: "tv" }
 *
 * @param adresse - Fuld adressestreng fra tinglysning
 * @returns Etage og dør
 */
function parseEtageDoer(adresse: string): { etage: string | null; doer: string | null } {
  const parts = adresse.split(',').map((s) => s.trim());
  if (parts.length < 3) return { etage: null, doer: null };
  const etageDoer = parts[1].trim();
  const match = etageDoer.match(/^(\d+|st|kl)\.?\s*(.*)$/i);
  if (!match) return { etage: null, doer: null };
  return {
    etage: match[1].toLowerCase(),
    doer: match[2]?.toLowerCase().trim() || null,
  };
}

// ─── Route handler ──────────────────────────────────────────────────────────

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

    // Debug: log alle TL items for at forstå klassificering
    logger.log(
      `[ejendom-struktur] ${items.length} items fra TL for ejerlav=${ejerlavKode} matr=${matrikelnr}:`,
      items.map((i) => ({
        adresse: i.adresse,
        vedroerende: i.vedroerende,
        bfe: i.ejendomsnummer,
        vurdering: i.ejendomsVurdering,
      }))
    );

    // ── Trin 2: Klassificér alle items ──
    const classified = items.map((item) => {
      const niveau = klassificerItem(item);
      const bfe = item.ejendomsnummer ? parseInt(item.ejendomsnummer, 10) : 0;
      const husnr = extractHusnr(item.adresse);
      const { etage, doer } = parseEtageDoer(item.adresse);
      return { ...item, niveau, bfe, husnr, etage, doer };
    });

    logger.log(
      `[ejendom-struktur] klassificering:`,
      classified.map((c) => `${c.adresse} → ${c.niveau} (husnr=${c.husnr}, bfe=${c.bfe})`)
    );

    let sfeItems = classified.filter((i) => i.niveau === 'sfe');
    const hovedejendomItems = classified.filter((i) => i.niveau === 'hovedejendom');
    const ejerlejlighedItems = classified.filter((i) => i.niveau === 'ejerlejlighed');

    // Heuristik: hvis der er FLERE "sfe"-items, er de reelt hovedejendomme.
    // Den ægte SFE er den med lavest BFE eller den uden husnr-bogstav.
    // Resten er hovedejendomme der ikke blev fanget af vedroerende-tekst.
    if (sfeItems.length > 1) {
      // Find den der bedst matcher "ren" SFE: laveste BFE, eller den med
      // husnr uden bogstav-suffix
      const sorted = [...sfeItems].sort((a, b) => {
        // Foretrøk item med sfeBfe match
        if (sfeBfe) {
          if (a.bfe === sfeBfe) return -1;
          if (b.bfe === sfeBfe) return 1;
        }
        // Foretrøk husnr uden bogstav (f.eks. "62" over "62A")
        const aHasLetter = /[A-Z]$/i.test(a.husnr);
        const bHasLetter = /[A-Z]$/i.test(b.husnr);
        if (aHasLetter !== bHasLetter) return aHasLetter ? 1 : -1;
        return a.bfe - b.bfe;
      });
      // Første er den ægte SFE, resten er hovedejendomme
      const realSfe = sorted[0];
      const extraHoved = sorted.slice(1);
      sfeItems = [realSfe];
      for (const item of extraHoved) {
        item.niveau = 'hovedejendom';
        hovedejendomItems.push(item);
      }
      logger.log(
        `[ejendom-struktur] multi-sfe heuristik: SFE=${realSfe.bfe}, ekstra hovedejendomme:`,
        extraHoved.map((h) => h.bfe)
      );
    }

    // ── Trin 3: Hent vurderinger for hovedejendomme parallelt ──
    const vurderinger = await Promise.all(
      hovedejendomItems.map(async (hej) => {
        if (hej.bfe <= 0)
          return { bfe: hej.bfe, ejendomsvaerdi: null, grundvaerdi: null, aar: null };
        return { bfe: hej.bfe, ...(await fetchVurderingForBfe(hej.bfe)) };
      })
    );
    const vurMap = new Map(vurderinger.map((v) => [v.bfe, v]));

    // ── Trin 4: Resolve DAWA ID'er for navigation ──
    const allItems = [...sfeItems, ...hovedejendomItems, ...ejerlejlighedItems];
    const dawaIds = await Promise.all(
      allItems.map(async (item) => {
        const id = await resolveDawaId(item.adresse, item.etage, item.doer);
        return { bfe: item.bfe, adresse: item.adresse, dawaId: id };
      })
    );
    const dawaMap = new Map(dawaIds.map((d) => [d.adresse, d.dawaId]));

    // ── Trin 5: Byg træet ──

    // Gruppér ejerlejligheder under hovedejendomme baseret på husnummer-match
    const assignedEjl = new Set<number>();
    const hovedejendomNodes: StrukturNode[] = hovedejendomItems.map((hej) => {
      const vur = vurMap.get(hej.bfe);
      const children: StrukturNode[] = ejerlejlighedItems
        .filter((ejl) => ejl.husnr === hej.husnr)
        .map((ejl) => {
          assignedEjl.add(ejl.bfe);
          return {
            bfe: ejl.bfe,
            adresse: ejl.adresse,
            niveau: 'ejerlejlighed' as const,
            dawaId: dawaMap.get(ejl.adresse) ?? null,
            ejendomsvaerdi: null,
            grundvaerdi: null,
            vurderingsaar: null,
            tlVurdering: ejl.ejendomsVurdering,
            children: [],
          };
        });

      return {
        bfe: hej.bfe,
        adresse: hej.adresse,
        niveau: 'hovedejendom' as const,
        dawaId: dawaMap.get(hej.adresse) ?? null,
        ejendomsvaerdi: vur?.ejendomsvaerdi ?? null,
        grundvaerdi: vur?.grundvaerdi ?? null,
        vurderingsaar: vur?.aar ?? null,
        tlVurdering: hej.ejendomsVurdering,
        children,
      };
    });

    // Orphan-ejerlejligheder: gruppér per husnr og opret virtuelle
    // hovedejendom-noder for dem. Tinglysning returnerer ikke altid
    // en eksplicit "Hovedejendom"-item for alle opgange, men ejerlejlighederne
    // hører logisk under en hovedejendom med samme husnr.
    const orphanItems = ejerlejlighedItems.filter((ejl) => !assignedEjl.has(ejl.bfe));
    const orphanByHusnr = new Map<string, typeof orphanItems>();
    for (const ejl of orphanItems) {
      const group = orphanByHusnr.get(ejl.husnr) ?? [];
      group.push(ejl);
      orphanByHusnr.set(ejl.husnr, group);
    }

    // Opret virtuelle hovedejendom-noder for orphan-grupper og hent
    // deres vurderinger + DAWA-ID'er
    const virtualHovedNodes: StrukturNode[] = [];
    for (const [husnr, ejls] of orphanByHusnr) {
      // Byg adresse for den virtuelle hovedejendom: vejnavn + husnr + postnr
      const firstAddr = ejls[0].adresse;
      const streetMatch = firstAddr
        .split(',')[0]
        .trim()
        .match(/^(.+?)\s+\d+\w*$/);
      const postMatch = firstAddr.match(/(\d{4}\s+\S+.*)$/);
      const vejnavn = streetMatch?.[1] ?? '';
      const postBy = postMatch?.[1] ?? '';
      const hovedAdresse = `${vejnavn} ${husnr}, ${postBy}`;

      // Resolve DAWA ID for den virtuelle hovedejendom
      let hovedDawaId: string | null = null;
      try {
        hovedDawaId = await resolveDawaId(hovedAdresse, null, null);
      } catch {
        /* non-fatal */
      }

      const children: StrukturNode[] = ejls.map((ejl) => ({
        bfe: ejl.bfe,
        adresse: ejl.adresse,
        niveau: 'ejerlejlighed' as const,
        dawaId: dawaMap.get(ejl.adresse) ?? null,
        ejendomsvaerdi: null,
        grundvaerdi: null,
        vurderingsaar: null,
        tlVurdering: ejl.ejendomsVurdering,
        children: [],
      }));

      virtualHovedNodes.push({
        bfe: 0,
        adresse: hovedAdresse,
        niveau: 'hovedejendom',
        dawaId: hovedDawaId,
        ejendomsvaerdi: null,
        grundvaerdi: null,
        vurderingsaar: null,
        tlVurdering: null,
        children,
      });
    }

    // Root node = SFE
    const sfeItem = sfeItems[0];
    const sfeAdresse = sfeItem?.adresse ?? items[0].adresse.split(',').slice(0, 1).join(',').trim();

    // SFE DAWA ID: prøv først den vi allerede har; hvis den fejlede, prøv
    // adgangsadresse-lookup med bare vejnavn+laveste husnr
    let sfeDawaId = dawaMap.get(sfeAdresse) ?? null;
    if (!sfeDawaId && sfeItem) {
      try {
        sfeDawaId = await resolveDawaId(sfeItem.adresse, null, null);
      } catch {
        /* non-fatal */
      }
    }

    const root: StrukturNode = {
      bfe: sfeBfe ?? sfeItem?.bfe ?? 0,
      adresse: sfeAdresse,
      niveau: 'sfe',
      dawaId: sfeDawaId,
      ejendomsvaerdi: null,
      grundvaerdi: null,
      vurderingsaar: null,
      tlVurdering: sfeItem?.ejendomsVurdering ?? null,
      children: [...hovedejendomNodes, ...virtualHovedNodes],
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
