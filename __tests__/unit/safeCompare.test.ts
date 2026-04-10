/**
 * Unit tests for app/lib/safeCompare.
 *
 * safeCompare performs constant-time string comparison to prevent timing
 * side-channel attacks. These tests verify correctness (equal strings
 * return true, unequal strings return false) and edge-case handling
 * (empty strings, null-like inputs, different lengths, Unicode).
 *
 * Covers:
 * - Identical strings → true
 * - Different strings with same length → false
 * - Strings of different lengths → false (no crash)
 * - Empty strings equality
 * - One empty, one non-empty → false
 * - Unicode / multi-byte characters
 * - Typical Bearer token comparison patterns used in cron routes
 * - Case sensitivity (case-different strings are not equal)
 */
import { describe, it, expect } from 'vitest';
import { safeCompare } from '@/lib/safeCompare';

describe('safeCompare', () => {
  // ── Basic equality ────────────────────────────────────────────────────────

  it('returns true for two identical ASCII strings', () => {
    expect(safeCompare('hello', 'hello')).toBe(true);
  });

  it('returns false for two different strings of the same length', () => {
    // Both length 5 — exercises the timingSafeEqual path
    expect(safeCompare('hello', 'world')).toBe(false);
  });

  it('returns false for strings that differ by a single character', () => {
    expect(safeCompare('secret1', 'secret2')).toBe(false);
  });

  it('returns false for strings that differ only in case', () => {
    expect(safeCompare('Secret', 'secret')).toBe(false);
  });

  // ── Length mismatch ────────────────────────────────────────────────────────

  it('returns false when a is shorter than b', () => {
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });

  it('returns false when a is longer than b', () => {
    expect(safeCompare('abcd', 'abc')).toBe(false);
  });

  it('returns false when one string is empty and the other is not', () => {
    expect(safeCompare('', 'secret')).toBe(false);
    expect(safeCompare('secret', '')).toBe(false);
  });

  // ── Empty strings ─────────────────────────────────────────────────────────

  it('returns true when both strings are empty', () => {
    // Two empty Buffers are trivially equal — expected behaviour
    expect(safeCompare('', '')).toBe(true);
  });

  // ── Unicode / multi-byte ──────────────────────────────────────────────────

  it('returns true for identical strings containing multi-byte characters', () => {
    expect(safeCompare('hemmelig🔑', 'hemmelig🔑')).toBe(true);
  });

  it('returns false for different strings containing multi-byte characters', () => {
    expect(safeCompare('hemmelig🔑', 'hemmelig🔒')).toBe(false);
  });

  it('handles Danish characters correctly', () => {
    expect(safeCompare('hæmmeligt', 'hæmmeligt')).toBe(true);
    expect(safeCompare('hæmmeligt', 'hemmeligt')).toBe(false);
  });

  // ── Typical Bearer token patterns (mirrors cron route usage) ─────────────

  it('returns true for matching Bearer token strings', () => {
    const secret = 'my-cron-secret-abc123';
    const auth = `Bearer ${secret}`;
    const expected = `Bearer ${secret}`;
    expect(safeCompare(auth, expected)).toBe(true);
  });

  it('returns false when Bearer token is wrong', () => {
    const auth = 'Bearer wrong-secret';
    const expected = 'Bearer correct-secret-value';
    expect(safeCompare(auth, expected)).toBe(false);
  });

  it('returns false when Authorization header is missing (empty string)', () => {
    // Mirrors the `?? ''` fallback in route handlers
    const auth = '';
    const expected = 'Bearer some-cron-secret';
    expect(safeCompare(auth, expected)).toBe(false);
  });

  it('returns false when prefix is present but secret is wrong', () => {
    expect(safeCompare('Bearer abc', 'Bearer xyz')).toBe(false);
  });

  it('returns false when prefix is absent entirely', () => {
    const secret = 'my-secret';
    expect(safeCompare(secret, `Bearer ${secret}`)).toBe(false);
  });

  // ── Long strings ──────────────────────────────────────────────────────────

  it('returns true for long identical strings (256 chars)', () => {
    const long = 'a'.repeat(256);
    expect(safeCompare(long, long)).toBe(true);
  });

  it('returns false for long strings differing only in the last character', () => {
    const a = 'a'.repeat(255) + 'x';
    const b = 'a'.repeat(255) + 'y';
    expect(safeCompare(a, b)).toBe(false);
  });
});
