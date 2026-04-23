/**
 * DocPreviewContext — global state for the right-side document preview panel.
 *
 * BIZZ-807: Any feature can call `docPreview.open({...})` to surface a
 * document in a fixed-right side panel that pushes the rest of the
 * layout to the left. Closing restores the default layout.
 *
 * Current producers:
 *   - AIChatPanel — opens preview when user clicks the eye icon on an
 *     attachment chip (pre-send).
 *   - (future) AI Chat `generate_document` tool result — opens preview
 *     with the generated docx/xlsx/pptx.
 *
 * The panel UI lives in DocPreviewPanel.tsx and is mounted once from
 * DashboardLayout; it subscribes to this context and renders on demand.
 *
 * @module app/context/DocPreviewContext
 */
'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Generic previewable payload. `text` is what actually gets rendered;
 * `downloadUrl` (when set) adds a "Hent" button on the panel header.
 */
export interface DocPreviewContent {
  /** Filename shown in the panel header */
  name: string;
  /** Short file-type label (e.g. "DOCX", "XLSX") */
  fileType: string;
  /** Optional size in bytes — shown alongside the type */
  sizeBytes?: number;
  /** The body to render — plain text, will preserve whitespace */
  text: string;
  /** True if the text was cut off server-side */
  truncated?: boolean;
  /** Optional download URL — when present, a Hent button is rendered */
  downloadUrl?: string;
  /** Optional identifier to let consumers deduplicate / re-open the same content */
  key?: string;
}

interface DocPreviewCtx {
  content: DocPreviewContent | null;
  /** True when a content payload is set AND the user has not explicitly closed it */
  isOpen: boolean;
  open: (content: DocPreviewContent) => void;
  close: () => void;
}

const Ctx = createContext<DocPreviewCtx | null>(null);

export function DocPreviewProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<DocPreviewContent | null>(null);

  const open = useCallback((c: DocPreviewContent) => {
    setContent(c);
  }, []);

  const close = useCallback(() => {
    setContent(null);
  }, []);

  const value = useMemo<DocPreviewCtx>(
    () => ({ content, isOpen: content !== null, open, close }),
    [content, open, close]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Hook consumed by producers (AI chat, generation tool) and the panel itself. */
export function useDocPreview(): DocPreviewCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useDocPreview must be used within a DocPreviewProvider');
  }
  return ctx;
}
