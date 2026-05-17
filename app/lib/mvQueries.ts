/**
 * MV Query Helpers — BIZZ-1474, BIZZ-1475
 *
 * Pre-joined materialized view queries der eliminerer N+1 patterns
 * i diagram/expand og ejendomme-by-owner. Brug disse i stedet for
 * separate ejf_ejerskab + cvr_virksomhed + cvr_deltager queries.
 *
 * @module app/lib/mvQueries
 */

import { createAdminClient } from '@/lib/supabase/admin';

/** Ejerskab beriget med virksomheds- og person-info. */
export interface EjerskabBeriget {
  bfe_nummer: number;
  ejer_navn: string | null;
  ejer_cvr: string | null;
  ejer_type: string | null;
  ejerandel_pct: number | null;
  ejerandel_taeller: number | null;
  ejerandel_naevner: number | null;
  virkning_fra: string | null;
  virksomhed_navn: string | null;
  virksomhedsform: string | null;
  branche_tekst: string | null;
  branche_kode: string | null;
  virksomhed_status: string | null;
  person_enhedsnummer: string | null;
}

/** Virksomhedsstruktur (ejer-ejet relationer). */
export interface VirksomhedStruktur {
  ejer_cvr: string;
  ejer_navn: string | null;
  ejer_form: string | null;
  ejer_branche: string | null;
  ejer_status: string | null;
  ejet_cvr: string;
  ejet_navn: string | null;
  ejet_form: string | null;
  ejet_branche: string | null;
  ejet_status: string | null;
  ejerandel_min: number | null;
  ejerandel_max: number | null;
  ejerandel_pct: number | null;
}

/** Deltager beriget med navn og rolle-info. */
export interface DeltagerBeriget {
  virksomhed_cvr: string;
  deltager_enhedsnummer: string;
  deltager_navn: string | null;
  relation_type: string | null;
  ejer_cvr: string | null;
  ejerandel_pct: number | null;
  antal_aktive_selskaber: number | null;
}

/**
 * Hent alle gældende ejerskaber for en virksomhed (via CVR).
 *
 * @param cvr - Virksomhedens CVR-nummer
 * @param limit - Max antal resultater
 */
export async function getEjerskaberByCvr(cvr: string, limit = 50): Promise<EjerskabBeriget[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('mv_ejerskab_beriget')
    .select('*')
    .eq('ejer_cvr', cvr)
    .limit(limit);
  if (error || !data) return [];
  return data as EjerskabBeriget[];
}

/**
 * Hent alle gældende ejerskaber for en person (via enhedsNummer).
 *
 * @param enhedsNummer - Personens enhedsnummer
 * @param limit - Max antal resultater
 */
export async function getEjerskaberByPerson(
  enhedsNummer: string,
  limit = 50
): Promise<EjerskabBeriget[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('mv_ejerskab_beriget')
    .select('*')
    .eq('person_enhedsnummer', enhedsNummer)
    .limit(limit);
  if (error || !data) return [];
  return data as EjerskabBeriget[];
}

/**
 * Hent alle ejerskaber for et BFE-nummer (alle ejere af en ejendom).
 *
 * @param bfe - BFE-nummer
 */
export async function getEjereByBfe(bfe: number): Promise<EjerskabBeriget[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin.from('mv_ejerskab_beriget').select('*').eq('bfe_nummer', bfe);
  if (error || !data) return [];
  return data as EjerskabBeriget[];
}

/**
 * Hent virksomhedsstruktur: hvem ejer dette CVR (opad).
 *
 * @param ejetCvr - CVR-nummer der ejes
 */
export async function getOwnersOf(ejetCvr: string): Promise<VirksomhedStruktur[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('mv_virksomhed_struktur')
    .select('*')
    .eq('ejet_cvr', ejetCvr);
  if (error || !data) return [];
  return data as VirksomhedStruktur[];
}

/**
 * Hent virksomhedsstruktur: hvad ejer dette CVR (nedad).
 *
 * @param ejerCvr - CVR-nummer der ejer
 */
export async function getSubsidiariesOf(ejerCvr: string): Promise<VirksomhedStruktur[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('mv_virksomhed_struktur')
    .select('*')
    .eq('ejer_cvr', ejerCvr);
  if (error || !data) return [];
  return data as VirksomhedStruktur[];
}

/**
 * Hent deltagere (personer) for en virksomhed.
 *
 * @param cvr - Virksomhedens CVR-nummer
 */
export async function getDeltagereByCvr(cvr: string): Promise<DeltagerBeriget[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('mv_deltager_beriget')
    .select('*')
    .eq('virksomhed_cvr', cvr);
  if (error || !data) return [];
  return data as DeltagerBeriget[];
}

/**
 * Hent virksomheder en person er tilknyttet.
 *
 * @param enhedsNummer - Personens enhedsnummer
 */
export async function getVirksomhederByDeltager(enhedsNummer: string): Promise<DeltagerBeriget[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const { data, error } = await admin
    .from('mv_deltager_beriget')
    .select('*')
    .eq('deltager_enhedsnummer', enhedsNummer);
  if (error || !data) return [];
  return data as DeltagerBeriget[];
}
