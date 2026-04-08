/**
 * Component tests for error boundary components.
 *
 * Covers:
 * - app/error.tsx (GlobalError) — root-level Next.js error boundary
 * - app/dashboard/error.tsx (DashboardError) — dashboard-level error boundary
 * - app/components/ErrorBoundary.tsx (class ErrorBoundary) — reusable React class boundary
 *
 * For each:
 * - Renders the error message / heading
 * - Reset / Genindlæs button calls the reset prop (or window.location.reload)
 * - Digest code is shown when provided
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GlobalError from '@/app/error';
import DashboardError from '@/app/dashboard/error';
import ErrorBoundary from '@/app/components/ErrorBoundary';

// Sentry is an external service — stub it so tests run without network calls
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn().mockReturnValue('fake-sentry-event-id'),
}));

// Stub BugReportModal used by the class ErrorBoundary
vi.mock('@/app/components/BugReportModal', () => ({
  default: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" data-testid="bug-modal" /> : null,
}));

// ─── GlobalError (app/error.tsx) ───────────────────────────────────────────

describe('GlobalError (app/error.tsx)', () => {
  const baseError = new Error('test error') as Error & { digest?: string };

  it('renders the "Noget gik galt" heading', () => {
    const reset = vi.fn();
    render(<GlobalError error={baseError} reset={reset} />);
    expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
  });

  it('renders the "Prøv igen" button', () => {
    const reset = vi.fn();
    render(<GlobalError error={baseError} reset={reset} />);
    expect(screen.getByRole('button', { name: /prøv igen/i })).toBeInTheDocument();
  });

  it('"Prøv igen" button calls the reset prop', () => {
    const reset = vi.fn();
    render(<GlobalError error={baseError} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /prøv igen/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('shows the digest error code when provided', () => {
    const reset = vi.fn();
    const errorWithDigest = Object.assign(new Error('fail'), { digest: 'ABC-123' });
    render(<GlobalError error={errorWithDigest} reset={reset} />);
    expect(screen.getByText(/ABC-123/)).toBeInTheDocument();
  });

  it('does not show digest section when digest is absent', () => {
    const reset = vi.fn();
    render(<GlobalError error={baseError} reset={reset} />);
    expect(screen.queryByText(/Fejlkode:/)).not.toBeInTheDocument();
  });
});

// ─── DashboardError (app/dashboard/error.tsx) ──────────────────────────────

describe('DashboardError (app/dashboard/error.tsx)', () => {
  const baseError = new Error('dashboard error') as Error & { digest?: string };

  it('renders the "Noget gik galt" heading', () => {
    const reset = vi.fn();
    render(<DashboardError error={baseError} reset={reset} />);
    expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
  });

  it('renders the "Prøv igen" button', () => {
    const reset = vi.fn();
    render(<DashboardError error={baseError} reset={reset} />);
    expect(screen.getByRole('button', { name: /prøv igen/i })).toBeInTheDocument();
  });

  it('"Prøv igen" button calls the reset prop', () => {
    const reset = vi.fn();
    render(<DashboardError error={baseError} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /prøv igen/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('shows the digest error code when provided', () => {
    const reset = vi.fn();
    const errorWithDigest = Object.assign(new Error('fail'), { digest: 'DASH-999' });
    render(<DashboardError error={errorWithDigest} reset={reset} />);
    expect(screen.getByText(/DASH-999/)).toBeInTheDocument();
  });
});

// ─── ErrorBoundary class component (app/components/ErrorBoundary.tsx) ───────

/** Throws an error on render so ErrorBoundary.getDerivedStateFromError fires */
function ThrowingChild(): React.ReactNode {
  throw new Error('render boom');
}

describe('ErrorBoundary (class component)', () => {
  // Suppress the React error overlay noise in test output
  const origConsoleError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = origConsoleError;
  });

  it('renders children normally when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>OK content</p>
      </ErrorBoundary>
    );
    expect(screen.getByText('OK content')).toBeInTheDocument();
  });

  it('renders the error UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Noget gik galt')).toBeInTheDocument();
  });

  it('renders English error heading when lang="en"', () => {
    render(
      <ErrorBoundary lang="en">
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders the custom fallback when one is provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
  });

  it('"Rapportér fejl" button opens the BugReportModal dialog', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    const reportBtn = screen.getByRole('button', { name: /rapportér fejl/i });
    fireEvent.click(reportBtn);
    expect(screen.getByTestId('bug-modal')).toBeInTheDocument();
  });

  it('"Genindlæs" button calls window.location.reload', () => {
    // jsdom does not implement reload, so we stub it
    const reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: /genindlæs/i }));
    expect(reloadSpy).toHaveBeenCalledOnce();
  });
});
