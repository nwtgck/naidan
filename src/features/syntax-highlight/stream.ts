import { createSyntaxHighlighter } from './highlight';
import type { CodeEdit, HighlightEdit, SyntaxLanguage } from './types';

async function nextInput({ iterator, signal }: { iterator: AsyncIterator<CodeEdit>, signal: AbortSignal }) {
  if (signal.aborted) return { type: 'aborted' } as const;
  let abort: () => void = () => {};
  const aborted = new Promise<{ type: 'aborted' }>((resolve) => {
    abort = () => resolve({ type: 'aborted' });
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      iterator.next().then(result => ({ type: 'input' as const, result })),
      aborted,
    ]);
  } finally {
    // Each input owns one listener; do not accumulate reactions on a shared
    // unresolved abort promise over an arbitrarily long stream.
    signal.removeEventListener('abort', abort);
  }
}

export async function* highlightSyntaxStream({ edits, language, signal }: {
  edits: AsyncIterable<CodeEdit>,
  language: SyntaxLanguage,
  signal: AbortSignal,
}): AsyncGenerator<HighlightEdit> {
  if (signal.aborted) return;
  const highlighter = createSyntaxHighlighter({ language });
  const iterator = edits[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const next = await nextInput({ iterator, signal });
      switch (next.type) {
      case 'aborted': return;
      case 'input':
        if (next.result.done || signal.aborted) return;
        yield highlighter.update({ edit: next.result.value });
        break;
      default: { const _ex: never = next; throw new Error(`Unhandled input event: ${_ex}`); }
      }
    }
  } finally {
    // An arbitrary input iterator may not cooperate with cancellation. Do not
    // leave this consumer waiting for its return(), or leak a late rejection.
    // Component-owned sources additionally close their waiting input explicitly.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch { /* Best-effort input cleanup. */ }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
