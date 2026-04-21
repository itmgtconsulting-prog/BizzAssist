/**
 * EjendomAdministratorCard — viser ejendomsadministrator-info for en BFE.
 *
 * BIZZ-583: Administrator er ofte en ejerforening, udlejnings-selskab eller
 * advokat — ikke ejeren. Særligt relevant for ejerlejligheder. Data hentes
 * fra /api/ejendomsadmin?bfeNummer=X som bruger EJF Custom GraphQL.
 *
 * Viser:
 *   - Administratorens navn (person eller virksomhed)
 *   - Type-badge (Virksomhed / Person)
 *   - Klikbart link: virksomhed → /dashboard/companies/[cvr], person → ingen link (persondata begraenset)
 *   - Virkningstids-periode (fra-til)
 *
 * Skjules når der ingen administrator er (i.e. ingen sektion vises for
 * ejendomme uden admin-relation — ikke "Ukendt").
 *
 * @module app/components/ejendomme/EjendomAdministratorCard
 */

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, User, ExternalLink } from 'lucide-react';
import { logger } from '@/app/lib/logger';

/** Administrator-info som returneret fra /api/ejendomsadmin */
interface AdministratorInfo {
  id: string;
  type: 'virksomhed' | 'person' | 'ukendt';
  cvr: string | null;
  navn: string | null;
  foedselsdato: string | null;
  virkningFra: string | null;
  virkningTil: string | null;
  status: string | null;
}

interface Props {
  bfeNummer: number | string;
  /** 'da' | 'en' — bilingual */
  lang?: 'da' | 'en';
}

/**
 * Formatér ISO-dato til dansk format (DD/MM-YYYY).
 * Returnerer tom streng for null/invalid.
 */
function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}-${d.getFullYear()}`;
  } catch {
    return '';
  }
}

/** Lookup virksomhedsnavn fra CVR via offentlig CVR-API. */
async function fetchCvrName(cvr: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/cvr-public?vat=${encodeURIComponent(cvr)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { name?: string };
    return data.name ?? null;
  } catch {
    return null;
  }
}

export default function EjendomAdministratorCard({ bfeNummer, lang = 'da' }: Props) {
  const [loading, setLoading] = useState(true);
  const [admins, setAdmins] = useState<AdministratorInfo[]>([]);
  const [cvrNames, setCvrNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/ejendomsadmin?bfeNummer=${bfeNummer}`, {
          credentials: 'include',
        });
        if (!res.ok || !active) return;
        const data = (await res.json()) as { administratorer?: AdministratorInfo[] };
        if (!active) return;
        const list = data.administratorer ?? [];
        setAdmins(list);

        // Slå CVR-navne op parallelt
        const cvrs = Array.from(
          new Set(list.filter((a) => a.type === 'virksomhed' && a.cvr).map((a) => a.cvr!))
        );
        if (cvrs.length > 0) {
          const pairs = await Promise.all(
            cvrs.map(async (cvr) => [cvr, await fetchCvrName(cvr)] as const)
          );
          if (active) {
            const next: Record<string, string> = {};
            for (const [cvr, name] of pairs) if (name) next[cvr] = name;
            setCvrNames(next);
          }
        }
      } catch (err) {
        logger.warn(
          '[EjendomAdministratorCard] fetch fejl:',
          err instanceof Error ? err.message : err
        );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [bfeNummer]);

  // Skjul sektionen helt når ingen administrator (pr. ticket-acceptance)
  if (loading) return null;
  const aktive = admins.filter((a) => a.status !== 'historisk');
  if (aktive.length === 0) return null;

  const title = lang === 'da' ? 'Administrator' : 'Administrator';
  const typeVirksomhed = lang === 'da' ? 'Virksomhed' : 'Company';
  const typePerson = lang === 'da' ? 'Person' : 'Person';
  const fraLabel = lang === 'da' ? 'Fra' : 'From';

  return (
    <div className="rounded-xl bg-slate-900/60 border border-slate-700/50 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Building2 size={16} className="text-teal-400" />
        <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">{title}</h3>
      </div>
      <div className="space-y-3">
        {aktive.map((admin) => {
          const isVirksomhed = admin.type === 'virksomhed' && admin.cvr;
          const isPerson = admin.type === 'person' && admin.navn;
          const cvrName = admin.cvr ? cvrNames[admin.cvr] : null;
          const displayName = isVirksomhed
            ? (cvrName ?? `CVR ${admin.cvr}`)
            : isPerson
              ? admin.navn
              : lang === 'da'
                ? 'Ukendt administrator'
                : 'Unknown administrator';
          const typeBadge = isVirksomhed ? typeVirksomhed : typePerson;
          const Icon = isVirksomhed ? Building2 : User;

          const content = (
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <Icon size={18} className="text-slate-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm text-white font-medium truncate">
                    {displayName}
                    {isVirksomhed && (
                      <ExternalLink size={12} className="inline ml-1 text-slate-500" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400">
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                      {typeBadge}
                    </span>
                    {admin.virkningFra && (
                      <span>
                        {fraLabel} {formatDate(admin.virkningFra)}
                        {admin.virkningTil && ` — ${formatDate(admin.virkningTil)}`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );

          if (isVirksomhed) {
            return (
              <Link
                key={admin.id}
                href={`/dashboard/companies/${admin.cvr}`}
                className="block rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/40 hover:border-slate-600 p-3 transition-all"
              >
                {content}
              </Link>
            );
          }
          return (
            <div
              key={admin.id}
              className="rounded-lg bg-slate-800/40 border border-slate-700/40 p-3"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
