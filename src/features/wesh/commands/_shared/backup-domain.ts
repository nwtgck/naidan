import { basenamePath, dirnamePath } from '@/features/wesh/commands/_shared/path';
import type { WeshCommandContext } from '@/features/wesh/types';

export type BackupControl = 'none' | 'simple' | 'numbered' | 'existing';

type BackupControlResolution =
  | { ok: true, control: BackupControl }
  | { ok: false, value: string, source: 'option' | 'environment' };

function parseBackupControlValue({
  value,
}: {
  value: string,
}): BackupControl | undefined {
  switch (value) {
  case 'none':
  case 'off':
    return 'none';
  case 'simple':
  case 'never':
    return 'simple';
  case 'numbered':
  case 't':
    return 'numbered';
  case 'existing':
  case 'nil':
    return 'existing';
  default:
    return undefined;
  }
}

export function resolveBackupControl({
  explicitValue,
  environmentValue,
}: {
  explicitValue: string | undefined,
  environmentValue: string | undefined,
}): BackupControlResolution {
  if (explicitValue !== undefined && explicitValue.length > 0) {
    const parsed = parseBackupControlValue({ value: explicitValue });
    return parsed === undefined
      ? { ok: false, value: explicitValue, source: 'option' }
      : { ok: true, control: parsed };
  }

  if (environmentValue !== undefined && environmentValue.length > 0) {
    const parsed = parseBackupControlValue({ value: environmentValue });
    return parsed === undefined
      ? { ok: false, value: environmentValue, source: 'environment' }
      : { ok: true, control: parsed };
  }

  return { ok: true, control: 'simple' };
}

function parseNumberedBackupVersion({
  name,
  prefix,
}: {
  name: string,
  prefix: string,
}): bigint | undefined {
  if (!name.startsWith(prefix) || !name.endsWith('~')) return undefined;
  const digits = name.slice(prefix.length, -1);
  if (!/^[1-9][0-9]*$/u.test(digits)) return undefined;
  return BigInt(digits);
}

async function findHighestNumberedBackupVersion({
  context,
  destinationPath,
}: {
  context: WeshCommandContext,
  destinationPath: string,
}): Promise<bigint | undefined> {
  const parentPath = dirnamePath({ path: destinationPath });
  const basename = basenamePath({ path: destinationPath, suffix: undefined });
  const prefix = `${basename}.~`;
  const parentEntry = await context.files.resolveEntry({
    path: parentPath,
    finalSymlinkTreatment: 'follow',
  });
  const parentDirectory = (() => {
    switch (parentEntry.type) {
    case 'directory':
      return parentEntry;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`backup parent '${parentPath}' is not a directory`);
    default: {
      const _ex: never = parentEntry;
      throw new Error(`Unhandled backup parent type: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }
  })();

  let highest: bigint | undefined;
  for await (const child of context.files.readDirEntry({ entry: parentDirectory })) {
    const version = parseNumberedBackupVersion({ name: child.name, prefix });
    if (version !== undefined && (highest === undefined || version > highest)) {
      highest = version;
    }
  }
  return highest;
}

export async function selectBackupSuffix({
  context,
  destinationPath,
  control,
  simpleSuffix,
}: {
  context: WeshCommandContext,
  destinationPath: string,
  control: BackupControl,
  simpleSuffix: string,
}): Promise<string | undefined> {
  switch (control) {
  case 'none':
    return undefined;
  case 'simple':
    return simpleSuffix;
  case 'numbered': {
    const highest = await findHighestNumberedBackupVersion({ context, destinationPath });
    return `.~${(highest ?? 0n) + 1n}~`;
  }
  case 'existing': {
    const highest = await findHighestNumberedBackupVersion({ context, destinationPath });
    return highest === undefined ? simpleSuffix : `.~${highest + 1n}~`;
  }
  default: {
    const _ex: never = control;
    return _ex;
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
