'use client';

import { useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import BugReportModal from './BugReportModal';
import { useLanguage } from '@/app/context/LanguageContext';

export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const { lang } = useLanguage();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-3 rounded-full shadow-lg hover:shadow-xl transition-all group"
        aria-label={lang === 'da' ? 'Rapportér fejl' : 'Report issue'}
      >
        <MessageSquarePlus size={18} />
        <span className="hidden group-hover:inline transition-all">
          {lang === 'da' ? 'Feedback' : 'Feedback'}
        </span>
      </button>

      <BugReportModal open={open} onClose={() => setOpen(false)} lang={lang} />
    </>
  );
}
