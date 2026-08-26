import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import type { WeshCommandContext } from '@/features/wesh/types';

export async function pathExists({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<boolean> {
  try {
    await context.files.lstat({ path });
    return true;
  } catch (error: unknown) {
    if (isPathNotFoundError({ error })) {
      return false;
    }
    throw error;
  }
}

export async function unlinkForcedOutputSymlink({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<void> {
  try {
    const stat = await context.files.lstat({ path });
    switch (stat.type) {
    case 'symlink':
      await context.files.unlink({ path });
      break;
    case 'directory':
    case 'file':
    case 'fifo':
    case 'chardev':
      break;
    default: {
      const _exhaustiveCheck: never = stat.type;
      throw new Error(`Unhandled file type: ${String(_exhaustiveCheck)}`);
    }
    }
  } catch (error: unknown) {
    if (!isPathNotFoundError({ error })) {
      throw error;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
