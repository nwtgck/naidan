import { readTextFromFile, readTextFromHandle } from '@/features/wesh/commands/_shared/text';
import type { ColumnContext } from './types';

function resolvePath({
  cwd,
  path,
}: {
  cwd: string,
  path: string,
}): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

export async function readCommandInput({
  context,
  operands,
}: {
  context: ColumnContext,
  operands: string[],
}): Promise<{ text: string, exitCode: number }> {
  const inputs = operands.length === 0 ? ['-'] : operands;
  const parts: string[] = [];
  let exitCode = 0;

  for (const input of inputs) {
    try {
      if (input === '-') {
        parts.push(await readTextFromHandle({ handle: context.stdin }));
        continue;
      }

      parts.push(await readTextFromFile({
        files: context.files,
        path: resolvePath({ cwd: context.cwd, path: input }),
      }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `column: ${input}: ${message}\n` });
      exitCode = 1;
    }
  }

  return { text: parts.join(''), exitCode };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
