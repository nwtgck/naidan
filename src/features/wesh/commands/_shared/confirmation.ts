export function createAffirmativeResponseReader({
  input,
}: {
  input: AsyncIterable<string>,
}): () => Promise<boolean> {
  const iterator = input[Symbol.asyncIterator]();
  let pendingLines: string[] = [];
  let pendingLineIndex = 0;

  return async (): Promise<boolean> => {
    while (pendingLineIndex >= pendingLines.length) {
      pendingLines = [];
      pendingLineIndex = 0;
      const result = await iterator.next();
      if (result.done) return false;

      const lines = result.value.split('\n');
      if (result.value.endsWith('\n')) {
        lines.pop();
      }
      for (const line of lines) {
        pendingLines.push(line.replace(/\r$/u, ''));
      }
    }

    return /^[yY]/u.test(pendingLines[pendingLineIndex++]!);
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createAffirmativeResponseReader,
};
