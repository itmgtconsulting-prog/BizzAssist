/**
 * SkatteberegningFlow — step-by-step visualisering af skatteberegning.
 *
 * BIZZ-957: Viser hvordan ejendomsskatten beregnes fra vurdering til
 * endelig skat som en vertikal flowchart med beløb og forklaring pr. trin.
 *
 * @param vurdering - Officiel vurdering (grundværdi, ejendomsværdi)
 * @param forelobig - Foreløbig vurdering (faktiske skatter)
 * @param loft - Grundskatteloft (ESL §45)
 * @param fritagelser - Skattefritagelser
 * @param erKolonihave - Om ejendommen er kolonihave (fritaget ejendomsværdiskat)
 */

'use client';

import { ArrowDown } from 'lucide-react';
import { formatDKK } from '@/app/lib/mock/ejendomme';
import type { VurderingData, VurderingResponse } from '@/app/api/vurdering/route';
import type { ForelobigVurdering } from '@/app/api/vurdering-forelobig/route';

interface Props {
  lang: 'da' | 'en';
  vurdering: VurderingData | null;
  forelobig: ForelobigVurdering | null;
  loft: VurderingResponse['loft'];
  fritagelser: VurderingResponse['fritagelser'];
  erKolonihave: boolean;
}

/** Enkelt trin i flowchart'en. */
function FlowStep({
  label,
  value,
  note,
  color = 'slate',
}: {
  label: string;
  value: string;
  note?: string;
  color?: 'emerald' | 'red' | 'blue' | 'amber' | 'slate';
}) {
  const colorMap = {
    emerald: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400',
    red: 'border-red-500/30 bg-red-500/5 text-red-400',
    blue: 'border-blue-500/30 bg-blue-500/5 text-blue-400',
    amber: 'border-amber-500/30 bg-amber-500/5 text-amber-400',
    slate: 'border-slate-700/40 bg-slate-800/40 text-white',
  };

  return (
    <div className={`rounded-lg border p-3 ${colorMap[color]}`}>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">{label}</p>
      <p className="text-lg font-bold">{value}</p>
      {note && <p className="text-[10px] text-slate-500 mt-0.5">{note}</p>}
    </div>
  );
}

/** Pil mellem trin. */
function FlowArrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1">
      <ArrowDown size={14} className="text-slate-600" />
      {label && <span className="text-[9px] text-slate-600 mt-0.5">{label}</span>}
    </div>
  );
}

/**
 * Step-by-step skatteberegningsflow.
 */
export default function SkatteberegningFlow({
  lang,
  vurdering,
  forelobig,
  loft,
  fritagelser,
  erKolonihave,
}: Props) {
  const da = lang === 'da';

  if (!vurdering && !forelobig) return null;

  const grundvaerdi = vurdering?.grundvaerdi ?? forelobig?.grundvaerdi ?? null;
  const ejendomsvaerdi = vurdering?.ejendomsvaerdi ?? forelobig?.ejendomsvaerdi ?? null;
  const afgiftGrund = vurdering?.afgiftspligtigGrundvaerdi ?? grundvaerdi;
  const promille = vurdering?.grundskyldspromille ?? null;
  const grundskyld = forelobig?.grundskyld ?? vurdering?.estimereretGrundskyld ?? null;
  const ejendomsskat = forelobig?.ejendomsskat ?? null;
  const totalSkat = forelobig?.totalSkat ?? null;
  const harLoft = loft && loft.length > 0;
  const harFritagelser = fritagelser && fritagelser.length > 0;

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <h3 className="text-white font-semibold text-sm mb-3">
        {da ? 'Skatteberegning trin for trin' : 'Tax calculation step by step'}
      </h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 items-start">
        {/* BIZZ-1043: Grundskyld-flow — self-start for top-alignment */}
        <div className="space-y-0 self-start">
          <p className="text-slate-400 text-xs font-medium mb-2">
            {da ? 'Grundskyld' : 'Land tax'}
          </p>

          {grundvaerdi != null && (
            <FlowStep
              label={da ? 'Offentlig grundværdi' : 'Official land value'}
              value={formatDKK(grundvaerdi)}
              color="blue"
            />
          )}

          {afgiftGrund != null && afgiftGrund !== grundvaerdi && (
            <>
              <FlowArrow label={da ? 'Afgiftspligtig' : 'Taxable'} />
              <FlowStep
                label={da ? 'Afgiftspligtig grundværdi' : 'Taxable land value'}
                value={formatDKK(afgiftGrund)}
                note={
                  da
                    ? 'Kan være lavere pga. overgangsregler'
                    : 'May be lower due to transition rules'
                }
                color="amber"
              />
            </>
          )}

          {harLoft && (
            <>
              <FlowArrow label="ESL §45" />
              <FlowStep
                label={da ? 'Grundskatteloft' : 'Land tax ceiling'}
                value={formatDKK(loft[0].grundvaerdi ?? 0)}
                note={da ? 'Max 4,75% stigning pr. år' : 'Max 4.75% increase per year'}
                color="emerald"
              />
            </>
          )}

          {harFritagelser && (
            <>
              <FlowArrow label={da ? 'Fritagelse' : 'Exemption'} />
              <FlowStep
                label={da ? 'Skattefritagelse' : 'Tax exemption'}
                value={`-${formatDKK(fritagelser.reduce((s, f) => s + (f.beloeb ?? 0), 0))}`}
                color="emerald"
              />
            </>
          )}

          {promille != null && <FlowArrow label={`× ${promille}‰`} />}

          {grundskyld != null && (
            <>
              {!promille && <FlowArrow />}
              <FlowStep
                label={da ? 'Årlig grundskyld' : 'Annual land tax'}
                value={formatDKK(grundskyld)}
                note={da ? 'Betales til kommunen' : 'Paid to municipality'}
                color="blue"
              />
            </>
          )}
        </div>

        {/* Ejendomsværdiskat-flow */}
        {!erKolonihave && ejendomsvaerdi != null && (
          <div className="space-y-0">
            <p className="text-slate-400 text-xs font-medium mb-2">
              {da ? 'Ejendomsværdiskat' : 'Property value tax'}
            </p>

            <FlowStep
              label={da ? 'Ejendomsværdi' : 'Property value'}
              value={formatDKK(ejendomsvaerdi)}
              color="blue"
            />

            <FlowArrow label={da ? '0,51% / 1,4%' : '0.51% / 1.4%'} />

            {ejendomsskat != null ? (
              <FlowStep
                label={da ? 'Årlig ejendomsværdiskat' : 'Annual property value tax'}
                value={formatDKK(ejendomsskat)}
                note={
                  da
                    ? '0,51% op til progressionsgrænse, 1,4% over'
                    : '0.51% up to threshold, 1.4% above'
                }
                color="blue"
              />
            ) : (
              <FlowStep
                label={da ? 'Ejendomsværdiskat' : 'Property value tax'}
                value={da ? 'Beregnes af SKAT' : 'Calculated by tax authority'}
                color="slate"
              />
            )}
          </div>
        )}
      </div>

      {/* Total */}
      {totalSkat != null && (
        <div className="mt-4 pt-3 border-t border-slate-700/30">
          <div className="flex items-center justify-between">
            <p className="text-slate-300 text-sm font-medium">
              {da ? 'Total årlig ejendomsskat' : 'Total annual property tax'}
            </p>
            <p className="text-white text-lg font-bold">{formatDKK(totalSkat)}</p>
          </div>
          <p className="text-slate-500 text-[10px] mt-0.5">
            {da
              ? `Grundskyld ${formatDKK(grundskyld ?? 0)} + ejendomsværdiskat ${formatDKK(ejendomsskat ?? 0)}`
              : `Land tax ${formatDKK(grundskyld ?? 0)} + property tax ${formatDKK(ejendomsskat ?? 0)}`}
          </p>
        </div>
      )}

      {/* BIZZ-992: Forklarende note om nyt vs. gammelt system */}
      <p className="text-slate-600 text-[9px] mt-3 leading-relaxed">
        {da
          ? 'Skattebeløbene er fra Vurderingsstyrelsens foreløbige beregning. Den faktiske opkrævede skat kan afvige pga. skatteloft, overgangsordninger og individuelle fradrag.'
          : "Tax amounts are from the Assessment Authority's preliminary calculation. Actual tax charged may differ due to tax ceilings, transitional rules and individual deductions."}
      </p>
    </div>
  );
}
