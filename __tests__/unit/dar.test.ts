/**
 * Unit tests for app/lib/dar — BIZZ-599.
 *
 * Consolidates the core dar.ts exports that don't hit external services.
 * Network-backed helpers (darAutocomplete, darHentAdresse, etc.) are already
 * covered in separate test files with mocked fetches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { erDarId, __clearDarCachesForTests } from '@/app/lib/dar';

describe('erDarId — UUID format predicate', () => {
  it('accepts a canonical DAR UUID', () => {
    expect(erDarId('0a3f5079-d44a-32b8-e044-0003ba298018')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(erDarId('0A3F5079-D44A-32B8-E044-0003BA298018')).toBe(true);
  });

  it('rejects a numeric BFE id', () => {
    expect(erDarId('100165718')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(erDarId('')).toBe(false);
  });

  it('rejects a UUID missing a segment', () => {
    // dropped the final 12-char segment
    expect(erDarId('0a3f5079-d44a-32b8-e044')).toBe(false);
  });

  it('rejects a UUID with trailing content', () => {
    expect(erDarId('0a3f5079-d44a-32b8-e044-0003ba298018-extra')).toBe(false);
  });

  it('rejects a UUID with non-hex characters', () => {
    expect(erDarId('0a3f5079-d44a-32b8-e044-zzzzzzzzzzzz')).toBe(false);
  });

  it('rejects a string with spaces', () => {
    expect(erDarId(' 0a3f5079-d44a-32b8-e044-0003ba298018 ')).toBe(false);
  });
});

describe('__clearDarCachesForTests', () => {
  beforeEach(() => {
    __clearDarCachesForTests();
  });

  afterEach(() => {
    __clearDarCachesForTests();
  });

  it('can be invoked without throwing', () => {
    expect(() => __clearDarCachesForTests()).not.toThrow();
  });

  it('is idempotent (may be called multiple times)', () => {
    __clearDarCachesForTests();
    __clearDarCachesForTests();
    __clearDarCachesForTests();
    // No assertion beyond not-throwing is possible without observable cache state.
    expect(true).toBe(true);
  });
});
