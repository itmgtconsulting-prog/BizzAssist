/**
 * systemConfig — server-side helper til at læse admin-konfigurerbare
 * værdier fra public.system_config (BIZZ-419).
 *
 * Fallback-hierarki:
 *   1. Proces-lokal TTL-cache (5 min)
 *   2. public.system_config row via admin client
 *   3. process.env[key.toUpperCase()] — legacy-fallback
 *   4. caller-provided defaultValue
 *
 * Cache er proces-lokal (ikke delt på tværs af Vercel instances).
 * TTL 5 min er kompromis mellem "fresh efter admin-opdatering" og
 * "ikke slå DB hver request". Admin-UI må vente op til 5 min før
 * ændringer slår igennem på alle instanser — acceptable for config
 * der normalt ændres sjældent.
 *
 * @module app/lib/systemConfig
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/app/lib/logger';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Proces-lokal TTL-cache. Simpelt Map-baseret for at undgå lru-cache-
 * dependency. Evicter ældste entries når MAX_ENTRIES er nået, og rydder
 * eksplicit expired entries ved get().
 */
const cache = new Map<string, CacheEntry>();

function evictIfFull(): void {
  if (cache.size < CACHE_MAX_ENTRIES) return;
  // Simpel "oldest first" eviction — Map bibeholder insertion-order.
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}

function readCache(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache(key: string, value: unknown): void {
  evictIfFull();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Henter en config-værdi fra admin-konfigurerbar store.
 *
 * @param key - Config-nøgle (snake_case, fx "support_email")
 * @param defaultValue - Fallback hvis værdi ikke findes nogen steder
 * @returns Værdi fra cache / DB / env / default
 *
 * @example
 *   const supportEmail = await getConfig('support_email', 'support@bizzassist.dk');
 *   const maxUploads = await getConfig('max_uploads_per_day', 50);
 */
export async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
  // Layer 1: cache
  const cached = readCache(key);
  if (cached !== undefined) return cached as T;

  // Layer 2: Supabase
  try {
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = (await (admin as any)
      .from('system_config')
      .select('value')
      .eq('key', key)
      .maybeSingle()) as { data: { value: unknown } | null };

    if (data && data.value !== undefined && data.value !== null) {
      writeCache(key, data.value);
      return data.value as T;
    }
  } catch (e) {
    logger.warn('[systemConfig] DB lookup failed for key', key, e);
    // fall through to env / default
  }

  // Layer 3: process.env fallback (legacy config path)
  const envKey = key.toUpperCase();
  const envVal = process.env[envKey];
  if (envVal !== undefined && envVal !== '') {
    // Forsøg JSON-parse for structured values; falder tilbage til string.
    let parsed: unknown = envVal;
    try {
      parsed = JSON.parse(envVal);
    } catch {
      /* ikke JSON, behold som string */
    }
    writeCache(key, parsed);
    return parsed as T;
  }

  // Layer 4: default
  return defaultValue;
}

/**
 * Invaliderer cache-entry for en given key. Kaldes af admin-PATCH-route
 * efter en opdatering så samme proces ser ny værdi ved næste read.
 * Note: andre Vercel-instanser har stadig gammel cache indtil TTL udløber
 * (max 5 min) — acceptable trade-off.
 *
 * @param key - Config-nøgle at invalidere
 */
export function invalidateConfig(key: string): void {
  cache.delete(key);
}

/**
 * Rydder hele cachen. Bruges primært i tests.
 */
export function clearConfigCache(): void {
  cache.clear();
}

/**
 * Liste af alle kategorier der forventes i UI. Admin-UI bruger dette til
 * at bygge kategori-tabs. Seed-script bruger dette til validering.
 */
export const CONFIG_CATEGORIES = [
  'endpoints',
  'email',
  'rate_limits',
  'cache',
  'company',
  'feature_flags',
] as const;

export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

/**
 * Shape af en system_config row som API returnerer.
 */
export interface SystemConfigRow {
  id: string;
  category: ConfigCategory | string;
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}
