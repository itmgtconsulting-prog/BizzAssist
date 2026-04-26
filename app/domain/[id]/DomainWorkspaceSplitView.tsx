/**
 * DomainWorkspaceSplitView — to-panels arbejdsområde inden i Domain/Sager-tab.
 *
 * Efter pivot til global AI Chat (BIZZ-805): Dette panel hoster nu KUN
 * venstre-siden — sager-liste + valgt sag-detail med dokumenter, kunde-link
 * og inline edit. Den tidligere embedded AI-agent og skabelon-vælger er
 * fjernet; brugeren åbner i stedet topbar "AI Chat" for at generere
 * dokumenter. Den globale chat accepterer filer og viser preview i et
 * højre-side panel der skubber resten af skærmen til venstre.
 *
 * Layout:
 *   * TOP: sager-listen (filter: åbne/lukkede/arkiverede osv. styres af parent)
 *   * Resizable horizontal bar
 *   * BOTTOM: valgt sag — metadata, kunde-link, dokumenter (upload + select),
 *     inline edit-mode (blyant-ikon).
 *
 * @module app/domain/[id]/DomainWorkspaceSplitView
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  GripHorizontal,
  Briefcase,
  X,
  Loader2,
  Paperclip,
  Pencil,
  Save,
  Building2,
  User,
  Upload,
  FileText,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { useSetAIPageContext } from '@/app/context/AIPageContext';
import type { DomainCaseSummary } from './DomainCaseList';
import { CustomerSearchPicker, type CustomerLink } from './CustomerSearchPicker';
import SkabelonPickerPanel from '@/app/components/sager/SkabelonPickerPanel';

interface CaseDocSummary {
  id: string;
  name: string;
}

interface CaseDetail {
  id: string;
  name: string;
  client_ref: string | null;
  status: 'open' | 'closed' | 'archived';
  notes: string | null;
  tags: string[];
  client_kind: 'company' | 'person' | null;
  client_cvr: string | null;
  client_person_id: string | null;
  client_name: string | null;
  /** BIZZ-809: Kort beskrivelse vist som preview på sagskort + editable i detail */
  short_description: string | null;
}

interface Props {
  domainId: string;
  selectedCaseId: string;
  cases: DomainCaseSummary[];
  onSelectCase: (id: string) => void;
  onCloseWorkspace: () => void;
  /**
   * BIZZ-807: Valgfri callback som kaldes når sag ændres (fx via inline-edit
   * af sagsnavn). Parent bruger den til at reloade cases-listen så venstre
   * kolonne afspejler navneændringen øjeblikkeligt.
   */
  onCaseUpdated?: () => void;
}

const STORAGE = {
  // BIZZ-877: Tidligere topPct (vertikal split). Nu leftPct (horisontal split).
  // Læses ikke længere — ny key undgår kollision med gamle værdier.
  leftPct: 'bizz-domain-ws-leftPct',
};

export function DomainWorkspaceSplitView({
  domainId,
  selectedCaseId,
  cases,
  onSelectCase,
  onCloseWorkspace,
  onCaseUpdated,
}: Props) {
  const { lang } = useLanguage();
  const da = lang === 'da';

  // BIZZ-877: Skift fra vertikal split (topPct) til horisontal split (leftPct).
  // Default 38% = ~380px paa 1000px skaerm. Clamp 25-55% for laesbarhed.
  const [leftPct, setLeftPct] = useState(38);
  // BIZZ-936: Skabelon-panel bredde i pixels. Clamp 200-500px.
  const [templatePanelWidth, setTemplatePanelWidth] = useState(() => {
    if (typeof window === 'undefined') return 320;
    const saved = window.localStorage.getItem('bizz-domain-ws-templateW');
    return saved ? Math.max(200, Math.min(500, parseInt(saved, 10))) : 320;
  });

  // BIZZ-898: Ref til højre-panel så vi kan scrollTo-top når brugeren
  // skifter sag. Ellers beholder panel sin nuværende scroll-position som
  // ofte er langt nede — så brugeren ser "forkert" content ved skift.
  const rightPanelRef = useRef<HTMLDivElement>(null);

  // BIZZ-899: Valgte dokumenter til ai-chat-kontekst. Cap 20 (server-side
  // token-budget — ~20KB * 20 = 400KB parsed text). Persisteres i URL som
  // ?docs=id1,id2,id3 så state er bookmarkable. Ryddes automatisk ved
  // sag-skift (ny sag → nye relevante docs).
  const MAX_SELECTED_DOCS = 20;
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  // BIZZ-900: Valgte skabelon-IDs + modal-open-state. Persisteres i URL
  // som ?skabelon=tmpl1,tmpl2. Ryddes IKKE ved sag-skift (skabelon-valg
  // er tværgående — bruger kan anvende samme skabelon på flere sager).
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<Set<string>>(new Set());
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const v = Number(window.localStorage.getItem(STORAGE.leftPct));
    if (v >= 25 && v <= 55) setLeftPct(v);
  }, []);

  // BIZZ-898: Smooth scroll-to-top af højre panel når selectedCaseId ændres.
  // Matcher UX-kravet om "smooth scroll-to-top of højre panel ved skift".
  useEffect(() => {
    if (!rightPanelRef.current) return;
    rightPanelRef.current.scrollTo({ top: 0, behavior: 'smooth' });
  }, [selectedCaseId]);

  // BIZZ-899: Initial dokument-valg fra URL (?docs=id1,id2). Læses kun
  // ved mount + hver gang selectedCaseId ændres — sag-skift nulstiller
  // valget fordi dokument-IDs er sag-specifikke.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('docs');
    if (!raw) {
      setSelectedDocIds(new Set());
      return;
    }
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setSelectedDocIds(new Set(ids.slice(0, MAX_SELECTED_DOCS)));
  }, [selectedCaseId]);

  // BIZZ-899: Sync selectedDocIds → URL via replaceState. Non-empty: sæt
  // ?docs=id1,id2. Empty: fjern param helt.
  const writeDocsToUrl = useCallback((ids: Set<string>) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (ids.size > 0) {
      url.searchParams.set('docs', Array.from(ids).join(','));
    } else {
      url.searchParams.delete('docs');
    }
    window.history.replaceState(null, '', url.toString());
  }, []);

  // BIZZ-899: Toggle enkelt dokument. Cap håndhæves — ignorer add når
  // cap er nået (UI viser toast via uploadError-felt eller tooltip).
  const toggleDocSelect = useCallback(
    (docId: string) => {
      setSelectedDocIds((prev) => {
        const next = new Set(prev);
        if (next.has(docId)) {
          next.delete(docId);
        } else if (next.size < MAX_SELECTED_DOCS) {
          next.add(docId);
        }
        writeDocsToUrl(next);
        return next;
      });
    },
    [writeDocsToUrl]
  );

  // BIZZ-899: Bulk-actions "Vælg alle" / "Ryd valg".
  const selectAllDocs = useCallback(
    (allIds: string[]) => {
      const capped = new Set(allIds.slice(0, MAX_SELECTED_DOCS));
      setSelectedDocIds(capped);
      writeDocsToUrl(capped);
    },
    [writeDocsToUrl]
  );
  const clearSelectedDocs = useCallback(() => {
    const empty = new Set<string>();
    setSelectedDocIds(empty);
    writeDocsToUrl(empty);
  }, [writeDocsToUrl]);

  // BIZZ-900: Initial template-valg fra URL (?skabelon=id1,id2). Læses
  // kun ved mount — ikke nulstillet ved sag-skift (tværgående state).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('skabelon');
    if (!raw) return;
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setSelectedTemplateIds(new Set(ids));
  }, []);

  // BIZZ-900: URL-sync for skabelon-valg.
  const writeTemplatesToUrl = useCallback((ids: Set<string>) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (ids.size > 0) {
      url.searchParams.set('skabelon', Array.from(ids).join(','));
    } else {
      url.searchParams.delete('skabelon');
    }
    window.history.replaceState(null, '', url.toString());
  }, []);

  const commitTemplateSelection = useCallback(
    (ids: Set<string>) => {
      setSelectedTemplateIds(ids);
      writeTemplatesToUrl(ids);
    },
    [writeTemplatesToUrl]
  );

  const removeTemplate = useCallback(
    (id: string) => {
      setSelectedTemplateIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        writeTemplatesToUrl(next);
        return next;
      });
    },
    [writeTemplatesToUrl]
  );

  // BIZZ-900: Cache af navne for at kunne render chips uden at refetche
  // templates-liste. Fyldes første gang modalen hentet data, eller lazy
  // ved første chip-render. For MVP: vis ID som fallback når navn mangler.
  const [templateNameCache, setTemplateNameCache] = useState<Map<string, string>>(new Map());

  // BIZZ-900: Hvis URL havde pre-selected templates (?skabelon=...), hent
  // liste en gang for at fylde navn-cachet så chips viser navne ikke IDs.
  useEffect(() => {
    if (selectedTemplateIds.size === 0) return;
    // Skip hvis cachet allerede har alle navne
    if (Array.from(selectedTemplateIds).every((id) => templateNameCache.has(id))) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/domain/${domainId}/templates`);
        if (!r.ok) return;
        const tmpls = (await r.json()) as Array<{ id: string; name: string }>;
        if (!cancelled) {
          setTemplateNameCache(new Map(tmpls.map((t) => [t.id, t.name])));
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Kun kør når domainId eller template-ids ændrer — cache-lookup er
    // reeksekveret ved næste render så vi undgår re-fetch-loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainId, selectedTemplateIds]);

  // BIZZ-902: Sync workspace-state til AI page-context så AI Chat
  // automatisk kender aktuel sag + valgte dokumenter. AI kan så bruge
  // hent_dokument_indhold(docId) for at læse parsed tekst for hvert.
  const setAICtx = useSetAIPageContext();

  const colRef = useRef<HTMLDivElement>(null);

  const startHorizontalResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = colRef.current;
    if (!el) return;
    const onMove = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      // BIZZ-877: Horisontal resize — maalt paa clientX i stedet for clientY.
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(25, Math.min(55, pct));
      setLeftPct(clamped);
      window.localStorage.setItem(STORAGE.leftPct, String(Math.round(clamped)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // BIZZ-936: Resize handler for skabelon-panel (højre divider)
  const startTemplateResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = colRef.current;
    if (!el) return;
    const onMove = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const fromRight = rect.right - ev.clientX;
      const clamped = Math.max(200, Math.min(500, fromRight));
      setTemplatePanelWidth(clamped);
      window.localStorage.setItem('bizz-domain-ws-templateW', String(Math.round(clamped)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const selectedCase = cases.find((c) => c.id === selectedCaseId) ?? null;

  // ─── Case detail state ──────────────────────────────────────────────────
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [caseDocs, setCaseDocs] = useState<CaseDocSummary[]>([]);
  const [caseLoading, setCaseLoading] = useState(false);

  // BIZZ-902: Push domain-kontekst (aktuel sag + valgte dokumenter) ind
  // i AIPageContext så AIChatPanel kan sende det som side-kontekst i
  // chat-request. Opdateres hver gang selectedDocIds eller caseDetail
  // ændres. Cleanup ved unmount eller sag-close nulstilles via caseDetail=null.
  useEffect(() => {
    if (!caseDetail) {
      setAICtx(null);
      return;
    }
    const selectedDocs = caseDocs
      .filter((d) => selectedDocIds.has(d.id))
      .map((d) => ({ id: d.id, name: d.name }));
    // BIZZ-930: Inkluder valgte skabeloner i AI-kontekst
    const selectedTmpls = Array.from(selectedTemplateIds).map((id) => ({
      id,
      name: templateNameCache.get(id) ?? id.slice(0, 8),
    }));
    // BIZZ-937: Inkluder klient-info + sags-metadata i AI-kontekst
    const caseClient =
      caseDetail.client_kind && caseDetail.client_name
        ? {
            kind: caseDetail.client_kind,
            name: caseDetail.client_name,
            cvr:
              caseDetail.client_kind === 'company' && caseDetail.client_cvr
                ? caseDetail.client_cvr
                : undefined,
            enhedsNummer:
              caseDetail.client_kind === 'person' && caseDetail.client_person_id
                ? caseDetail.client_person_id
                : undefined,
          }
        : undefined;
    setAICtx({
      pageType: 'domain',
      currentCaseId: caseDetail.id,
      currentCaseName: caseDetail.name,
      selectedDocuments: selectedDocs,
      selectedTemplates: selectedTmpls.length > 0 ? selectedTmpls : undefined,
      caseClient,
      caseStatus: caseDetail.status,
      caseTags: caseDetail.tags.length > 0 ? caseDetail.tags : undefined,
      caseClientRef: caseDetail.client_ref ?? undefined,
    });
  }, [caseDetail, caseDocs, selectedDocIds, selectedTemplateIds, templateNameCache, setAICtx]);

  const [editing, setEditing] = useState(false);
  // BIZZ-807: inline edit-mode for selve sagsnavn — klik på header-titel
  // åbner input uden at skulle ind i fuld edit-form.
  const [inlineEditingName, setInlineEditingName] = useState(false);
  const [inlineNameValue, setInlineNameValue] = useState('');
  const [savingInlineName, setSavingInlineName] = useState(false);
  const [editName, setEditName] = useState('');
  const [editClientRef, setEditClientRef] = useState('');
  const [editNotes, setEditNotes] = useState('');
  // BIZZ-809: kort beskrivelse editable i detail-form
  const [editShortDescription, setEditShortDescription] = useState('');
  const [editStatus, setEditStatus] = useState<'open' | 'closed' | 'archived'>('open');
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editCustomer, setEditCustomer] = useState<CustomerLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const loadCaseDetail = useCallback(async () => {
    if (!selectedCaseId) return;
    setCaseLoading(true);
    try {
      const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}`);
      if (r.ok) {
        const json = (await r.json()) as CaseDetail & { docs?: CaseDocSummary[] };
        setCaseDetail({
          id: json.id,
          name: json.name,
          client_ref: json.client_ref,
          status: json.status,
          notes: json.notes,
          tags: json.tags ?? [],
          client_kind: json.client_kind ?? null,
          client_cvr: json.client_cvr ?? null,
          client_person_id: json.client_person_id ?? null,
          client_name: json.client_name ?? null,
          short_description: json.short_description ?? null,
        });
        setCaseDocs(json.docs ?? []);
      } else {
        setCaseDetail(null);
        setCaseDocs([]);
      }
    } catch {
      setCaseDetail(null);
      setCaseDocs([]);
    } finally {
      setCaseLoading(false);
    }
  }, [domainId, selectedCaseId]);

  useEffect(() => {
    void loadCaseDetail();
    setEditing(false);
  }, [loadCaseDetail]);

  useEffect(() => {
    if (!caseDetail) return;
    setEditName(caseDetail.name);
    setEditClientRef(caseDetail.client_ref ?? '');
    setEditNotes(caseDetail.notes ?? '');
    setEditShortDescription(caseDetail.short_description ?? '');
    setEditStatus(caseDetail.status);
    setEditTagsInput(caseDetail.tags.join(', '));
    setEditCustomer(
      caseDetail.client_kind
        ? {
            kind: caseDetail.client_kind,
            cvr: caseDetail.client_cvr,
            person_id: caseDetail.client_person_id,
            name: caseDetail.client_name ?? '',
          }
        : null
    );
  }, [caseDetail]);

  /**
   * BIZZ-888: Dirty-detection — sammenligner edit-state mod caseDetail.
   * Bruges af close/cancel-handlers til at vise confirm-dialog hvis
   * brugeren har ugemte ændringer. Tidligere lukkede X silently og
   * forkastede status-ændringer (fx 'open' → 'closed' blev glemt).
   */
  const isEditDirty = useCallback((): boolean => {
    if (!caseDetail) return false;
    if (editName !== caseDetail.name) return true;
    if (editClientRef !== (caseDetail.client_ref ?? '')) return true;
    if (editNotes !== (caseDetail.notes ?? '')) return true;
    if (editShortDescription !== (caseDetail.short_description ?? '')) return true;
    if (editStatus !== caseDetail.status) return true;
    if (editTagsInput !== caseDetail.tags.join(', ')) return true;
    const origCustomer = caseDetail.client_kind
      ? {
          kind: caseDetail.client_kind,
          cvr: caseDetail.client_cvr,
          person_id: caseDetail.client_person_id,
        }
      : null;
    const currCustomer = editCustomer
      ? {
          kind: editCustomer.kind,
          cvr: editCustomer.cvr,
          person_id: editCustomer.person_id,
        }
      : null;
    if (JSON.stringify(origCustomer) !== JSON.stringify(currCustomer)) return true;
    return false;
  }, [
    caseDetail,
    editName,
    editClientRef,
    editNotes,
    editShortDescription,
    editStatus,
    editTagsInput,
    editCustomer,
  ]);

  /**
   * BIZZ-888: Close-edit med dirty-check. Hvis ugemte ændringer:
   * spørg bruger om de vil forkaste. Tom ellers → luk direkte.
   */
  const closeEditWithConfirm = useCallback(() => {
    if (isEditDirty()) {
      const confirmed = window.confirm(
        da
          ? 'Du har ugemte ændringer. Vil du forkaste dem?'
          : 'You have unsaved changes. Discard them?'
      );
      if (!confirmed) return;
    }
    setEditing(false);
    setSaveError(null);
  }, [isEditDirty, da]);

  // BIZZ-884 + BIZZ-888: ESC-tast lukker edit-tilstand med dirty-check.
  // Kun aktiv når editing=true — ingen forstyrrelse af anden keyboard-nav.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditWithConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, closeEditWithConfirm]);

  const saveCase = async () => {
    if (!caseDetail) return;
    if (!editName.trim() || editName.length > 200) {
      setSaveError(da ? 'Sagsnavn skal være 1-200 tegn' : 'Name must be 1-200 chars');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const tags = editTagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const body: Record<string, unknown> = {
        name: editName.trim(),
        client_ref: editClientRef.trim() || null,
        notes: editNotes.trim() || null,
        status: editStatus,
        tags,
        client_kind: editCustomer?.kind ?? null,
        client_cvr: editCustomer?.cvr ?? null,
        client_person_id: editCustomer?.person_id ?? null,
        client_name: editCustomer?.name ?? null,
        short_description: editShortDescription.trim() || null,
      };
      const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({ error: 'Ukendt' }));
        setSaveError(j.error ?? (da ? 'Kunne ikke gemme' : 'Save failed'));
        return;
      }
      setEditing(false);
      await loadCaseDetail();
      // BIZZ-807: notify parent så sagsliste afspejler navn/status-ændring
      onCaseUpdated?.();
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!selectedCaseId || files.length === 0) return;
      setUploadBusy(true);
      setUploadError(null);
      try {
        for (const f of Array.from(files)) {
          if (f.size > 50 * 1024 * 1024) {
            setUploadError(
              da ? `${f.name} er for stor (max 50 MB)` : `${f.name} is too large (max 50 MB)`
            );
            continue;
          }
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}/docs`, {
            method: 'POST',
            body: fd,
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({ error: 'Ukendt' }));
            setUploadError(j.error ?? (da ? 'Upload fejlede' : 'Upload failed'));
            continue;
          }
        }
        await loadCaseDetail();
      } finally {
        setUploadBusy(false);
      }
    },
    [domainId, selectedCaseId, loadCaseDetail, da]
  );

  return (
    <div
      ref={colRef}
      // BIZZ-877: Horisontal split-view — flex-row (venstre: liste, højre: detaljer).
      // Tidligere flex-col (vertikal stack) som ikke udnyttede skærmens bredde.
      className="flex flex-col md:flex-row border border-slate-700/40 rounded-xl overflow-hidden"
      style={{ height: 'calc(100vh - 280px)', minHeight: 480 }}
    >
      {/* LEFT: cases list. BIZZ-877: På mobile (< md) fylder den hele bredden
          via w-full; på md+ bruges custom-pct via inline style. */}
      <div
        className="min-h-0 overflow-y-auto bg-slate-900/30 w-full md:w-[var(--split-left)] md:flex-shrink-0"
        style={{ ['--split-left' as string]: `${leftPct}%` }}
      >
        <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 flex items-center justify-between sticky top-0 z-10">
          <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Briefcase size={12} />
            {da ? 'Sager' : 'Cases'} · {cases.length}
          </p>
          <button
            type="button"
            onClick={onCloseWorkspace}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title={da ? 'Luk arbejdsområde' : 'Close workspace'}
          >
            <X size={12} />
          </button>
        </div>
        <ul className="divide-y divide-slate-800/60">
          {cases.map((c) => {
            const active = c.id === selectedCaseId;
            return (
              <li
                key={c.id}
                onClick={() => onSelectCase(c.id)}
                className={`px-3 py-2 cursor-pointer transition-colors ${
                  active
                    ? 'bg-blue-500/15 border-l-2 border-blue-400'
                    : 'hover:bg-slate-800/60 border-l-2 border-transparent'
                }`}
              >
                <p className="text-sm text-white truncate">{c.name}</p>
                {c.client_ref && (
                  <p className="text-[11px] text-slate-500 truncate">{c.client_ref}</p>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* BIZZ-877: Vertikal divider (vises kun på md+). På mobile falder
          layoutet tilbage til stack (flex-col) så divideren er skjult. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startHorizontalResize}
        className="group shrink-0 cursor-col-resize bg-slate-800/40 hover:bg-blue-500/40 relative transition-colors w-1.5 hidden md:block"
        title={da ? 'Træk venstre/højre' : 'Drag left/right'}
      >
        <GripHorizontal
          size={12}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300 rotate-90"
        />
      </div>

      {/* RIGHT: selected case detail */}
      <div ref={rightPanelRef} className="min-h-0 overflow-y-auto bg-slate-900/20 flex-1">
        <div className="px-3 py-2 border-b border-slate-700/40 bg-slate-900/50 sticky top-0 z-10 flex items-center justify-between gap-2">
          {/* BIZZ-807: Sagsnavn er klik-til-edit. Klik på tekst eller Pencil
              starter inline-edit; Enter/Blur gemmer; Escape cancel. */}
          {caseDetail && inlineEditingName ? (
            <input
              type="text"
              autoFocus
              value={inlineNameValue}
              onChange={(e) => setInlineNameValue(e.target.value)}
              maxLength={200}
              disabled={savingInlineName}
              onKeyDown={async (e) => {
                if (e.key === 'Escape') {
                  setInlineEditingName(false);
                  setInlineNameValue(caseDetail.name);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              onBlur={async () => {
                const next = inlineNameValue.trim();
                if (!next || next.length > 200 || next === caseDetail.name) {
                  setInlineEditingName(false);
                  setInlineNameValue(caseDetail.name);
                  return;
                }
                setSavingInlineName(true);
                try {
                  const r = await fetch(`/api/domain/${domainId}/cases/${selectedCaseId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: next }),
                  });
                  if (r.ok) {
                    // Reload så sagsliste + detail synker
                    await loadCaseDetail();
                    onCaseUpdated?.();
                  }
                } finally {
                  setSavingInlineName(false);
                  setInlineEditingName(false);
                }
              }}
              className="flex-1 min-w-0 text-xs font-semibold bg-slate-900 border border-blue-500/40 rounded px-2 py-1 text-white focus:outline-none focus:border-blue-400"
              aria-label={da ? 'Sagsnavn' : 'Case name'}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!caseDetail) return;
                setInlineNameValue(caseDetail.name);
                setInlineEditingName(true);
              }}
              disabled={!caseDetail}
              className="flex-1 min-w-0 text-xs font-semibold text-slate-300 hover:text-white text-left truncate disabled:cursor-default disabled:hover:text-slate-300"
              title={
                caseDetail
                  ? da
                    ? 'Klik for at redigere sagsnavn'
                    : 'Click to edit case name'
                  : undefined
              }
            >
              {caseDetail?.name ?? selectedCase?.name ?? (da ? 'Vælg en sag' : 'Select a case')}
            </button>
          )}
          {caseDetail && !editing && !inlineEditingName && (
            <>
              {/* BIZZ-929/930: Toggle skabelon-panel (3. kolonne). */}
              <button
                type="button"
                onClick={() => setTemplatePickerOpen((prev) => !prev)}
                aria-label={da ? 'Skabelon-panel' : 'Template panel'}
                title={
                  templatePickerOpen
                    ? da
                      ? 'Luk skabelon-panel'
                      : 'Close template panel'
                    : da
                      ? 'Åbn skabelon-panel'
                      : 'Open template panel'
                }
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors shrink-0 ${
                  templatePickerOpen
                    ? 'bg-blue-600/20 hover:bg-blue-600/30 border-blue-500/40 text-blue-300'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                }`}
              >
                <FileText size={10} />
                {da ? 'Skabelon' : 'Template'}
                {selectedTemplateIds.size > 0 && (
                  <span className="px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[9px] leading-none">
                    {selectedTemplateIds.size}
                  </span>
                )}
              </button>
              {/* BIZZ-984: Expand-knap fjernet — sager vises kun i split-view */}
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={da ? 'Rediger sag (alle felter)' : 'Edit case (all fields)'}
                className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
                title={da ? 'Rediger alle felter' : 'Edit all fields'}
              >
                <Pencil size={12} />
              </button>
            </>
          )}
          {/* BIZZ-884 + BIZZ-888: Synlig X-knap der lukker edit-tilstand med
              dirty-check. Forkaster ikke ugemte ændringer silently. */}
          {caseDetail && editing && (
            <button
              type="button"
              onClick={closeEditWithConfirm}
              aria-label={da ? 'Luk redigering' : 'Close edit'}
              title={da ? 'Luk redigering (Esc)' : 'Close edit (Esc)'}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="p-3 space-y-3">
          {caseLoading && !caseDetail && (
            <Loader2 size={14} className="animate-spin text-blue-400" />
          )}
          {caseDetail && !editing && (
            <>
              {caseDetail.client_kind && caseDetail.client_name && (
                <div className="flex items-center gap-2 bg-slate-900/60 border border-slate-700/40 rounded-md px-2.5 py-1.5">
                  {caseDetail.client_kind === 'company' ? (
                    <Building2 size={13} className="text-emerald-400 shrink-0" />
                  ) : (
                    <User size={13} className="text-sky-400 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-white truncate">{caseDetail.client_name}</p>
                    <p className="text-[10px] text-slate-500 uppercase">
                      {caseDetail.client_kind === 'company'
                        ? `CVR ${caseDetail.client_cvr}`
                        : `Person · ${caseDetail.client_person_id}`}
                    </p>
                  </div>
                  {caseDetail.client_kind === 'company' && caseDetail.client_cvr && (
                    <Link
                      href={`/dashboard/companies/${caseDetail.client_cvr}`}
                      className="text-[10px] text-blue-300 hover:text-blue-200 shrink-0"
                    >
                      {da ? 'Åbn →' : 'Open →'}
                    </Link>
                  )}
                </div>
              )}
              <div className="text-xs space-y-1">
                {caseDetail.client_ref && (
                  <p>
                    <span className="text-slate-500">
                      {da ? 'Klient-reference: ' : 'Client ref: '}
                    </span>
                    <span className="text-slate-200">{caseDetail.client_ref}</span>
                  </p>
                )}
                <p>
                  <span className="text-slate-500">{da ? 'Status: ' : 'Status: '}</span>
                  <span className="text-slate-200 capitalize">{caseDetail.status}</span>
                </p>
                {caseDetail.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {caseDetail.tags.map((t) => (
                      <span
                        key={t}
                        className="px-1.5 py-0.5 bg-slate-700/40 text-slate-300 text-[10px] rounded"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {caseDetail.notes && (
                  <p className="text-slate-300 whitespace-pre-wrap pt-1.5 text-[11px]">
                    {caseDetail.notes}
                  </p>
                )}
              </div>

              {/* BIZZ-900/929: Skabelon-sektion viser valgte skabeloner som chips.
                  Knap er flyttet til sags-header (BIZZ-929). */}
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">
                  {da ? 'Skabeloner' : 'Templates'}
                  {selectedTemplateIds.size > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] normal-case tracking-normal">
                      {selectedTemplateIds.size}{' '}
                      {da ? (selectedTemplateIds.size === 1 ? 'valgt' : 'valgte') : 'selected'}
                    </span>
                  )}
                </p>
                {selectedTemplateIds.size === 0 ? (
                  <p className="text-xs text-slate-500">
                    {da ? 'Ingen skabeloner valgt.' : 'No templates selected.'}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {Array.from(selectedTemplateIds).map((id) => {
                      const name = templateNameCache.get(id) ?? id.slice(0, 8);
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-800/80 border border-blue-500/30 rounded text-[11px] text-slate-200"
                        >
                          <span className="truncate max-w-[180px]" title={name}>
                            {name}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeTemplate(id)}
                            aria-label={da ? `Fjern ${name}` : `Remove ${name}`}
                            className="p-0.5 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-700/40 transition-colors"
                          >
                            <X size={9} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5 gap-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500 whitespace-nowrap">
                    {da ? 'Dokumenter' : 'Documents'} · {caseDocs.length}
                    {selectedDocIds.size > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] normal-case tracking-normal">
                        {selectedDocIds.size}{' '}
                        {da ? (selectedDocIds.size === 1 ? 'valgt' : 'valgte') : 'selected'}
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* BIZZ-899: Bulk-actions — kun relevant når der er docs */}
                    {caseDocs.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => selectAllDocs(caseDocs.map((d) => d.id))}
                          className="text-[10px] px-1.5 py-0.5 rounded text-slate-300 hover:text-white hover:bg-slate-800"
                          disabled={selectedDocIds.size === caseDocs.length}
                        >
                          {da ? 'Vælg alle' : 'Select all'}
                        </button>
                        {selectedDocIds.size > 0 && (
                          <button
                            type="button"
                            onClick={clearSelectedDocs}
                            className="text-[10px] px-1.5 py-0.5 rounded text-slate-300 hover:text-white hover:bg-slate-800"
                          >
                            {da ? 'Ryd valg' : 'Clear'}
                          </button>
                        )}
                      </>
                    )}
                    <label className="cursor-pointer inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors">
                      {uploadBusy ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Upload size={10} />
                      )}
                      {da ? 'Upload' : 'Upload'}
                      <input
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files) void uploadFiles(e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
                {uploadError && <p className="text-[10px] text-rose-300 mb-1">{uploadError}</p>}
                {/* BIZZ-899: Cap-advisel når bruger har valgt MAX og forsøger at
                    vælge flere. Forhindrer forvirring over "intet sker". */}
                {selectedDocIds.size >= MAX_SELECTED_DOCS && (
                  <p className="text-[10px] text-amber-300 mb-1">
                    {da
                      ? `Max ${MAX_SELECTED_DOCS} dokumenter kan vælges til AI-kontekst.`
                      : `Max ${MAX_SELECTED_DOCS} documents can be selected for AI context.`}
                  </p>
                )}
                {caseDocs.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    {da ? 'Ingen dokumenter på sagen.' : 'No documents on this case.'}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {caseDocs.map((d) => {
                      const checked = selectedDocIds.has(d.id);
                      return (
                        <li
                          key={d.id}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded transition-colors border ${
                            checked
                              ? 'bg-blue-500/10 border-blue-400/40'
                              : 'border-transparent hover:bg-slate-800/40'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDocSelect(d.id)}
                            aria-label={
                              da ? `Vælg dokument ${d.name}` : `Select document ${d.name}`
                            }
                            className="shrink-0 accent-blue-500"
                          />
                          <Paperclip size={11} className="text-slate-400 shrink-0" />
                          <span className="text-xs text-slate-200 truncate">{d.name}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              {/* BIZZ-984: "Åbn i fuld visning"-link fjernet — sager vises kun i split-view */}
            </>
          )}

          {caseDetail && editing && (
            <div className="space-y-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Sagsnavn' : 'Case name'}
                </span>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={200}
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Kunde (valgfri)' : 'Customer (optional)'}
                </span>
                <div className="mt-0.5">
                  <CustomerSearchPicker value={editCustomer} onChange={setEditCustomer} compact />
                </div>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Klient-ref' : 'Client ref'}
                </span>
                <input
                  type="text"
                  value={editClientRef}
                  onChange={(e) => setEditClientRef(e.target.value)}
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Status' : 'Status'}
                </span>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as 'open' | 'closed' | 'archived')}
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                >
                  <option value="open">{da ? 'Åben' : 'Open'}</option>
                  <option value="closed">{da ? 'Lukket' : 'Closed'}</option>
                  <option value="archived">{da ? 'Arkiveret' : 'Archived'}</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Tags (komma)' : 'Tags (comma)'}
                </span>
                <input
                  type="text"
                  value={editTagsInput}
                  onChange={(e) => setEditTagsInput(e.target.value)}
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs"
                />
              </label>
              {/* BIZZ-809: Kort beskrivelse (max 200 tegn). Vises på
                  sagskort i listen. Char-counter i label. */}
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center justify-between">
                  <span>{da ? 'Kort beskrivelse' : 'Short description'}</span>
                  <span className="text-slate-600 tabular-nums">
                    {editShortDescription.length}/200
                  </span>
                </span>
                <textarea
                  value={editShortDescription}
                  onChange={(e) => setEditShortDescription(e.target.value.slice(0, 200))}
                  rows={2}
                  maxLength={200}
                  placeholder={
                    da
                      ? '2-3 linjer preview vist på sagskort'
                      : '2-3 lines preview shown on case cards'
                  }
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs resize-none"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">
                  {da ? 'Noter' : 'Notes'}
                </span>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={3}
                  className="mt-0.5 w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded text-white text-xs resize-y"
                />
              </label>
              {saveError && <p className="text-[10px] text-rose-300">{saveError}</p>}
              <div className="flex items-center justify-end gap-1.5 pt-1">
                <button
                  type="button"
                  // BIZZ-888: Annuller bruger samme dirty-check som X/ESC
                  // for konsistent adfaerd paa tvaers af alle close-paths.
                  onClick={closeEditWithConfirm}
                  disabled={saving}
                  className="px-2 py-1 text-[11px] text-slate-400 hover:text-white"
                >
                  {da ? 'Annuller' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={() => void saveCase()}
                  disabled={saving}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white text-[11px] font-medium"
                >
                  {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                  {da ? 'Gem' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* BIZZ-930/936: Skabelon-picker panel — 3. kolonne i split-layout.
          Resizable divider + panel. Live-selection ved hvert klik. */}
      {templatePickerOpen && (
        <>
          {/* BIZZ-936: Resize divider mellem sags-detaljer og skabelon-panel */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startTemplateResize}
            className="group shrink-0 cursor-col-resize bg-slate-800/40 hover:bg-blue-500/40 relative transition-colors w-1.5 hidden md:block"
            title={da ? 'Træk venstre/højre' : 'Drag left/right'}
          >
            <GripHorizontal
              size={12}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-slate-600 group-hover:text-blue-300 rotate-90"
            />
          </div>
        </>
      )}
      {templatePickerOpen && (
        <SkabelonPickerPanel
          domainId={domainId}
          selectedIds={selectedTemplateIds}
          width={templatePanelWidth}
          onSelectionChange={(ids) => {
            commitTemplateSelection(ids);
            // Byg navn-cache fra template-listen (fire-and-forget)
            void (async () => {
              try {
                const r = await fetch(`/api/domain/${domainId}/templates`);
                if (!r.ok) return;
                const tmpls = (await r.json()) as Array<{ id: string; name: string }>;
                setTemplateNameCache(new Map(tmpls.map((t) => [t.id, t.name])));
              } catch {
                /* non-fatal */
              }
            })();
          }}
          onClose={() => setTemplatePickerOpen(false)}
        />
      )}
    </div>
  );
}
