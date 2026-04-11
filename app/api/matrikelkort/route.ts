/**
 * GET /api/matrikelkort
 *
 * Genererer og returnerer et matrikelkort som PDF i Resights-stil.
 * Hvid baggrund, rød matrikel-outline, naboer som sorte polygon-konturer,
 * blå kursive labels og målestoksangivelse.
 * Bruger udelukkende fri DAWA GeoJSON-data — ingen WMS-autentifikation.
 *
 * Flow:
 *   1. Modtag ejerlavKode + matrikelnr som query-parametre
 *   2. Hent primær matrikel: flat JSON (metadata) + ?format=geojson (polygon)
 *   3. Hent naboplotter: bbox-søgning med ?format=geojson (faktiske polygoner)
 *   4. Render PDF: hvid baggrund, naboer sort outline, primær rød outline, blå labels, skala
 *   5. Returner PDF som download
 *
 * @param request - Next.js request med ?ejerlavKode=xxx&matrikelnr=xxx
 * @returns PDF af matrikelkort (portrait A4)
 */

import { NextRequest, NextResponse } from 'next/server';
import PDFDocument from 'pdfkit';
import { logger } from '@/app/lib/logger';

// pdfkit bruger Node.js streams — tving Node.js runtime (ikke Edge)
export const runtime = 'nodejs';

// ─── Konstanter ────────────────────────────────────────────────────────────────

const DAWA_BASE = 'https://api.dataforsyningen.dk';

/** PDF-side i portrait A4 (pt) */
const PAGE_W = 595.28;
const PAGE_H = 841.89;

/** Header og footer højder (pt) */
const HEADER_H = 62;
const FOOTER_H = 32;

/** Kortområde — ekskl. header og footer */
const MAP_X = 0;
const MAP_Y = HEADER_H;
const MAP_W = PAGE_W;
const MAP_H = PAGE_H - HEADER_H - FOOTER_H;

/** Latitude-korrektionsfaktor ved ~56°N */
const LAT_COS = Math.cos((56 * Math.PI) / 180); // ≈ 0.559

/** Skala-bar placering — bunden af kortområdet */
const SCALE_X = 20;
const SCALE_Y = MAP_Y + MAP_H - 28;

// ─── Overpass-typer (OpenStreetMap bygninger + veje) ─────────────────────────

interface OverpassNode {
  lat: number;
  lon: number;
}

interface OverpassElement {
  type: 'way' | 'relation' | 'node';
  /** Geometri for way-elementer (kræver `out geom;`) */
  geometry?: OverpassNode[];
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/** En vejesektion med OSM highway-type og koordinater */
interface VejLinje {
  /** OSM highway-tag (fx "residential", "primary") */
  highway: string;
  /** Koordinater som [lon, lat][] */
  nodes: Array<[number, number]>;
}

// ─── DAWA-typer ─────────────────────────────────────────────────────────────────

interface DawaJordstykkeFlat {
  /** ejerlavkode er IKKE top-level — brug ejerlav.kode */
  ejerlav?: { navn: string; kode: number };
  matrikelnr: string;
  registreretareal?: number;
  kommune?: { navn: string; kode: number };
  visueltcenter?: [number, number];
  bbox?: [number, number, number, number];
}

interface DawaGeoJsonFeature {
  type: 'Feature';
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  properties: Record<string, unknown>;
}

// interface DawaGeoJsonCollection — removed (unused, kept for future reference)
// type: 'FeatureCollection'; features: DawaGeoJsonFeature[];

// ─── Intern repræsentation ─────────────────────────────────────────────────────

interface MatrikelInfo {
  ejerlavkode: number;
  matrikelnr: string;
  registreretareal?: number;
  ejerlav?: { navn: string; kode: number };
  kommune?: { navn: string; kode: number };
  visueltcenter?: [number, number];
  polygon?: number[][];
  bbox?: [number, number, number, number];
}

// ─── Hjælpefunktioner ──────────────────────────────────────────────────────────

/**
 * Beregner centroiden (geometrisk center) for en GeoJSON polygon-ring.
 * Bruges som label-placering når visueltcenter ikke er tilgængeligt.
 *
 * @param ring - Array af [lon, lat] koordinater
 * @returns [lon, lat] centroid
 */
function centroidFraRing(ring: number[][]): [number, number] {
  const n = ring.length;
  if (n === 0) return [0, 0];
  let sumX = 0,
    sumY = 0;
  for (const [x, y] of ring) {
    sumX += x;
    sumY += y;
  }
  return [sumX / n, sumY / n];
}

/**
 * Finder min/max fra en GeoJSON koordinatring.
 */
function minMaxFraRing(
  ring: number[][]
): { xMin: number; yMin: number; xMax: number; yMax: number } | null {
  if (!ring.length) return null;
  let xMin = Infinity,
    yMin = Infinity,
    xMax = -Infinity,
    yMax = -Infinity;
  for (const [x, y] of ring) {
    if (x < xMin) xMin = x;
    if (y < yMin) yMin = y;
    if (x > xMax) xMax = x;
    if (y > yMax) yMax = y;
  }
  return isFinite(xMin) ? { xMin, yMin, xMax, yMax } : null;
}

/**
 * Mapper geo-koordinater (lon/lat) til PDF-punkter inden for kortområdet.
 * Y-aksen inverteres (PDF: 0,0 øverst til venstre).
 */
function tilPdfPt(
  lon: number,
  lat: number,
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number }
): [number, number] {
  const normX = (lon - bounds.xMin) / (bounds.xMax - bounds.xMin);
  const normY = (lat - bounds.yMin) / (bounds.yMax - bounds.yMin);
  const px = MAP_X + normX * MAP_W;
  const py = MAP_Y + MAP_H - normY * MAP_H;
  return [px, py];
}

/**
 * Tegner en GeoJSON polygon-ring som pdfkit-sti.
 * Kalder closePath + fillAndStroke eller stroke alene.
 */
function tegnPolygonRing(
  doc: InstanceType<typeof PDFDocument>,
  ring: number[][],
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number },
  fill: string | null,
  stroke: string,
  lineWidth: number
): void {
  if (ring.length < 3) return;
  doc.lineWidth(lineWidth);
  const [sx, sy] = tilPdfPt(ring[0][0], ring[0][1], bounds);
  doc.moveTo(sx, sy);
  for (let i = 1; i < ring.length; i++) {
    const [px, py] = tilPdfPt(ring[i][0], ring[i][1], bounds);
    doc.lineTo(px, py);
  }
  doc.closePath();
  if (fill) {
    doc.fillAndStroke(fill, stroke);
  } else {
    doc.stroke(stroke);
  }
}

/**
 * Ray-casting punkt-i-polygon test.
 * Returnerer true hvis punktet (x, y) er inden i polygon-ringen.
 *
 * @param x - Longitude for testpunktet
 * @param y - Latitude for testpunktet
 * @param ring - Polygon-ring som [lon, lat][]
 * @returns true hvis punktet er inden i ringen
 */
function erPunktIPoly(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Henter bygningspolygoner fra OpenStreetMap via Overpass API for det givne
 * kortudsnit. Prøver tre offentlige Overpass-mirrors i rækkefølge — returnerer
 * resultatet fra det første der svarer. Returnerer tom liste hvis alle fejler.
 *
 * @param bounds - Kortudsnittets bounding box (lon/lat)
 * @returns Liste af polygon-ringe som [lon, lat][]
 */
async function hentBygninger(bounds: {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}): Promise<number[][][]> {
  // Overpass bbox-format: south,west,north,east
  const bbox = `${bounds.yMin.toFixed(7)},${bounds.xMin.toFixed(7)},${bounds.yMax.toFixed(7)},${bounds.xMax.toFixed(7)}`;
  const query = `[out:json][timeout:20];(way["building"](${bbox});relation["building"](${bbox}););out geom;`;
  const body = `data=${encodeURIComponent(query)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

  // Tre offentlige Overpass-mirrors — prøv i rækkefølge
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  /** Forsøger én Overpass-endpoint og returnerer bygningsringe ved succes. */
  const prøvEndpoint = async (url: string): Promise<number[][][] | null> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(22000),
      });
      if (!res.ok) {
        logger.error(`[matrikelkort] Overpass ${url} HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as OverpassResponse;
      const ringe = data.elements
        .filter(
          (el): el is OverpassElement & { geometry: OverpassNode[] } =>
            (el.type === 'way' || el.type === 'relation') &&
            Array.isArray(el.geometry) &&
            el.geometry.length >= 3
        )
        .map((el) => el.geometry.map(({ lon, lat }) => [lon, lat]));
      logger.log(`[matrikelkort] Overpass ${url} → ${ringe.length} bygninger`);
      return ringe;
    } catch (err) {
      logger.error(
        `[matrikelkort] Overpass ${url} fejl:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  };

  for (const url of endpoints) {
    const result = await prøvEndpoint(url);
    if (result !== null) return result;
  }

  logger.error('[matrikelkort] Alle Overpass-endpoints fejlede — ingen bygninger');
  return [];
}

/**
 * Henter vejlinjer fra OpenStreetMap via Overpass API for det givne kortudsnit.
 * Bruger de samme tre offentlige Overpass-mirrors som hentBygninger.
 * Returnerer tom liste hvis alle endpoints fejler.
 *
 * @param bounds - Kortudsnittets bounding box (lon/lat)
 * @returns Liste af vejlinjer med OSM highway-type og koordinater
 */
async function hentVeje(bounds: {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}): Promise<VejLinje[]> {
  const bbox = `${bounds.yMin.toFixed(7)},${bounds.xMin.toFixed(7)},${bounds.yMax.toFixed(7)},${bounds.xMax.toFixed(7)}`;
  // Hent alle kørsels- og stiveje — ekskluder meget lette spor (track) fra søgning
  const query = `[out:json][timeout:20];(way[highway](${bbox}););out geom;`;
  const body = `data=${encodeURIComponent(query)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  const prøvEndpoint = async (url: string): Promise<VejLinje[] | null> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(22000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as OverpassResponse;
      const veje = data.elements
        .filter(
          (el): el is OverpassElement & { geometry: OverpassNode[] } =>
            el.type === 'way' &&
            Array.isArray(el.geometry) &&
            el.geometry.length >= 2 &&
            !!el.tags?.highway
        )
        .map((el) => ({
          highway: el.tags!.highway!,
          nodes: el.geometry.map(({ lon, lat }) => [lon, lat] as [number, number]),
        }));
      logger.log(`[matrikelkort] Overpass veje ${url} → ${veje.length} vejsektioner`);
      return veje;
    } catch {
      return null;
    }
  };

  for (const url of endpoints) {
    const result = await prøvEndpoint(url);
    if (result !== null) return result;
  }

  logger.error('[matrikelkort] Alle Overpass-endpoints fejlede for veje');
  return [];
}

// vejBredde and tegnLinje removed — currently unused (OSM road rendering not yet implemented).
// Restore from git history when OSM road overlay is added to matrikelkort PDF.

/**
 * Beregner målestoksforholdet baseret på kortets geo-bredde og PDF-bredde.
 * Returnerer afrundet til nærmeste pæne tal (1:100, 1:200, 1:500 osv.)
 */
function beregnMaalestok(lonSpan: number, pdfWidthPt: number): number {
  const meterSpan = lonSpan * LAT_COS * 111320;
  const paperWidthM = pdfWidthPt * (0.0254 / 72); // pt → meter (1 pt = 1/72 tomme = 0,0254/72 m)
  const ratio = meterSpan / paperWidthM;
  // Afrund til nærmeste pæne tal
  const pæne = [25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 5000];
  return pæne.reduce((prev, curr) =>
    Math.abs(curr - ratio) < Math.abs(prev - ratio) ? curr : prev
  );
}

/**
 * Tegner en sort/hvid skalabar og målestokstekst i Resights-stil.
 */
function tegnSkalabar(
  doc: InstanceType<typeof PDFDocument>,
  lonSpan: number,
  maalestok: number
): void {
  // Beregn pixels pr. meter ved den aktuelle målestok
  const meterSpan = lonSpan * LAT_COS * 111320;
  const ptPerMeter = MAP_W / meterSpan;

  // Vælg en passende skalastep (6 m, 10 m, 50 m osv.)
  const steps = [1, 2, 5, 6, 10, 20, 25, 50, 100, 200, 500, 1000];
  const targetBarPt = 80; // ønsket bar-bredde i pt
  const stepM = steps.reduce((prev, curr) =>
    Math.abs(curr * ptPerMeter - targetBarPt) < Math.abs(prev * ptPerMeter - targetBarPt)
      ? curr
      : prev
  );
  const barPt = stepM * ptPerMeter;
  const segPt = barPt / 2;

  doc.save();
  // Sort/hvid skaktern (2 segmenter)
  doc.rect(SCALE_X, SCALE_Y, segPt, 5).fill('#000000');
  doc
    .rect(SCALE_X + segPt, SCALE_Y, segPt, 5)
    .fill('#ffffff')
    .rect(SCALE_X + segPt, SCALE_Y, segPt, 5)
    .stroke('#000000');
  // Ramme rundt om hele baren
  doc.rect(SCALE_X, SCALE_Y, barPt, 5).lineWidth(0.5).stroke('#000000');
  // Labels
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .fillColor('#000000')
    .text('0 m', SCALE_X - 3, SCALE_Y + 7, { lineBreak: false })
    .text(`${stepM} m`, SCALE_X + segPt - 6, SCALE_Y + 7, { lineBreak: false })
    .text(`${stepM * 2} m`, SCALE_X + barPt - 8, SCALE_Y + 7, { lineBreak: false });
  // Målestoksforhold
  doc
    .fontSize(6.5)
    .fillColor('#000000')
    .text(`Målestoksforhold 1:${maalestok}`, SCALE_X, SCALE_Y + 17, { lineBreak: false });
  doc.restore();
}

// ─── PDF-generator ──────────────────────────────────────────────────────────────

/**
 * Genererer PDF-matrikelkort i BizzAssist/Resights-stil og returnerer en Buffer.
 *
 * @param hoved - Primær matrikel (rød outline)
 * @param naboer - Naboplotter (tynd mørk outline, blå label)
 * @param bygninger - Bygningspolygoner fra OSM (lysegrå/beige fyld)
 * @param veje - Vejlinjer fra OSM (sorte linjer, bredde efter vejtype)
 * @param bounds - Kortudsnittets bounding box
 * @returns Promise<Buffer>
 */
async function genererPdf(
  hoved: MatrikelInfo,
  naboer: MatrikelInfo[],
  bygninger: number[][][],
  veje: VejLinje[],
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margin: 0,
      info: {
        Title: `Matrikelkort — ${hoved.matrikelnr}`,
        Author: 'BizzAssist · Kilde: DAWA (Dataforsyningen)',
        CreationDate: new Date(),
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Hvid kortbaggrund (hele siden) ────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, PAGE_H).fill('#ffffff');

    // ═══════════════════════════════════════════════════════════════════════════
    // KORTOMRÅDE — alt kortindhold klippes til MAP-rektanglet så det aldrig
    // overlapper header eller footer.
    // ═══════════════════════════════════════════════════════════════════════════
    doc.save();
    doc.rect(MAP_X, MAP_Y, MAP_W, MAP_H).clip();

    // ── Naboplotter: hvid fyld + tynd sort outline ─────────────────────────────
    for (const n of naboer) {
      if (n.polygon && n.polygon.length >= 3) {
        tegnPolygonRing(doc, n.polygon, bounds, '#ffffff', '#000000', 0.4);
      } else if (n.bbox) {
        // Fallback: tegn bbox-rektangel med tynd grå streg
        const [x1, y1] = tilPdfPt(n.bbox[0], n.bbox[1], bounds);
        const [x2, y2] = tilPdfPt(n.bbox[2], n.bbox[3], bounds);
        doc
          .rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
          .lineWidth(0.3)
          .stroke('#888888');
      }
    }

    // ── Primær matrikel: hvid fyld (outline tegnes efter bygninger) ────────────
    if (hoved.polygon && hoved.polygon.length >= 3) {
      tegnPolygonRing(doc, hoved.polygon, bounds, '#ffffff', '#ffffff', 0);
    }

    // ── Bygninger fra OSM: lysegrå fyld + mørkegrå outline ────────────────────
    // Tegnes oven på de hvide parcel-fyld så bygningerne er synlige.
    for (const ring of bygninger) {
      if (ring.length >= 3) {
        tegnPolygonRing(doc, ring, bounds, '#c8c8c8', '#999999', 0.4);
      }
    }

    // ── Primær matrikel: rød outline oven på bygninger ────────────────────────
    if (hoved.polygon && hoved.polygon.length >= 3) {
      tegnPolygonRing(doc, hoved.polygon, bounds, null, '#cc0000', 1.5);
    }

    // ── Nabo-labels: blå kursiv ────────────────────────────────────────────────
    doc.font('Helvetica-Oblique').fontSize(7).fillColor('#0066cc');
    for (const n of naboer) {
      if (n.visueltcenter) {
        const [px, py] = tilPdfPt(n.visueltcenter[0], n.visueltcenter[1], bounds);
        if (px > 4 && px < PAGE_W - 4 && py > MAP_Y + 4 && py < MAP_Y + MAP_H - 4) {
          doc.text(n.matrikelnr, px - 12, py - 4, { lineBreak: false, width: 36 });
        }
      }
    }

    // ── Primær matrikel label: blå kursiv, lidt større ────────────────────────
    if (hoved.visueltcenter) {
      const [cx, cy] = tilPdfPt(hoved.visueltcenter[0], hoved.visueltcenter[1], bounds);
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor('#0066cc')
        .text(hoved.matrikelnr, cx - 20, cy - 5, { lineBreak: false, width: 60 });
    }

    // ── Skalabar ───────────────────────────────────────────────────────────────
    const maalestok = beregnMaalestok(bounds.xMax - bounds.xMin, MAP_W);
    tegnSkalabar(doc, bounds.xMax - bounds.xMin, maalestok);

    // Fjern klip-maske — alt herefter tegnes over kortindholdet
    doc.restore();

    // ═══════════════════════════════════════════════════════════════════════════
    // HEADER — tegnes EFTER kortindholdet så den altid er synlig øverst
    // ═══════════════════════════════════════════════════════════════════════════
    doc.rect(0, 0, PAGE_W, HEADER_H).fill('#0f172a');

    // Logo-boks: afrundet blå firkant med "B"
    const LOGO_SZ = 30;
    const LOGO_X = 16;
    const LOGO_Y = (HEADER_H - LOGO_SZ) / 2;
    doc.roundedRect(LOGO_X, LOGO_Y, LOGO_SZ, LOGO_SZ, 5).fill('#2563eb');
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor('#ffffff')
      .text('B', LOGO_X, LOGO_Y + 8, { width: LOGO_SZ, align: 'center', lineBreak: false });

    // "BizzAssist" brand-tekst
    const BRAND_X = LOGO_X + LOGO_SZ + 9;
    const BRAND_Y = LOGO_Y + 2;
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#ffffff')
      .text('Bizz', BRAND_X, BRAND_Y, { lineBreak: false, continued: true })
      .fillColor('#60a5fa')
      .text('Assist', { lineBreak: false });
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#94a3b8')
      .text('MATRIKELKORT', BRAND_X, BRAND_Y + 18, { lineBreak: false });

    // Lodret separator
    const SEP_X = PAGE_W / 2;
    doc
      .moveTo(SEP_X, 10)
      .lineTo(SEP_X, HEADER_H - 10)
      .lineWidth(0.5)
      .stroke('#334155');

    // Højre side: parcel-information
    const INFO_X = SEP_X + 14;
    const INFO_Y = 9;
    const INFO_W = PAGE_W - INFO_X - 12;
    const ejerlavNavn = hoved.ejerlav?.navn ?? `Ejerlav ${hoved.ejerlavkode}`;
    const arealTekst = hoved.registreretareal
      ? `${hoved.registreretareal.toLocaleString('da-DK')} m²`
      : '';
    const kommuneNavn = hoved.kommune?.navn ?? '';
    const metaLinje = [arealTekst, kommuneNavn].filter(Boolean).join('  ·  ');

    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor('#f1f5f9')
      .text(hoved.matrikelnr, INFO_X, INFO_Y, { lineBreak: false, width: INFO_W });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#94a3b8')
      .text(ejerlavNavn, INFO_X, INFO_Y + 17, { lineBreak: false, width: INFO_W });
    if (metaLinje) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#cbd5e1')
        .text(metaLinje, INFO_X, INFO_Y + 30, { lineBreak: false, width: INFO_W });
    }

    // Tynd streg i bunden af headeren
    doc.moveTo(0, HEADER_H).lineTo(PAGE_W, HEADER_H).lineWidth(0.5).stroke('#1e3a5f');

    // ═══════════════════════════════════════════════════════════════════════════
    // FOOTER — tegnes EFTER kortindholdet så den altid er synlig nederst
    // ═══════════════════════════════════════════════════════════════════════════
    const FOOT_Y = PAGE_H - FOOTER_H;
    doc.rect(0, FOOT_Y, PAGE_W, FOOTER_H).fill('#0f172a');

    doc.moveTo(0, FOOT_Y).lineTo(PAGE_W, FOOT_Y).lineWidth(0.5).stroke('#1e3a5f');

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#64748b')
      .text(
        'Kilde: Dataforsyningen (DAWA)  ·  Data er vejledende og uden juridisk gyldighed',
        12,
        FOOT_Y + 12,
        { lineBreak: false }
      );

    const dato = new Date().toLocaleDateString('da-DK', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#64748b')
      .text(`Genereret: ${dato}`, 0, FOOT_Y + 12, {
        lineBreak: false,
        width: PAGE_W - 12,
        align: 'right',
      });

    doc.end();
  });
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const { searchParams } = request.nextUrl;
  const ejerlavKodeStr = searchParams.get('ejerlavKode');
  const matrikelnr = searchParams.get('matrikelnr');

  if (!ejerlavKodeStr || !matrikelnr) {
    return NextResponse.json({ fejl: 'Mangler ejerlavKode eller matrikelnr' }, { status: 400 });
  }

  const ejerlavKode = parseInt(ejerlavKodeStr, 10);
  if (isNaN(ejerlavKode)) {
    return NextResponse.json({ fejl: 'Ugyldigt ejerlavKode' }, { status: 400 });
  }

  try {
    const path = `${ejerlavKode}/${encodeURIComponent(matrikelnr)}`;

    // Trin 1: Hent primær matrikel — flat JSON for metadata
    const [flatRes, geoRes] = await Promise.all([
      fetch(`${DAWA_BASE}/jordstykker/${path}`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${DAWA_BASE}/jordstykker/${path}?format=geojson`, {
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    if (!flatRes.ok) {
      return NextResponse.json(
        {
          fejl: `DAWA HTTP ${flatRes.status} for jordstykke ${matrikelnr} (ejerlav ${ejerlavKode})`,
        },
        { status: 502 }
      );
    }

    const flat = (await flatRes.json()) as DawaJordstykkeFlat;
    let polygon: number[][] | undefined;
    if (geoRes.ok) {
      const geo = (await geoRes.json()) as DawaGeoJsonFeature;
      polygon = geo.geometry?.coordinates?.[0];
    }

    const hoved: MatrikelInfo = {
      ejerlavkode: flat.ejerlav?.kode ?? ejerlavKode,
      matrikelnr: flat.matrikelnr ?? matrikelnr,
      registreretareal: flat.registreretareal,
      ejerlav: flat.ejerlav,
      kommune: flat.kommune,
      visueltcenter: flat.visueltcenter,
      polygon,
      bbox: flat.bbox,
    };

    if (!polygon && !flat.bbox) {
      return NextResponse.json(
        { fejl: `Ingen geometri for matrikel ${matrikelnr} (ejerlav ${ejerlavKode})` },
        { status: 404 }
      );
    }

    // Trin 2: Beregn primær matrikels bbox
    const primærBounds = flat.bbox
      ? { xMin: flat.bbox[0], yMin: flat.bbox[1], xMax: flat.bbox[2], yMax: flat.bbox[3] }
      : (minMaxFraRing(polygon!) ?? { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });

    let naboer: MatrikelInfo[] = [];
    try {
      // Trin 3a: Hent flat liste over naboplotter via cirkel-søgning.
      // NB: DAWA /jordstykker?bbox=... ignorerer bbox og returnerer alfabetisk — brug cirkel i stedet.
      const cirkelCx = hoved.visueltcenter?.[0] ?? (primærBounds.xMin + primærBounds.xMax) / 2;
      const cirkelCy = hoved.visueltcenter?.[1] ?? (primærBounds.yMin + primærBounds.yMax) / 2;
      const naboListRes = await fetch(
        `${DAWA_BASE}/jordstykker?cirkel=${cirkelCx.toFixed(7)},${cirkelCy.toFixed(7)},200&per_side=40`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (naboListRes.ok) {
        const flatListe = (await naboListRes.json()) as DawaJordstykkeFlat[];
        if (Array.isArray(flatListe)) {
          // Beregn primærparcellets centrum til distance-sortering
          const primCx = (primærBounds.xMin + primærBounds.xMax) / 2;
          const primCy = (primærBounds.yMin + primærBounds.yMax) / 2;

          const kandidater = flatListe
            .filter((n) => !(n.ejerlav?.kode === ejerlavKode && n.matrikelnr === matrikelnr))
            .map((n) => {
              // Brug visueltcenter eller bbox-center til afstandsberegning
              const cx = n.visueltcenter?.[0] ?? ((n.bbox?.[0] ?? 0) + (n.bbox?.[2] ?? 0)) / 2;
              const cy = n.visueltcenter?.[1] ?? ((n.bbox?.[1] ?? 0) + (n.bbox?.[3] ?? 0)) / 2;
              // Korriger for latitude-stræk i afstandsberegning
              const dx = (cx - primCx) * LAT_COS * 111320;
              const dy = (cy - primCy) * 111320;
              return { n, dist: Math.hypot(dx, dy) };
            })
            // Behold kun naboplotter inden for 200 m af centrum
            .filter(({ dist }) => dist < 200)
            .sort((a, b) => a.dist - b.dist)
            .map(({ n }) => n);

          // Trin 3b: Parallel-fetch GeoJSON-polygon for op til 15 nærmeste naboer
          const MAX_NABOER = 15;
          const udvalgte = kandidater.slice(0, MAX_NABOER);
          const geoResults = await Promise.allSettled(
            udvalgte.map((n) => {
              const eKode = n.ejerlav?.kode;
              if (!eKode) return Promise.resolve(null);
              return fetch(
                `${DAWA_BASE}/jordstykker/${eKode}/${encodeURIComponent(n.matrikelnr)}?format=geojson`,
                { signal: AbortSignal.timeout(5000) }
              ).then((r) => (r.ok ? (r.json() as Promise<DawaGeoJsonFeature>) : null));
            })
          );
          naboer = udvalgte
            .map((n, i) => {
              const result = geoResults[i];
              const geo =
                result.status === 'fulfilled' && result.value
                  ? (result.value as DawaGeoJsonFeature)
                  : null;
              const ring = geo?.geometry?.coordinates?.[0];
              return {
                ejerlavkode: n.ejerlav?.kode ?? 0,
                matrikelnr: n.matrikelnr,
                visueltcenter: n.visueltcenter ?? (ring ? centroidFraRing(ring) : undefined),
                polygon: ring,
                bbox: n.bbox,
              } as MatrikelInfo;
            })
            .filter((n) => !!n.polygon || !!n.bbox); // tegn bbox-fallback hvis ingen polygon
        }
      }
    } catch {
      // Naboer er optional
    }

    // Trin 4: Beregn visnings-bounds — parcel + kontekst til at vise naboer.
    // Min. 80 m margin (i grader) for at naboplotterne er synlige.
    const minMarginLon = 80 / (LAT_COS * 111320); // ≈ 0.00129°
    const minMarginLat = 80 / 111320; // ≈ 0.000719°
    const visMX = Math.max((primærBounds.xMax - primærBounds.xMin) * 0.8, minMarginLon);
    const visMY = Math.max((primærBounds.yMax - primærBounds.yMin) * 0.8, minMarginLat);
    const bounds = {
      xMin: primærBounds.xMin - visMX,
      yMin: primærBounds.yMin - visMY,
      xMax: primærBounds.xMax + visMX,
      yMax: primærBounds.yMax + visMY,
    };

    // Tilpas til portrait A4 med latitude-korrektion
    const targetRatio = MAP_W / MAP_H; // A4 portrait: ~0.707
    const lonSpan = bounds.xMax - bounds.xMin;
    const latSpan = bounds.yMax - bounds.yMin;
    const effW = lonSpan * LAT_COS;
    const effH = latSpan;
    const actualRatio = effW / (effH || 0.001);

    if (actualRatio < targetRatio) {
      const newLonSpan = (latSpan * targetRatio) / LAT_COS;
      const cx = (bounds.xMin + bounds.xMax) / 2;
      bounds.xMin = cx - newLonSpan / 2;
      bounds.xMax = cx + newLonSpan / 2;
    } else {
      const newLatSpan = (lonSpan * LAT_COS) / targetRatio;
      const cy = (bounds.yMin + bounds.yMax) / 2;
      bounds.yMin = cy - newLatSpan / 2;
      bounds.yMax = cy + newLatSpan / 2;
    }

    // Trin 5: Hent bygninger og veje fra OSM Overpass parallelt (optional — fejler stiltiende).
    // Bygninger filtreres så kun dem der har centroid inden i en af parcel-
    // polygonerne (eller bbox for parceller uden polygon) vises på kortet.
    let bygninger: number[][][] = [];
    let veje: VejLinje[] = [];
    try {
      const [alleBygninger, alleVeje] = await Promise.all([
        hentBygninger(bounds),
        hentVeje(bounds),
      ]);
      veje = alleVeje;

      // Byg opslagsstruktur: polygon + bbox for primær parcel og alle naboer.
      type ParcelEntry = {
        poly: number[][] | null;
        bbox: { xMin: number; yMin: number; xMax: number; yMax: number } | null;
      };
      const parcelEntries: ParcelEntry[] = [];

      /** Tilføjer én parcel til filterlisten. */
      const tilføjEntry = (
        poly: number[][] | undefined,
        rawBbox: [number, number, number, number] | undefined
      ) => {
        const p: ParcelEntry = { poly: null, bbox: null };
        if (poly && poly.length >= 3) {
          p.poly = poly;
          p.bbox = minMaxFraRing(poly);
        } else if (rawBbox) {
          p.bbox = { xMin: rawBbox[0], yMin: rawBbox[1], xMax: rawBbox[2], yMax: rawBbox[3] };
        }
        if (p.poly || p.bbox) parcelEntries.push(p);
      };

      tilføjEntry(hoved.polygon, hoved.bbox);
      for (const n of naboer) tilføjEntry(n.polygon, n.bbox);

      // Behold kun bygninger hvis centroid ligger inden i én af parcelgrænse
      // (præcis polygon-test) eller inden i parcellets bbox (fallback).
      bygninger = alleBygninger.filter((ring) => {
        if (ring.length === 0) return false;
        const cx = ring.reduce((s, pt) => s + pt[0], 0) / ring.length;
        const cy = ring.reduce((s, pt) => s + pt[1], 0) / ring.length;
        return parcelEntries.some((entry) => {
          if (entry.poly) return erPunktIPoly(cx, cy, entry.poly);
          if (entry.bbox) {
            return (
              cx >= entry.bbox.xMin &&
              cx <= entry.bbox.xMax &&
              cy >= entry.bbox.yMin &&
              cy <= entry.bbox.yMax
            );
          }
          return false;
        });
      });

      logger.log(
        `[matrikelkort] ${bygninger.length} af ${alleBygninger.length} bygninger inden i parcelgrænser`
      );
    } catch (bygErr) {
      // Bygninger er optional dekoration — fortsæt uden
      logger.error(
        '[matrikelkort] hentBygninger fejl:',
        bygErr instanceof Error ? bygErr.message : bygErr
      );
    }

    // Trin 6: Generer PDF
    const pdfBuffer = await genererPdf(hoved, naboer, bygninger, veje, bounds);

    // Trin 6: Returner som download
    const safeNr = matrikelnr.replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_');
    const filename = `matrikelkort_${ejerlavKode}_${safeNr}.pdf`;

    return new Response(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json({ fejl: `Matrikelkort-fejl: ${msg}` }, { status: 500 });
  }
}
