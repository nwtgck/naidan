import { createSyntaxHighlighter } from '@/features/syntax-highlight/highlight';
import type { SyntaxLanguage, SyntaxToken } from '@/features/syntax-highlight/types';
import { parsePatchDocument } from '@/features/wesh/commands/patch/parser';
import type { PatchLine, PatchLineKind, TextHunk } from '@/features/wesh/commands/patch/types';

type DiffRow = {
  kind: PatchLineKind,
  oldLine: number | undefined,
  newLine: number | undefined,
  tokens: SyntaxToken[],
  terminator: PatchLine['terminator'],
};

type DiffHunk = { label: string, rows: DiffRow[] };
type DiffFile = { oldPath: string | undefined, newPath: string | undefined, hunks: DiffHunk[] };
type PatchView = { kind: 'structured', files: DiffFile[] } | { kind: 'source' };

const maxPatchBytes = 256 * 1024;
const maxDisplayRows = 5_000;
const maxDisplayTokens = 32_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

function pathLanguage({ path }: { path: string | undefined }): SyntaxLanguage {
  if (path === undefined) {
    return 'plain';
  }
  if (/\.(?:ts|tsx|cts|mts)$/iu.test(path)) {
    return 'typescript';
  }
  if (/\.(?:js|jsx|cjs|mjs)$/iu.test(path)) {
    return 'javascript';
  }
  if (/\.(?:sh|bash)$/iu.test(path)) {
    return 'shell';
  }
  return 'plain';
}

function highlightLines({ lines, language }: { lines: string[], language: SyntaxLanguage }): SyntaxToken[][] {
  switch (language) {
  case 'plain': return lines.map(text => text === '' ? [] : [{ kind: 'plain', text }]);
  case 'shell':
  case 'javascript':
  case 'typescript':
    break;
  default: {
    const _ex: never = language;
    throw new Error(`Unsupported patch source language: ${_ex}`);
  }
  }

  // A whole side of the hunk carries context across lines, while removals
  // and additions never share lexer state.
  const highlighter = createSyntaxHighlighter({ language });
  const { tokens } = highlighter.update({ edit: { offset: 0, text: lines.join('\n') } });
  const result: SyntaxToken[][] = [[]];
  let current = result[0]!;
  for (const { kind, text } of tokens) {
    const [first, ...remaining] = text.split('\n');
    if (first) {
      current.push({ kind, text: first });
    }
    for (const line of remaining) {
      current = line === '' ? [] : [{ kind, text: line }];
      result.push(current);
    }
  }
  return result;
}

function buildHunk({ hunk, oldLanguage, newLanguage }: {
  hunk: TextHunk,
  oldLanguage: SyntaxLanguage,
  newLanguage: SyntaxLanguage,
}): DiffHunk {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const rowOffsets = hunk.lines.map(({ kind, content, terminator }) => {
    const line = textDecoder.decode(content);
    switch (kind) {
    case 'context':
      return { kind, terminator, oldIndex: oldLines.push(line) - 1, newIndex: newLines.push(line) - 1 };
    case 'add':
      return { kind, terminator, oldIndex: undefined, newIndex: newLines.push(line) - 1 };
    case 'remove':
      return { kind, terminator, oldIndex: oldLines.push(line) - 1, newIndex: undefined };
    default: {
      const _ex: never = kind;
      throw new Error(`Unsupported patch line kind: ${_ex}`);
    }
    }
  });
  const oldTokens = highlightLines({ lines: oldLines, language: oldLanguage });
  const newTokens = highlightLines({ lines: newLines, language: newLanguage });
  const rows = rowOffsets.map(({ kind, terminator, oldIndex, newIndex }): DiffRow => {
    const tokens = newIndex !== undefined ? newTokens[newIndex] : oldIndex !== undefined ? oldTokens[oldIndex] : undefined;
    return {
      kind,
      terminator,
      oldLine: oldIndex === undefined ? undefined : hunk.oldRange.start + oldIndex,
      newLine: newIndex === undefined ? undefined : hunk.newRange.start + newIndex,
      tokens: tokens ?? [],
    };
  });
  const heading = hunk.heading ? ` ${hunk.heading}` : '';
  return {
    label: `@@ -${hunk.oldRange.start},${hunk.oldRange.count} +${hunk.newRange.start},${hunk.newRange.count} @@${heading}`,
    rows,
  };
}

export function buildPatchView({ text }: { text: string }): PatchView {
  if (text.length > maxPatchBytes) {
    return { kind: 'source' };
  }
  const bytes = textEncoder.encode(text);
  if (bytes.length > maxPatchBytes) {
    return { kind: 'source' };
  }

  try {
    const { sections } = parsePatchDocument({ bytes, forcedFormat: undefined, binary: false });
    if (sections.length === 0) {
      return { kind: 'source' };
    }
    const files: DiffFile[] = [];
    let displayRows = 0;
    let displayTokens = 0;
    for (const section of sections) {
      if (section.kind !== 'text' || section.header.gitBinary || section.hunks.length === 0) {
        return { kind: 'source' };
      }
      const oldPath = section.header.oldPath === '/dev/null' ? undefined : section.header.oldPath ?? section.header.indexPath;
      const newPath = section.header.newPath === '/dev/null' ? undefined : section.header.newPath ?? section.header.indexPath;
      const oldLanguage = pathLanguage({ path: oldPath });
      const newLanguage = pathLanguage({ path: newPath });
      const hunks: DiffHunk[] = [];
      for (const hunk of section.hunks) {
        displayRows += hunk.lines.length + 1;
        if (displayRows > maxDisplayRows) {
          return { kind: 'source' };
        }
        const result = buildHunk({ hunk, oldLanguage, newLanguage });
        displayTokens += result.rows.reduce((count, row) => count + row.tokens.length, 0);
        if (displayTokens > maxDisplayTokens) {
          return { kind: 'source' };
        }
        hunks.push(result);
      }
      files.push({ oldPath, newPath, hunks });
    }
    return { kind: 'structured', files };
  } catch {
    // Raw source remains readable if the syntax or one of the hunks cannot be presented.
    return { kind: 'source' };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
