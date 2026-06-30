import type { WeshCommandContext } from '@/features/wesh/types';
import { resolvePath } from '@/features/wesh/path';
import { openFileReadStream, openHandleReadStream } from '@/features/wesh/utils/fs';


export async function openCommandInputStream({
  context,
  input,
}: {
  context: WeshCommandContext,
  input: string | undefined,
}): Promise<ReadableStream<Uint8Array>> {
  if (input === undefined || input === '-') {
    return openHandleReadStream({
      handle: context.stdin,
    });
  }

  return openFileReadStream({
    files: context.files,
    path: resolvePath({
      cwd: context.cwd,
      path: input,
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
