/**
 * One-time migration of localStorage data to Supabase.
 *
 * Runs once per user on first authenticated dashboard load.
 * Reads all localStorage keys and pushes them to the server
 * via the appropriate API routes. Sets a flag to prevent re-running.
 *
 * @module app/lib/migrateLocalStorage
 */

const MIGRATION_KEY = 'ba-migrated-to-supabase';

/**
 * Check if migration has already been performed.
 */
export function hasMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATION_KEY) === 'true';
  } catch {
    return true; // If we can't read localStorage, skip migration
  }
}

/**
 * Migrate all localStorage data to Supabase.
 * Should be called once from dashboard layout after authentication.
 */
export async function migrateLocalStorageToSupabase(): Promise<void> {
  if (hasMigrated()) return;

  try {
    // 1. Migrate language preference
    const lang = localStorage.getItem('ba-lang');
    if (lang && (lang === 'da' || lang === 'en')) {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      }).catch(() => {});
    }

    // 2. Migrate map style
    const mapStyle = localStorage.getItem('bizzassist-map-style');
    if (mapStyle) {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapStyle }),
      }).catch(() => {});
    }

    // 3. Migrate recent properties
    const recentEjendomme = localStorage.getItem('ba-seneste-ejendomme');
    if (recentEjendomme) {
      try {
        const items = JSON.parse(recentEjendomme);
        if (Array.isArray(items)) {
          for (const item of items) {
            await fetch('/api/recents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entity_type: 'property',
                entity_id: item.id,
                display_name: item.adresse ?? `${item.postnr} ${item.by}`,
                entity_data: {
                  postnr: item.postnr,
                  by: item.by,
                  kommune: item.kommune,
                  anvendelse: item.anvendelse,
                  senestiSet: item.senestiSet,
                },
              }),
            }).catch(() => {});
          }
        }
      } catch {
        /* invalid JSON */
      }
    }

    // 4. Migrate recent companies
    const recentCompanies = localStorage.getItem('ba-companies-recent');
    if (recentCompanies) {
      try {
        const items = JSON.parse(recentCompanies);
        if (Array.isArray(items)) {
          for (const item of items) {
            await fetch('/api/recents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entity_type: 'company',
                entity_id: String(item.cvr),
                display_name: item.name,
                entity_data: {
                  industry: item.industry,
                  address: item.address,
                  zipcode: item.zipcode,
                  city: item.city,
                  active: item.active,
                  visitedAt: item.visitedAt,
                },
              }),
            }).catch(() => {});
          }
        }
      } catch {
        /* invalid JSON */
      }
    }

    // 5. Migrate tracked properties
    const trackedEjendomme = localStorage.getItem('ba-tracked-ejendomme');
    if (trackedEjendomme) {
      try {
        const items = JSON.parse(trackedEjendomme);
        if (Array.isArray(items)) {
          for (const item of items) {
            await fetch('/api/tracked', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entity_id: item.id,
                label: item.adresse,
                entity_data: {
                  postnr: item.postnr,
                  by: item.by,
                  kommune: item.kommune,
                  anvendelse: item.anvendelse,
                  trackedSiden: item.trackedSiden,
                },
              }),
            }).catch(() => {});
          }
        }
      } catch {
        /* invalid JSON */
      }
    }

    // 6. Migrate tracked companies
    const trackedCompanies = localStorage.getItem('ba-tracked-companies');
    if (trackedCompanies) {
      try {
        const items = JSON.parse(trackedCompanies);
        if (Array.isArray(items)) {
          for (const item of items) {
            await fetch('/api/tracked-companies', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entity_id: item.cvr,
                label: item.navn,
                entity_data: { trackedSiden: item.trackedSiden },
              }),
            }).catch(() => {});
          }
        }
      } catch {
        /* invalid JSON */
      }
    }

    // Mark migration as complete
    localStorage.setItem(MIGRATION_KEY, 'true');
  } catch {
    // Don't set the flag — retry next time
    console.error('[migrateLocalStorage] Migration failed, will retry');
  }
}
