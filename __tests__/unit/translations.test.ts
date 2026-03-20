/**
 * Unit tests for the translations module.
 *
 * Verifies that:
 * - All required translation keys exist for both DA and EN
 * - No translation key returns undefined or empty string
 * - DA and EN have matching key structure
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
});
