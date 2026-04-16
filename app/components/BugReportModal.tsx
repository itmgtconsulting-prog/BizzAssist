'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Bug,
  Lightbulb,
  MessageSquare,
  Send,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  Camera,
  Upload,
  Trash2,
} from 'lucide-react';
import type { BugReportPayload } from '@/app/api/report-bug/route';

/**
 * Returns true when running on a mobile device (iOS or Android).
 * Used to switch screenshot capture strategy: desktop browsers support
 * `getDisplayMedia`, but iOS Safari does not implement it at all.
 * Must only be called client-side (after mount).
 *
 * @returns Whether the current UA is a mobile device
 */
function erMobilEnhed(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

interface Props {
  open: boolean;
  onClose: () => void;
  lang?: 'da' | 'en';
  currentPage?: string;
}

const text = {
  da: {
    title: 'Rapportér et problem',
    typeLabel: 'Hvad vil du rapportere?',
    types: [
      { value: 'bug', label: 'Fejl / Bug', icon: Bug },
      { value: 'feedback', label: 'Generel feedback', icon: MessageSquare },
      { value: 'feature', label: 'Funktionsønske', icon: Lightbulb },
    ],
    titleLabel: 'Titel',
    titlePlaceholder: 'Kort beskrivelse af problemet',
    descLabel: 'Beskrivelse',
    descPlaceholder: 'Beskriv problemet i detaljer — hvad skete der? Hvad forventede du?',
    severityLabel: 'Alvorlighed',
    severities: [
      { value: 'low', label: 'Lav — kosmetisk fejl' },
      { value: 'medium', label: 'Medium — funktion virker delvist' },
      { value: 'high', label: 'Høj — funktion virker ikke' },
      { value: 'critical', label: 'Kritisk — app er ubrugelig' },
    ],
    emailLabel: 'Din e-mail (valgfrit)',
    emailPlaceholder: 'jakob@bizzassist.dk',
    screenshotLabel: 'Skærmbillede (valgfrit)',
    captureBtn: 'Tag skærmbillede',
    uploadBtn: 'Upload billede',
    cameraBtn: 'Tag billede med kamera',
    removeScreenshot: 'Fjern',
    submit: 'Send rapport',
    sending: 'Sender...',
    successTitle: 'Rapport sendt!',
    successText: 'Tak! Din rapport er oprettet som en JIRA-sag. Vi kigger på det hurtigst muligt.',
    errorTitle: 'Noget gik galt',
    close: 'Luk',
    newReport: 'Send ny rapport',
  },
  en: {
    title: 'Report an issue',
    typeLabel: 'What would you like to report?',
    types: [
      { value: 'bug', label: 'Bug / Error', icon: Bug },
      { value: 'feedback', label: 'General feedback', icon: MessageSquare },
      { value: 'feature', label: 'Feature request', icon: Lightbulb },
    ],
    titleLabel: 'Title',
    titlePlaceholder: 'Short description of the issue',
    descLabel: 'Description',
    descPlaceholder: 'Describe the issue in detail — what happened? What did you expect?',
    severityLabel: 'Severity',
    severities: [
      { value: 'low', label: 'Low — cosmetic issue' },
      { value: 'medium', label: 'Medium — feature partially works' },
      { value: 'high', label: 'High — feature does not work' },
      { value: 'critical', label: 'Critical — app is unusable' },
    ],
    emailLabel: 'Your email (optional)',
    emailPlaceholder: 'jakob@bizzassist.dk',
    screenshotLabel: 'Screenshot (optional)',
    captureBtn: 'Capture screen',
    uploadBtn: 'Upload image',
    cameraBtn: 'Take photo with camera',
    removeScreenshot: 'Remove',
    submit: 'Send report',
    sending: 'Sending...',
    successTitle: 'Report sent!',
    successText:
      'Thank you! Your report has been created as a JIRA issue. We will look into it as soon as possible.',
    errorTitle: 'Something went wrong',
    close: 'Close',
    newReport: 'Send new report',
  },
};

/**
 * Bug/feedback report modal with ARIA dialog semantics and focus trap.
 *
 * @param open - Whether the modal is currently open
 * @param onClose - Callback invoked when the modal is closed
 * @param lang - UI language ('da' | 'en'), defaults to 'da'
 * @param currentPage - Optional URL path override for the report context
 */
/** BIZZ-211: memoized to prevent re-renders when parent FeedbackButton state changes */
const BugReportModal = React.memo(function BugReportModal({
  open,
  onClose,
  lang = 'da',
  currentPage,
}: Props) {
  const t = text[lang];
  const [type, setType] = useState<'bug' | 'feedback' | 'feature'>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [email, setEmail] = useState('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [issueKey, setIssueKey] = useState('');
  /**
   * True after mount when the UA identifies as a mobile device.
   * iOS Safari does not support `getDisplayMedia`, so we replace the
   * "Tag skærmbillede" button with a camera-capture file input (BIZZ-77).
   * Initialises false (SSR-safe) and flips once on the client.
   */
  const [isMobile, setIsMobile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  /**
   * Focus trap: while the modal is open, Tab/Shift+Tab cycles through
   * focusable children only. Also focuses the first element on open.
   */
  useEffect(() => {
    if (!open) return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const trap = (e: KeyboardEvent) => {
      // BIZZ-212: Escape key closes the modal (keyboard equivalent of clicking backdrop)
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', trap);
    first?.focus();
    return () => document.removeEventListener('keydown', trap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Detects mobile UA once after mount.
   * `getDisplayMedia` is unavailable on iOS Safari (BIZZ-77), so mobile devices
   * get a camera-capture file input instead of the screen-capture button.
   * Runs only once — UA never changes during a session.
   */
  useEffect(() => {
    setIsMobile(erMobilEnhed());
  }, []);

  if (!open) return null;

  const reset = () => {
    setTitle('');
    setDescription('');
    setSeverity('medium');
    setEmail('');
    setScreenshot(null);
    setStatus('idle');
    setErrorMsg('');
    setIssueKey('');
  };

  /**
   * Captures the screen using the browser's getDisplayMedia API.
   * User selects which screen/tab to capture via the browser picker.
   */
  const captureScreen = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement('video');
      video.srcObject = stream;
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
      });
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      setScreenshot(canvas.toDataURL('image/png'));
    } catch {
      // User cancelled the picker — do nothing
    }
  };

  /**
   * Handles file upload input — reads the selected image as a base64 data URL.
   */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setScreenshot(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');

    const payload: BugReportPayload = {
      type,
      title: title.trim(),
      description: description.trim(),
      severity,
      page: currentPage ?? (typeof window !== 'undefined' ? window.location.pathname : undefined),
      email: email.trim() || undefined,
      screenshotBase64: screenshot ?? undefined,
    };

    try {
      const res = await fetch('/api/report-bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Unknown error');
      setIssueKey(data.issueKey ?? '');
      setStatus('success');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
        role="presentation"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-modal-title"
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center">
              <Bug size={16} className="text-red-500" />
            </div>
            <h2 id="bug-report-modal-title" className="font-bold text-slate-900">
              {t.title}
            </h2>
          </div>
          <button
            onClick={handleClose}
            aria-label="Luk"
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {status === 'success' ? (
          <div className="px-6 py-10 text-center">
            <div className="w-14 h-14 bg-emerald-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle size={28} className="text-emerald-500" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">{t.successTitle}</h3>
            <p className="text-slate-500 text-sm mb-2">{t.successText}</p>
            {issueKey && (
              <span className="inline-block bg-blue-50 text-blue-700 text-xs font-mono font-semibold px-3 py-1.5 rounded-lg">
                {issueKey}
              </span>
            )}
            <div className="flex gap-3 justify-center mt-6">
              <button
                onClick={reset}
                className="border border-slate-200 text-slate-700 font-medium text-sm px-4 py-2.5 rounded-xl hover:bg-slate-50 transition-colors"
              >
                {t.newReport}
              </button>
              <button
                onClick={handleClose}
                className="bg-blue-600 text-white font-medium text-sm px-4 py-2.5 rounded-xl hover:bg-blue-500 transition-colors"
              >
                {t.close}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
            {/* Type selector */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">{t.typeLabel}</label>
              <div className="grid grid-cols-3 gap-2">
                {t.types.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setType(opt.value as typeof type)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-xl border text-xs font-medium transition-all ${
                        type === opt.value
                          ? 'bg-blue-50 border-blue-400 text-blue-700'
                          : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <Icon size={18} />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Title */}
            <div>
              <label
                htmlFor="bug-title"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                {t.titleLabel}
              </label>
              <input
                id="bug-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t.titlePlaceholder}
                required
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="bug-desc" className="block text-sm font-medium text-slate-700 mb-1.5">
                {t.descLabel}
              </label>
              <textarea
                id="bug-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.descPlaceholder}
                required
                rows={4}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors resize-none"
              />
            </div>

            {/* Severity (only for bugs) */}
            {type === 'bug' && (
              <div>
                <label
                  htmlFor="bug-type"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  {t.severityLabel}
                </label>
                <div className="relative">
                  <select
                    id="bug-type"
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as typeof severity)}
                    className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:border-blue-400 transition-colors appearance-none bg-white"
                  >
                    {t.severities.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={16}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                  />
                </div>
              </div>
            )}

            {/* Email */}
            <div>
              <label
                htmlFor="bug-email"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                {t.emailLabel}
              </label>
              <input
                id="bug-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.emailPlaceholder}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
              />
            </div>

            {/* Screenshot */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {t.screenshotLabel}
              </label>
              {/*
               * BIZZ-77: iOS Safari does not implement getDisplayMedia, so the
               * screen-capture button is replaced on mobile with a camera-capture
               * file input (`capture="environment"`), which opens the native camera
               * or photo-picker directly when tapped.
               * Desktop retains both buttons: screen-capture + file upload.
               */}
              {isMobile ? (
                /*
                 * Mobile path: single hidden file input with `capture="environment"`.
                 * `accept="image/*"` combined with `capture` makes iOS open the
                 * camera app (or the Files picker on iPadOS) instead of the
                 * generic file browser, giving a better UX than a plain upload.
                 */
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              ) : (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              )}
              {screenshot ? (
                <div className="relative">
                  <img
                    src={screenshot}
                    alt="Screenshot preview"
                    className="w-full rounded-xl border border-slate-200 object-cover max-h-48"
                  />
                  <button
                    type="button"
                    onClick={() => setScreenshot(null)}
                    aria-label={t.removeScreenshot}
                    className="absolute top-2 right-2 bg-red-500 text-white rounded-lg p-1 hover:bg-red-600 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ) : isMobile ? (
                /* Mobile: single full-width camera button */
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 border border-slate-200 rounded-xl py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <Camera size={15} />
                  {t.cameraBtn}
                </button>
              ) : (
                /* Desktop: screen-capture + file upload */
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={captureScreen}
                    className="flex-1 flex items-center justify-center gap-2 border border-slate-200 rounded-xl py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    <Camera size={15} />
                    {t.captureBtn}
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 flex items-center justify-center gap-2 border border-slate-200 rounded-xl py-2.5 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    <Upload size={15} />
                    {t.uploadBtn}
                  </button>
                </div>
              )}
            </div>

            {/* Error */}
            {status === 'error' && (
              <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
                <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-700">{t.errorTitle}</p>
                  <p className="text-xs text-red-500 mt-0.5">{errorMsg}</p>
                </div>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {status === 'sending' ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t.sending}
                </>
              ) : (
                <>
                  <Send size={16} />
                  {t.submit}
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
});

export default BugReportModal;
