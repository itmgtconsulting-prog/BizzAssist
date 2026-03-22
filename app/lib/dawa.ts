/**
 * DAWA — Danmarks Adressers Web API
 *
 * Gratis adresse- og matrikeldata fra Dataforsyningen.
 * Ingen API-nøgle nødvendig.
 *
 * Dokumentation: https://dawadocs.dataforsyningen.dk
 */

/**
 * Et autocomplete-resultat fra DAWA — normaliseret fra alle 3 DAWA-typer:
 *   - 'adresse'       → fuld adresse med lejlighed/dør (UUID navigerbar)
 *   - 'adgangsadresse' → adgangspunkt til bygning (UUID navigerbar)
 *   - 'vejnavn'        → kun gadenavn, ingen husnummer (id = 'vejnavn:…', ikke navigerbar)
 *
 * Vejnavn-resultater bruges til at autocomplete søgefeltet med gadenavn + mellemrum,
 * så brugeren kan fortsætte med at taste husnummer.
 */
export interface DawaAutocompleteResult {
  type: 'adresse' | 'adgangsadresse' | 'vejnavn';
  tekst: string;
  adresse: {
    id: string; // 'vejnavn:…' for vejnavn-type, UUID for adresse/adgangsadresse
    vejnavn: string;
    husnr: string;
    etage?: string;
    dør?: string;
    postnr: string;
    postnrnavn: string;
    kommunenavn: string;
    x: number; // længdegrad
    y: number; // breddegrad
  };
}

/** Fuld adressedetalje fra DAWA */
export interface DawaAdresse {
  id: string;
  vejnavn: string;
  husnr: string;
  etage?: string;
  dør?: string;
  postnr: string;
  postnrnavn: string;
  kommunenavn: string;
  regionsnavn: string;
  x: number;
  y: number;
  matrikelnr?: string;
  ejerlavsnavn?: string;
  ejerlavskode?: number;
  /** Samlet adressestreng */
  adressebetegnelse: string;
}

/** Et jordstykke (matrikel) fra DAWA */
export interface DawaJordstykke {
  matrikelnr: string;
  ejerlav: { navn: string; kode: number };
  areal_m2: number;
  kommune: { navn: string; kode: number };
  visueltcenter?: [number, number];
}

const BASE = 'https://api.dataforsyningen.dk';

/**
 * Mapper et råt DAWA-svarobjekt til DawaAutocompleteResult.
 *
 * Dataforsyningen's autocomplete API bruger `data` som fælles nøgle for al
 * type-specifik information — uanset om resultatet er adresse, adgangsadresse
 * eller vejnavn. Det svarer IKKE til den gamle dawa.aws.dk-formatering.
 *
 * Eksempel på vejnavn-resultat:
 *   { type: "vejnavn", tekst: "Søbyvej ", data: { navn: "Søbyvej", href: "…" } }
 * Eksempel på adgangsadresse-resultat:
 *   { type: "adgangsadresse", tekst: "Søbyvej 11, …", data: { id: "…", vejnavn: "…", x: …, y: … } }
 *
 * @param r - Rå JSON fra DAWA autocomplete API
 */
function normaliserDawaResultat(r: unknown): DawaAutocompleteResult | null {
  if (typeof r !== 'object' || r === null) return null;
  const item = r as Record<string, unknown>;
  const type = typeof item.type === 'string' ? item.type : '';
  const tekst = (typeof item.tekst === 'string' ? item.tekst : '').trim();
  const data = item.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  // ── Gadenavn (vejnavn) — ingen UUID, udfyld søgefeltet i stedet for at navigere ──
  if (type === 'vejnavn') {
    const navn = typeof d.navn === 'string' ? d.navn : tekst;
    return {
      type: 'vejnavn',
      tekst,
      adresse: {
        id: `vejnavn:${navn}`, // Ikke UUID — forhindrer navigation
        vejnavn: navn,
        husnr: '',
        postnr: '',
        postnrnavn: '',
        kommunenavn: '',
        x: 0,
        y: 0,
      },
    };
  }

  // ── Adresse eller adgangsadresse — data.id er UUID ────────────────────────
  if ((type === 'adresse' || type === 'adgangsadresse') && typeof d.id === 'string') {
    return {
      type: type as 'adresse' | 'adgangsadresse',
      tekst,
      adresse: {
        id: d.id,
        vejnavn: typeof d.vejnavn === 'string' ? d.vejnavn : '',
        husnr: typeof d.husnr === 'string' ? d.husnr : '',
        etage: typeof d.etage === 'string' ? d.etage : undefined,
        dør: typeof d.dør === 'string' ? d.dør : undefined,
        postnr: typeof d.postnr === 'string' ? d.postnr : '',
        postnrnavn: typeof d.postnrnavn === 'string' ? d.postnrnavn : '',
        kommunenavn: '', // Ikke i autocomplete-svaret — vises som postnr i stedet
        x: typeof d.x === 'number' ? d.x : 0,
        y: typeof d.y === 'number' ? d.y : 0,
      },
    };
  }

  return null;
}

/**
 * Henter adresse-autocomplete-forslag fra DAWA uden typebegrænsning.
 * Returnerer op til 8 resultater matchende søgestrengen.
 * Håndterer adresse-, adgangsadresse- og vejnavn-type resultater.
 *
 * @param q - Søgestreng (f.eks. "Bredgade 1" eller "Søbyvej")
 * @returns Liste af normaliserede autocomplete-resultater
 */
export async function dawaAutocomplete(q: string): Promise<DawaAutocompleteResult[]> {
  if (!q || q.trim().length < 2) return [];
  try {
    // Ingen type-begrænsning — returnerer adresse, adgangsadresse OG vejnavn-resultater
    const url = `${BASE}/autocomplete?q=${encodeURIComponent(q)}&per_side=8&caretpos=${q.length}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return [];
    return raw.map(normaliserDawaResultat).filter((r): r is DawaAutocompleteResult => r !== null);
  } catch {
    return [];
  }
}

/**
 * Henter fuld adressedetalje fra DAWA ud fra UUID.
 * Prøver først /adresser/{id}, derefter /adgangsadresser/{id} som fallback
 * (bruges når UUID stammer fra et adgangsadresse-autocomplete-resultat).
 * Returnerer null hvis ingen af endpointene finder adressen.
 *
 * @param id - DAWA adresse- eller adgangsadresse-UUID
 */
export async function dawaHentAdresse(id: string): Promise<DawaAdresse | null> {
  const mapRaw = (raw: Record<string, unknown>): DawaAdresse => ({
    id: raw.id as string,
    vejnavn: raw.vejnavn as string,
    husnr: raw.husnr as string,
    etage: (raw.etage as string | null) ?? undefined,
    dør: (raw.dør as string | null) ?? undefined,
    postnr: raw.postnr as string,
    postnrnavn: raw.postnrnavn as string,
    kommunenavn: raw.kommunenavn as string,
    regionsnavn: (raw.regionsnavn as string) ?? '',
    x: raw.x as number,
    y: raw.y as number,
    matrikelnr: (raw.matrikelnr as string | null) ?? undefined,
    ejerlavsnavn: (raw.ejerlavsnavn as string | null) ?? undefined,
    ejerlavskode: (raw.ejerlavskode as number | null) ?? undefined,
    adressebetegnelse:
      (raw.adressebetegnelse as string | null) ??
      `${raw.vejnavn} ${raw.husnr}, ${raw.postnr} ${raw.postnrnavn}`,
  });

  try {
    // Forsøg 1: fuld adresse
    const res1 = await fetch(`${BASE}/adresser/${id}?struktur=mini`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res1.ok) return mapRaw(await res1.json());

    // Forsøg 2: adgangspunkt (adgangsadresse-UUID fra autocomplete)
    const res2 = await fetch(`${BASE}/adgangsadresser/${id}?struktur=mini`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res2.ok) return mapRaw(await res2.json());

    return null;
  } catch {
    return null;
  }
}

/**
 * Henter jordstykke (matrikel) for en koordinat via DAWA.
 * Returnerer null hvis ingen matrikel findes.
 *
 * @param lng - Længdegrad
 * @param lat - Breddegrad
 */
export async function dawaHentJordstykke(lng: number, lat: number): Promise<DawaJordstykke | null> {
  try {
    const res = await fetch(`${BASE}/jordstykker?x=${lng}&y=${lat}&srid=4326`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const j = data[0];
    return {
      matrikelnr: j.matrikelnr,
      ejerlav: { navn: j.ejerlav?.navn ?? '', kode: j.ejerlav?.kode ?? 0 },
      areal_m2: j.areal_m2 ?? 0,
      kommune: { navn: j.kommune?.navn ?? '', kode: j.kommune?.kode ?? 0 },
      visueltcenter: j.visueltcenter,
    };
  } catch {
    return null;
  }
}

/**
 * Returnerer true hvis `id` ser ud som et DAWA UUID (adresse eller adgangsadresse).
 * Returnerer false for vejnavn-id'er (starter med 'vejnavn:') og mock-id'er.
 *
 * @param id - ID-streng at teste
 */
export function erDawaId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
