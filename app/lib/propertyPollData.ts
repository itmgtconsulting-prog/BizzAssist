/**
 * Property-poll datakilder — app/lib/propertyPollData.ts
 *
 * Service-role datafunktioner som poll-properties-cronen bruger til at hente de
 * overvågede felter for en fulgt ejendom UDEN at gå gennem de auth-beskyttede
 * HTTP-routes (/api/ejendom, /api/ejerskab). Cronen kører uden brugersession, så
 * den læser i stedet:
 *   - BBR + BFE-nummer direkte via fetchBbrForAddress() (env-baseret DAF-adgang)
 *   - Gældende ejerskab direkte fra backfill-tabellen public.ejf_ejerskab
 *     (samme kilde som /api/ejerskab's cache-first-sti, BIZZ-1013)
 *
 * BIZZ-2194: tidligere kaldte poll-properties de authede routes server-to-server
 * med forkerte query-params (?id= i stedet for ?bfeNummer=) → 401/null, så
 * change-detektering virkede aldrig. Disse funktioner retter det.
 *
 * RESTRICTED — SERVER-SIDE ONLY (service_role).
 *
 * @module app/lib/propertyPollData
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { logger } from '@/app/lib/logger';

/** Overvåget BBR-snapshot + det opløste BFE-nummer for ejendommen */
export interface BbrPollSnapshot {
  /** BFE-nummer opløst fra ejendomsrelationer (null hvis ikke fundet) */
  bfe: number | null;
  /** Stabil delmængde af BBR-felter der overvåges for ændringer */
  monitored: Record<string, unknown>;
}

/**
 * Henter de overvågede BBR-felter + BFE-nummer for en DAWA-adresse via den
 * eksisterende service-role-funktion fetchBbrForAddress().
 *
 * @param dawaId - DAWA adresse-UUID (entity_id i saved_entities)
 * @returns BBR-snapshot + BFE, eller null ved fejl
 */
export async function fetchBbrPollSnapshot(dawaId: string): Promise<BbrPollSnapshot | null> {
  try {
    const data = await fetchBbrForAddress(dawaId);
    const bfe =
      data.ejendomsrelationer?.find((r) => r.bfeNummer != null)?.bfeNummer ??
      data.ejerlejlighedBfe ??
      data.moderBfe ??
      null;

    // Stabil projektion: kun felter der reelt ændrer sig ved en BBR-opdatering.
    // Sorteret på bygnings-id så hash er deterministisk uafhængigt af rækkefølge.
    const bygninger = (data.bbr ?? [])
      .map((b) => ({
        id: b.id,
        opfoerelsesaar: b.opfoerelsesaar,
        ombygningsaar: b.ombygningsaar,
        samletBygningsareal: b.samletBygningsareal,
        samletBoligareal: b.samletBoligareal,
        antalEtager: b.antalEtager,
        anvendelse: b.anvendelse,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return { bfe, monitored: { bygninger } };
  } catch (err) {
    logger.warn('[propertyPollData] fetchBbrPollSnapshot fejl:', err);
    return null;
  }
}

/** Et overvåget ejerskab-snapshot: de gældende ejere for et BFE */
export interface OwnershipPollSnapshot {
  ejere: Array<{
    navn: string | null;
    cvr: string | null;
    type: string | null;
    taeller: number | null;
    naevner: number | null;
  }>;
}

/**
 * Henter gældende ejerskab for et BFE direkte fra backfill-tabellen
 * public.ejf_ejerskab (service-role). Samme kilde som /api/ejerskab's
 * cache-first-sti, men uden HTTP/auth.
 *
 * @param bfe - BFE-nummer
 * @returns Sorteret liste af gældende ejere, eller null ved fejl
 */
export async function fetchOwnershipPollSnapshot(
  bfe: number
): Promise<OwnershipPollSnapshot | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('ejf_ejerskab')
      .select('ejer_navn, ejer_cvr, ejer_type, ejerandel_taeller, ejerandel_naevner')
      .eq('bfe_nummer', bfe)
      .eq('status', 'gældende');

    if (error) {
      logger.warn('[propertyPollData] ejf_ejerskab opslag fejl:', error.message);
      return null;
    }

    const ejere = (
      (data ?? []) as Array<{
        ejer_navn: string | null;
        ejer_cvr: string | null;
        ejer_type: string | null;
        ejerandel_taeller: number | null;
        ejerandel_naevner: number | null;
      }>
    )
      .map((r) => ({
        navn: r.ejer_navn,
        cvr: r.ejer_cvr,
        type: r.ejer_type,
        taeller: r.ejerandel_taeller,
        naevner: r.ejerandel_naevner,
      }))
      // Deterministisk rækkefølge → stabil hash uafhængigt af DB-rækkefølge
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    return { ejere };
  } catch (err) {
    logger.warn('[propertyPollData] fetchOwnershipPollSnapshot fejl:', err);
    return null;
  }
}

/** Et overvåget vurderings-snapshot: offentlige ejendoms-/grundværdier for et BFE */
export interface VurderingPollSnapshot {
  vurderinger: Array<{
    aar: number | null;
    grundvaerdi: number | null;
    ejendomvaerdi: number | null;
  }>;
}

/**
 * Henter de overvågede vurderings-felter for et BFE direkte fra den persistente
 * VUR-cache public.cache_vur (service-role). BIZZ-2202: poll-properties kunne
 * ikke overvåge vurdering før, fordi /api/vurdering kun har en in-memory LRU
 * uden persistent kilde cronen kan læse. cache_vur (vedligeholdt af
 * refresh-vur-cache) er netop den kilde.
 *
 * @param bfe - BFE-nummer
 * @returns Sorteret liste af (år, grundværdi, ejendomsværdi), eller null
 */
export async function fetchVurderingPollSnapshot(
  bfe: number
): Promise<VurderingPollSnapshot | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('cache_vur')
      .select('raw_data')
      .eq('bfe_nummer', bfe)
      .maybeSingle();

    if (error) {
      logger.warn('[propertyPollData] cache_vur opslag fejl:', error.message);
      return null;
    }
    if (!data?.raw_data) return null;

    const raw = data.raw_data as {
      vurderinger?: Array<{
        aar?: number | null;
        grundvaerdiBeloeb?: number | null;
        ejendomvaerdiBeloeb?: number | null;
      }>;
    };
    const vurderinger = (raw.vurderinger ?? [])
      .map((v) => ({
        aar: v.aar ?? null,
        grundvaerdi: v.grundvaerdiBeloeb ?? null,
        ejendomvaerdi: v.ejendomvaerdiBeloeb ?? null,
      }))
      // Deterministisk rækkefølge (år) → stabil hash uafhængigt af DB-rækkefølge
      .sort((a, b) => (a.aar ?? 0) - (b.aar ?? 0));

    return { vurderinger };
  } catch (err) {
    logger.warn('[propertyPollData] fetchVurderingPollSnapshot fejl:', err);
    return null;
  }
}

/** Overvåget CVR-snapshot: stamdata der ændrer sig ved en virksomheds-opdatering */
export interface CompanyPollSnapshot {
  monitored: Record<string, unknown>;
}

/**
 * Henter de overvågede CVR-stamdata for en virksomhed direkte fra
 * public.cvr_virksomhed (service-role). BIZZ-2201: giver følgere af en
 * virksomhed notifikation + mail ved ændringer i navn/status/form/branche/ophør.
 *
 * @param cvr - CVR-nummer (entity_id i saved_entities for entity_type=company)
 * @returns Stabil projektion af overvågede felter, eller null
 */
export async function fetchCompanyPollSnapshot(cvr: string): Promise<CompanyPollSnapshot | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('cvr_virksomhed')
      .select('navn, status, virksomhedsform, branche_kode, branche_tekst, ophoert')
      .eq('cvr', cvr)
      .maybeSingle();

    if (error) {
      logger.warn('[propertyPollData] cvr_virksomhed opslag fejl:', error.message);
      return null;
    }
    if (!data) return null;

    const r = data as Record<string, unknown>;

    // BIZZ-2265/2266: overvåg også virksomhedens ejerskaber, så følgere alarmeres
    // ved får/mister/ændret ejerskab. NB (verificeret 2026-09-06): ticketernes
    // kilde cvr_deltagerrelation.ejer_cvr er tom for aktive rækker — company↔company-
    // ejerskab ligger i cvr_virksomhed_ejerskab (ejer_cvr/ejet_cvr), person-ejere i
    // cvr_deltagerrelation type='register'. Vi projicerer de aktive relationer til
    // stabilt-sorterede "modpart:andel"-lister; enhver ændring i sættet ændrer hashen
    // → detectChange fyrer cvr-notifikation. Tomt sæt = stabil hash (ingen falsk alarm).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = admin as any;
    const CAP = 1000;
    // BIZZ-2265 (udgående): virksomheder DENNE virksomhed ejer
    const { data: udg } = await a
      .from('cvr_virksomhed_ejerskab')
      .select('ejet_cvr, ejerandel_pct')
      .eq('ejer_cvr', cvr)
      .is('gyldig_til', null)
      .order('ejet_cvr', { ascending: true })
      .limit(CAP);
    // BIZZ-2266 (indgående): virksomheds-ejere af DENNE virksomhed
    const { data: indgVirk } = await a
      .from('cvr_virksomhed_ejerskab')
      .select('ejer_cvr, ejerandel_pct')
      .eq('ejet_cvr', cvr)
      .is('gyldig_til', null)
      .order('ejer_cvr', { ascending: true })
      .limit(CAP);
    // BIZZ-2266 (indgående): person/register-ejere af DENNE virksomhed
    const { data: indgPers } = await a
      .from('cvr_deltagerrelation')
      .select('deltager_enhedsnummer, ejerandel_pct')
      .eq('virksomhed_cvr', cvr)
      .eq('type', 'register')
      .is('gyldig_til', null)
      .not('ejerandel_pct', 'is', null)
      .order('deltager_enhedsnummer', { ascending: true })
      .limit(CAP);

    /** Projicér relationer til stabile "modpart:andel"-strenge (deterministisk hash). */
    const proj = (rows: Record<string, unknown>[] | null, key: string): string[] =>
      (rows ?? []).map((row) => `${row[key] ?? ''}:${row.ejerandel_pct ?? ''}`);

    return {
      monitored: {
        navn: r.navn ?? null,
        status: r.status ?? null,
        virksomhedsform: r.virksomhedsform ?? null,
        branche_kode: r.branche_kode ?? null,
        branche_tekst: r.branche_tekst ?? null,
        ophoert: r.ophoert ?? null,
        // BIZZ-2265: udgående ejerskaber (ejet_cvr:andel)
        ejer_af: proj(udg, 'ejet_cvr'),
        // BIZZ-2266: indgående ejerkreds — virksomheds-ejere + person/register-ejere
        ejet_af_virksomheder: proj(indgVirk, 'ejer_cvr'),
        ejet_af_personer: proj(indgPers, 'deltager_enhedsnummer'),
      },
    };
  } catch (err) {
    logger.warn('[propertyPollData] fetchCompanyPollSnapshot fejl:', err);
    return null;
  }
}

/** Overvåget person-snapshot: personens aktive roller (ændres ved rolle-skift) */
export interface PersonPollSnapshot {
  monitored: Record<string, unknown>;
}

/**
 * Henter de overvågede felter for en person direkte fra public.cvr_deltager
 * (service-role). BIZZ-2201: giver følgere af en person notifikation + mail når
 * personens aktive roller/ejerskab ændrer sig (nye/ophørte roller).
 *
 * @param enhedsnummer - CVR-deltager-enhedsnummer (entity_id for entity_type=person)
 * @returns Stabil projektion af aktive roller + rolle-antal, eller null
 */
export async function fetchPersonPollSnapshot(
  enhedsnummer: string
): Promise<PersonPollSnapshot | null> {
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from('cvr_deltager')
      .select('navn, aktive_roller_json, role_typer, totalt_antal_roller')
      .eq('enhedsnummer', enhedsnummer)
      .maybeSingle();

    if (error) {
      logger.warn('[propertyPollData] cvr_deltager opslag fejl:', error.message);
      return null;
    }
    if (!data) return null;

    const r = data as Record<string, unknown>;
    // role_typer kan være et array — sortér for deterministisk hash.
    const roleTyper = Array.isArray(r.role_typer)
      ? [...(r.role_typer as unknown[])].map(String).sort()
      : (r.role_typer ?? null);
    return {
      monitored: {
        navn: r.navn ?? null,
        aktive_roller: r.aktive_roller_json ?? null,
        role_typer: roleTyper,
        totalt_antal_roller: r.totalt_antal_roller ?? null,
      },
    };
  } catch (err) {
    logger.warn('[propertyPollData] fetchPersonPollSnapshot fejl:', err);
    return null;
  }
}
