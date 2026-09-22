import type { CodeEdit } from './types';

// Keep only the newest snapshot while the consumer is busy. Diff against the
// last consumed snapshot, not a skipped UI update, so coalescing stays lossless.
export function createCodeEditSource() {
  let latest: string | undefined;
  let consumed = '';
  let closed = false;
  let wake: (() => void) | undefined;
  let claimed = false;

  function close() {
    closed = true;
    latest = undefined;
    consumed = '';
    wake?.();
    wake = undefined;
  }

  const edits: AsyncIterable<CodeEdit> = {
    async *[Symbol.asyncIterator]() {
      if (claimed) throw new Error('Code edit source already has a consumer');
      claimed = true;
      try {
        while (!closed) {
          if (latest === undefined) await new Promise<void>(resolve => {
            wake = resolve;
          });
          if (closed) return;
          const snapshot = latest;
          latest = undefined;
          if (snapshot === undefined || snapshot === consumed) continue;
          // Corrections rebuild lexical state anyway; only the common append
          // path needs a suffix edit. Avoid a JavaScript prefix walk per update.
          const offset = snapshot.startsWith(consumed) ? consumed.length : 0;
          const text = snapshot.slice(offset);
          consumed = snapshot;
          yield { offset, text };
        }
      } finally {
        close();
      }
    },
  };

  return {
    edits,
    setCode({ code }: { code: string }) {
      if (closed) return;
      latest = code;
      wake?.();
      wake = undefined;
    },
    close,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
