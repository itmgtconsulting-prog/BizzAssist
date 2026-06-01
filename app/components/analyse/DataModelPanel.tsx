/**
 * DataModelPanel — visuelt felt-panel for pivot-analyse.
 *
 * BIZZ-1269: Viser forretningsdomæner (Ejendom, Virksomhed) med klikbare
 * felter. Klik tilføjer/fjerner felt fra pivot-tabellen.
 *
 * @param selectedFields - Set af valgte kolonne-navne
 * @param onToggleField - Callback til at toggle et felt
 * @param selectedDomain - Aktivt domæne-ID
 * @param onSelectDomain - Callback til at skifte domæne
 */

'use client';

import { memo } from 'react';
import { Hash, Type, Calendar, ToggleLeft } from 'lucide-react';
import { ANALYSE_DOMAINS, type FieldType } from '@/app/lib/analyseDataModel';

/** Ikon-map for felt-typer */
function FieldTypeIcon({ type, size = 12 }: { type: FieldType; size?: number }) {
  switch (type) {
    case 'number':
      return <Hash size={size} />;
    case 'date':
      return <Calendar size={size} />;
    case 'boolean':
      return <ToggleLeft size={size} />;
    default:
      return <Type size={size} />;
  }
}

interface DataModelPanelProps {
  /** Aktuelt valgte felter (kolonne-navne) */
  selectedFields: Set<string>;
  /** Toggle-handler for felt */
  onToggleField: (column: string, table: string) => void;
  /** Aktivt domæne-ID */
  selectedDomain: string;
  /** Skift domæne */
  onSelectDomain: (domainId: string) => void;
}

/**
 * Visuelt felt-panel med domæne-tabs og klikbare felter.
 */
export const DataModelPanel = memo(function DataModelPanel({
  selectedFields,
  onToggleField,
  selectedDomain,
  onSelectDomain,
}: DataModelPanelProps) {
  const activeDomain = ANALYSE_DOMAINS.find((d) => d.id === selectedDomain) ?? ANALYSE_DOMAINS[0];

  return (
    <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl overflow-hidden">
      {/* Domæne-tabs */}
      <div className="flex border-b border-slate-700/40">
        {ANALYSE_DOMAINS.map((domain) => {
          const isActive = domain.id === selectedDomain;
          const selectedCount = domain.fields.filter((f) => selectedFields.has(f.column)).length;
          return (
            <button
              key={domain.id}
              onClick={() => onSelectDomain(domain.id)}
              className={`flex-1 px-3 py-2.5 text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                isActive
                  ? `bg-${domain.color}-500/10 text-${domain.color}-300 border-b-2 border-${domain.color}-400`
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30'
              }`}
            >
              {domain.label}
              {selectedCount > 0 && (
                <span
                  className={`bg-${domain.color}-500/20 text-${domain.color}-300 text-[10px] px-1.5 py-0.5 rounded-full font-bold`}
                >
                  {selectedCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Felt-liste */}
      <div className="p-2 space-y-0.5 max-h-[400px] overflow-y-auto">
        {activeDomain.fields.map((field) => {
          const isSelected = selectedFields.has(field.column);
          return (
            <button
              key={field.column}
              onClick={() => onToggleField(field.column, activeDomain.table)}
              title={field.description}
              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all flex items-center gap-2.5 ${
                isSelected
                  ? `bg-${activeDomain.color}-500/15 text-${activeDomain.color}-200 border border-${activeDomain.color}-500/30`
                  : 'text-slate-300 hover:bg-slate-700/40 border border-transparent'
              }`}
            >
              <span className={isSelected ? `text-${activeDomain.color}-400` : 'text-slate-400'}>
                <FieldTypeIcon type={field.type} />
              </span>
              <span className="flex-1 truncate">{field.label}</span>
              <span className="text-[10px] text-slate-400">{field.type}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
