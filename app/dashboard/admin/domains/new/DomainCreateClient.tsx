/**
 * DomainCreateClient — form for super-admins to provision a new domain.
 *
 * POSTs to /api/admin/domains which inserts into the `domain` table with
 * the provided name/slug/plan. The slug auto-generates from the name but
 * remains editable. owner_tenant_id defaults to a sentinel UUID in the
 * API — the super-admin assigns a real tenant later via member-invite.
 *
 * @module app/dashboard/admin/domains/new/DomainCreateClient
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Building2, Loader2, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';

/** Slug sanitiser — matches the same pattern used server-side. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-zæøå0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/** Renders the new-domain form. */
export default function DomainCreateClient() {
  const router = useRouter();
  const { lang } = useLanguage();
  const da = lang === 'da';

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [plan, setPlan] = useState('enterprise_domain');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError(da ? 'Navn er påkrævet' : 'Name is required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), slug: effectiveSlug, plan }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          j.error ??
            (res.status === 409
              ? da
                ? 'Slug findes allerede — vælg et andet'
                : 'Slug already exists — choose another'
              : da
                ? 'Kunne ikke oprette domain'
                : 'Could not create domain')
        );
        return;
      }
      router.push('/dashboard/admin/domains');
      router.refresh();
    } catch {
      setError(da ? 'Netværksfejl' : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/admin/domains"
          className="text-slate-400 hover:text-slate-200 transition-colors"
          aria-label={da ? 'Tilbage' : 'Back'}
        >
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Building2 size={22} className="text-blue-400" />
          {da ? 'Opret Domain' : 'Create Domain'}
        </h1>
      </div>

      {/* Form */}
      <form
        onSubmit={handleSubmit}
        className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-6 space-y-5"
      >
        {/* Name */}
        <div>
          <label htmlFor="domain-name" className="block text-sm text-slate-300 mb-1.5">
            {da ? 'Navn' : 'Name'}
          </label>
          <input
            id="domain-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={da ? 'F.eks. Ringkjøbing Advokatpartnerselskab' : 'e.g. Acme Law Firm'}
            required
            className="w-full bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Slug */}
        <div>
          <label htmlFor="domain-slug" className="block text-sm text-slate-300 mb-1.5">
            {da ? 'Slug (URL-identifier)' : 'Slug (URL identifier)'}
          </label>
          <input
            id="domain-slug"
            type="text"
            value={effectiveSlug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="ringkjoebing-advokater"
            required
            pattern="[a-z0-9\-]+"
            className="w-full bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white placeholder:text-slate-500 focus:border-blue-500 focus:outline-none font-mono text-sm"
          />
          <p className="text-slate-500 text-xs mt-1">
            {da
              ? 'Auto-genereret fra navnet. Må kun indeholde små bogstaver, tal og bindestreger.'
              : 'Auto-generated from name. Only lowercase letters, digits, and hyphens.'}
          </p>
        </div>

        {/* Plan */}
        <div>
          <label htmlFor="domain-plan" className="block text-sm text-slate-300 mb-1.5">
            {da ? 'Plan' : 'Plan'}
          </label>
          <select
            id="domain-plan"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="w-full bg-slate-900/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
          >
            <option value="enterprise_domain">Enterprise Domain (4.999 DKK/md)</option>
          </select>
          <p className="text-slate-500 text-xs mt-1">
            {da
              ? 'Limits opdateres automatisk når Stripe-abonnementet aktiveres.'
              : 'Limits are refreshed automatically when the Stripe subscription activates.'}
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={16} className="text-red-400 shrink-0" />
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* Submit */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {submitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {da ? 'Opretter…' : 'Creating…'}
              </>
            ) : (
              <>
                <Building2 size={16} />
                {da ? 'Opret Domain' : 'Create Domain'}
              </>
            )}
          </button>
          <Link
            href="/dashboard/admin/domains"
            className="text-slate-400 hover:text-slate-200 text-sm transition-colors"
          >
            {da ? 'Annullér' : 'Cancel'}
          </Link>
        </div>
      </form>
    </div>
  );
}
