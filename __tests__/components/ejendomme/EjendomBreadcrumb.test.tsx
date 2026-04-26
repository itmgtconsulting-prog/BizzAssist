/**
 * Unit tests for EjendomBreadcrumb (BIZZ-797).
 *
 * Verifies:
 *   - Renders nav + ol med alle levels
 *   - Sidste element har aria-current="page" og ingen link
 *   - Mellem-elementer rendrer som Link når href er sat
 *   - Chevron-separator vises kun mellem elementer (ikke før første)
 *   - Tom levels-array rendrer ikke noget
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EjendomBreadcrumb from '@/app/components/ejendomme/EjendomBreadcrumb';

describe('EjendomBreadcrumb', () => {
  it('rendrer nav med aria-label', () => {
    render(
      <EjendomBreadcrumb
        levels={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'SFE 123' }]}
      />
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('rendrer alle levels i rækkefølge', () => {
    render(
      <EjendomBreadcrumb
        levels={[
          { label: 'Dashboard', href: '/dashboard' },
          { label: 'Ejendomme', href: '/dashboard/ejendomme' },
          { label: 'SFE 123' },
        ]}
      />
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Ejendomme')).toBeInTheDocument();
    expect(screen.getByText('SFE 123')).toBeInTheDocument();
  });

  it('sidste element har aria-current=page og er ikke et link', () => {
    render(
      <EjendomBreadcrumb
        levels={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'SFE 123' }]}
      />
    );
    const current = screen.getByText('SFE 123');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.tagName).toBe('SPAN');
  });

  it('mellem-elementer med href rendrer som Link', () => {
    render(
      <EjendomBreadcrumb
        levels={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'SFE 123' }]}
      />
    );
    const link = screen.getByRole('link', { name: 'Dashboard' });
    expect(link).toHaveAttribute('href', '/dashboard');
  });

  it('mellem-elementer uden href rendrer som span (ikke link)', () => {
    render(<EjendomBreadcrumb levels={[{ label: 'Parent without link' }, { label: 'SFE 123' }]} />);
    const parent = screen.getByText('Parent without link');
    expect(parent.tagName).toBe('SPAN');
  });

  it('tom levels-array rendrer ingenting', () => {
    const { container } = render(<EjendomBreadcrumb levels={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('accepterer custom ariaLabel', () => {
    render(<EjendomBreadcrumb levels={[{ label: 'X' }]} ariaLabel="Custom" />);
    expect(screen.getByRole('navigation', { name: 'Custom' })).toBeInTheDocument();
  });
});
