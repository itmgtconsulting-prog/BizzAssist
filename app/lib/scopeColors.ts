/**
 * BIZZ-782: Color tokens for API-key scopes.
 *
 * Mirrors the detail-page color language so token-scope chips align with
 * the rest of the app: properties=emerald, companies=blue, people=purple,
 * ai=amber. Defaults to slate for unknown scopes.
 *
 * @module app/lib/scopeColors
 */

/** A small colour bundle for one scope family. */
export interface ScopeColor {
  /** Background class — intentionally faint so it works on dark surfaces. */
  bg: string;
  /** Text class — saturated variant of the bg colour. */
  text: string;
  /** Border class — 20% alpha of the bg colour. */
  border: string;
}

/** Scope-family → colour bundle mapping. */
export const SCOPE_COLORS: Record<string, ScopeColor> = {
  'read:properties': {
    bg: 'bg-emerald-500/5',
    text: 'text-emerald-400',
    border: 'border-emerald-500/20',
  },
  'read:companies': {
    bg: 'bg-blue-500/5',
    text: 'text-blue-400',
    border: 'border-blue-500/20',
  },
  'read:people': {
    bg: 'bg-purple-500/5',
    text: 'text-purple-400',
    border: 'border-purple-500/20',
  },
  'read:ai': {
    bg: 'bg-amber-500/5',
    text: 'text-amber-400',
    border: 'border-amber-500/20',
  },
};

/** Fallback colour bundle for unknown scopes. */
export const DEFAULT_SCOPE_COLOR: ScopeColor = {
  bg: 'bg-slate-500/5',
  text: 'text-slate-400',
  border: 'border-slate-500/20',
};

/**
 * Look up the colour bundle for a scope. Returns the default if the scope
 * isn't registered in SCOPE_COLORS (future-proof for custom scopes).
 */
export function scopeColor(scope: string): ScopeColor {
  return SCOPE_COLORS[scope] ?? DEFAULT_SCOPE_COLOR;
}
