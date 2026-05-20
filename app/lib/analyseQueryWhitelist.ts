/**
 * analyseQueryWhitelist — tilladte tabeller og kolonner for AI Query Builder.
 *
 * BIZZ-1038: AI-genereret SQL valideres mod denne whitelist.
 * Kun de specificerede tabeller og kolonner kan forespørges.
 * Alle queries scopes via RLS (service role for public cache tables).
 *
 * @module app/lib/analyseQueryWhitelist
 */

/** Definition af en tilgængelig tabel i query builder */
export interface WhitelistedTable {
  /** Fuldt kvalificeret tabelnavn (schema.table) */
  table: string;
  /** Dansk beskrivelse til Claude's system prompt */
  description: string;
  /** Tilladte kolonner med typer og beskrivelser */
  columns: Record<string, { type: string; description: string }>;
}

/**
 * Whitelist af tabeller og kolonner der kan bruges i AI Query Builder.
 *
 * SIKKERHED: AI-genereret SQL valideres mod denne liste.
 * Tilføj aldrig tabeller med PII (brugerdata, sessions, auth).
 */
export const WHITELISTED_TABLES: WhitelistedTable[] = [
  {
    table: 'public.bbr_ejendom_status',
    description:
      'BBR ejendomsstatus — én række per BFE (ejendom). 2,5M+ rækker. Indeholder bygningsdata, kommunekode, areal og status. BEMÆRK: kommune_kode, energimaerke og samlet_boligareal kan være NULL — filtrer altid med IS NOT NULL ved aggregering.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      kommune_kode: {
        type: 'smallint',
        description: 'Kommunekode (4-cifret, kan være NULL — filtrer med IS NOT NULL)',
      },
      is_udfaset: { type: 'boolean', description: 'True hvis ejendommen er udfaset/nedrevet' },
      bbr_status_code: { type: 'smallint', description: 'BBR statuskode' },
      samlet_boligareal: {
        type: 'integer',
        description: 'Samlet boligareal i m² (kan være NULL)',
      },
      opfoerelsesaar: { type: 'integer', description: 'Bygningens opførelsesår (kan være NULL)' },
      energimaerke: {
        type: 'text',
        description: 'Energimærkeklasse (A2015, B2015, C2015... eller A, B, C... kan være NULL)',
      },
      byg021_anvendelse: { type: 'text', description: 'BBR anvendelseskode' },
      antal_etager: { type: 'smallint', description: 'Antal etager (primær bygning)' },
      antal_boligenheder: { type: 'smallint', description: 'Antal boligenheder' },
      tagmateriale: { type: 'text', description: 'Tagmateriale-kode (BBR byg032)' },
      ydervaeg_materiale: { type: 'text', description: 'Ydervæg-materiale-kode (BBR byg033)' },
      varmeinstallation: { type: 'text', description: 'Varmeinstallation-kode (BBR byg056)' },
      opvarmningsform: { type: 'text', description: 'Opvarmningsform-kode (BBR byg058)' },
      vandforsyning: { type: 'text', description: 'Vandforsyning-kode (BBR byg060)' },
      afloebsforhold: { type: 'text', description: 'Afløbsforhold-kode (BBR byg061)' },
      bevaringsvaerdighed: {
        type: 'smallint',
        description: 'Bevaringsværdighed (1-9, 1 = højest, kan være NULL)',
      },
      ejerforholdskode: { type: 'text', description: 'Ejerforholdskode (BBR)' },
      status_last_checked_at: { type: 'timestamptz', description: 'Seneste statuscheck' },
    },
  },
  {
    table: 'public.cvr_virksomhed',
    description:
      'CVR-registrerede virksomheder — 2,1M+ rækker. Indeholder grunddata, branche, ansatte, status og stiftelsesdato.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle, 8 cifre)' },
      navn: { type: 'text', description: 'Virksomhedens navn' },
      status: {
        type: 'text',
        description: 'Status: NORMAL, OPHØRT, UNDER_KONKURS, TVANGSOPLØST, etc.',
      },
      branche_kode: { type: 'text', description: 'DB07 branchekode (6 cifre)' },
      branche_tekst: { type: 'text', description: 'Branchebeskrivelse på dansk' },
      virksomhedsform: {
        type: 'text',
        description: 'Selskabsform: APS, AS, IVS, ENK, PMV, SOV, etc.',
      },
      stiftet: { type: 'date', description: 'Stiftelsesdato' },
      ophoert: { type: 'date', description: 'Ophørsdato (NULL hvis aktiv)' },
      ansatte_aar: { type: 'integer', description: 'Antal årsansatte (kan være NULL)' },
      hvidvask_omfattet: { type: 'boolean', description: 'Omfattet af hvidvaskloven' },
      revision_fravalgt: { type: 'boolean', description: 'Har fravalgt revision' },
      reklame_beskyttet: { type: 'boolean', description: 'Er reklame-beskyttet' },
      bibranche1_kode: { type: 'text', description: 'Bibranche 1 DB07-kode' },
      bibranche1_tekst: { type: 'text', description: 'Bibranche 1 beskrivelse' },
      formaal: { type: 'text', description: 'Virksomhedens formålsbeskrivelse' },
      sidst_opdateret: { type: 'timestamptz', description: 'Senest opdateret fra CVR' },
    },
  },
  {
    table: 'public.cvr_virksomhed_ejerskab',
    description:
      'Ejerskabsrelationer — 333K+ rækker. Hvem ejer hvilke virksomheder (CVR→CVR og person→CVR).',
    columns: {
      cvr: { type: 'text', description: 'Ejet virksomheds CVR-nummer' },
      ejer_cvr: { type: 'text', description: 'Ejer-virksomheds CVR (NULL ved person-ejer)' },
      ejer_enheds_nummer: {
        type: 'bigint',
        description: 'Ejer-persons enhedsNummer (NULL ved virksomheds-ejer)',
      },
      ejer_navn: { type: 'text', description: 'Ejers navn' },
      andel_pct: { type: 'numeric', description: 'Ejerandel i procent (kan være NULL)' },
      sidst_opdateret: { type: 'timestamptz', description: 'Senest opdateret' },
    },
  },
  {
    table: 'public.ejf_ejerskab',
    description: 'Ejendomsejerskab fra EJF — 7,6M+ rækker. Hvem ejer hvilke ejendomme (BFE).',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (ejendom)' },
      ejer_navn: { type: 'text', description: 'Ejers navn' },
      ejer_cvr: { type: 'text', description: 'Ejers CVR-nummer (NULL ved person-ejer)' },
      ejer_type: {
        type: 'text',
        description: 'Ejertype: Personligt ejet, Selskab, Kommune, Region, Stat, etc.',
      },
      ejerandel_taeller: { type: 'integer', description: 'Ejerandel tæller (fx 1 af 2)' },
      ejerandel_naevner: { type: 'integer', description: 'Ejerandel nævner (fx 2)' },
      status: { type: 'text', description: 'Status: Aktiv, Historisk' },
      virkning_fra: { type: 'timestamptz', description: 'Ejerskab gældende fra' },
      sidst_opdateret: { type: 'timestamptz', description: 'Senest opdateret fra EJF' },
    },
  },
  {
    table: 'public.regnskab_cache',
    description:
      'Cached XBRL regnskabsdata per CVR-nummer — 143 rækker. Kolonnen "years" er JSONB med array af årsregnskaber.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle)' },
      years: {
        type: 'jsonb',
        description: 'Array af regnskabsår med brutto, netto, egenkapital, ansatte m.fl.',
      },
      fetched_at: { type: 'timestamptz', description: 'Hvornår data sidst blev hentet' },
    },
  },
  {
    table: 'public.mv_analyse_ejendom',
    description:
      'Unified ejendomsanalyse-view — ~46K aktive ejendomme. Joiner BBR + ejer + virksomhed + kommune + anvendelse i én flad tabel. Refreshes nightly. Brug til geografi, areal, ejertype og anvendelsesanalyser.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      boligareal_m2: { type: 'integer', description: 'Samlet boligareal i m²' },
      opfoerelsesaar: { type: 'smallint', description: 'Bygningens opførelsesår' },
      energimaerke: { type: 'text', description: 'Energimærkeklasse (A2015, B, C, D...)' },
      anvendelse_kode: { type: 'smallint', description: 'BBR byg021 anvendelseskode' },
      anvendelse_tekst: {
        type: 'text',
        description: 'Anvendelsestype på dansk (fx "Parcelhus", "Lejlighed")',
      },
      anvendelse_kategori: {
        type: 'text',
        description: 'Kategori: bolig, erhverv, institution, andet',
      },
      kommune_kode: { type: 'smallint', description: 'Kommunekode (4-cifret)' },
      kommunenavn: { type: 'text', description: 'Kommunenavn (fx "Hvidovre", "Aarhus")' },
      region: {
        type: 'text',
        description: 'Region (Hovedstaden, Sjælland, Syddanmark, Midtjylland, Nordjylland)',
      },
      ejer_navn: { type: 'text', description: 'Ejers navn' },
      ejer_type: { type: 'text', description: 'Ejertype: Personligt ejet, Selskab, Kommune, Stat' },
      ejer_cvr: { type: 'text', description: 'Ejers CVR-nummer (NULL for privatpersoner)' },
      ejerandel_pct: { type: 'numeric', description: 'Ejerandel i procent' },
      virksomhed_navn: { type: 'text', description: 'Virksomhedsejerens navn' },
      virksomhed_branche: { type: 'text', description: 'Virksomhedsejerens branche' },
      virksomhed_form: { type: 'text', description: 'Virksomhedsform (APS, AS, etc.)' },
      virksomhed_ansatte: { type: 'integer', description: 'Antal ansatte i ejervirksomheden' },
    },
  },
  {
    table: 'public.mv_analyse_virksomhed',
    description:
      'Unified virksomhedsanalyse-view — 2,1M+ virksomheder med antal ejede ejendomme. Refreshes nightly. Brug til branche, selskabsform og ejendomsportefølje-analyser.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer (primærnøgle)' },
      navn: { type: 'text', description: 'Virksomhedens navn' },
      branche_kode: { type: 'text', description: 'DB07 branchekode (6 cifre)' },
      branche_tekst: { type: 'text', description: 'Branchebeskrivelse på dansk' },
      virksomhedsform: { type: 'text', description: 'Selskabsform: APS, AS, IVS, ENK, etc.' },
      status: { type: 'text', description: 'Status: NORMAL, OPHØRT, UNDER_KONKURS, etc.' },
      stiftet: { type: 'date', description: 'Stiftelsesdato' },
      ophoert: { type: 'date', description: 'Ophørsdato (NULL hvis aktiv)' },
      ansatte: { type: 'integer', description: 'Antal årsansatte' },
      antal_ejendomme: { type: 'integer', description: 'Antal ejede ejendomme (fra EJF)' },
    },
  },
  {
    table: 'public.vurdering_cache',
    description:
      'Ejendomsvurderinger — cached fra Datafordeler VUR. Normaliserede kolonner for ejendomsværdi, grundværdi, vurderingsår. BIZZ-1274.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer (primærnøgle)' },
      ejendomsvaerdi: { type: 'bigint', description: 'Offentlig ejendomsværdi i DKK' },
      grundvaerdi: { type: 'bigint', description: 'Grundværdi i DKK' },
      vurderingsaar: { type: 'integer', description: 'Vurderingsår (fx 2024)' },
      benyttelseskode: { type: 'text', description: 'Benyttelseskode' },
      grundskyldspromille: { type: 'numeric', description: 'Grundskyldspromille (‰)' },
      bebyggelsesprocent: { type: 'numeric', description: 'Bebyggelsesprocent (0-100)' },
    },
  },
  {
    table: 'public.cvr_historik',
    description:
      'CVR ændringshistorik — alle ændringer for virksomheder (navn, adresse, status, branche, form, fusion, spaltning). BIZZ-1277.',
    columns: {
      cvr: { type: 'text', description: 'CVR-nummer' },
      felt: {
        type: 'text',
        description: 'Felt: navn, adresse, status, branche, form, fusion, spaltning',
      },
      vaerdi_fra: { type: 'text', description: 'Gammel værdi' },
      vaerdi_til: { type: 'text', description: 'Ny værdi' },
      gyldig_fra: { type: 'date', description: 'Ændring gyldig fra dato' },
      gyldig_til: { type: 'date', description: 'Ændring gyldig til dato (NULL = aktuel)' },
    },
  },
  {
    table: 'public.kommune_ref',
    description:
      'Kommune-lookup — 98 kommuner med kode, navn og region. Brug til at oversætte kommunekoder til navne.',
    columns: {
      kommune_kode: { type: 'smallint', description: 'Kommunekode (primærnøgle, 4 cifre)' },
      kommunenavn: { type: 'text', description: 'Kommunenavn' },
      region: {
        type: 'text',
        description: 'Region (Hovedstaden, Sjælland, Syddanmark, Midtjylland, Nordjylland)',
      },
    },
  },
  // BIZZ-1726+1727: EJF Ejerskifte + Handelsoplysninger fra Datafordeler
  {
    table: 'public.ejf_ejerskifte',
    description:
      'EJF ejerskifter — komplet ejerskifte-historik med BFE, handelstype og pris-kobling. JOIN ejf_handelsoplysninger via handelsoplysninger_lokal_id for priser.',
    columns: {
      id_lokal_id: { type: 'text', description: 'Ejerskifte ID (primærnøgle)' },
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer for ejendommen' },
      overtagelsesdato: { type: 'timestamptz', description: 'Overtagelsesdato' },
      overdragelsesmaade: {
        type: 'text',
        description:
          'Handelstype: Almindelig fri handel, Familieoverdragelse, Arv, Gave, Tvangsauktion, Interessesammenfald. VIGTIGT: filtrer på "Almindelig fri handel" for reelle markedspriser.',
      },
      betinget: { type: 'boolean', description: 'Om skødet er betinget' },
      forretningshaendelse: { type: 'text', description: 'Endeligt skøde, Skifteretsattest osv.' },
      handelsoplysninger_lokal_id: {
        type: 'text',
        description: 'FK til ejf_handelsoplysninger.id_lokal_id (pris-data)',
      },
      status: { type: 'text', description: 'gældende / historisk' },
    },
  },
  {
    table: 'public.ejf_handelsoplysninger',
    description:
      'EJF salgspriser — kontant + samlet købesum fra Datafordeler. Kobles til ejf_ejerskifte via id_lokal_id = ejf_ejerskifte.handelsoplysninger_lokal_id.',
    columns: {
      id_lokal_id: { type: 'text', description: 'Handelsoplysning ID (primærnøgle)' },
      samlet_koebesum: { type: 'bigint', description: 'Samlet købesum i DKK' },
      kontant_koebesum: { type: 'bigint', description: 'Kontant købesum i DKK' },
      loesoeressum: { type: 'bigint', description: 'Løsøresum i DKK' },
      entreprisesum: { type: 'bigint', description: 'Entreprisesum i DKK' },
      koebsaftale_dato: { type: 'date', description: 'Dato for købekontrakt' },
      valutakode: { type: 'text', description: 'Valuta (typisk DKK)' },
      forretningshaendelse: { type: 'text', description: 'Endeligt skøde, Skifteretsattest osv.' },
      status: { type: 'text', description: 'gældende / historisk' },
    },
  },
  // BIZZ-1725: Tilføjede tabeller for salgspriser, ejerskifter, personer, administratorer
  {
    table: 'public.ejendomshandel',
    description:
      'Ejendomshandler med faktiske salgspriser fra Tinglysning. 58K+ rækker med købesum. PRIMÆR tabel for salgspris-spørgsmål.',
    columns: {
      bfe_nummer: { type: 'integer', description: 'BFE-nummer for ejendommen' },
      dato: { type: 'date', description: 'Handelsdato' },
      koebsaftale_dato: { type: 'date', description: 'Dato for købekontrakt' },
      type: { type: 'text', description: 'Handelstype (skøde, arv, gave osv.)' },
      koebesum: { type: 'numeric', description: 'Faktisk købesum i DKK' },
      samlet_koebesum: { type: 'numeric', description: 'Samlet købesum inkl. løsøre' },
      koeber_navne: { type: 'text[]', description: 'Købernavne (array)' },
      koeber_cvrs: { type: 'text[]', description: 'Køber-CVR numre (array)' },
    },
  },
  {
    table: 'public.ejerskifte_historik',
    description:
      'Ejerskifte-historik — 572K rækker. Alle ejerskifter med ejer, dato, pris. Brug ejendomshandel for bedre prisdata.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer' },
      overtagelsesdato: { type: 'date', description: 'Overtagelsesdato' },
      ejer_navn: { type: 'text', description: 'Ejer-navn' },
      ejer_cvr: { type: 'text', description: 'Ejer-CVR (null for personer)' },
      ejer_type: { type: 'text', description: 'person / virksomhed' },
      kontant_koebesum: { type: 'bigint', description: 'Kontant købesum i DKK' },
      i_alt_koebesum: { type: 'bigint', description: 'Samlet købesum i DKK' },
    },
  },
  {
    table: 'public.tinglysning_adkomst',
    description: 'Tinglysning adkomster — normaliserede skøder med salgspriser og ejerskifter.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'BFE-nummer' },
      ejer_navn: { type: 'text', description: 'Ejer/køber-navn' },
      ejer_cvr: { type: 'text', description: 'CVR-nummer' },
      overtagelsesdato: { type: 'date', description: 'Overtagelsesdato' },
      kontant_koebesum: { type: 'bigint', description: 'Kontant købesum DKK' },
      i_alt_koebesum: { type: 'bigint', description: 'Samlet købesum DKK' },
    },
  },
  {
    table: 'public.cvr_deltager',
    description:
      'CVR personer/deltagere — navne, roller, aktive selskaber. Brug til person-søgning.',
    columns: {
      enhedsnummer: { type: 'bigint', description: 'Person enhedsNummer (primærnøgle)' },
      navn: { type: 'text', description: 'Fuldt navn' },
      is_aktiv: { type: 'boolean', description: 'Har aktive roller' },
      antal_aktive_selskaber: { type: 'integer', description: 'Antal aktive virksomheder' },
    },
  },
  {
    table: 'public.cvr_deltagerrelation',
    description: 'Person-virksomhed relationer — hvem har hvilke roller i hvilke virksomheder.',
    columns: {
      virksomhed_cvr: { type: 'text', description: 'CVR-nummer på virksomhed' },
      deltager_enhedsnummer: { type: 'bigint', description: 'Person enhedsNummer' },
      type: { type: 'text', description: 'Rolletype (register, direktør, bestyrelsesmedlem osv.)' },
      gyldig_fra: { type: 'date', description: 'Rolle gyldig fra' },
      gyldig_til: { type: 'date', description: 'Rolle gyldig til (null = aktiv)' },
      ejerandel_pct: {
        type: 'numeric',
        description: 'Ejerandel i procent (kun for register-type)',
      },
    },
  },
  {
    table: 'public.ejf_administrator',
    description:
      'Ejendomsadministratorer — ejerforeninger, udlejere, advokater der administrerer ejendomme.',
    columns: {
      bfe_nummer: { type: 'bigint', description: 'Den administrerede ejendoms BFE' },
      administrator_type: { type: 'text', description: 'virksomhed / person / ukendt' },
      virksomhed_cvr: { type: 'text', description: 'CVR for virksomheds-administratorer' },
      person_navn: { type: 'text', description: 'Navn for person-administratorer' },
      status: { type: 'text', description: 'gældende / historisk' },
    },
  },
];

/**
 * Genererer SQL schema-beskrivelse til Claude's system prompt.
 *
 * @returns Formateret tekstbeskrivelse af alle tilgængelige tabeller
 */
export function generateSchemaDescription(): string {
  return WHITELISTED_TABLES.map((t) => {
    const cols = Object.entries(t.columns)
      .map(([name, { type, description }]) => `  - ${name} (${type}): ${description}`)
      .join('\n');
    return `TABLE: ${t.table}\n  ${t.description}\n  Kolonner:\n${cols}`;
  }).join('\n\n');
}

/**
 * Validerer at en SQL-query kun bruger tilladte tabeller og kolonner.
 *
 * SIMPEL validering — tjekker at alle FROM/JOIN targets er whitelistede
 * og at der ikke er destruktive operationer.
 *
 * @param sql - SQL-query der skal valideres
 * @returns Fejlbesked eller null hvis valid
 */
export function validateQuery(sql: string): string | null {
  const upper = sql.toUpperCase().trim();

  /* Blokér destruktive operationer */
  const forbidden = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'ALTER',
    'CREATE',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
  ];
  for (const kw of forbidden) {
    if (upper.startsWith(kw) || new RegExp(`\\b${kw}\\b`).test(upper)) {
      return `Forbudt operation: ${kw}. Kun SELECT er tilladt.`;
    }
  }

  if (!upper.startsWith('SELECT')) {
    return 'Kun SELECT-queries er tilladt.';
  }

  /* Tjek at alle refererede tabeller er whitelistede */
  const allowedTables = WHITELISTED_TABLES.map((t) => t.table.toLowerCase());
  const allowedTableNames = WHITELISTED_TABLES.map((t) => t.table.split('.')[1].toLowerCase());

  /* Simpel FROM/JOIN extraction */
  const tableRefs = sql.match(/(?:FROM|JOIN)\s+([a-zA-Z_.]+)/gi) ?? [];
  for (const ref of tableRefs) {
    const tableName = ref
      .replace(/^(?:FROM|JOIN)\s+/i, '')
      .toLowerCase()
      .trim();
    if (!allowedTables.includes(tableName) && !allowedTableNames.includes(tableName)) {
      return `Tabel "${tableName}" er ikke tilladt. Tilladte tabeller: ${allowedTables.join(', ')}`;
    }
  }

  return null;
}
