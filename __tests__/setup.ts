/**
 * Global test setup file.
 * Runs once before all unit and component tests.
 *
 * - Imports jest-dom matchers (toBeInTheDocument, toHaveClass, etc.)
 * - Clears all mocks between tests to prevent state leakage
 * - Resets localStorage between tests
 */
import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Clean up React Testing Library after each test
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
