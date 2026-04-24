/**
 * BIZZ-853: Entity-link komponenter med konsistent hover-farve pr.
 * entitetstype. Personer → purple, virksomheder → blue, ejendomme →
 * emerald. Følger farvekonventionen fra app/lib/entityStyles.ts
 * (etableret i BIZZ-806).
 *
 * Alle varianter bruger Next.js Link for client-side navigation og
 * deler link-styles fra entityStyles.ts så CSS-klasser ikke
 * duplikeres i 10+ call-sites.
 *
 * @module app/components/ui/EntityLink
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { getEntityStyle, type EntityKind } from '@/app/lib/entityStyles';

interface BaseProps {
  href: string;
  children: ReactNode;
  /** Yderligere klasser append'es efter base-styles. */
  className?: string;
  /** Aria-label hvis children er ikon-only. */
  'aria-label'?: string;
  /** Optional onClick for analytics/stopPropagation. */
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Generisk EntityLink — vælg type eksplicit. Brug de navngivne
 * varianter (PersonLink/CompanyLink/PropertyLink) som default.
 */
export function EntityLink({
  kind,
  href,
  children,
  className,
  'aria-label': ariaLabel,
  onClick,
}: BaseProps & { kind: EntityKind }) {
  const style = getEntityStyle(kind);
  const classes = className ? `${style.link} ${className}` : style.link;
  return (
    <Link href={href} className={classes} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </Link>
  );
}

/** Klikbart person-navn/link. Hover → lilla (purple). */
export function PersonLink(props: BaseProps) {
  return <EntityLink kind="person" {...props} />;
}

/** Klikbart virksomhedsnavn/link. Hover → blå (blue). */
export function CompanyLink(props: BaseProps) {
  return <EntityLink kind="virksomhed" {...props} />;
}

/** Klikbart ejendomsnavn/link. Hover → grøn (emerald). */
export function PropertyLink(props: BaseProps) {
  return <EntityLink kind="ejendom" {...props} />;
}
