import { logger } from '@/app/lib/logger';
import { loadConversations } from '@/app/lib/chatStorage';

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
const CHAT_MIGRATION_KEY = 'ba-chat-migrated';
const CHAT_MIGRATION_PROGRESS_KEY = 'ba-chat-migration-progress';
const CHAT_HISTORY_KEY = 'ba-chat-history';

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
    logger.error('[migrateLocalStorage] Migration failed, will retry');
  }
}

// ─── BIZZ-820: AI-chat-historik migration ───────────────────────────────────

/** Map local conversation-id → remote session-id for idempotens */
type ChatProgressMap = Record<string, string>;

/**
 * BIZZ-820: Engangs-migration af localStorage chat-historik
 * (ba-chat-history) til Supabase via /api/ai/sessions. Separat flag fra
 * den øvrige localStorage-migration fordi chat-migration kræver auth +
 * kan fejle delvist (mange messages per session) og skal kunne
 * genoptages.
 *
 * Idempotent: tracker hvilke conversations der er uploaded i
 * ba-chat-migration-progress så vi kan genoptage efter fejl. Når alt er
 * klaret: sæt ba-chat-migrated=done og slet gamle localStorage-nøgler.
 *
 * @returns Antal conversations der blev migreret i dette run (0 = done
 *   eller intet at gøre).
 */
export async function migrateChatHistoryToSupabase(): Promise<number> {
  if (typeof window === 'undefined') return 0;

  try {
    if (localStorage.getItem(CHAT_MIGRATION_KEY) === 'done') return 0;
  } catch {
    return 0;
  }

  const conversations = loadConversations();

  if (conversations.length === 0) {
    try {
      localStorage.setItem(CHAT_MIGRATION_KEY, 'done');
    } catch {
      /* ignore */
    }
    return 0;
  }

  // Load progress-map (lokal-id → remote-session-id)
  let progress: ChatProgressMap = {};
  try {
    const raw = localStorage.getItem(CHAT_MIGRATION_PROGRESS_KEY);
    if (raw) progress = JSON.parse(raw) as ChatProgressMap;
  } catch {
    progress = {};
  }

  let migrated = 0;

  for (const conv of conversations) {
    if (progress[conv.id]) continue; // allerede uploaded

    try {
      // 1. Opret session
      const sessionRes = await fetch('/api/ai/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: conv.title || 'Migreret samtale' }),
      });
      if (!sessionRes.ok) {
        // 401 = ikke logget ind → afbryd migration (prøv igen næste gang)
        if (sessionRes.status === 401) return migrated;
        continue;
      }
      const data = (await sessionRes.json()) as { session?: { id?: string } };
      const newId = data.session?.id;
      if (!newId) continue;

      // 2. Append messages sekventielt (bevar rækkefølge)
      for (const msg of conv.messages || []) {
        await fetch(`/api/ai/sessions/${newId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: msg.role,
            content: { text: msg.content },
          }),
        }).catch(() => null);
      }

      // 3. Registrér fremdrift (idempotens)
      progress[conv.id] = newId;
      try {
        localStorage.setItem(CHAT_MIGRATION_PROGRESS_KEY, JSON.stringify(progress));
      } catch {
        /* quota */
      }
      migrated += 1;
    } catch {
      // Netværksfejl — afbryd så vi kan genoptage
      return migrated;
    }
  }

  // Alle conversations klaret — markér og slet gamle data
  try {
    localStorage.setItem(CHAT_MIGRATION_KEY, 'done');
    localStorage.removeItem(CHAT_HISTORY_KEY);
    localStorage.removeItem(CHAT_MIGRATION_PROGRESS_KEY);
  } catch {
    /* ignore */
  }

  return migrated;
}
