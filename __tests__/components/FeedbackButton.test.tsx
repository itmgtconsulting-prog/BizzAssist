/**
 * Component tests for FeedbackButton.
 *
 * Verifies that:
 * - A button is rendered with the correct aria-label
 * - Clicking the button opens the BugReportModal dialog
 * - The component renders correctly in both DA and EN language contexts
 * - The modal can be dismissed via its close callback
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import FeedbackButton from '@/app/components/FeedbackButton';
import { LanguageProvider } from '@/app/context/LanguageContext';

// Stub BugReportModal — isolates FeedbackButton from its modal's complexity
// (focus trap, media APIs, fetch calls)
vi.mock('@/app/components/BugReportModal', () => ({
  default: ({ open, onClose, lang }: { open: boolean; onClose: () => void; lang?: string }) =>
    open ? (
      <div role="dialog" aria-label="bug-report-modal">
        <span data-testid="modal-lang">{lang}</span>
        <button onClick={onClose}>Luk</button>
      </div>
    ) : null,
}));

/** Renders FeedbackButton wrapped in LanguageProvider (required for useLanguage hook) */
function renderFeedbackButton() {
  return render(
    <LanguageProvider>
      <FeedbackButton />
    </LanguageProvider>
  );
}

describe('FeedbackButton', () => {
  it('renders a button with the Danish aria-label by default', () => {
    renderFeedbackButton();
    expect(screen.getByRole('button', { name: /rapportér fejl/i })).toBeInTheDocument();
  });

  it('clicking the button opens the feedback modal', async () => {
    renderFeedbackButton();
    // Modal must be absent before clicking
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /rapportér fejl/i }));
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('passes the current language (da) down to BugReportModal', async () => {
    renderFeedbackButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /rapportér fejl/i }));
    });
    expect(screen.getByTestId('modal-lang').textContent).toBe('da');
  });

  it('modal closes when the onClose callback is invoked', async () => {
    renderFeedbackButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /rapportér fejl/i }));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /luk/i }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders with English aria-label when language context is EN', () => {
    // LanguageProvider reads from localStorage key 'ba-lang' on mount
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <FeedbackButton />
      </LanguageProvider>
    );
    expect(screen.getByRole('button', { name: /report issue/i })).toBeInTheDocument();
  });

  it('opens modal in English with lang="en" passed to BugReportModal', async () => {
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <FeedbackButton />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /report issue/i }));
    });
    expect(screen.getByTestId('modal-lang').textContent).toBe('en');
  });
});
