import {
  encodePortableFilenameComponent,
  encodePortableSymlinkTarget,
} from '@/00-storage/service/hizofs/compatibility';
import type { TransitionNamespaceEntry } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

export class TransitionNamespaceContractError extends Error {
  public constructor({ code, message }: {
    code: 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target';
    message: string;
  }) {
    super(message);
    this.code = code;
    this.name = 'TransitionNamespaceContractError';
  }

  public readonly code: 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target';
}

export function validateTransitionNamespaceEntryName({ name }: { name: string }): void {
  try {
    encodePortableFilenameComponent({ value: name });
  } catch (cause: unknown) {
    throw new TransitionNamespaceContractError({
      code: 'invalid_entry_name',
      message: `namespace entry name is not a portable canonical filename component: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

export function validateTransitionNamespaceDirectoryPage({ afterName, entries, maximumEntries, state }: {
  afterName: string | undefined;
  entries: readonly TransitionNamespaceEntry[];
  maximumEntries: number;
  state: 'complete' | 'more';
}): void {
  if (entries.length > maximumEntries || (state === 'more' && entries.length === 0)) {
    throw new TransitionNamespaceContractError({ code: 'invalid_directory_page', message: 'namespace source returned an invalid bounded directory page' });
  }
  let previous = afterName;
  for (const entry of entries) {
    validateTransitionNamespaceEntryName({ name: entry.name });
    if (previous !== undefined && previous >= entry.name) {
      throw new TransitionNamespaceContractError({ code: 'invalid_directory_page', message: 'namespace directory page is not strict canonical ascending order' });
    }
    previous = entry.name;
  }
}

export function validateTransitionSymlinkTarget({ target }: { target: string }): void {
  try {
    encodePortableSymlinkTarget({ value: target });
  } catch (cause: unknown) {
    throw new TransitionNamespaceContractError({
      code: 'invalid_symlink_target',
      message: `symbolic link target is not portable HizoFS V1 data: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

export const TEST_ONLY = {
};
