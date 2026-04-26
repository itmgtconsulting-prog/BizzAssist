/**
 * EjendomBreadcrumb (BIZZ-797) — ensartet navigations-breadcrumb for
 * alle ejendoms-hierarki-detaljesider: SFE, Bygning, Ejerlejlighed.
 *
 * Tager et array af `BreadcrumbLevel` som rendres som nav/ol/li med
 * chevron-separator. Sidste element er "current page" og har
 * aria-current="page" + ingen link. WCAG AA-compliant.
 *
 * Eksempel:
 *   <EjendomBreadcrumb levels={[
 *     { label: 'Dashboard', href: '/dashboard' },
 *     { label: 'Ejendomme', href: '/dashboard/ejendomme' },
 *     { label: 'SFE 2091165', href: '/dashboard/ejendomme/sfe/2091165' },
 *     { label: 'Bygning 62B' },  // current page, intet href
 *   ]} />
 */

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

export interface BreadcrumbLevel {
  /** Vist tekst */
  label: string;
  /** Hvis defineret: link'et der skal navigeres til. Udelad for current page. */
  href?: string;
}

interface EjendomBreadcrumbProps {
  levels: BreadcrumbLevel[];
  /** ARIA-label for nav-element. Default: "Breadcrumb" */
  ariaLabel?: string;
}

/**
 * Bilingual-agnostisk breadcrumb. Labels leveres af caller (da/en-valg
 * sker i caller-komponenten).
 */
export default function EjendomBreadcrumb({
  levels,
  ariaLabel = 'Breadcrumb',
}: EjendomBreadcrumbProps) {
  if (levels.length === 0) return null;
  return (
    <nav aria-label={ariaLabel} className="text-xs">
      <ol className="flex flex-wrap items-center gap-1 text-slate-400">
        {levels.map((lvl, i) => {
          const isLast = i === levels.length - 1;
          return (
            <li key={`${lvl.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-slate-600 shrink-0" />}
              {isLast || !lvl.href ? (
                <span
                  aria-current={isLast ? 'page' : undefined}
                  className={isLast ? 'text-slate-200 font-medium' : 'text-slate-400'}
                >
                  {lvl.label}
                </span>
              ) : (
                <Link href={lvl.href} className="text-slate-400 hover:text-white transition-colors">
                  {lvl.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
