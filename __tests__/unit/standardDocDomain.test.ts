/**
 * BIZZ-2104: Tests for slet/ret-rettighedsreglen på standard-docs.
 */
import { describe, it, expect } from 'vitest';
import { canModifyStandardDoc } from '@/app/lib/forsikring/standardDocDomain';

describe('canModifyStandardDoc (BIZZ-2104)', () => {
  const doc = { added_by_user: 'user-a', added_by_domain: 'dom-1' };

  it('uploaderen selv må altid slette/rette', () => {
    expect(canModifyStandardDoc(doc, 'user-a', [])).toBe(true);
  });

  it('admin af dokumentets domain må slette/rette', () => {
    expect(canModifyStandardDoc(doc, 'user-b', ['dom-1'])).toBe(true);
  });

  it('almindeligt domain-medlem (ikke admin) må IKKE', () => {
    expect(canModifyStandardDoc(doc, 'user-b', [])).toBe(false);
  });

  it('admin af et ANDET domain må IKKE', () => {
    expect(canModifyStandardDoc(doc, 'user-b', ['dom-2'])).toBe(false);
  });

  it('privat doc uden domain: kun uploaderen', () => {
    const privDoc = { added_by_user: 'user-a', added_by_domain: null };
    expect(canModifyStandardDoc(privDoc, 'user-a', ['dom-1'])).toBe(true);
    expect(canModifyStandardDoc(privDoc, 'user-b', ['dom-1'])).toBe(false);
  });

  it('curated doc uden uploader: ingen almindelig bruger', () => {
    const curated = { added_by_user: null, added_by_domain: null };
    expect(canModifyStandardDoc(curated, 'user-a', ['dom-1'])).toBe(false);
  });
});
