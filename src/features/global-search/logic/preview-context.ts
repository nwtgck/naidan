export type SearchPreviewContextSize = number | 'full';

export interface SearchPreviewMessageWindow {
  start: number,
  end: number,
}

const DEFAULT_SEARCH_PREVIEW_CONTEXT_SIZE = 2;

export function resolveSearchPreviewContextSize({ size }: {
  size: SearchPreviewContextSize,
}): SearchPreviewContextSize {
  if (size === 'full') return 'full';
  if (!Number.isFinite(size)) return DEFAULT_SEARCH_PREVIEW_CONTEXT_SIZE;
  return Math.max(1, Math.floor(size));
}

export function resolveSearchPreviewMessageWindow({
  messageCount,
  matchedIndex,
  contextSize,
}: {
  messageCount: number,
  matchedIndex: number | undefined,
  contextSize: SearchPreviewContextSize,
}): SearchPreviewMessageWindow {
  if (messageCount <= 0) return { start: 0, end: 0 };

  const resolvedContextSize = resolveSearchPreviewContextSize({ size: contextSize });
  if (resolvedContextSize === 'full') {
    return { start: 0, end: messageCount };
  }

  if (
    matchedIndex === undefined
    || matchedIndex < 0
    || matchedIndex >= messageCount
  ) {
    return {
      start: Math.max(0, messageCount - resolvedContextSize),
      end: messageCount,
    };
  }

  return {
    start: Math.max(0, matchedIndex - resolvedContextSize),
    end: Math.min(messageCount, matchedIndex + resolvedContextSize + 1),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
