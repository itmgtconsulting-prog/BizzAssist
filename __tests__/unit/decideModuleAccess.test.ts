/**
 * Unit-tests for BIZZ-1988 — server-side modul-entitlement decision logic.
 *
 * `decideModuleAccess` er den rene (IO-fri) kerne i ServerModuleGate +
 * requireModuleAccess. Den afgør om en bruger må tilgå et analyse-modul ud fra
 * admin-status, abonnements-status, payment-grace, plan-moduler og add-ons.
 *
 * Sikkerheds-kritisk: en regression her lækker betalte moduler til brugere uden
 * abonnement (eller spærrer betalende brugere ude). Hver permutation dækkes.
 */

import { describe, it, expect } from 'vitest';
import { decideModuleAccess, type ModuleAccessInput } from '@/app/lib/serverModuleAccess';

/** Basis-input: ikke-admin, aktiv, ingen grace, intet i plan/addons. */
function base(overrides: Partial<ModuleAccessInput> = {}): ModuleAccessInput {
  return {
    isAdmin: false,
    status: 'active',
    withinGrace: false,
    planModules: [],
    addons: [],
    moduleId: 'virksomhedshandler',
    ...overrides,
  };
}

describe('decideModuleAccess — BIZZ-1988 modul-entitlement', () => {
  // ── Admin bypass ──────────────────────────────────────────────────────────
  it('admin har altid adgang — uanset status/plan/addons', () => {
    expect(decideModuleAccess(base({ isAdmin: true }))).toBe(true);
    expect(
      decideModuleAccess(base({ isAdmin: true, status: 'canceled', planModules: [], addons: [] }))
    ).toBe(true);
    expect(decideModuleAccess(base({ isAdmin: true, status: undefined, withinGrace: false }))).toBe(
      true
    );
  });

  // ── Subscription-status gating ────────────────────────────────────────────
  it('blokerer ikke-aktiv status uden grace (selv hvis modul er i planen)', () => {
    expect(
      decideModuleAccess(base({ status: 'canceled', planModules: ['virksomhedshandler'] }))
    ).toBe(false);
    expect(
      decideModuleAccess(base({ status: 'past_due', planModules: ['virksomhedshandler'] }))
    ).toBe(false);
    expect(
      decideModuleAccess(base({ status: undefined, planModules: ['virksomhedshandler'] }))
    ).toBe(false);
    expect(decideModuleAccess(base({ status: '', planModules: ['virksomhedshandler'] }))).toBe(
      false
    );
  });

  it('tillader past_due når den er inden for payment-grace OG modul i plan', () => {
    expect(
      decideModuleAccess(
        base({ status: 'past_due', withinGrace: true, planModules: ['virksomhedshandler'] })
      )
    ).toBe(true);
  });

  it('grace alene giver IKKE adgang hvis modulet ikke er i plan/addons', () => {
    expect(
      decideModuleAccess(
        base({ status: 'past_due', withinGrace: true, planModules: [], addons: [] })
      )
    ).toBe(false);
  });

  // ── Entitlement: plan-moduler ─────────────────────────────────────────────
  it('tillader aktiv bruger når modulet er i plan.modules', () => {
    expect(decideModuleAccess(base({ planModules: ['virksomhedshandler'] }))).toBe(true);
  });

  it('blokerer aktiv bruger når modulet IKKE er i plan og ikke add-on', () => {
    expect(
      decideModuleAccess(base({ planModules: ['kreditvurdering'], addons: ['forsikring'] }))
    ).toBe(false);
  });

  // ── Entitlement: add-ons ──────────────────────────────────────────────────
  it('tillader aktiv bruger når modulet er købt som add-on (selvom ikke i plan)', () => {
    expect(decideModuleAccess(base({ planModules: [], addons: ['virksomhedshandler'] }))).toBe(
      true
    );
  });

  it('add-on til ANDET modul giver ikke adgang til target-modulet', () => {
    expect(decideModuleAccess(base({ addons: ['kreditvurdering'] }))).toBe(false);
  });

  // ── moduleId-specificitet ─────────────────────────────────────────────────
  it('matcher præcist på moduleId (ingen delvis/substring-match)', () => {
    expect(
      decideModuleAccess(base({ moduleId: 'aml-kyc', planModules: ['aml'], addons: [] }))
    ).toBe(false);
    expect(decideModuleAccess(base({ moduleId: 'aml-kyc', planModules: ['aml-kyc'] }))).toBe(true);
  });

  // ── Kombinationer ─────────────────────────────────────────────────────────
  it('plan ELLER addon er nok (logisk OR)', () => {
    expect(
      decideModuleAccess(
        base({ planModules: ['virksomhedshandler'], addons: ['virksomhedshandler'] })
      )
    ).toBe(true);
    expect(decideModuleAccess(base({ planModules: ['virksomhedshandler'], addons: [] }))).toBe(
      true
    );
    expect(decideModuleAccess(base({ planModules: [], addons: ['virksomhedshandler'] }))).toBe(
      true
    );
  });

  it('non-admin + active + tomt plan/addons = ingen adgang (fail-closed default)', () => {
    expect(decideModuleAccess(base())).toBe(false);
  });
});
