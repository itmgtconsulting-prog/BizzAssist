/**
 * BIZZ-2104: Tests for slet/ret-rettighedsreglen på standard-docs.
 * BIZZ-2107: Tests for revocation af domain-deling ved member-removal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  canModifyStandardDoc,
  revokeStandardDocDomainSharing,
} from '@/app/lib/forsikring/standardDocDomain';

// Mock admin-klienten så revokeStandardDocDomainSharing kan testes uden DB
const updateChain = {
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
};
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => updateChain }),
}));

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

describe('revokeStandardDocDomainSharing (BIZZ-2107)', () => {
  beforeEach(() => {
    updateChain.update.mockReturnValue(updateChain);
    updateChain.eq.mockReturnValue(updateChain);
  });

  it('demoter brugerens docs til private og returnerer antallet', async () => {
    updateChain.select.mockResolvedValue({ data: [{ id: 'd1' }, { id: 'd2' }] });
    const n = await revokeStandardDocDomainSharing('user-a', 'dom-1');
    expect(n).toBe(2);
    expect(updateChain.update).toHaveBeenCalledWith({
      visibility: 'private',
      added_by_domain: null,
    });
    // Scoper på BÅDE bruger og domain — andre domains/brugeres docs røres ikke
    expect(updateChain.eq).toHaveBeenCalledWith('added_by_user', 'user-a');
    expect(updateChain.eq).toHaveBeenCalledWith('added_by_domain', 'dom-1');
  });

  it('returnerer 0 når brugeren ingen delte docs har', async () => {
    updateChain.select.mockResolvedValue({ data: [] });
    expect(await revokeStandardDocDomainSharing('user-b', 'dom-1')).toBe(0);
  });
});
