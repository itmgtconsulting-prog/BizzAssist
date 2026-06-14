/**
 * Tenant-scoped insurance database client — lib/db/insurance.ts
 *
 * SERVER-SIDE ONLY. Bygger oven på getTenantContext() patternet fra
 * lib/db/tenant.ts og giver typede CRUD-operationer for forsikrings-
 * modulets fire tabeller (migration 096).
 *
 * Sikkerhed: Tenant-membership verificeres af getTenantContext før
 * dette modul kaldes. Alle queries inkluderer eksplicit tenant_id
 * filter som defence-in-depth.
 *
 * @module lib/db/insurance
 */

import { createAdminClient, type TenantDb } from '@/lib/supabase/admin';
import { getTenantSchemaName, verifyTenantAccess } from '@/lib/db/tenant';
import type {
  ForsikringDocument,
  ForsikringPolicy,
  ForsikringCoverage,
  ForsikringGap,
  ParseStatus,
  GapSeverity,
  InsuranceForm,
} from '@/app/lib/forsikring/types';

// ─── Typed admin client helper ───────────────────────────────────

/**
 * Returnér en admin-client scoped til tenantens schema. Cast er sikkert
 * fordi schemaName er valideret før vi når her (stammer fra
 * getTenantSchemaName som læser fra public.tenants).
 *
 * @internal
 */
function tenantDb(admin: ReturnType<typeof createAdminClient>, schemaName: string): TenantDb {
  return admin.schema(schemaName as 'tenant');
}

// ─── Insert/update payload types ─────────────────────────────────

/** Payload til at oprette et nyt PDF-dokument */
export interface CreateDocumentInput {
  storage_path: string;
  original_name: string;
  mime_type?: string;
  size_bytes: number;
  uploaded_by: string;
  /** BIZZ-1399: Optionelt link til kundesag */
  sag_id?: string;
  /** BIZZ-1632: Kunde-ID for at isolere dokumenter per kunde */
  kunde_id?: string;
}

/** Payload til at oprette en parsed police (efter Claude-parsing) */
export interface CreatePolicyInput {
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
  created_by: string;
  /** BIZZ-1399: Optionelt link til kundesag */
  sag_id?: string;
}

/** Payload til at oprette en dækning */
export interface CreateCoverageInput {
  policy_id: string;
  coverage_code: string;
  coverage_label: string;
  is_covered: boolean;
  sum_dkk: number | null;
  deductible_dkk: number | null;
  conditions_ref: string | null;
  notes: string | null;
}

/** Payload til at oprette en gap-detektion */
export interface CreateGapInput {
  policy_id: string;
  check_id: string;
  category: string;
  severity: GapSeverity;
  title: string;
  description: string;
  recommendation: string | null;
  estimated_impact_dkk: number | null;
  source_data: Record<string, unknown>;
}

// ─── Insurance API ───────────────────────────────────────────────

/**
 * Forsikrings-API. Hver metode er tenant-scoped og verificerer
 * membership ved første kald.
 */
export interface InsuranceApi {
  /** Documents — uploaded PDF files */
  documents: {
    /** Hent alle dokumenter (sorteret nyeste først) */
    list(): Promise<ForsikringDocument[]>;
    /** Hent ét dokument by id */
    get(id: string): Promise<ForsikringDocument | null>;
    /** Opret nyt dokument efter Storage-upload */
    create(input: CreateDocumentInput): Promise<ForsikringDocument>;
    /** Opdater parse-status (parsing → parsed/failed) */
    updateParseStatus(
      id: string,
      status: ParseStatus,
      opts?: { error?: string; extractedText?: string; policyId?: string }
    ): Promise<void>;
    /** Slet ét dokument by id */
    delete(id: string): Promise<void>;
    /** Slet ALLE dokumenter for tenant (bulk reset) */
    deleteAll(): Promise<string[]>;
  };
  /** Policies — strukturerede police-data */
  policies: {
    /** Hent alle policer for tenant */
    list(): Promise<ForsikringPolicy[]>;
    /** Hent én police by id */
    get(id: string): Promise<ForsikringPolicy | null>;
    /** BIZZ-1395: Find eksisterende police by normaliseret policenummer (dedup) */
    findByNumber(policyNumber: string): Promise<ForsikringPolicy | null>;
    /** BIZZ-2097: Find ALLE policer med samme normaliserede policenummer (multi-type aftaler) */
    findAllByNumber(policyNumber: string): Promise<ForsikringPolicy[]>;
    /** Opret ny police */
    create(input: CreatePolicyInput): Promise<ForsikringPolicy>;
    /** Slet en police (cascade-sletter coverages og gaps) */
    delete(id: string): Promise<void>;
  };
  /** Coverages — enkelte dækninger på en police */
  coverages: {
    /** Hent alle dækninger for en police */
    listForPolicy(policyId: string): Promise<ForsikringCoverage[]>;
    /** Bulk-insert dækninger (typisk efter parsing) */
    bulkCreate(inputs: CreateCoverageInput[]): Promise<ForsikringCoverage[]>;
    /** Slet alle dækninger for en police (bruges før re-parse) */
    deleteForPolicy(policyId: string): Promise<void>;
  };
  /** Gaps — detekterede mangler/risici */
  gaps: {
    /** Hent alle gaps for en police */
    listForPolicy(policyId: string): Promise<ForsikringGap[]>;
    /** Bulk-insert gaps (typisk efter analyse-kørsel) */
    bulkCreate(inputs: CreateGapInput[]): Promise<ForsikringGap[]>;
    /** Slet alle gaps for en police (bruges før re-analyse) */
    deleteForPolicy(policyId: string): Promise<void>;
    /** Marker en gap som løst */
    markResolved(id: string, userId: string): Promise<void>;
    /** BIZZ-1404: Hent gaps scoped til en specifik analyse */
    listForAnalysis(analyseId: string): Promise<ForsikringGap[]>;
  };
  /** BIZZ-1404: Analyse-dokument junction (many-to-many) */
  analyseDocuments: {
    /** Link et dokument til en analyse */
    link(analyseId: string, documentId: string, source: 'uploaded' | 'reused'): Promise<void>;
    /** List dokumenter for en analyse */
    listForAnalysis(analyseId: string): Promise<Array<ForsikringDocument & { source: string }>>;
    /** List alle dokumenter på tværs af analyser for en kunde */
    listForCustomer(
      kundeId: string
    ): Promise<Array<ForsikringDocument & { from_analyse_id: string }>>;
  };
}

/**
 * Returnér en insurance-API for den givne tenant. Verificerer membership
 * og returnerer typed CRUD-API mod tenantens schema.
 *
 * @param tenantId - UUID for tenant (fra valideret auth-session)
 * @returns InsuranceApi
 * @throws hvis user ikke er medlem af tenant
 */
export async function getInsuranceApi(tenantId: string): Promise<InsuranceApi> {
  await verifyTenantAccess(tenantId);
  const schemaName = await getTenantSchemaName(tenantId);
  const admin = createAdminClient();

  return {
    documents: {
      async list() {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false });
        if (error) throw new Error(`forsikring_documents.list: ${error.message}`);
        return (data ?? []) as ForsikringDocument[];
      },
      async get(id) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .select('*')
          .eq('id', id)
          .eq('tenant_id', tenantId)
          .single();
        if (error) return null;
        return data as ForsikringDocument;
      },
      async create(input) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .insert({
            ...input,
            mime_type: input.mime_type ?? 'application/pdf',
            tenant_id: tenantId,
          })
          .select('*')
          .single();
        if (error) throw new Error(`forsikring_documents.create: ${error.message}`);
        return data as ForsikringDocument;
      },
      async updateParseStatus(id, status, opts) {
        const update: Record<string, unknown> = { parse_status: status };
        if (opts?.error !== undefined) update.parse_error = opts.error;
        if (opts?.extractedText !== undefined) update.extracted_text = opts.extractedText;
        if (opts?.policyId !== undefined) update.policy_id = opts.policyId;
        const { error } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .update(update)
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) {
          throw new Error(`forsikring_documents.updateParseStatus: ${error.message}`);
        }
      },
      async delete(id) {
        // BIZZ-2126: Cascade-slet dokumentets policer FØR selve dokumentet.
        // FK'en er ON DELETE SET NULL, så uden dette efterlades policerne
        // forældreløse (document_id=NULL) — de forgifter re-parse-dedup'en og
        // er usynlige for analysen (som scoper på document_id). Coverages og
        // gaps fjernes automatisk via deres egen ON DELETE CASCADE på policy_id.
        await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('document_id', id);
        const { error } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .delete()
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) throw new Error(`forsikring_documents.delete: ${error.message}`);
      },
      async deleteAll() {
        const { data } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .select('id, storage_path')
          .eq('tenant_id', tenantId);
        const ids = (data ?? []).map((d: { id: string }) => d.id);
        const paths = (data ?? [])
          .map((d: { storage_path: string }) => d.storage_path)
          .filter(Boolean);
        if (ids.length > 0) {
          // BIZZ-2126: Cascade-slet alle policer (de tilhører dokumenterne der
          // slettes) før dokumenterne — ellers efterlades de forældreløse.
          await tenantDb(admin, schemaName)
            .from('forsikring_policies')
            .delete()
            .eq('tenant_id', tenantId);
          await tenantDb(admin, schemaName)
            .from('forsikring_documents')
            .delete()
            .eq('tenant_id', tenantId);
        }
        return paths as string[];
      },
    },

    policies: {
      async list() {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .select('*')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false });
        if (error) throw new Error(`forsikring_policies.list: ${error.message}`);
        return (data ?? []) as ForsikringPolicy[];
      },
      /**
       * BIZZ-1395: Find eksisterende police by normaliseret policenummer.
       * Bruges til dedup ved re-parsing af oversigter/individuelle policer.
       *
       * @param policyNumber - Normaliseret policenummer (uden ledende nuller)
       * @returns Eksisterende police eller null
       */
      async findByNumber(policyNumber: string) {
        // Normalisér: fjern ledende nuller og mellemrum
        const normalized = policyNumber.replace(/^0+/, '').replace(/\s+/g, '');
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .select('*')
          .eq('tenant_id', tenantId)
          // BIZZ-2126: Ignorér forældreløse policer (document_id=NULL fra slettede
          // dokumenter) i dedup — ellers blokerer de gen-oprettelse ved re-parse.
          .not('document_id', 'is', null)
          .or(
            `policy_number.eq.${normalized},policy_number.eq.0${normalized},policy_number.eq.00${normalized}`
          )
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return null;
        return data as ForsikringPolicy | null;
      },
      /**
       * BIZZ-2097: Find ALLE policer med samme normaliserede policenummer.
       * Flere forsikringstyper kan dele aftalenummer (fx Topdanmark-aftaler med
       * Cyber + Netbank + Driftstab) — dedup skal sammenligne mod dem alle,
       * ikke kun den senest oprettede.
       *
       * @param policyNumber - Normaliseret policenummer (uden ledende nuller)
       * @returns Alle eksisterende policer med det nummer (nyeste først)
       */
      async findAllByNumber(policyNumber: string) {
        // Normalisér: fjern ledende nuller og mellemrum
        const normalized = policyNumber.replace(/^0+/, '').replace(/\s+/g, '');
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .select('*')
          .eq('tenant_id', tenantId)
          // BIZZ-2126: Ignorér forældreløse policer (document_id=NULL fra slettede
          // dokumenter) i dedup — ellers blokerer de gen-oprettelse ved re-parse.
          .not('document_id', 'is', null)
          .or(
            `policy_number.eq.${normalized},policy_number.eq.0${normalized},policy_number.eq.00${normalized}`
          )
          .order('created_at', { ascending: false });
        if (error) return [];
        return (data ?? []) as ForsikringPolicy[];
      },
      async get(id) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .select('*')
          .eq('id', id)
          .eq('tenant_id', tenantId)
          .single();
        if (error) return null;
        return data as ForsikringPolicy;
      },
      async create(input) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .insert({ ...input, tenant_id: tenantId })
          .select('*')
          .single();
        if (error) throw new Error(`forsikring_policies.create: ${error.message}`);
        return data as ForsikringPolicy;
      },
      async delete(id) {
        const { error } = await tenantDb(admin, schemaName)
          .from('forsikring_policies')
          .delete()
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) throw new Error(`forsikring_policies.delete: ${error.message}`);
      },
    },

    coverages: {
      async listForPolicy(policyId) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_coverages')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('policy_id', policyId)
          .order('coverage_code');
        if (error) throw new Error(`forsikring_coverages.list: ${error.message}`);
        return (data ?? []) as ForsikringCoverage[];
      },
      async bulkCreate(inputs) {
        if (inputs.length === 0) return [];
        const rows = inputs.map((c) => ({ ...c, tenant_id: tenantId }));
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_coverages')
          .insert(rows)
          .select('*');
        if (error) throw new Error(`forsikring_coverages.bulkCreate: ${error.message}`);
        return (data ?? []) as ForsikringCoverage[];
      },
      async deleteForPolicy(policyId) {
        const { error } = await tenantDb(admin, schemaName)
          .from('forsikring_coverages')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('policy_id', policyId);
        if (error) {
          throw new Error(`forsikring_coverages.deleteForPolicy: ${error.message}`);
        }
      },
    },

    gaps: {
      async listForPolicy(policyId) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_gaps')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('policy_id', policyId)
          .eq('is_resolved', false)
          .order('severity', { ascending: true });
        if (error) throw new Error(`forsikring_gaps.list: ${error.message}`);
        return (data ?? []) as ForsikringGap[];
      },
      async bulkCreate(inputs) {
        if (inputs.length === 0) return [];
        const rows = inputs.map((g) => ({ ...g, tenant_id: tenantId }));
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_gaps')
          .insert(rows)
          .select('*');
        if (error) throw new Error(`forsikring_gaps.bulkCreate: ${error.message}`);
        return (data ?? []) as ForsikringGap[];
      },
      async deleteForPolicy(policyId) {
        const { error } = await tenantDb(admin, schemaName)
          .from('forsikring_gaps')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('policy_id', policyId);
        if (error) {
          throw new Error(`forsikring_gaps.deleteForPolicy: ${error.message}`);
        }
      },
      async markResolved(id, userId) {
        const { error } = await tenantDb(admin, schemaName)
          .from('forsikring_gaps')
          .update({
            is_resolved: true,
            resolved_at: new Date().toISOString(),
            resolved_by: userId,
          })
          .eq('id', id)
          .eq('tenant_id', tenantId);
        if (error) throw new Error(`forsikring_gaps.markResolved: ${error.message}`);
      },
      async listForAnalysis(analyseId) {
        const { data, error } = await tenantDb(admin, schemaName)
          .from('forsikring_gaps')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('analyse_id', analyseId)
          .order('severity');
        if (error) throw new Error(`forsikring_gaps.listForAnalysis: ${error.message}`);
        return (data ?? []) as ForsikringGap[];
      },
    },

    // BIZZ-1404: Analyse-dokument junction
    analyseDocuments: {
      async link(analyseId, documentId, source) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (admin as any)
          .schema(schemaName)
          .from('forsikring_analyse_documents')
          .insert({
            tenant_id: tenantId,
            analyse_id: analyseId,
            document_id: documentId,
            source,
          });
        if (error && !error.message?.includes('duplicate'))
          throw new Error(`analyseDocuments.link: ${error.message}`);
      },
      async listForAnalysis(analyseId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (admin as any)
          .schema(schemaName)
          .from('forsikring_analyse_documents')
          .select('document_id, source')
          .eq('tenant_id', tenantId)
          .eq('analyse_id', analyseId);
        if (error) throw new Error(`analyseDocuments.listForAnalysis: ${error.message}`);
        const docIds = (data ?? []).map((r: { document_id: string }) => r.document_id);
        const sourceMap = new Map(
          (data ?? []).map((r: { document_id: string; source: string }) => [
            r.document_id,
            r.source,
          ])
        );
        if (docIds.length === 0) return [];
        const { data: docs } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .select('*')
          .in('id', docIds)
          .eq('tenant_id', tenantId);
        return (docs ?? []).map((d: Record<string, unknown>) => ({
          ...d,
          source: sourceMap.get(d.id as string) ?? 'uploaded',
        })) as Array<ForsikringDocument & { source: string }>;
      },
      async listForCustomer(kundeId) {
        // Hent alle analyser for denne kunde, derefter alle docs via junction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: analyser } = await (admin as any)
          .schema(schemaName)
          .from('forsikring_analyser')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('kunde_id', kundeId);
        const analyseIds = (analyser ?? []).map((a: { id: string }) => a.id);
        if (analyseIds.length === 0) return [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: links } = await (admin as any)
          .schema(schemaName)
          .from('forsikring_analyse_documents')
          .select('analyse_id, document_id')
          .in('analyse_id', analyseIds);
        const docIds = [
          ...new Set((links ?? []).map((l: { document_id: string }) => l.document_id)),
        ] as string[];
        const analyseMap = new Map(
          (links ?? []).map((l: { document_id: string; analyse_id: string }) => [
            l.document_id,
            l.analyse_id,
          ])
        );
        if (docIds.length === 0) return [];
        const { data: docs } = await tenantDb(admin, schemaName)
          .from('forsikring_documents')
          .select('*')
          .in('id', docIds)
          .eq('tenant_id', tenantId);
        return (docs ?? []).map((d: Record<string, unknown>) => ({
          ...d,
          from_analyse_id: analyseMap.get(d.id as string) ?? '',
        })) as Array<ForsikringDocument & { from_analyse_id: string }>;
      },
    },
  };
}
