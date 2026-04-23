/**
 * NewCaseClient — form for creating a new case in a domain.
 *
 * BIZZ-712: name (required, 1-200 chars), optional client_ref, optional
 * comma-separated tags. Redirects to the new case detail page on success.
 *
 * @module app/domain/[id]/new-case/NewCaseClient
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Save, Briefcase } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import { CustomerSearchPicker, type CustomerLink } from '../CustomerSearchPicker';

/**
 * New-case form. On submit, POSTs to /api/domain/:id/cases and navigates
 * to the newly-created case's detail page.
 *
 * @param domainId - Domain UUID
 */
export default function NewCaseClient({ domainId }: { domainId: string }) {
  const { lang } = useLanguage();
  const da = lang === 'da';
  const router = useRouter();

  const [name, setName] = useState('');
  const [clientRef, setClientRef] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  // BIZZ-802: Optional customer link — user searches BizzAssist db
  const [customer, setCustomer] = useState<CustomerLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const r = await fetch(`/api/domain/${domainId}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          client_ref: clientRef.trim() || undefined,
          tags,
          // BIZZ-802: send customer link if picked — server validates combo
          client_kind: customer?.kind ?? null,
          client_cvr: customer?.cvr ?? null,
          client_person_id: customer?.person_id ?? null,
          client_name: customer?.name ?? null,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: 'Unknown' }));
        setError(d.error || (da ? 'Ukendt fejl' : 'Unknown error'));
        return;
      }
      const { id } = (await r.json()) as { id: string };
      router.push(`/domain/${domainId}/case/${id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <Link
        href={`/domain/${domainId}`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm"
      >
        <ArrowLeft size={14} />
        {da ? 'Tilbage til sager' : 'Back to cases'}
      </Link>

      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Briefcase size={22} className="text-blue-400" />
          {da ? 'Opret ny sag' : 'New case'}
        </h1>
      </div>

      <form
        onSubmit={submit}
        className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-4"
      >
        <label className="block">
          <span className="text-slate-300 text-sm">
            {da ? 'Sagsnavn' : 'Case name'} <span className="text-rose-400">*</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            placeholder={da ? 'fx: Skøde Hansen 2026' : 'e.g. Deed Hansen 2026'}
            className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
          />
        </label>

        <label className="block">
          <span className="text-slate-300 text-sm">
            {da ? 'Klient-reference (valgfri)' : 'Client reference (optional)'}
          </span>
          <input
            type="text"
            value={clientRef}
            onChange={(e) => setClientRef(e.target.value)}
            placeholder={da ? 'fx: J.nr. 2026-042' : 'e.g. File No. 2026-042'}
            className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
          />
        </label>

        {/* BIZZ-802: Optional customer link — søg i BizzAssist-databasen
            (CVR-virksomhed eller person via /api/search) og tilknyt. */}
        <div className="block">
          <span className="text-slate-300 text-sm">
            {da ? 'Kunde (valgfri)' : 'Customer (optional)'}
          </span>
          <div className="mt-1">
            <CustomerSearchPicker value={customer} onChange={setCustomer} />
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {da
              ? 'Søg efter en virksomhed (CVR) eller person allerede i BizzAssist.'
              : 'Search for a company (CVR) or person already in BizzAssist.'}
          </p>
        </div>

        <label className="block">
          <span className="text-slate-300 text-sm">
            {da ? 'Tags (komma-separeret)' : 'Tags (comma-separated)'}
          </span>
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder={da ? 'fx: skøde, ejerskifte' : 'e.g. deed, transfer'}
            className="mt-1 w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-md text-white text-sm"
          />
        </label>

        {error && (
          <div className="px-3 py-2 bg-rose-900/20 border border-rose-700/40 rounded-md text-rose-300 text-sm">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Link
            href={`/domain/${domainId}`}
            className="px-3 py-2 text-slate-400 hover:text-white text-sm"
          >
            {da ? 'Annuller' : 'Cancel'}
          </Link>
          <button
            type="submit"
            disabled={!name.trim() || saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md text-white text-sm font-medium"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {da ? 'Opret sag' : 'Create case'}
          </button>
        </div>
      </form>
    </div>
  );
}
