/**
 * entityResolver — resolves entity references across the BizzAssist data model.
 *
 * Provides typed helper functions to look up entities by their primary identifiers
 * and generate cross-links between properties, companies, and people.
 *
 * Recognises identifier patterns in free text (AI responses, search results) and
 * generates consistent hrefs for internal navigation.
 *
 * Used by pages and API routes to avoid duplicating resolution logic.
 *
 * @module entityResolver
 */

// ─── Entity type definitions ─────────────────────────────────────────────────

/**
 * A resolved property entity identified by its BFE number.
 *
 * BFE (Bestemt Fast Ejendom) numbers are assigned by Geodatastyrelsen
 * and uniquely identify a registered real property in Denmark.
 */
export interface PropertyEntity {
  type: 'property';
  /** BFE number as a string (leading zeroes preserved). */
  bfeNummer: string;
  /** Human-readable address, if available. */
  adresse?: string;
  /** Internal link: /dashboard/ejendomme/[bfeNummer] */
  href: string;
}

/**
 * A resolved company entity identified by its CVR number.
 *
 * CVR (Det Centrale Virksomhedsregister) numbers are 8-digit identifiers
 * issued by Erhvervsstyrelsen for all Danish legal entities.
 */
export interface CompanyEntity {
  type: 'company';
  /** CVR number as a string (always 8 digits). */
  cvrNummer: string;
  /** Company name, if available. */
  navn?: string;
  /** Internal link: /dashboard/companies/[cvrNummer] */
  href: string;
}

/**
 * A resolved person entity identified by their CVR enhedsNummer.
 *
 * enhedsNummer is the unique identifier for a deltager (participant) in
 * the CVR register — used for both natural persons and other legal forms.
 */
export interface PersonEntity {
  type: 'person';
  /** CVR enhedsNummer as a string. */
  enhedsNummer: string;
  /** Person name, if available. */
  navn?: string;
  /** Internal link: /dashboard/owners/[enhedsNummer] */
  href: string;
}

/** Union of all entity types supported by the resolver. */
export type Entity = PropertyEntity | CompanyEntity | PersonEntity;

/** A single breadcrumb step in a navigation trail. */
export interface Breadcrumb {
  /** Display label for the breadcrumb. */
  label: string;
  /** Absolute internal href. */
  href: string;
}

// ─── Resolver functions ───────────────────────────────────────────────────────

/**
 * Resolves a property entity from a BFE number.
 *
 * Builds the canonical internal href for the property detail page.
 *
 * @param bfeNummer - BFE number (string or number — converted to string)
 * @param adresse - Optional human-readable address to include on the entity
 * @returns A fully resolved PropertyEntity
 *
 * @example
 * resolveProperty('1234567', 'Vesterbrogade 1, 1620 København V')
 * // { type: 'property', bfeNummer: '1234567', adresse: '...', href: '/dashboard/ejendomme/1234567' }
 */
export function resolveProperty(bfeNummer: string | number, adresse?: string): PropertyEntity {
  const id = String(bfeNummer);
  return {
    type: 'property',
    bfeNummer: id,
    adresse,
    href: `/dashboard/ejendomme/${id}`,
  };
}

/**
 * Resolves a company entity from a CVR number.
 *
 * Builds the canonical internal href for the company detail page.
 *
 * @param cvrNummer - CVR number (string or number — converted to string)
 * @param navn - Optional company name to include on the entity
 * @returns A fully resolved CompanyEntity
 *
 * @example
 * resolveCompany(12345678, 'Novo Nordisk A/S')
 * // { type: 'company', cvrNummer: '12345678', navn: 'Novo Nordisk A/S', href: '/dashboard/companies/12345678' }
 */
export function resolveCompany(cvrNummer: string | number, navn?: string): CompanyEntity {
  const id = String(cvrNummer);
  return {
    type: 'company',
    cvrNummer: id,
    navn,
    href: `/dashboard/companies/${id}`,
  };
}

/**
 * Resolves a person entity from a CVR enhedsNummer.
 *
 * Builds the canonical internal href for the owner/person detail page.
 *
 * @param enhedsNummer - CVR enhedsNummer (string or number — converted to string)
 * @param navn - Optional person name to include on the entity
 * @returns A fully resolved PersonEntity
 *
 * @example
 * resolvePerson(4000123456, 'Anders And')
 * // { type: 'person', enhedsNummer: '4000123456', navn: 'Anders And', href: '/dashboard/owners/4000123456' }
 */
export function resolvePerson(enhedsNummer: string | number, navn?: string): PersonEntity {
  const id = String(enhedsNummer);
  return {
    type: 'person',
    enhedsNummer: id,
    navn,
    href: `/dashboard/owners/${id}`,
  };
}

// ─── Text extraction ──────────────────────────────────────────────────────────

/**
 * Patterns used to detect entity identifiers in free text.
 *
 * CVR: 8-digit number — matched by "CVR[: ]XXXXXXXX", "cvr-nr XXXXXXXX", or bare 8-digit number
 *   preceded by explicit label.
 * BFE: 6–9 digit number — matched by "BFE[: ]XXXXXXX".
 * enhedsNummer: 10-digit number — matched by "enhed[: ]XXXXXXXXXX" or "enhedsNummer XXXXXXXXXX".
 *
 * All patterns are case-insensitive.
 */
const PATTERNS = {
  /** Matches "CVR: 12345678", "cvr 12345678", "cvr-nr. 12345678" */
  cvr: /\bcvr[-.]?\s*(?:nr\.?)?\s*[:\s]\s*(\d{8})\b/gi,
  /** Matches "BFE: 1234567", "BFE 123456" */
  bfe: /\bbfe\s*[:\s]\s*(\d{6,9})\b/gi,
  /** Matches "enhed: 4000123456", "enhedsNummer 4000123456" */
  enhed: /\benhedsnummer\s*[:\s]\s*(\d{8,12})\b|\benhed\s*[:\s]\s*(\d{8,12})\b/gi,
} as const;

/**
 * Extracts all entity references from a text string (e.g. an AI response).
 *
 * Recognises patterns like:
 *  - "CVR: 12345678" or "cvr 12345678" → CompanyEntity
 *  - "BFE: 1234567" or "bfe 123456"   → PropertyEntity
 *  - "enhed 4000123456" or "enhedsNummer 4000123456" → PersonEntity
 *
 * Deduplicates results — each unique identifier is returned at most once.
 *
 * @param text - Free-form text to scan for entity identifiers
 * @returns Array of resolved entities in the order they first appear in the text
 *
 * @example
 * extractEntitiesFromText('Virksomhed med CVR: 12345678 ejer BFE: 1234567.')
 * // [
 * //   { type: 'company', cvrNummer: '12345678', href: '/dashboard/companies/12345678' },
 * //   { type: 'property', bfeNummer: '1234567', href: '/dashboard/ejendomme/1234567' },
 * // ]
 */
export function extractEntitiesFromText(text: string): Entity[] {
  const entities: Entity[] = [];
  const seen = new Set<string>();

  /**
   * Adds an entity to the result list if its canonical key has not been seen before.
   *
   * @param key - Deduplication key (type:id)
   * @param entity - The resolved entity to add
   */
  function addIfNew(key: string, entity: Entity): void {
    if (!seen.has(key)) {
      seen.add(key);
      entities.push(entity);
    }
  }

  // ── Extract CVR numbers ──────────────────────────────────────────────────
  // Reset lastIndex so the regex can be reused correctly across calls.
  PATTERNS.cvr.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATTERNS.cvr.exec(text)) !== null) {
    const id = match[1];
    addIfNew(`company:${id}`, resolveCompany(id));
  }

  // ── Extract BFE numbers ──────────────────────────────────────────────────
  PATTERNS.bfe.lastIndex = 0;
  while ((match = PATTERNS.bfe.exec(text)) !== null) {
    const id = match[1];
    addIfNew(`property:${id}`, resolveProperty(id));
  }

  // ── Extract enhedsNummer / enhed numbers ─────────────────────────────────
  PATTERNS.enhed.lastIndex = 0;
  while ((match = PATTERNS.enhed.exec(text)) !== null) {
    // The regex has two capture groups — take whichever one matched.
    const id = match[1] ?? match[2];
    addIfNew(`person:${id}`, resolvePerson(id));
  }

  return entities;
}

// ─── Breadcrumbs ─────────────────────────────────────────────────────────────

/**
 * Generates a breadcrumb trail for an entity.
 *
 * The trail always starts with the Dashboard root, then the section list page,
 * and finally the entity's own page.  The entity label uses the most descriptive
 * name available (name/address), falling back to the raw identifier.
 *
 * @param entity - A resolved entity (property, company, or person)
 * @returns Ordered array of breadcrumb steps from root to the entity page
 *
 * @example
 * entityBreadcrumbs(resolveProperty('1234567', 'Vesterbrogade 1'))
 * // [
 * //   { label: 'Dashboard', href: '/dashboard' },
 * //   { label: 'Ejendomme', href: '/dashboard/ejendomme' },
 * //   { label: 'Vesterbrogade 1', href: '/dashboard/ejendomme/1234567' },
 * // ]
 */
export function entityBreadcrumbs(entity: Entity): Breadcrumb[] {
  const root: Breadcrumb = { label: 'Dashboard', href: '/dashboard' };

  switch (entity.type) {
    case 'property': {
      const label = entity.adresse ?? `BFE ${entity.bfeNummer}`;
      return [
        root,
        { label: 'Ejendomme', href: '/dashboard/ejendomme' },
        { label, href: entity.href },
      ];
    }

    case 'company': {
      const label = entity.navn ?? `CVR ${entity.cvrNummer}`;
      return [
        root,
        { label: 'Virksomheder', href: '/dashboard/companies' },
        { label, href: entity.href },
      ];
    }

    case 'person': {
      const label = entity.navn ?? `Enhed ${entity.enhedsNummer}`;
      return [root, { label: 'Personer', href: '/dashboard/owners' }, { label, href: entity.href }];
    }

    default: {
      // Exhaustive check — TypeScript will flag unhandled entity types.
      const _exhaustive: never = entity;
      return [root];
    }
  }
}
