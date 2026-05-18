/**
 * Forsikrings-modul — fælles typer og Zod-schemas.
 *
 * Strukturen matcher database-tabellerne fra migration 096:
 *   forsikring_documents  → ForsikringDocument
 *   forsikring_policies   → ForsikringPolicy
 *   forsikring_coverages  → ForsikringCoverage
 *   forsikring_gaps       → ForsikringGap
 *
 * Parser-output (Claude → struktureret JSON) valideres mod
 * ParsedPolicySchema før det skrives til DB. Det giver os garanti for
 * at AI-output er well-formed selv hvis Claude hallucinerer felter.
 *
 * @module app/lib/forsikring/types
 */

import { z } from 'zod';

// ─── BIZZ-1392: Dokumenttype-detektion ──────────────────────────

/**
 * Dokumenttype detekteret i trin 1 af 2-trins parsing-pipeline.
 *
 * - police: individuel forsikringspolice → parse som hidtil (1 dok → 1 police)
 * - oversigt: forsikringsoversigt med flere policer → split til N policer
 * - tillaeg: tillæg/ændring til eksisterende police → match + opdatér
 * - tilbud: fornyelsestilbud → udtrák info til notes
 * - korrespondance: brev/email → udtrák info til notes
 * - ukendt: kan ikke klassificeres → vis advarsel
 */
export type DocumentType =
  | 'police'
  | 'oversigt'
  | 'tillaeg'
  | 'tilbud'
  | 'korrespondance'
  | 'ukendt';

/** Resultat fra trin 1: dokumenttype-detektion */
export interface DocumentTypeDetection {
  type: DocumentType;
  confidence: number;
  reason: string;
  /** Antal policer detekteret (kun relevant for oversigt-type) */
  policy_count?: number;
  /** BIZZ-1404: Token-forbrug fra Claude-kald */
  tokenUsage?: { input: number; output: number };
}

/** Oversigt-entry: en police uddraget fra en forsikringsoversigt */
export const ParsedOversigtsEntrySchema = z.object({
  policy_number: z.string().min(1).max(100),
  insurer_name: z.string().min(1).max(200),
  insurer_cvr: z.string().max(20).nullable().optional(),
  policyholder_name: z.string().min(1).max(200),
  policyholder_cvr: z.string().max(20).nullable().optional(),
  property_address: z.string().max(500).nullable().optional(),
  insurance_type: z.string().max(200).nullable().optional(),
  annual_premium_dkk: z.number().int().nonnegative().nullable().optional(),
  sum_insured_dkk: z.number().int().nonnegative().nullable().optional(),
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  effective_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export type ParsedOversigtsEntry = z.infer<typeof ParsedOversigtsEntrySchema>;

/** Schema for oversigt-parsing output: array of entries */
export const ParsedOvesigtSchema = z.object({
  policies: z.array(ParsedOversigtsEntrySchema).min(1).max(50),
  broker_name: z.string().max(200).nullable().optional(),
  overview_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  notes: z.string().max(5000).nullable().optional(),
});

export type ParsedOversigt = z.infer<typeof ParsedOvesigtSchema>;

// ─── Database row types ──────────────────────────────────────────

/** Status for PDF-parsing */
export type ParseStatus = 'pending' | 'parsing' | 'parsed' | 'failed';

/** Hvordan forsikringssummen er beregnet */
export type InsuranceForm = 'nyvaerdi' | 'sum' | 'f_risiko' | 'nedrivning' | 'uforsikret';

/** Severity-niveau for en gap-detektion */
export type GapSeverity = 'info' | 'warning' | 'critical';

/** Uploaded PDF-fil */
export interface ForsikringDocument {
  id: string;
  tenant_id: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  parse_status: ParseStatus;
  parse_error: string | null;
  policy_id: string | null;
  uploaded_by: string | null;
  /** BIZZ-1632: Kunde-ID for at isolere dokumenter per kunde */
  kunde_id: string | null;
  /** BIZZ-1399: Sag-ID (forsikringssag) */
  sag_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Struktureret police efter parsing */
export interface ForsikringPolicy {
  id: string;
  tenant_id: string;
  document_id: string | null;
  policy_number: string;
  insurer_name: string;
  insurer_cvr: string | null;
  broker_name: string | null;
  policyholder_name: string;
  policyholder_cvr: string | null;
  policyholder_address: string | null;
  property_address: string | null;
  property_matrikel: string | null;
  property_bfe: string | null;
  property_entity_id: string | null;
  business_activity: string | null;
  building_use: string | null;
  building_area_m2: number | null;
  building_floors: number | null;
  building_year_built: number | null;
  building_has_basement: boolean | null;
  insurance_form: InsuranceForm | null;
  sum_insured_dkk: number | null;
  annual_premium_dkk: number | null;
  general_deductible_dkk: number | null;
  effective_from: string | null;
  effective_to: string | null;
  main_renewal_date: string | null;
  policy_issued_date: string | null;
  raw_metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Enkelt dækning på en police */
export interface ForsikringCoverage {
  id: string;
  tenant_id: string;
  policy_id: string;
  coverage_code: string;
  coverage_label: string;
  is_covered: boolean;
  sum_dkk: number | null;
  deductible_dkk: number | null;
  conditions_ref: string | null;
  notes: string | null;
  created_at: string;
}

/** Gap-detektion fra analyse-engine */
export interface ForsikringGap {
  id: string;
  tenant_id: string;
  policy_id: string;
  check_id: string;
  category: string;
  severity: GapSeverity;
  title: string;
  description: string;
  recommendation: string | null;
  estimated_impact_dkk: number | null;
  source_data: Record<string, unknown>;
  is_resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

// ─── Standard coverage codes ─────────────────────────────────────

/**
 * Kanonisk liste af dækningskoder vi normaliserer til når vi parser.
 * Holder gap-engine konsistent på tværs af forsikringsselskaber.
 */
export const COVERAGE_CODES = [
  'brand_el',
  'bygningskasko',
  'udvidet_roerskade',
  'glas',
  'sanitet',
  'insekt_svamp',
  'restvaerdi',
  'stikledning',
  'jordskade',
  'lovliggoerelse',
  'huslejetab',
  'haerverk',
  'omstilling_laase',
  'hus_grundejer_ansvar',
  'forurening',
  'driftstab',
  'erhvervsansvar',
] as const;

export type CoverageCode = (typeof COVERAGE_CODES)[number];

/** Menneskelæsbare labels (DA) for hver dækningskode */
export const COVERAGE_LABELS_DA: Record<CoverageCode, string> = {
  brand_el: 'Brand inkl. el-skade',
  bygningskasko: 'Bygningskasko',
  udvidet_roerskade: 'Udvidet rørskade',
  glas: 'Glas',
  sanitet: 'Sanitet',
  insekt_svamp: 'Insekt og svamp',
  restvaerdi: 'Restværdi',
  stikledning: 'Stikledning',
  jordskade: 'Jordskade',
  lovliggoerelse: 'Lovliggørelse',
  huslejetab: 'Huslejetab',
  haerverk: 'Hærværk',
  omstilling_laase: 'Omstilling af låse',
  hus_grundejer_ansvar: 'Hus- og grundejeransvar',
  forurening: 'Forurening',
  driftstab: 'Driftstab',
  erhvervsansvar: 'Erhvervsansvar',
};

// ─── Parser output schema (Claude → JSON) ────────────────────────

/**
 * Zod-schema for hvad Claude returnerer fra PDF-parser.
 * Alle felter er optional fordi PDF'er varierer i kvalitet — vi
 * accepterer delvise data og lader gap-engine flagge mangler.
 */
export const ParsedCoverageSchema = z.object({
  coverage_code: z.enum(COVERAGE_CODES),
  coverage_label: z.string().min(1).max(200),
  is_covered: z.boolean(),
  sum_dkk: z.number().int().nonnegative().nullable().optional(),
  deductible_dkk: z.number().int().nonnegative().nullable().optional(),
  conditions_ref: z.string().max(100).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export type ParsedCoverage = z.infer<typeof ParsedCoverageSchema>;

export const ParsedPolicySchema = z.object({
  policy_number: z.string().min(1).max(100),
  insurer_name: z.string().min(1).max(200),
  insurer_cvr: z.string().max(20).nullable().optional(),
  broker_name: z.string().max(200).nullable().optional(),
  policyholder_name: z.string().min(1).max(200),
  policyholder_cvr: z.string().max(20).nullable().optional(),
  policyholder_address: z.string().max(500).nullable().optional(),
  property_address: z.string().max(500).nullable().optional(),
  property_matrikel: z.string().max(100).nullable().optional(),
  property_bfe: z.string().max(50).nullable().optional(),
  business_activity: z.string().max(200).nullable().optional(),
  building_use: z.string().max(200).nullable().optional(),
  building_area_m2: z.number().int().nonnegative().nullable().optional(),
  building_floors: z.number().int().min(0).max(50).nullable().optional(),
  building_year_built: z.number().int().min(1500).max(2100).nullable().optional(),
  building_has_basement: z.boolean().nullable().optional(),
  insurance_form: z
    .enum(['nyvaerdi', 'sum', 'f_risiko', 'nedrivning', 'uforsikret'])
    .nullable()
    .optional(),
  sum_insured_dkk: z.number().int().nonnegative().nullable().optional(),
  annual_premium_dkk: z.number().int().nonnegative().nullable().optional(),
  general_deductible_dkk: z.number().int().nonnegative().nullable().optional(),
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  effective_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  main_renewal_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  policy_issued_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
  coverages: z.array(ParsedCoverageSchema).max(50),
  /** Frie noter fra parser (særlige forhold, besigtigelses-bemærkninger, etc.) */
  notes: z.string().max(5000).nullable().optional(),
});

export type ParsedPolicy = z.infer<typeof ParsedPolicySchema>;

// ─── BBR-data input til gap-engine ───────────────────────────────

/**
 * Subset af BBR-data som gap-engine bruger til sammenligning.
 * Hentes via eksisterende `hent_bbr_data` AI-tool eller direkte fra
 * BBR-API. Felterne er nullable for at understøtte ufuldstændig data.
 */
export interface BbrPropertyFacts {
  bfe: string | null;
  matrikel: string | null;
  bebygget_areal_m2: number | null;
  antal_etager: number | null;
  opfoert_aar: number | null;
  has_kaelder: boolean | null;
  anvendelseskode: string | null;
  anvendelse_label: string | null;
  /** Tagdaekningsmateriale-kode (BBR byg033). 6/7 = strå/rør (blødt tag) */
  tag_materiale_kode: string | null;
}

// ─── Gap-engine input/output ─────────────────────────────────────

/**
 * Input til gap-engine. Policy + (valgfri) BBR-fakta + dato.
 * Hvis bbr er null springer vi BBR-relaterede checks over.
 */
export interface GapEngineInput {
  policy: ForsikringPolicy;
  coverages: ForsikringCoverage[];
  bbr: BbrPropertyFacts | null;
  /** Hvilken dato analyse er kørt — bruges til "udløber snart"-check */
  asOfDate: Date;
  /** BIZZ-1377: Branchekoder fra CVR (til branchekode-baserede checks) */
  branche?: {
    hovedbranche: string | null;
    hovedbranche_tekst: string | null;
    bibrancher: Array<{ kode: string; tekst: string | null }>;
  };
  /** BIZZ-1364: Optionelt asset fra koncern-walk (til asset-level checks) */
  asset?: {
    type: 'ejendom' | 'virksomhed' | 'bil' | 'bestyrelsespost';
    vaerdiDkk?: number;
    haeftelserDkk?: number;
    byggeaar?: number;
    matchScore?: number;
    virksomhedsform?: string;
  };
}

/**
 * Detekteret gap. Genereres af gap-engine, persisteres i forsikring_gaps.
 * created_at sættes af DB; tenant_id, policy_id, id sættes af caller.
 */
export interface DetectedGap {
  check_id: string;
  category: string;
  severity: GapSeverity;
  title: string;
  description: string;
  recommendation: string | null;
  estimated_impact_dkk: number | null;
  source_data: Record<string, unknown>;
}
