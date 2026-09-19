export function createTextInputLineReader({
  input,
}: {
  input: AsyncIterable<string>,
}): () => Promise<string | undefined> {
  const iterator = input[Symbol.asyncIterator]();
  let pendingLines: string[] = [];
  let pendingLineIndex = 0;

  return async (): Promise<string | undefined> => {
    while (pendingLineIndex >= pendingLines.length) {
      pendingLines = [];
      pendingLineIndex = 0;
      const result = await iterator.next();
      if (result.done) return undefined;

      const lines = result.value.split('\n');
      if (result.value.endsWith('\n')) {
        lines.pop();
      }
      for (const line of lines) {
        pendingLines.push(line.replace(/\r$/u, ''));
      }
    }

    return pendingLines[pendingLineIndex++];
  };
}

export function createAffirmativeResponseReader({
  input,
}: {
  input: AsyncIterable<string>,
}): () => Promise<boolean> {
  const readLine = createTextInputLineReader({ input });

  return async (): Promise<boolean> => {
    const line = await readLine();
    return line !== undefined && /^[yY]/u.test(line);
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createAffirmativeResponseReader,
  createTextInputLineReader,
};
