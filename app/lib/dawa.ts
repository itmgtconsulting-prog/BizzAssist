/**
 * DAWA — Danmarks Adressers Web API
 *
 * Gratis adresse- og matrikeldata fra Dataforsyningen.
 * Ingen API-nøgle nødvendig.
 *
 * Dokumentation: https://dawadocs.dataforsyningen.dk
 */

/** Et autocomplete-resultat fra DAWA */
export interface DawaAutocompleteResult {
  type: 'adresse' | 'adgangsadresse';
  tekst: string;
  adresse: {
    id: string;
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
 * Henter adresse-autocomplete-forslag fra DAWA.
 * Returnerer op til 8 resultater matchende søgestrengen.
 *
 * @param q - Søgestreng (f.eks. "Bredgade 1")
 * @returns Liste af autocomplete-resultater
 */
export async function dawaAutocomplete(q: string): Promise<DawaAutocompleteResult[]> {
  if (!q || q.trim().length < 2) return [];
  try {
    const url = `${BASE}/autocomplete?q=${encodeURIComponent(q)}&type=adresse&per_side=8&caretpos=${q.length}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return (await res.json()) as DawaAutocompleteResult[];
  } catch {
    return [];
  }
}

/**
 * Henter fuld adressedetalje fra DAWA ud fra adresse-UUID.
 * Returnerer null hvis adressen ikke findes.
 *
 * @param id - DAWA adresse-UUID
 */
export async function dawaHentAdresse(id: string): Promise<DawaAdresse | null> {
  try {
    const res = await fetch(`${BASE}/adresser/${id}?struktur=mini`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const raw = await res.json();
    return {
      id: raw.id,
      vejnavn: raw.vejnavn,
      husnr: raw.husnr,
      etage: raw.etage ?? undefined,
      dør: raw.dør ?? undefined,
      postnr: raw.postnr,
      postnrnavn: raw.postnrnavn,
      kommunenavn: raw.kommunenavn,
      regionsnavn: raw.regionsnavn ?? '',
      x: raw.x,
      y: raw.y,
      matrikelnr: raw.matrikelnr ?? undefined,
      ejerlavsnavn: raw.ejerlavsnavn ?? undefined,
      ejerlavskode: raw.ejerlavskode ?? undefined,
      adressebetegnelse:
        raw.adressebetegnelse ?? `${raw.vejnavn} ${raw.husnr}, ${raw.postnr} ${raw.postnrnavn}`,
    };
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
 * Returnerer true hvis `id` ser ud som et DAWA UUID (ikke et mock-id).
 *
 * @param id - ID-streng at teste
 */
export function erDawaId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
