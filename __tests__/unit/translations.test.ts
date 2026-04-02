/**
 * Unit tests for the translations module.
 *
 * Verifies that:
 * - All required translation keys exist for both DA and EN
 * - No translation key returns undefined or empty string
 * - DA and EN have matching key structure
 * - Dashboard, sidebar, AI, company, and common sections are complete
 */
import { describe, it, expect } from 'vitest';
import { translations } from '@/app/lib/translations';

describe('translations', () => {
  const languages = ['da', 'en'] as const;
  const requiredTopLevelKeys = [
    'nav',
    'hero',
    'stats',
    'features',
    'useCases',
    'cta',
    'footer',
    'login',
    'dashboard',
    'sidebar',
    'ai',
    'company',
    'common',
  ];

  it('has all required top-level keys for both languages', () => {
    for (const lang of languages) {
      for (const key of requiredTopLevelKeys) {
        expect(translations[lang]).toHaveProperty(key);
      }
    }
  });

  it('has matching key structure between DA and EN', () => {
    const daKeys = Object.keys(translations.da).sort();
    const enKeys = Object.keys(translations.en).sort();
    expect(daKeys).toEqual(enKeys);
  });

  it('has no empty string values in nav', () => {
    for (const lang of languages) {
      for (const [key, value] of Object.entries(translations[lang].nav)) {
        expect(value, `nav.${key} in ${lang} is empty`).not.toBe('');
      }
    }
  });

  it('has correct number of stats (4)', () => {
    expect(translations.da.stats).toHaveLength(4);
    expect(translations.en.stats).toHaveLength(4);
  });

  it('has correct number of feature items (4)', () => {
    expect(translations.da.features.items).toHaveLength(4);
    expect(translations.en.features.items).toHaveLength(4);
  });

  it('has correct number of use case items (6)', () => {
    expect(translations.da.useCases.items).toHaveLength(6);
    expect(translations.en.useCases.items).toHaveLength(6);
  });

  it('each feature item has icon, title and description', () => {
    for (const lang of languages) {
      for (const item of translations[lang].features.items) {
        expect(item.icon, `Missing icon in ${lang}`).toBeTruthy();
        expect(item.title, `Missing title in ${lang}`).toBeTruthy();
        expect(item.description, `Missing description in ${lang}`).toBeTruthy();
      }
    }
  });

  /* ─── Dashboard section tests ─── */

  it('dashboard has all required keys for both languages', () => {
    const requiredKeys = [
      'welcome',
      'welcomeSub',
      'checkingAccess',
      'properties',
      'companies',
      'owners',
      'map',
      'recentProperties',
      'recentCompanies',
      'recentOwners',
      'tracked',
      'viewAll',
      'manage',
      'emptyProperties',
      'emptyCompanies',
      'emptyOwners',
      'emptyTracked',
      'compare',
    ];
    for (const lang of languages) {
      for (const key of requiredKeys) {
        expect(translations[lang].dashboard, `dashboard.${key} missing in ${lang}`).toHaveProperty(
          key
        );
      }
    }
  });

  /* ─── Sidebar section tests ─── */

  it('sidebar has matching keys between DA and EN', () => {
    const daKeys = Object.keys(translations.da.sidebar).sort();
    const enKeys = Object.keys(translations.en.sidebar).sort();
    expect(daKeys).toEqual(enKeys);
  });

  it('sidebar has no empty values', () => {
    for (const lang of languages) {
      for (const [key, value] of Object.entries(translations[lang].sidebar)) {
        expect(value, `sidebar.${key} in ${lang} is empty`).not.toBe('');
      }
    }
  });

  /* ─── AI section tests ─── */

  it('ai section has matching keys between DA and EN', () => {
    const daKeys = Object.keys(translations.da.ai).sort();
    const enKeys = Object.keys(translations.en.ai).sort();
    expect(daKeys).toEqual(enKeys);
  });

  it('ai section has all required keys', () => {
    const requiredKeys = [
      'title',
      'tokenStatus',
      'emptyPrompt',
      'inputPlaceholder',
      'sendLabel',
      'stopLabel',
      'stopped',
      'connectionError',
      'serverError',
      'genericError',
      'subPending',
      'subInactive',
      'aiNotIncluded',
      'tokensExhausted',
    ];
    for (const lang of languages) {
      for (const key of requiredKeys) {
        expect(translations[lang].ai, `ai.${key} missing in ${lang}`).toHaveProperty(key);
      }
    }
  });

  /* ─── Company section tests ─── */

  it('company section has matching keys between DA and EN', () => {
    const daKeys = Object.keys(translations.da.company).sort();
    const enKeys = Object.keys(translations.en.company).sort();
    expect(daKeys).toEqual(enKeys);
  });

  it('company tabs are complete for both languages', () => {
    for (const lang of languages) {
      const tabs = translations[lang].company.tabs;
      expect(tabs).toHaveProperty('overview');
      expect(tabs).toHaveProperty('masterdata');
      expect(tabs).toHaveProperty('portfolio');
    }
  });

  /* ─── Common section tests ─── */

  it('common section has matching keys between DA and EN', () => {
    const daKeys = Object.keys(translations.da.common).sort();
    const enKeys = Object.keys(translations.en.common).sort();
    expect(daKeys).toEqual(enKeys);
  });
});
