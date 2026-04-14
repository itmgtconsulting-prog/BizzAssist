'use client';

/**
 * Shared markdown renderer for AI assistant messages.
 *
 * BIZZ-229: Extracted from ChatPageClient to be shared between
 * the full-page chat and sidebar AIChatPanel.
 *
 * Supports: **bold**, *italic*, `code`, ```code blocks```,
 * ## headings, - bullet lists, 1. numbered lists.
 */

import React from 'react';

export default function MarkdownContent({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let keyCounter = 0;

  const renderInline = (line: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    let rest = line;
    let i = 0;

    while (rest.length > 0) {
      const boldMatch = rest.match(/^([\s\S]*?)\*\*([\s\S]+?)\*\*([\s\S]*)/);
      const italicMatch = rest.match(/^([\s\S]*?)\*([\s\S]+?)\*([\s\S]*)/);
      const codeMatch = rest.match(/^([\s\S]*?)`([\s\S]+?)`([\s\S]*)/);

      const candidates: { idx: number; type: string; match: RegExpMatchArray }[] = [];
      if (boldMatch) candidates.push({ idx: boldMatch[1].length, type: 'bold', match: boldMatch });
      if (italicMatch)
        candidates.push({ idx: italicMatch[1].length, type: 'italic', match: italicMatch });
      if (codeMatch) candidates.push({ idx: codeMatch[1].length, type: 'code', match: codeMatch });

      if (candidates.length === 0) {
        parts.push(rest);
        break;
      }
      candidates.sort((a, b) => a.idx - b.idx);
      const { type, match } = candidates[0];

      if (match[1]) parts.push(match[1]);
      if (type === 'bold') {
        parts.push(<strong key={`b-${i++}`}>{match[2]}</strong>);
      } else if (type === 'italic') {
        parts.push(<em key={`e-${i++}`}>{match[2]}</em>);
      } else {
        parts.push(
          <code
            key={`c-${i++}`}
            className="bg-slate-700/70 px-1 py-0.5 rounded text-xs font-mono text-blue-200"
          >
            {match[2]}
          </code>
        );
      }
      rest = match[3];
    }
    return <>{parts}</>;
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre
            key={`pre-${keyCounter++}`}
            className="bg-slate-900 border border-slate-700 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap"
          >
            {codeLines.join('\n')}
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === '') {
      elements.push(<div key={`br-${keyCounter++}`} className="h-2" />);
      continue;
    }

    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={`h3-${keyCounter++}`} className="text-white font-semibold text-sm mt-3 mb-1">
          {renderInline(line.slice(4))}
        </h3>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={`h2-${keyCounter++}`} className="text-white font-semibold text-base mt-4 mb-1">
          {renderInline(line.slice(3))}
        </h2>
      );
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={`li-${keyCounter++}`} className="flex items-start gap-2 text-sm">
          <span className="text-slate-500 mt-0.5 shrink-0">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
      continue;
    }

    const numMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      elements.push(
        <div key={`nl-${keyCounter++}`} className="flex items-start gap-2 text-sm">
          <span className="text-slate-500 mt-0.5 shrink-0 w-4 text-right">{numMatch[1]}.</span>
          <span>{renderInline(numMatch[2])}</span>
        </div>
      );
      continue;
    }

    elements.push(
      <p key={`p-${keyCounter++}`} className="text-sm leading-relaxed">
        {renderInline(line)}
      </p>
    );
  }

  return <div className="space-y-1 text-slate-200">{elements}</div>;
}
