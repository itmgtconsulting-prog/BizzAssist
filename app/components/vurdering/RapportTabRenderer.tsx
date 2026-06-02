/**
 * BIZZ-1740: Struktureret rendering af vurderingsrapport tabs.
 *
 * Erstatter JSON.stringify med React-komponenter per tab-type.
 * Understøtter både raw data (fra generate-tabs) og AI-enhanced
 * data (fra generate-ai, gemt under indhold.ai).
 *
 * @module app/components/vurdering/RapportTabRenderer
 */

'use client';

import {
  Building2,
  Zap,
  DollarSign,
  FileText,
  MapPin,
  AlertTriangle,
  Users,
  Scale,
} from 'lucide-react';

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Format DKK number with da-DK locale. */
function fmtDkk(n: unknown): string {
  if (n == null || typeof n !== 'number') return '–';
  return n.toLocaleString('da-DK') + ' DKK';
}

/** Format number with da-DK locale. */
function fmtNum(n: unknown, suffix = ''): string {
  if (n == null || typeof n !== 'number') return '–';
  return n.toLocaleString('da-DK') + (suffix ? ` ${suffix}` : '');
}

/** Format date. */
function fmtDate(d: unknown): string {
  if (!d || typeof d !== 'string') return '–';
  try {
    return new Date(d).toLocaleDateString('da-DK', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return d;
  }
}

/** Section component with label + value. */
function Field({ label, value }: { label: string; value: unknown }) {
  const display = value == null || value === '' ? '–' : String(value);
  return (
    <div className="flex justify-between py-1 border-b border-slate-800/50 last:border-0">
      <span className="text-slate-400 text-xs">{label}</span>
      <span className="text-slate-300 text-xs font-medium text-right max-w-[60%]">{display}</span>
    </div>
  );
}

/** Section header with icon. */
function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3 mt-4 first:mt-0">
      <Icon size={14} className="text-blue-400" />
      <h4 className="text-sm font-medium text-slate-200">{title}</h4>
    </div>
  );
}

/** AI prose section — shown when AI content is available. */
function AiSection({ title, text }: { title: string; text: unknown }) {
  if (!text || typeof text !== 'string') return null;
  return (
    <div className="mt-3">
      <div className="text-xs font-medium text-blue-400/80 mb-1">{title}</div>
      <p className="text-xs text-slate-300 leading-relaxed">{text}</p>
    </div>
  );
}

/** Data table for arrays. */
function DataTable({ headers, rows }: { headers: string[]; rows: Array<Record<string, unknown>> }) {
  if (!rows || rows.length === 0) {
    return <p className="text-xs text-slate-400 italic">Ingen data.</p>;
  }
  const keys = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-700">
            {headers.map((h, i) => (
              <th key={i} className="text-left py-1.5 px-2 text-slate-400 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-800/30 hover:bg-slate-800/30">
              {keys.map((k, j) => (
                <td key={j} className="py-1.5 px-2 text-slate-300">
                  {row[k] == null ? '–' : String(row[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Per-tab renderers ──────────────────────────────────────────────────────

/** Extract data and AI sections from tab content. */
function extractParts(indhold: Record<string, unknown>) {
  // AI-enhanced: { data: {...}, ai: {...} }
  if (indhold.data && typeof indhold.data === 'object') {
    return {
      data: indhold.data as Record<string, unknown>,
      ai: (indhold.ai as Record<string, string>) ?? null,
    };
  }
  // Raw data only
  return { data: indhold, ai: null };
}

function IdentifikationTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  return (
    <div>
      <SectionHeader icon={Building2} title="Identifikation" />
      <Field label="Adresse" value={data.adresse} />
      <Field label="BFE-nummer" value={data.bfe} />
      <Field label="Matrikel" value={data.matrikelnr} />
      <Field label="Ejerlav" value={data.ejerlavsnavn} />
      <Field label="Kommune" value={data.kommune} />
      <Field label="Region" value={data.region} />
      <Field
        label="Postnr"
        value={data.postnr ? `${data.postnr} ${data.postnrnavn ?? ''}` : null}
      />
      <Field label="Zone" value={data.zone} />
      <Field label="Ejerforhold" value={data.ejerforholdskode} />
      <Field label="Anvendelse" value={data.bygningsanvendelse} />
      <Field label="Juridisk kategori" value={data.juridiskKategori} />
      {ai && (
        <>
          <AiSection title="Sagsoplysninger" text={ai.sagsoplysninger} />
          <AiSection title="Ejendomsbetegnelse" text={ai.ejendomsbetegnelse} />
          <AiSection title="Ejendomskategori" text={ai.ejendomskategori} />
          <AiSection title="Ejerforhold" text={ai.ejerforhold} />
        </>
      )}
    </div>
  );
}

function BygningsdataTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  return (
    <div>
      <SectionHeader icon={Building2} title="Bygningsdata" />
      <Field label="Opførelsesår" value={data.opfoerelsesaar} />
      <Field label="Om/tilbygningsår" value={data.omTilbygningsaar} />
      <Field label="Antal etager" value={data.antalEtager} />
      <Field label="Bebygget areal" value={fmtNum(data.bebyggetAreal, 'm²')} />
      <Field label="Samlet bygningsareal" value={fmtNum(data.samletBygningsareal, 'm²')} />
      <Field label="Boligareal" value={fmtNum(data.samletBoligareal, 'm²')} />
      <Field label="Erhvervsareal" value={fmtNum(data.samletErhvervsareal, 'm²')} />
      <Field label="Grundareal" value={fmtNum(data.grundareal, 'm²')} />
      <Field label="Bebyggelsesprocent" value={fmtNum(data.bebyggelsesprocent, '%')} />
      <Field label="Tagmateriale" value={data.tagdaekningsmateriale} />
      <Field label="Ydervæg" value={data.ydervaegMateriale} />
      <Field label="Fredning" value={data.fredning} />
      <Field label="Bevaringsværdighed" value={data.bevaringsvaerdighed} />
      <Field label="Asbest" value={data.asbestholdigtMateriale} />
      {ai && (
        <>
          <AiSection title="Oversigt" text={ai.oversigt} />
          <AiSection title="Konstruktion" text={ai.konstruktion} />
          <AiSection title="Arealer" text={ai.arealer} />
          <AiSection title="Tilstand" text={ai.tilstand} />
        </>
      )}
    </div>
  );
}

function EnergiTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  return (
    <div>
      <SectionHeader icon={Zap} title="Energi" />
      <Field label="Energimærke" value={data.energimaerke} />
      <Field label="Mærke-dato" value={fmtDate(data.energimaerkeDato)} />
      <Field label="Varmeinstallation" value={data.opvarmning} />
      <Field label="Opvarmningsmiddel" value={data.opvarmningsmiddel} />
      <Field label="Supplerende varme" value={data.supplerendeVarme} />
      <Field label="Vandforsyning" value={data.vandforsyning} />
      <Field label="Afløbsforhold" value={data.afloebsforhold} />
      {ai && (
        <>
          <AiSection title="Energivurdering" text={ai.energimaerke} />
          <AiSection title="Opvarmning" text={ai.opvarmning} />
          <AiSection title="Forsyning" text={ai.forsyning} />
          <AiSection title="Miljøvurdering" text={ai.miljoevurdering} />
        </>
      )}
    </div>
  );
}

function VurderingSkatTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  return (
    <div>
      <SectionHeader icon={DollarSign} title="Vurdering & Skat" />
      <Field label="Ejendomsværdi" value={fmtDkk(data.ejendomsvaerdi)} />
      <Field label="Grundværdi" value={fmtDkk(data.grundvaerdi)} />
      <Field
        label="Afgiftspligtig ejendomsværdi"
        value={fmtDkk(data.afgiftspligtigEjendomsvaerdi)}
      />
      <Field label="Afgiftspligtig grundværdi" value={fmtDkk(data.afgiftspligtigGrundvaerdi)} />
      <Field label="Grundskyldspromille" value={fmtNum(data.grundskyldspromille, '‰')} />
      <Field label="Estimeret grundskyld" value={fmtDkk(data.estimeretGrundskyld)} />
      <Field label="Vurderingsår" value={data.vurderingsaar} />
      <Field label="Vurderet areal" value={fmtNum(data.vurderetAreal, 'm²')} />
      {ai && (
        <>
          <AiSection title="Ejendomsværdi" text={ai.ejendomsvaerdi} />
          <AiSection title="Grundværdi" text={ai.grundvaerdi} />
          <AiSection title="Skatteberegning" text={ai.skatteberegning} />
          <AiSection title="Sammenfatning" text={ai.sammenfatning} />
        </>
      )}
    </div>
  );
}

function TinglysningTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  const ejere = (data.ejere ?? []) as Array<Record<string, unknown>>;
  const salgshistorik = (data.salgshistorik ?? []) as Array<Record<string, unknown>>;
  const haeftelser = (data.haeftelser ?? []) as Array<Record<string, unknown>>;

  return (
    <div>
      <SectionHeader icon={Users} title="Ejere" />
      {ejere.length > 0 ? (
        <DataTable
          headers={['Navn', 'CVR', 'Type', 'Andel', 'Fra']}
          rows={ejere.map((e) => ({
            Navn: e.navn ?? '–',
            CVR: e.cvr ?? '–',
            Type: e.type ?? '–',
            Andel: e.andel ?? '–',
            Fra: fmtDate(e.virkningFra),
          }))}
        />
      ) : (
        <p className="text-xs text-slate-400 italic">Ingen ejere registreret.</p>
      )}

      <SectionHeader icon={Scale} title="Handelshistorik" />
      {salgshistorik.length > 0 ? (
        <DataTable
          headers={['Dato', 'Ejer', 'Pris', 'Type', 'Betinget']}
          rows={salgshistorik.map((s) => ({
            Dato: fmtDate(s.dato),
            Ejer: s.ejer ?? '–',
            Pris: fmtDkk(s.kontantPris ?? s.samletPris),
            Type: s.overdragelsesmaade ?? '–',
            Betinget: s.betinget ? 'Ja' : '–',
          }))}
        />
      ) : (
        <p className="text-xs text-slate-400 italic">Ingen handler registreret.</p>
      )}

      <SectionHeader icon={FileText} title="Hæftelser" />
      {haeftelser.length > 0 ? (
        <DataTable
          headers={['Dato', 'Type', 'Hovedstol', 'Restgæld', 'Kreditor', 'Rente']}
          rows={haeftelser.map((h) => ({
            Dato: fmtDate(h.dato),
            Type: h.type ?? '–',
            Hovedstol: fmtDkk(h.hovedstolDkk),
            Restgæld: fmtDkk(h.restgaeldDkk),
            Kreditor: h.kreditor ?? '–',
            Rente: h.rente != null ? `${h.rente}%` : '–',
          }))}
        />
      ) : (
        <p className="text-xs text-slate-400 italic">Ingen hæftelser tinglyst.</p>
      )}

      {ai && (
        <>
          <AiSection title="Adkomst" text={ai.adkomst} />
          <AiSection title="Handelshistorik" text={ai.handelshistorik} />
          <AiSection title="Hæftelser" text={ai.haeftelser} />
        </>
      )}
    </div>
  );
}

function ServitutterTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  const servitutter = (data.servitutter ?? []) as Array<Record<string, unknown>>;

  return (
    <div>
      <SectionHeader icon={FileText} title="Servitutter" />
      {servitutter.length > 0 ? (
        <DataTable
          headers={['Dato', 'Type', 'Akt nr.', 'Beskrivelse']}
          rows={servitutter.map((s) => ({
            Dato: fmtDate(s.dato),
            Type: s.type ?? '–',
            'Akt nr.': s.aktNummer ?? '–',
            Beskrivelse:
              typeof s.beskrivelse === 'string' && s.beskrivelse.length > 80
                ? s.beskrivelse.substring(0, 80) + '…'
                : (s.beskrivelse ?? '–'),
          }))}
        />
      ) : (
        <p className="text-xs text-slate-400 italic">Ingen servitutter tinglyst.</p>
      )}
      {typeof data.noter === 'string' && data.noter.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-slate-400 mb-1">Noter</div>
          <p className="text-xs text-slate-300">{String(data.noter)}</p>
        </div>
      )}
      {ai && (
        <>
          <AiSection title="Oversigt" text={ai.oversigt} />
          <AiSection title="Væsentlige" text={ai.vaesentlige} />
          <AiSection title="Vurdering" text={ai.vurdering} />
        </>
      )}
    </div>
  );
}

function BeliggenhedTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  return (
    <div>
      <SectionHeader icon={MapPin} title="Beliggenhed" />
      <Field label="Adresse" value={data.adresse} />
      <Field label="Kommune" value={data.kommune} />
      <Field label="Region" value={data.region} />
      <Field
        label="Postnr"
        value={data.postnr ? `${data.postnr} ${data.postnrnavn ?? ''}` : null}
      />
      <Field label="Zone" value={data.zone} />
      {data.koordinater != null && typeof data.koordinater === 'object' && (
        <Field
          label="Koordinater"
          value={`${(data.koordinater as Record<string, number>).y?.toFixed(5)}, ${(data.koordinater as Record<string, number>).x?.toFixed(5)}`}
        />
      )}
      {typeof data.noter === 'string' && data.noter.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-slate-400 mb-1">Besigtigelsesnoter</div>
          <p className="text-xs text-slate-300">{String(data.noter)}</p>
        </div>
      )}
      {ai && (
        <>
          <AiSection title="Beliggenhed" text={ai.beliggenhed} />
          <AiSection title="Planforhold" text={ai.planforhold} />
          <AiSection title="Omsættelighed" text={ai.omsaettelighed} />
        </>
      )}
    </div>
  );
}

function RisikoTab({ indhold }: { indhold: Record<string, unknown> }) {
  const { data, ai } = extractParts(indhold);
  const referencer = (data.referenceejendomme ?? []) as Array<Record<string, unknown>>;
  const trykproevning = data.trykproevning as Record<string, unknown> | null;

  return (
    <div>
      <SectionHeader icon={AlertTriangle} title="Risiko & Reference" />

      {/* Trykprøvning */}
      {trykproevning && (
        <div
          className={`rounded-lg p-3 mb-4 border ${trykproevning.flagget ? 'bg-red-500/10 border-red-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}
        >
          <div className="text-xs font-medium mb-2 text-slate-200">Trykprøvning af kvm-pris</div>
          <Field label="Ejendom kvm-pris" value={fmtDkk(trykproevning.ejendomKvmPris)} />
          <Field label="Reference median" value={fmtDkk(trykproevning.referenceMedianKvmPris)} />
          <Field
            label="Reference gennemsnit"
            value={fmtDkk(trykproevning.referenceGennemsnitKvmPris)}
          />
          <Field
            label="Afvigelse"
            value={
              trykproevning.afvigelseProcent != null ? `${trykproevning.afvigelseProcent}%` : '–'
            }
          />
          {trykproevning.flagget === true && (
            <div className="flex items-center gap-1 mt-2 text-red-400 text-xs">
              <AlertTriangle size={12} />
              <span>Afvigelse {'>'} 20% — yderligere undersøgelse anbefales</span>
            </div>
          )}
        </div>
      )}

      {/* Referenceejendomme */}
      {referencer.length > 0 && (
        <>
          <div className="text-xs font-medium text-slate-400 mb-2">
            Referenceejendomme ({referencer.length})
          </div>
          <DataTable
            headers={['Adresse', 'Dato', 'Pris', 'Areal', 'Kvm-pris']}
            rows={referencer.map((r) => ({
              Adresse:
                typeof r.adresse === 'string' && r.adresse.length > 35
                  ? r.adresse.substring(0, 35) + '…'
                  : (r.adresse ?? '–'),
              Dato: fmtDate(r.salgsdato),
              Pris: fmtDkk(r.kontantKoebesum ?? r.samletKoebesum),
              Areal: fmtNum(r.boligareal, 'm²'),
              'Kvm-pris': fmtDkk(r.kvmPris),
            }))}
          />
        </>
      )}

      {ai && (
        <>
          <AiSection title="Miljørisici" text={ai.miljoe} />
          <AiSection title="Klimarisici" text={ai.klima} />
          <AiSection title="Byggeteknisk" text={ai.byggeteknisk} />
          <AiSection title="Samlet vurdering" text={ai.samletVurdering} />
        </>
      )}
    </div>
  );
}

// ─── Main renderer ──────────────────────────────────────────────────────────

interface Props {
  tabKey: string;
  indhold: Record<string, unknown>;
}

/**
 * Render a vurderingsrapport tab with structured components.
 *
 * @param tabKey - Tab identifier (e.g. 'identifikation', 'bygningsdata')
 * @param indhold - Tab content from vurdering_rapport_tabs.indhold
 */
export default function RapportTabRenderer({ tabKey, indhold }: Props) {
  switch (tabKey) {
    case 'identifikation':
      return <IdentifikationTab indhold={indhold} />;
    case 'bygningsdata':
      return <BygningsdataTab indhold={indhold} />;
    case 'energi':
      return <EnergiTab indhold={indhold} />;
    case 'vurdering_skat':
      return <VurderingSkatTab indhold={indhold} />;
    case 'tinglysning':
      return <TinglysningTab indhold={indhold} />;
    case 'servitutter':
      return <ServitutterTab indhold={indhold} />;
    case 'beliggenhed':
      return <BeliggenhedTab indhold={indhold} />;
    case 'risiko':
      return <RisikoTab indhold={indhold} />;
    default:
      return (
        <pre className="text-xs text-slate-300 whitespace-pre-wrap">
          {JSON.stringify(indhold, null, 2)}
        </pre>
      );
  }
}
