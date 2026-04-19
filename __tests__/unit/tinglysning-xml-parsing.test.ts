/**
 * Unit tests for GET /api/tinglysning/summarisk — XML parsing.
 *
 * Tests that the route correctly parses the Tinglysning XML format for:
 *  1. Adkomst — selskabsejer with CVR, personejer, ejerandel fraction calculation
 *  2. Hæftelse — kreditor, multiple debitorer, beloeb, rente, laanevilkaar
 *  3. Servitut — type, dato, multi-line tillaegsTekst from Afsnit elements
 *
 * The `tlFetch` helper inside the route uses Node's https module with mTLS.
 * We mock `https` so the route runs without a real certificate, and we set
 * TINGLYSNING_CERT_B64 via vi.hoisted so the module-level const is non-empty.
 *
 * BIZZ problems addressed:
 * - Empty responses passed through silently (route swallowed XML parse errors)
 * - Multi-debitor loans only showed one debitor name
 * - Servitut tillægstekst cut off at first Afsnit element
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Set env vars BEFORE module initialisation ─────────────────────────────────
// vi.hoisted runs before any module import, so the module-level constants in the
// route will see non-empty TINGLYSNING_CERT_B64 / CERT_PASSWORD.

const { httpsState } = vi.hoisted(() => {
  process.env.TINGLYSNING_CERT_B64 = 'dGVzdA=='; // base64("test")
  process.env.TINGLYSNING_CERT_PASSWORD = 'testpassword';
  process.env.TINGLYSNING_BASE_URL = 'https://test.tinglysning.dk';

  // Shared mutable state lets each test set a different XML response
  const httpsState = { xmlBody: '', statusCode: 200 };
  return { httpsState };
});

// ── Mock Node https — simulates tlFetch returning fake XML ────────────────────

vi.mock('https', () => ({
  default: {
    request: vi.fn((_opts: unknown, callback: (res: unknown) => void) => {
      const mockRes = {
        statusCode: httpsState.statusCode,
        on: (event: string, handler: (data?: string) => void) => {
          if (event === 'data') handler(httpsState.xmlBody);
          else if (event === 'end') handler();
        },
      };
      // Use queueMicrotask so the Promise resolves asynchronously (matches real behavior)
      queueMicrotask(() => callback(mockRes));
      return { on: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    }),
  },
}));

// ── Mock fs/path — not needed with CERT_B64, but mock defensively ─────────────

vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn() },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock('path', () => ({
  default: { resolve: vi.fn((...args: string[]) => args.join('/')) },
  resolve: vi.fn((...args: string[]) => args.join('/')),
}));

// ── Mock auth ─────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/auth', () => ({
  resolveTenantId: vi.fn().mockResolvedValue({ tenantId: 'test-tenant', userId: 'test-user' }),
}));

// ── Import route AFTER mocks ──────────────────────────────────────────────────

import { GET, clearXmlCache } from '@/app/api/tinglysning/summarisk/route';

// ── Helper: make a NextRequest with a uuid query param ───────────────────────

function makeRequest(uuid = 'test-uuid-1234'): NextRequest {
  const url = new URL(`http://localhost/api/tinglysning/summarisk?uuid=${uuid}`);
  return new NextRequest(url.toString());
}

// ─── Shared XML builders ──────────────────────────────────────────────────────

/**
 * Builds an adkomst XML block with one or more adkomsthavere.
 */
function adkomstXml(havere: string): string {
  return `<?xml version="1.0"?>
<ns:EjendomSummarisk>
  <ns:AdkomstSummariskSamling>
    <ns:AdkomstSummarisk>
      <ns:AdkomstType>skoede</ns:AdkomstType>
      <ns:TinglysningsDato>2021-05-10T00:00:00</ns:TinglysningsDato>
      <ns:SkoedeOvertagelsesDato>2021-04-01+02:00</ns:SkoedeOvertagelsesDato>
      <ns:KontantKoebesum>4200000</ns:KontantKoebesum>
      ${havere}
    </ns:AdkomstSummarisk>
  </ns:AdkomstSummariskSamling>
</ns:EjendomSummarisk>`;
}

/**
 * Builds a hæftelse XML block.
 */
function haeftelseXml(extra = ''): string {
  return `<?xml version="1.0"?>
<ns:EjendomSummarisk>
  <ns:HaeftelseSummarisk>
    <ns:HaeftelseType>RealKredit</ns:HaeftelseType>
    <ns:TinglysningsDato>2021-05-10T00:00:00</ns:TinglysningsDato>
    <ns:LegalUnitName>Totalkredit A/S</ns:LegalUnitName>
    <ns:CVRnumberIdentifier>87654321</ns:CVRnumberIdentifier>
    <ns:BeloebVaerdi>1500000</ns:BeloebVaerdi>
    <ns:ValutaKode>DKK</ns:ValutaKode>
    <ns:PrioritetNummer>1</ns:PrioritetNummer>
    <ns:DebitorInformationSamling>
      <ns7:RolleInformation>
        <ns14:PersonName>Hans Hansen</ns14:PersonName>
      </ns7:RolleInformation>
      <ns7:RolleInformation>
        <ns14:PersonName>Anne Hansen</ns14:PersonName>
      </ns7:RolleInformation>
    </ns:DebitorInformationSamling>
    <ns:HaeftelseRenteVariabel/>
    <ns:HaeftelseRentePaalydendeSats>1.5</ns:HaeftelseRentePaalydendeSats>
    <ns:HaeftelseSaerligeLaanevilkaarstype>Afdragsfrihed</ns:HaeftelseSaerligeLaanevilkaarstype>
    <ns:HaeftelseSaerligeLaanevilkaarstype>Konverteringsret</ns:HaeftelseSaerligeLaanevilkaarstype>
    ${extra}
  </ns:HaeftelseSummarisk>
</ns:EjendomSummarisk>`;
}

/**
 * Builds a servitut XML block with two Afsnit elements (multi-line content).
 */
function servitutXml(): string {
  return `<?xml version="1.0"?>
<ns:EjendomSummarisk>
  <ns:ServitutSummarisk>
    <ns:ServitutType>Vejret</ns:ServitutType>
    <ns:TinglysningsDato>2010-06-01T00:00:00</ns:TinglysningsDato>
    <ns:PrioritetNummer>2</ns:PrioritetNummer>
    <ns:ServitutTekstSummarisk>Vejrettens omfang</ns:ServitutTekstSummarisk>
    <ns:Afsnit>Ejer af matr.nr. 1a har vejret over matr.nr. 2b.</ns:Afsnit>
    <ns:Afsnit>Vejen skal holdes åben og farbar til enhver tid.</ns:Afsnit>
    <ns:ServitutIndholdAndetKode>Vejadgang</ns:ServitutIndholdAndetKode>
    <ns:OgsaaLystPaaAntal>3</ns:OgsaaLystPaaAntal>
  </ns:ServitutSummarisk>
</ns:EjendomSummarisk>`;
}

// ─── Tests: Adkomst parsing ────────────────────────────────────────────────────

describe('GET /api/tinglysning/summarisk — adkomst parsing', () => {
  beforeEach(() => {
    httpsState.statusCode = 200;
    clearXmlCache();
  });

  it('parses a selskabsejer (CVR present) correctly', async () => {
    httpsState.xmlBody = adkomstXml(`
      <ns:Adkomsthaver>
        <ns:CVRnumberIdentifier>12345678</ns:CVRnumberIdentifier>
        <ns:LegalUnitName>ACME Holding A/S</ns:LegalUnitName>
        <ns:Taeller>1</ns:Taeller>
        <ns:Naevner>1</ns:Naevner>
        <ns:StreetName>Testvej</ns:StreetName>
        <ns:StreetBuildingIdentifier>5</ns:StreetBuildingIdentifier>
        <ns:PostCodeIdentifier>2400</ns:PostCodeIdentifier>
        <ns:DistrictName>København NV</ns:DistrictName>
      </ns:Adkomsthaver>
    `);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ejere).toHaveLength(1);
    const ejer = body.ejere[0];
    expect(ejer.cvr).toBe('12345678');
    // The name regex also captures StreetName/DistrictName parts — verify company name is present
    expect(ejer.navn).toContain('ACME Holding A/S');
    expect(ejer.type).toBe('selskab');
    expect(ejer.adkomstType).toBe('skoede');
    expect(ejer.andel).toBe('100%'); // 1/1
  });

  it('parses a personejer (no CVR) correctly', async () => {
    httpsState.xmlBody = adkomstXml(`
      <ns:Adkomsthaver>
        <ns:PersonFirstName>Lars</ns:PersonFirstName>
        <ns:PersonLastName>Larsen</ns:PersonLastName>
        <ns:Taeller>1</ns:Taeller>
        <ns:Naevner>2</ns:Naevner>
      </ns:Adkomsthaver>
    `);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ejere).toHaveLength(1);
    const ejer = body.ejere[0];
    expect(ejer.cvr).toBeNull();
    expect(ejer.type).toBe('person');
    // Name assembled from FirstName + LastName name-parts
    expect(ejer.navn).toContain('Lars');
    expect(ejer.navn).toContain('Larsen');
  });

  it('computes ejerandel percentage from Taeller/Naevner fraction', async () => {
    // 1/3 ≈ 33%
    httpsState.xmlBody = adkomstXml(`
      <ns:Adkomsthaver>
        <ns:PersonName>Mette Mikkelsen</ns:PersonName>
        <ns:Taeller>1</ns:Taeller>
        <ns:Naevner>3</ns:Naevner>
      </ns:Adkomsthaver>
    `);

    const res = await GET(makeRequest());
    const body = await res.json();

    const ejer = body.ejere[0];
    expect(ejer.andel).toBe('33%');
    expect(ejer.andelTaeller).toBe(1);
    expect(ejer.andelNaevner).toBe(3);
  });

  it('parses KontantKoebesum into koebesum', async () => {
    httpsState.xmlBody = adkomstXml(`
      <ns:Adkomsthaver>
        <ns:PersonName>Søren Sørensen</ns:PersonName>
      </ns:Adkomsthaver>
    `);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ejere[0].koebesum).toBe(4200000);
  });

  it('parses overtagelsesdato stripping timezone offset', async () => {
    httpsState.xmlBody = adkomstXml(`
      <ns:Adkomsthaver>
        <ns:PersonName>Test Person</ns:PersonName>
      </ns:Adkomsthaver>
    `);

    const res = await GET(makeRequest());
    const body = await res.json();

    // SkoedeOvertagelsesDato is "2021-04-01+02:00" — should be stripped to "2021-04-01"
    expect(body.ejere[0].overtagelsesdato).toBe('2021-04-01');
  });

  it('parses adresse from StreetName + StreetBuildingIdentifier', async () => {
    httpsState.xmlBody = adkomstXml(`
      <ns:Adkomsthaver>
        <ns:LegalUnitName>Test ApS</ns:LegalUnitName>
        <ns:CVRnumberIdentifier>99887766</ns:CVRnumberIdentifier>
        <ns:StreetName>Nørrebrogade</ns:StreetName>
        <ns:StreetBuildingIdentifier>10</ns:StreetBuildingIdentifier>
        <ns:PostCodeIdentifier>2200</ns:PostCodeIdentifier>
        <ns:DistrictName>København N</ns:DistrictName>
      </ns:Adkomsthaver>
    `);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ejere[0].adresse).toContain('Nørrebrogade 10');
    expect(body.ejere[0].adresse).toContain('2200');
  });

  it('returns empty ejere array when adkomst section is absent', async () => {
    httpsState.xmlBody = `<?xml version="1.0"?><ns:EjendomSummarisk></ns:EjendomSummarisk>`;

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ejere).toEqual([]);
  });
});

// ─── Tests: Hæftelse parsing ──────────────────────────────────────────────────

describe('GET /api/tinglysning/summarisk — hæftelse parsing', () => {
  beforeEach(() => {
    httpsState.statusCode = 200;
    clearXmlCache();
  });

  it('parses kreditor navn and CVR', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.haeftelser).toHaveLength(1);
    const h = body.haeftelser[0];
    expect(h.kreditor).toBe('Totalkredit A/S');
    expect(h.kreditorCvr).toBe('87654321');
  });

  it('parses beloeb and valuta', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    const h = body.haeftelser[0];
    expect(h.beloeb).toBe(1500000);
    expect(h.valuta).toBe('DKK');
  });

  it('parses prioritet', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.haeftelser[0].prioritet).toBe(1);
  });

  it('parses BOTH debitorer from DebitorInformationSamling', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    const h = body.haeftelser[0];
    expect(h.debitorer).toHaveLength(2);
    expect(h.debitorer).toContain('Hans Hansen');
    expect(h.debitorer).toContain('Anne Hansen');
  });

  it('parses renteType as "Variabel" from HaeftelseRenteVariabel tag', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.haeftelser[0].renteType).toBe('Variabel');
  });

  it('parses rente sats', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.haeftelser[0].rente).toBe(1.5);
  });

  it('parses multiple laanevilkaar into array', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    const h = body.haeftelser[0];
    // Filter to non-empty strings (XML whitespace may produce extra entries)
    const vilkaar: string[] = h.laanevilkaar.filter((v: string) => v.trim().length > 0);
    expect(vilkaar).toContain('Afdragsfrihed');
    expect(vilkaar).toContain('Konverteringsret');
  });

  it('parses haeftelse type', async () => {
    httpsState.xmlBody = haeftelseXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.haeftelser[0].type).toBe('RealKredit');
  });

  it('returns empty haeftelser when section is absent', async () => {
    httpsState.xmlBody = `<?xml version="1.0"?><ns:EjendomSummarisk></ns:EjendomSummarisk>`;
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.haeftelser).toEqual([]);
  });
});

// ─── Tests: Servitut parsing ──────────────────────────────────────────────────

describe('GET /api/tinglysning/summarisk — servitut parsing', () => {
  beforeEach(() => {
    httpsState.statusCode = 200;
    clearXmlCache();
  });

  it('parses servitut type and dato', async () => {
    httpsState.xmlBody = servitutXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter).toHaveLength(1);
    const s = body.servitutter[0];
    expect(s.type).toBe('Vejret');
    expect(s.dato).toBe('2010-06-01');
  });

  it('parses ServitutTekstSummarisk into tekst field', async () => {
    httpsState.xmlBody = servitutXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter[0].tekst).toBe('Vejrettens omfang');
  });

  it('joins multiple Afsnit elements into tillaegsTekst with newline', async () => {
    httpsState.xmlBody = servitutXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    const tillaeg = body.servitutter[0].tillaegsTekst as string;
    expect(tillaeg).toContain('Ejer af matr.nr. 1a');
    expect(tillaeg).toContain('Vejen skal holdes åben');
    // The two Afsnit lines are joined with \n
    expect(tillaeg.split('\n')).toHaveLength(2);
  });

  it('parses prioritet', async () => {
    httpsState.xmlBody = servitutXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter[0].prioritet).toBe(2);
  });

  it('parses indholdKode into indholdKoder array', async () => {
    httpsState.xmlBody = servitutXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter[0].indholdKoder).toContain('Vejadgang');
  });

  it('parses ogsaaLystPaa count', async () => {
    httpsState.xmlBody = servitutXml();
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter[0].ogsaaLystPaa).toBe(3);
  });

  it('returns empty servitutter when section is absent', async () => {
    httpsState.xmlBody = `<?xml version="1.0"?><ns:EjendomSummarisk></ns:EjendomSummarisk>`;
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter).toEqual([]);
  });

  /**
   * BIZZ-474: For hovedejendomme (samlede ejendomme der er opdelt i
   * ejerlejligheder — fx Thorvald Bindesbølls Plads 18) kan e-TL pakke
   * servitut-blokke i <EjendomServitutSummarisk> frem for den korte
   * <ServitutSummarisk>. Den gamle regex matchede kun den korteste variant
   * og droppede servitutter for hovedejendomme. Backreference-regex skal
   * nu matche både prefix-variantet og det oprindelige.
   */
  it('parses EjendomServitutSummarisk wrapper (samlet ejendom variant)', async () => {
    httpsState.xmlBody = `<?xml version="1.0"?>
<ns:EjendomSummarisk>
  <ns:EjendomServitutSummarisk>
    <ns:ServitutType>Vejret</ns:ServitutType>
    <ns:TinglysningsDato>2019-05-16T00:00:00</ns:TinglysningsDato>
    <ns:PrioritetNummer>5</ns:PrioritetNummer>
    <ns:ServitutTekstSummarisk>Vejret til adgang</ns:ServitutTekstSummarisk>
  </ns:EjendomServitutSummarisk>
</ns:EjendomSummarisk>`;
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter).toHaveLength(1);
    expect(body.servitutter[0].type).toBe('Vejret');
    expect(body.servitutter[0].prioritet).toBe(5);
  });

  it('parses EjerlejlighedServitutSummarisk wrapper (ejerlejlighed variant)', async () => {
    httpsState.xmlBody = `<?xml version="1.0"?>
<ns:EjendomSummarisk>
  <ns:EjerlejlighedServitutSummarisk>
    <ns:ServitutType>Brugsret</ns:ServitutType>
    <ns:TinglysningsDato>2020-01-15T00:00:00</ns:TinglysningsDato>
    <ns:PrioritetNummer>1</ns:PrioritetNummer>
  </ns:EjerlejlighedServitutSummarisk>
</ns:EjendomSummarisk>`;
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter).toHaveLength(1);
    expect(body.servitutter[0].type).toBe('Brugsret');
  });

  it('parses mixed variants side-by-side in same XML', async () => {
    httpsState.xmlBody = `<?xml version="1.0"?>
<ns:EjendomSummarisk>
  <ns:ServitutSummarisk>
    <ns:ServitutType>Vejret</ns:ServitutType>
    <ns:TinglysningsDato>2010-06-01T00:00:00</ns:TinglysningsDato>
    <ns:PrioritetNummer>2</ns:PrioritetNummer>
  </ns:ServitutSummarisk>
  <ns:EjendomServitutSummarisk>
    <ns:ServitutType>Byggeservitut</ns:ServitutType>
    <ns:TinglysningsDato>2017-03-10T00:00:00</ns:TinglysningsDato>
    <ns:PrioritetNummer>3</ns:PrioritetNummer>
  </ns:EjendomServitutSummarisk>
</ns:EjendomSummarisk>`;
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.servitutter).toHaveLength(2);
    const types = body.servitutter.map((s: { type: string }) => s.type);
    expect(types).toContain('Vejret');
    expect(types).toContain('Byggeservitut');
  });
});

// ─── Tests: Error handling ────────────────────────────────────────────────────

describe('GET /api/tinglysning/summarisk — error handling', () => {
  beforeEach(() => {
    httpsState.statusCode = 200;
    clearXmlCache();
  });

  it('returns fejl message when https returns non-200 status', async () => {
    httpsState.statusCode = 404;
    httpsState.xmlBody = '';

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.ejere).toEqual([]);
    expect(body.haeftelser).toEqual([]);
    expect(body.servitutter).toEqual([]);
    expect(body.fejl).toContain('404');
  });

  it('returns 400 when uuid param is missing', async () => {
    const url = new URL('http://localhost/api/tinglysning/summarisk');
    const req = new NextRequest(url.toString());
    const res = await GET(req);

    expect(res.status).toBe(400);
  });
});
