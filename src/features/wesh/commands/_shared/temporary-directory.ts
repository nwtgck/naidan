import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext } from '@/features/wesh/types';

async function resolveExistingDirectory({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<string | undefined> {
  try {
    const resolved = await context.files.resolve({
      path: resolvePath({
        cwd: context.cwd,
        path,
      }),
    });
    switch (resolved.stat.type) {
    case 'directory':
      return resolved.fullPath;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return undefined;
    default: {
      const _ex: never = resolved.stat.type;
      throw new Error(`Unhandled temporary directory entry type: ${_ex}`);
    }
    }
  } catch {
    return undefined;
  }
}

export async function resolveInternalTemporaryDirectory({
  context,
}: {
  context: WeshCommandContext,
}): Promise<string> {
  const configured = context.env.get('TMPDIR');
  if (configured !== undefined && configured.length > 0) {
    const resolved = await resolveExistingDirectory({
      context,
      path: configured,
    });
    if (resolved !== undefined) {
      return resolved;
    }
  }

  await context.files.mkdir({
    path: '/tmp',
    recursive: true,
  });
  return '/tmp';
}

export const TEST_ONLY = {
  resolveExistingDirectory,
};
