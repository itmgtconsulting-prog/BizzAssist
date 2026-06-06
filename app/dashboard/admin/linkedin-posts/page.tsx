/**
 * Admin-side for kuratering af LinkedIn featured posts.
 *
 * BIZZ-2040: CRUD UI med liste, toggle active/inactive,
 * tilføj ny post, rediger og slet.
 *
 * @module app/dashboard/admin/linkedin-posts/page
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ExternalLink, Loader2, Eye, EyeOff, Save, X, Linkedin } from 'lucide-react';

/** LinkedIn post data fra API. */
interface LinkedInPost {
  id: string;
  post_url: string;
  image_url: string | null;
  excerpt_da: string;
  excerpt_en: string;
  published_at: string;
  sort_order: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Formular-state for ny/rediger post. */
interface PostForm {
  post_url: string;
  image_url: string;
  excerpt_da: string;
  excerpt_en: string;
  published_at: string;
  sort_order: number;
  active: boolean;
}

const EMPTY_FORM: PostForm = {
  post_url: '',
  image_url: '',
  excerpt_da: '',
  excerpt_en: '',
  published_at: new Date().toISOString().slice(0, 10),
  sort_order: 0,
  active: true,
};

/**
 * LinkedInPostsAdmin — admin-side til kuratering af LinkedIn posts.
 */
export default function LinkedInPostsAdmin() {
  const [posts, setPosts] = useState<LinkedInPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<PostForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  /** Hent alle posts fra admin API. */
  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/linkedin-posts');
      if (!res.ok) throw new Error('Kunne ikke hente posts');
      const data = await res.json();
      setPosts(data.posts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  /** Åbn formular for ny post. */
  const handleNew = useCallback(() => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }, []);

  /** Åbn formular for redigering. */
  const handleEdit = useCallback((post: LinkedInPost) => {
    setEditId(post.id);
    setForm({
      post_url: post.post_url,
      image_url: post.image_url ?? '',
      excerpt_da: post.excerpt_da,
      excerpt_en: post.excerpt_en,
      published_at: post.published_at,
      sort_order: post.sort_order,
      active: post.active,
    });
    setShowForm(true);
  }, []);

  /** Gem post (opret eller opdater). */
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const method = editId ? 'PUT' : 'POST';
      const body = editId ? { ...form, id: editId } : form;
      const res = await fetch('/api/admin/linkedin-posts', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Fejl ved gem');
      }
      setShowForm(false);
      setEditId(null);
      await fetchPosts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ukendt fejl');
    } finally {
      setSaving(false);
    }
  }, [form, editId, fetchPosts]);

  /** Toggle active/inactive. */
  const handleToggle = useCallback(
    async (post: LinkedInPost) => {
      try {
        const res = await fetch('/api/admin/linkedin-posts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: post.id, active: !post.active }),
        });
        if (!res.ok) throw new Error('Fejl ved toggle');
        await fetchPosts();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ukendt fejl');
      }
    },
    [fetchPosts]
  );

  /** Slet post. */
  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm('Er du sikker på at du vil slette denne post?')) return;
      try {
        const res = await fetch(`/api/admin/linkedin-posts?id=${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error('Fejl ved sletning');
        await fetchPosts();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ukendt fejl');
      }
    },
    [fetchPosts]
  );

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Linkedin className="w-5 h-5 text-blue-400" />
            LinkedIn Featured Posts
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Kuratér posts der vises på marketing-hjemmesiden
          </p>
        </div>
        <button
          onClick={handleNew}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          Ny post
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-300 text-sm flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)} aria-label="Luk fejl">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white">
            {editId ? 'Rediger post' : 'Ny post'}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="post_url" className="block text-sm text-slate-300 mb-1">
                LinkedIn URL
              </label>
              <input
                id="post_url"
                type="url"
                value={form.post_url}
                onChange={(e) => setForm({ ...form, post_url: e.target.value })}
                className="w-full bg-slate-700/60 border border-slate-600/50 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="https://www.linkedin.com/posts/..."
              />
            </div>
            <div>
              <label htmlFor="image_url" className="block text-sm text-slate-300 mb-1">
                Billede URL (valgfrit)
              </label>
              <input
                id="image_url"
                type="url"
                value={form.image_url}
                onChange={(e) => setForm({ ...form, image_url: e.target.value })}
                className="w-full bg-slate-700/60 border border-slate-600/50 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="https://..."
              />
            </div>
            <div>
              <label htmlFor="excerpt_da" className="block text-sm text-slate-300 mb-1">
                Uddrag (DA)
              </label>
              <textarea
                id="excerpt_da"
                value={form.excerpt_da}
                onChange={(e) => setForm({ ...form, excerpt_da: e.target.value })}
                rows={3}
                className="w-full bg-slate-700/60 border border-slate-600/50 rounded-lg px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor="excerpt_en" className="block text-sm text-slate-300 mb-1">
                Uddrag (EN)
              </label>
              <textarea
                id="excerpt_en"
                value={form.excerpt_en}
                onChange={(e) => setForm({ ...form, excerpt_en: e.target.value })}
                rows={3}
                className="w-full bg-slate-700/60 border border-slate-600/50 rounded-lg px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor="published_at" className="block text-sm text-slate-300 mb-1">
                Publiceringsdato
              </label>
              <input
                id="published_at"
                type="date"
                value={form.published_at}
                onChange={(e) => setForm({ ...form, published_at: e.target.value })}
                className="w-full bg-slate-700/60 border border-slate-600/50 rounded-lg px-3 py-2 text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor="sort_order" className="block text-sm text-slate-300 mb-1">
                Sorteringsorden
              </label>
              <input
                id="sort_order"
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
                className="w-full bg-slate-700/60 border border-slate-600/50 rounded-lg px-3 py-2 text-white text-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="rounded border-slate-600"
              />
              Aktiv
            </label>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !form.post_url || !form.excerpt_da || !form.excerpt_en}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Gem
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-slate-700/60 hover:bg-slate-600/60 text-slate-300 text-sm font-medium rounded-lg transition-colors"
            >
              Annuller
            </button>
          </div>
        </div>
      )}

      {/* Posts liste */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          Ingen LinkedIn posts endnu. Klik &quot;Ny post&quot; for at tilføje.
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <div
              key={post.id}
              className={`bg-slate-800/40 border rounded-xl p-4 flex items-center gap-4 ${
                post.active ? 'border-slate-700/50' : 'border-slate-700/20 opacity-60'
              }`}
            >
              {/* Preview image */}
              {post.image_url && (
                <div className="w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-slate-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={post.image_url} alt="" className="w-full h-full object-cover" />
                </div>
              )}

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{post.excerpt_da}</p>
                <p className="text-slate-400 text-xs mt-0.5">
                  {new Date(post.published_at).toLocaleDateString('da-DK')} · Orden:{' '}
                  {post.sort_order}
                </p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => handleToggle(post)}
                  className="p-2 rounded-lg hover:bg-slate-700/40 text-slate-400 hover:text-white transition-colors"
                  aria-label={post.active ? 'Deaktiver' : 'Aktiver'}
                  title={post.active ? 'Deaktiver' : 'Aktiver'}
                >
                  {post.active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => handleEdit(post)}
                  className="px-3 py-1.5 rounded-lg bg-slate-700/40 text-slate-300 hover:bg-slate-600/40 text-sm transition-colors"
                >
                  Rediger
                </button>
                <a
                  href={post.post_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded-lg hover:bg-slate-700/40 text-slate-400 hover:text-white transition-colors"
                  aria-label="Åbn på LinkedIn"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button
                  onClick={() => handleDelete(post.id)}
                  className="p-2 rounded-lg hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition-colors"
                  aria-label="Slet post"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
