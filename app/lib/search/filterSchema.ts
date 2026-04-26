/**
 * FilterPanel foundation (BIZZ-792 / BIZZ-788a) — type-safe filter schema +
 * URL query-param serialization. Genbruges af ejendoms- (BIZZ-788),
 * virksomheds- (BIZZ-789) og personsøgning (BIZZ-790). ARCHITECT signed off
 * 2026-04-23.
 *
 * URL-query-konvention (kritisk at nail'e — 4 katalog-tickets deler den):
 *   - Multi-select: `?ejendomstype=parcelhus,raekkehus,lejlighed`
 *   - Range:        `?areal=50-150`   (min-max, bindestreg)
 *   - Toggle:       `?skjulUdfasede=true`
 *   - Dropdown:     `?energimaerke=a` (enkelt værdi, comma for multi)
 *   - Søgetekst:    `?q=...` (separat — håndteres ikke her)
 *
 * Invalid values rejectes af Zod og fjernes fra state uden at crashe UI.
 */
import { z } from 'zod';

// ─── Schema-typer (type-diskriminator for renderers) ────────────────────────

/** Option i multi-select / dropdown. */
export interface FilterOption {
  /** Serialiseret værdi i URL (fx "parcelhus") */
  value: string;
  /** Vist label (bilingual håndteres af parent via options-factory) */
  label: string;
}

/** Multi-select med komma-separeret URL-repræsentation. */
export interface MultiSelectFilterSchema {
  type: 'multi-select';
  /** URL param navn (fx "ejendomstype") — bruges som state key */
  key: string;
  /** Overskrift på section i panel */
  label: string;
  options: FilterOption[];
  /** Default-værdier (tom liste betyder "ingen filter") */
  default?: string[];
}

/** Enkelt-valg dropdown. */
export interface DropdownFilterSchema {
  type: 'dropdown';
  key: string;
  label: string;
  options: FilterOption[];
  /** Placeholder i dropdown når intet valgt */
  placeholder?: string;
  default?: string;
}

/** Range (min-max numerisk). */
export interface RangeFilterSchema {
  type: 'range';
  key: string;
  label: string;
  /** Clamp-lower for slider */
  min: number;
  /** Clamp-upper for slider */
  max: number;
  /** Trin-størrelse (default 1) */
  step?: number;
  /** Enhed vist i UI (fx "m²", "DKK", "år") */
  unit?: string;
  default?: { min?: number; max?: number };
}

/** Toggle (bool). */
export interface ToggleFilterSchema {
  type: 'toggle';
  key: string;
  label: string;
  /** Default-værdi hvis URL param mangler. Typisk true for "Skjul udfasede". */
  default: boolean;
  /** Valgfri beskrivelse vist under label */
  description?: string;
}

/** Union af alle filter-typer. */
export type FilterSchema =
  | MultiSelectFilterSchema
  | DropdownFilterSchema
  | RangeFilterSchema
  | ToggleFilterSchema;

// ─── State shape ────────────────────────────────────────────────────────────

/**
 * Filter-state for en søgeside. Keys matcher `FilterSchema.key`; værdier er
 * altid serializable (string[] | {min?,max?} | boolean | string).
 */
export type FilterValue = string[] | { min?: number; max?: number } | boolean | string;

export type FilterState = Record<string, FilterValue>;

// ─── URL encode / decode ────────────────────────────────────────────────────

/**
 * Serialiserer én filter-værdi til URL param-værdi (string) ifølge
 * arkitekt-konvention. Returnerer null hvis værdien er "tom" og ikke skal
 * tilføjes URL'en (fx tom multi-select-liste).
 */
export function encodeFilterValue(
  schema: FilterSchema,
  value: FilterValue | undefined
): string | null {
  if (value === undefined) return null;
  switch (schema.type) {
    case 'multi-select': {
      if (!Array.isArray(value) || value.length === 0) return null;
      // BIZZ-838: Escape literal commas in values so split(',') on decode is safe
      return value.map((v) => v.replaceAll(',', '%2C')).join(',');
    }
    case 'dropdown': {
      if (typeof value !== 'string' || value.length === 0) return null;
      return value;
    }
    case 'range': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
      const { min, max } = value as { min?: number; max?: number };
      if (min === undefined && max === undefined) return null;
      return `${min ?? schema.min}-${max ?? schema.max}`;
    }
    case 'toggle': {
      if (typeof value !== 'boolean') return null;
      // Default-toggles skal ikke i URL — reducerer støj
      if (value === schema.default) return null;
      return String(value);
    }
  }
}

/**
 * Parser URL param-værdi til typet filter-værdi. Invalid values returnerer
 * undefined (rejectes silent — bruger ser bare at filter ikke er aktivt i
 * stedet for at UI crasher).
 */
export function decodeFilterValue(
  schema: FilterSchema,
  raw: string | null
): FilterValue | undefined {
  if (raw === null) return undefined;
  switch (schema.type) {
    case 'multi-select': {
      if (raw.length === 0) return undefined;
      // BIZZ-838: Decode %2C back to literal commas in values
      const parts = raw
        .split(',')
        .map((s) => s.trim().replaceAll('%2C', ','))
        .filter((s) => s.length > 0);
      const allowed = new Set(schema.options.map((o) => o.value));
      const filtered = parts.filter((p) => allowed.has(p));
      return filtered.length > 0 ? filtered : undefined;
    }
    case 'dropdown': {
      const allowed = new Set(schema.options.map((o) => o.value));
      return allowed.has(raw) ? raw : undefined;
    }
    case 'range': {
      // BIZZ-838: Tighter regex — require at least one numeric group
      // Matches "50-150", "50-", "-150", but NOT "-" alone
      const parsed = z
        .string()
        .regex(/^(?:\d+-\d*|\d*-\d+)$/)
        .safeParse(raw);
      if (!parsed.success) return undefined;
      const [minStr, maxStr] = raw.split('-');
      const result: { min?: number; max?: number } = {};
      if (minStr) {
        const n = Number(minStr);
        if (Number.isFinite(n) && n >= schema.min) result.min = n;
      }
      if (maxStr) {
        const n = Number(maxStr);
        if (Number.isFinite(n) && n <= schema.max) result.max = n;
      }
      return result.min !== undefined || result.max !== undefined ? result : undefined;
    }
    case 'toggle': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return undefined;
    }
  }
}

/**
 * Parser et helt URLSearchParams objekt til et typet `FilterState` ud fra
 * et array af filter-schemaer. Filter-værdier der ikke er specificeret i
 * URL'en får deres `default` (hvis defineret) eller udelades.
 */
export function parseFiltersFromSearchParams(
  schemas: FilterSchema[],
  params: URLSearchParams
): FilterState {
  const state: FilterState = {};
  for (const schema of schemas) {
    const raw = params.get(schema.key);
    const decoded = decodeFilterValue(schema, raw);
    if (decoded !== undefined) {
      state[schema.key] = decoded;
    } else if (schema.type === 'toggle') {
      // Toggles har altid en værdi — default hvis URL mangler
      state[schema.key] = schema.default;
    } else if (schema.type === 'multi-select' && schema.default && schema.default.length > 0) {
      state[schema.key] = schema.default;
    } else if (schema.type === 'dropdown' && schema.default) {
      state[schema.key] = schema.default;
    } else if (schema.type === 'range' && schema.default) {
      state[schema.key] = schema.default;
    }
  }
  return state;
}

/**
 * Serialiserer et `FilterState` tilbage til en `URLSearchParams`. Default-
 * værdier udelades fra URL'en så delte links ikke er fyldt med støj.
 */
export function serializeFiltersToSearchParams(
  schemas: FilterSchema[],
  state: FilterState,
  existing?: URLSearchParams
): URLSearchParams {
  const out = new URLSearchParams(existing);
  for (const schema of schemas) {
    const value = state[schema.key];
    const encoded = encodeFilterValue(schema, value);
    if (encoded === null) {
      out.delete(schema.key);
    } else {
      out.set(schema.key, encoded);
    }
  }
  return out;
}

/**
 * Null'er alle filtre tilbage til deres defaults (eller tom).
 * Bruges af "Nulstil"-knap i panel.
 */
export function resetFilters(schemas: FilterSchema[]): FilterState {
  const state: FilterState = {};
  for (const schema of schemas) {
    if (schema.type === 'toggle') {
      state[schema.key] = schema.default;
    } else if (schema.type === 'multi-select' && schema.default) {
      state[schema.key] = schema.default;
    } else if (schema.type === 'dropdown' && schema.default) {
      state[schema.key] = schema.default;
    } else if (schema.type === 'range' && schema.default) {
      state[schema.key] = schema.default;
    }
  }
  return state;
}
