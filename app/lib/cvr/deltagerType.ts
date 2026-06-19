/**
 * BIZZ-2086: Klassificering af CVR-deltagere som person vs. virksomhed.
 *
 * Mange holdingselskaber står i Ejerregisteret som deltagere via enhedsnummer
 * og blev tidligere oprettet som person-noder i diagrammet. cvr_deltager HAR
 * en enhedstype-kolonne, men den er historisk NULL — derfor en navne-heuristik
 * som fallback (samme mønster som /api/cvr-public).
 */

/**
 * Heuristik: ligner navnet et virksomhedsnavn?
 * Matcher typiske danske selskabsform-suffikser og -ord.
 *
 * @param navn - Deltagerens navn (null/undefined → false)
 * @returns true hvis navnet ligner en virksomhed
 */
export function looksLikeCompanyName(navn: string | null | undefined): boolean {
  if (!navn) return false;
  return /(^|[\s,.])(a\/s|aps|i\/s|k\/s|p\/s|ivs|s\.m\.b\.a\.?|a\.m\.b\.a\.?|f\.m\.b\.a\.?|smba|amba|fmba|g\/s|holding|invest|fond|fonden|forening|komplementar|anpartsselskab|aktieselskab)($|[\s,.])/i.test(
    navn
  );
}

/**
 * Afgør om en deltager er en virksomhed (ikke en fysisk person).
 *
 * Primært via enhedstype fra cvr_deltager-cachen eller CVR ES
 * (case-insensitivt: 'PERSON' → person, alt andet kendt → virksomhed),
 * sekundært via navne-heuristik når enhedstype mangler.
 *
 * @param enhedstype - enhedstype fra cvr_deltager eller CVR ES (kan være null)
 * @param navn - Deltagerens navn til heuristik-fallback
 * @returns true hvis deltageren skal behandles som virksomhed
 */
export function erVirksomhedsDeltager(
  enhedstype: string | null | undefined,
  navn?: string | null
): boolean {
  if (enhedstype) {
    return enhedstype.toLowerCase() !== 'person';
  }
  return looksLikeCompanyName(navn);
}
