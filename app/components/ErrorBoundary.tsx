'use client';

import React from 'react';
import * as Sentry from '@sentry/nextjs';
import BugReportModal from './BugReportModal';

interface State {
  hasError: boolean;
  eventId: string | null;
  showReport: boolean;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode; lang?: 'da' | 'en'; fallback?: React.ReactNode },
  State
> {
  constructor(props: {
    children: React.ReactNode;
    lang?: 'da' | 'en';
    fallback?: React.ReactNode;
  }) {
    super(props);
    this.state = { hasError: false, eventId: null, showReport: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const eventId = Sentry.captureException(error, {
      extra: { componentStack: info.componentStack },
    });
    this.setState({ eventId });
  }

  render() {
    const { lang = 'da', fallback } = this.props;
    const { hasError, showReport } = this.state;

    if (hasError) {
      if (fallback !== undefined) return <>{fallback}</>;
      return (
        <div className="min-h-screen bg-[#0f172a] flex items-center justify-center p-6">
          <div className="bg-[#1e293b] border border-white/8 rounded-2xl p-10 max-w-md w-full text-center shadow-sm">
            <div className="w-16 h-16 bg-red-900/30 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <span className="text-3xl">⚠️</span>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">
              {lang === 'da' ? 'Noget gik galt' : 'Something went wrong'}
            </h2>
            <p className="text-slate-400 text-sm mb-6">
              {lang === 'da'
                ? 'Vi beklager ulejligheden. Fejlen er automatisk registreret. Du kan forsøge at genindlæse siden eller rapportere problemet.'
                : 'We apologise for the inconvenience. The error has been automatically logged. You can try reloading the page or report the issue.'}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => window.location.reload()}
                className="border border-white/10 text-slate-300 font-medium text-sm px-4 py-2.5 rounded-xl hover:bg-white/5 transition-colors"
              >
                {lang === 'da' ? 'Genindlæs' : 'Reload page'}
              </button>
              <button
                onClick={() => this.setState({ showReport: true })}
                className="bg-blue-600 text-white font-medium text-sm px-4 py-2.5 rounded-xl hover:bg-blue-500 transition-colors"
              >
                {lang === 'da' ? 'Rapportér fejl' : 'Report issue'}
              </button>
            </div>
          </div>

          <BugReportModal
            open={showReport}
            onClose={() => this.setState({ showReport: false })}
            lang={lang}
            currentPage={typeof window !== 'undefined' ? window.location.pathname : undefined}
          />
        </div>
      );
    }

    return this.props.children;
  }
}
